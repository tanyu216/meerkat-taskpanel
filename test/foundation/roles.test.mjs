/**
 * The optional team-role layer (`src/foundation/roles.mjs`).
 *
 * Roles are authored by `setup-meerkat`, never shipped by `install.sh`. The loader
 * is therefore deliberately fail-soft: a missing manifest means "no role layer"
 * (today's behaviour), while a broken manifest must warn and fall back rather
 * than wedge a poll or a wake.
 *
 * Precedence is whole-manifest: explicit `--roles-dir` > project
 * `.meerkat/roles` > the loop skill's `roles/`.
 * Project roles win as a set; they are not merged role-by-role with the global
 * set. Workflow paths are resolved inside the chosen root and may not escape it,
 * including through a symlink.
 *
 * The loop's own state directory is deliberately **not** a candidate: the
 * "deployed body" it once served no longer exists, and a role root there would be
 * silently shadowed by the skill's.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  loadRoles,
  resolveRolesRoot,
  selectReviewerRole,
  selectRole,
} from "../../src/foundation/roles.mjs";

/** A temp tree with the three candidate roots the loader knows about. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tp-roles-"));
  const projectDir = join(base, "project");
  const projectRoles = join(projectDir, ".meerkat", "roles");
  const loopSkillDir = join(base, "loop-skill");
  const loopRoles = join(loopSkillDir, "roles");
  const stateDir = join(base, "state");
  const stateRoles = join(stateDir, "roles");
  const explicitDir = join(base, "explicit");
  for (const dir of [projectRoles, loopRoles, stateRoles, explicitDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const write = (dir, rel, text) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  };

  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return {
    base,
    projectDir,
    projectRoles,
    loopSkillDir,
    loopRoles,
    stateDir,
    stateRoles,
    explicitDir,
    write,
    cleanup,
  };
}

/** A valid manifest with one worker role and one reviewer role. */
function manifest(overrides = {}) {
  return JSON.stringify({
    version: 1,
    team: "standard",
    default_reviewer: "reviewer",
    roles: [
      {
        id: "jobs",
        agent: "Jobs",
        native_agent: "jobs",
        lanes: ["worker"],
        title: "Product design",
        summary: "Product planning and design",
        responsibilities: ["product brief"],
        boundaries: ["Do not write production backend code."],
        workflow: "jobs/workflow.md",
        self_check: "jobs/self-check.md",
      },
      {
        id: "reviewer",
        agent: "Reviewer",
        native_agent: "reviewer",
        lanes: ["reviewer"],
        title: "Independent reviewer",
        summary: "Independent acceptance review",
        responsibilities: ["verify acceptance"],
        boundaries: ["Move nothing."],
        workflow: "reviewer/workflow.md",
        reviewer_prompt: "reviewer/reviewer-prompt.md",
      },
      ...(overrides.roles ?? []),
    ],
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "roles"),
    ),
  });
}

/** Write the files a manifest names so path validation can pass. */
function writeRoleFiles(f, dir, prefix = "") {
  f.write(dir, join(prefix, "jobs", "workflow.md"), "# Jobs\n");
  f.write(dir, join(prefix, "jobs", "self-check.md"), "# Jobs self-check\n");
  f.write(dir, join(prefix, "reviewer", "workflow.md"), "# Reviewer\n");
  f.write(dir, join(prefix, "reviewer", "reviewer-prompt.md"), "# Verdict first\n");
}

describe("resolveRolesRoot — whole-manifest precedence", () => {
  it("prefers an explicit directory, then project, then the loop skill", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.explicitDir);
      writeRoleFiles(f, f.projectRoles);
      writeRoleFiles(f, f.loopRoles);
      f.write(f.explicitDir, "manifest.json", manifest());
      f.write(f.projectRoles, "manifest.json", manifest({ team: "project" }));
      f.write(f.loopRoles, "manifest.json", manifest({ team: "global" }));

      assert.equal(
        resolveRolesRoot({
          explicitDir: f.explicitDir,
          projectDir: f.projectDir,
          loopSkillDir: f.loopSkillDir,
        }).source,
        "explicit",
      );
      assert.equal(
        resolveRolesRoot({
          projectDir: f.projectDir,
          loopSkillDir: f.loopSkillDir,
        }).source,
        "project",
      );
      assert.equal(resolveRolesRoot({ loopSkillDir: f.loopSkillDir }).source, "loop-skill");
    } finally {
      f.cleanup();
    }
  });

  it("ignores a manifest in the loop state directory", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.stateRoles);
      f.write(f.stateRoles, "manifest.json", manifest({ team: "state" }));

      assert.equal(
        resolveRolesRoot({ stateDir: f.stateDir }),
        null,
        "the state directory is runtime state, not a roles root",
      );
      const result = loadRoles({ stateDir: f.stateDir });
      assert.equal(result.ok, true);
      assert.equal(result.source, null);
      assert.deepEqual(result.roles, []);
    } finally {
      f.cleanup();
    }
  });

  it("returns null when no root has a manifest", () => {
    const f = fixture();
    try {
      assert.equal(resolveRolesRoot({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir }), null);
    } finally {
      f.cleanup();
    }
  });
});

describe("loadRoles — fail-soft loading", () => {
  it("returns no roles for a missing manifest, without a warning", () => {
    const f = fixture();
    try {
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ok, true);
      assert.equal(result.source, null);
      assert.deepEqual(result.roles, []);
      assert.deepEqual(result.warnings, []);
    } finally {
      f.cleanup();
    }
  });

  it("reports a malformed manifest and keeps the loop alive with no roles", () => {
    const f = fixture();
    try {
      f.write(f.projectRoles, "manifest.json", "{ not json");
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ok, false);
      assert.deepEqual(result.roles, []);
      assert.ok(result.warnings.length > 0);
      assert.match(result.warnings.join("\n"), /manifest/i);
    } finally {
      f.cleanup();
    }
  });

  it("rejects an unknown manifest version rather than guessing", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest({ version: 99 }));
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ok, false);
      assert.deepEqual(result.roles, []);
    } finally {
      f.cleanup();
    }
  });

  it("normalises a role and finds the reviewer", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ok, true);
      assert.equal(result.source, "project");
      assert.equal(result.team, "standard");
      assert.equal(result.roles.length, 2);
      assert.equal(result.defaultReviewer.id, "reviewer");
      assert.equal(result.byAgent.get("jobs").agent, "Jobs");
      assert.equal(result.roles[0].nativeAgent, "jobs");
      assert.match(result.roles[0].workflows.worker, /jobs\/workflow\.md$/);
      assert.match(result.roles[1].reviewerPrompt, /reviewer-prompt\.md$/);
    } finally {
      f.cleanup();
    }
  });

  it("supports the workflow-by-lane form", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(
        f.projectRoles,
        "manifest.json",
        JSON.stringify({
          version: 1,
          roles: [
            {
              id: "dual",
              agent: "Dual",
              lanes: ["worker", "reviewer"],
              title: "Dual",
              workflow: { worker: "jobs/workflow.md", reviewer: "reviewer/workflow.md" },
              reviewer_prompt: "reviewer/reviewer-prompt.md",
            },
          ],
        }),
      );
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ok, true);
      assert.match(result.roles[0].workflows.worker, /jobs\/workflow\.md$/);
      assert.match(result.roles[0].workflows.reviewer, /reviewer\/workflow\.md$/);
      assert.equal(result.defaultReviewer.id, "dual");
    } finally {
      f.cleanup();
    }
  });
});

describe("loadRoles — path safety", () => {
  for (const [label, workflow] of [
    ["a parent traversal", "../outside.md"],
    ["an absolute path", "/tmp/outside.md"],
    ["a backslash path", "..\\outside.md"],
    ["a non-markdown file", "jobs/workflow.txt"],
  ]) {
    it(`refuses ${label} and keeps the role with no workflow path`, () => {
      const f = fixture();
      try {
        writeRoleFiles(f, f.projectRoles);
        f.write(f.projectRoles, "manifest.json", manifest({ roles: [{ ...JSON.parse(manifest()).roles[0], id: "evil", agent: "Evil", workflow }] }));
        const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
        assert.equal(result.ok, true, "a bad workflow is a role warning, not a manifest failure");
        const evil = result.roles.find((role) => role.id === "evil");
        assert.ok(evil, "the role remains visible for reporting");
        assert.equal(evil.workflows.worker, null);
        assert.match(result.warnings.join("\n"), /evil/);
      } finally {
        f.cleanup();
      }
    });
  }

  it("refuses a symlink that escapes the roles root", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      const outside = join(f.base, "outside.md");
      writeFileSync(outside, "# outside\n", "utf8");
      symlinkSync(outside, join(f.projectRoles, "escape.md"));
      f.write(
        f.projectRoles,
        "manifest.json",
        manifest({ roles: [{ ...JSON.parse(manifest()).roles[0], id: "escape", agent: "Escape", workflow: "escape.md" }] }),
      );
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      const escape = result.roles.find((role) => role.id === "escape");
      assert.equal(escape.workflows.worker, null);
      assert.match(result.warnings.join("\n"), /escape/);
    } finally {
      f.cleanup();
    }
  });
});

describe("selectRole / selectReviewerRole", () => {
  it("matches the board agent name case-insensitively and respects the lane", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      const roles = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });

      assert.equal(selectRole(roles, "Jobs", "worker").id, "jobs");
      assert.equal(selectRole(roles, "jobs", "worker").id, "jobs");
      assert.equal(selectRole(roles, "Jobs", "reviewer"), null, "a worker-only role is not a review role");
      assert.equal(selectReviewerRole(roles, "Reviewer").id, "reviewer");
      assert.equal(selectRole(roles, "nobody", "worker"), null);
    } finally {
      f.cleanup();
    }
  });

  it("falls back to the default reviewer when a dedicated reviewer has no reviewer lane", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      const roles = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(selectReviewerRole(roles, "Jobs").id, "reviewer");
    } finally {
      f.cleanup();
    }
  });

  it("keeps the first role when two roles claim the same agent, and warns", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(
        f.projectRoles,
        "manifest.json",
        manifest({ roles: [{ ...JSON.parse(manifest()).roles[0], id: "jobs-2", agent: "jobs" }] }),
      );
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.roles.filter((role) => role.agent.toLowerCase() === "jobs").length, 1);
      assert.equal(result.byAgent.get("jobs").id, "jobs");
      assert.match(result.warnings.join("\n"), /duplicate/i);
    } finally {
      f.cleanup();
    }
  });
});

describe("decision policy", () => {
  it("ignores a team decision-policy.md — the loop policy is authoritative", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      f.write(f.projectRoles, "decision-policy.md", "# Team policy\n");
      f.write(f.loopSkillDir, "references/decision-policy.md", "# Default policy\n");
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.decisionPolicy.isDefault, true);
      assert.match(result.decisionPolicy.path, /loop-skill\/references\/decision-policy\.md$/);
      assert.match(result.decisionPolicy.text, /Default policy/);
      assert.doesNotMatch(result.decisionPolicy.text, /Team policy/);
    } finally {
      f.cleanup();
    }
  });

  it("falls back to the loop skill's default policy", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      f.write(f.loopSkillDir, "references/decision-policy.md", "# Default policy\n");
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.decisionPolicy.isDefault, true);
      assert.match(result.decisionPolicy.path, /loop-skill\/references\/decision-policy\.md$/);
      assert.match(result.decisionPolicy.text, /Default policy/);
    } finally {
      f.cleanup();
    }
  });

  it("reports no policy rather than failing when neither file exists", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.decisionPolicy.isDefault, true);
      assert.equal(result.decisionPolicy.path, null);
      assert.equal(result.decisionPolicy.text, null);
    } finally {
      f.cleanup();
    }
  });
});

describe("ownership guide", () => {
  it("loads ownership.md from the roles root", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      f.write(f.projectRoles, "ownership.md", "# Ownership\n| Work shape | Role |\n");
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ownership.source, "team");
      assert.match(result.ownership.path, /\.meerkat\/roles\/ownership\.md$/);
      assert.match(result.ownership.text, /Work shape/);
      assert.equal(result.ownership.truncated, false);
    } finally {
      f.cleanup();
    }
  });

  it("reports no guide when the file is absent", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ownership.source, null);
      assert.equal(result.ownership.path, null);
      assert.equal(result.ownership.text, null);
    } finally {
      f.cleanup();
    }
  });

  it("reports no guide when no roles root resolves", () => {
    const f = fixture();
    try {
      const result = loadRoles({ loopSkillDir: f.loopSkillDir });
      assert.equal(result.ownership.path, null);
      assert.equal(result.ownership.text, null);
    } finally {
      f.cleanup();
    }
  });

  it("truncates an oversized guide instead of failing", () => {
    const f = fixture();
    try {
      writeRoleFiles(f, f.projectRoles);
      f.write(f.projectRoles, "manifest.json", manifest());
      f.write(f.projectRoles, "ownership.md", "x".repeat(9 * 1024));
      const result = loadRoles({ projectDir: f.projectDir, loopSkillDir: f.loopSkillDir });
      assert.equal(result.ownership.truncated, true);
      assert.equal(result.ownership.text.length, 8 * 1024);
    } finally {
      f.cleanup();
    }
  });
});
