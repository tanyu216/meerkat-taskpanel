/**
 * The team-role layer (`src/foundation/roles.mjs`) — discovery by installed skill.
 *
 * A role is a skill: `<kind>/skills/<role>/role.json` carries a schema marker and
 * references that must stay inside the skill directory. The supervisor scans the
 * kinds in preference order and records where each role is installed; discovery
 * is fail-soft, so a malformed skill warns and is skipped rather than wedging a
 * poll or a wake.
 *
 * Decision authority is the director skill's, never a role's and never an
 * explicit roles directory's.
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
  renderRoutingTable,
  roleVariant,
  selectReviewerRole,
  selectRole,
  selectWorkerRole,
  skillFingerprint,
  skillLoadMode,
  supportsInlineSkill,
  supportsSkillOpener,
} from "../../src/foundation/roles.mjs";

/** A temp home with claude/codex/pi skill trees. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tp-roles-"));
  const home = join(base, "home");
  const kinds = { claude: ".claude", codex: ".codex", pi: ".agents" };
  for (const dir of Object.values(kinds)) {
    mkdirSync(join(home, dir, "skills"), { recursive: true });
  }
  const write = (dir, rel, text) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return { base, home, kinds, write, cleanup };
}

/** A role skill under one kind, with a valid role.json and SKILL.md. */
function writeRole(f, kind, id, overrides = {}) {
  const dir = join(f.home, f.kinds[kind], "skills", id);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${id}\n`, "utf8");
  writeFileSync(join(dir, "references", "self-check.md"), "# check\n", "utf8");
  const role = {
    schema: "meerkat-role",
    id,
    agent: id[0].toUpperCase() + id.slice(1),
    native_agent: id,
    lanes: ["worker"],
    title: id,
    summary: `${id} role`,
    shapes: [`${id} work`],
    responsibilities: [],
    boundaries: [],
    self_check: "references/self-check.md",
    ...overrides,
  };
  writeFileSync(join(dir, "role.json"), JSON.stringify(role), "utf8");
  return dir;
}

/** A director skill with a decision policy. */
function writeDirector(f, kind, text = "# Decision policy\nsubagent → director → human\n") {
  const dir = join(f.home, f.kinds[kind], "skills", "meerkat-director");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# director\n", "utf8");
  writeFileSync(join(dir, "references", "decision-policy.md"), text, "utf8");
  return dir;
}

describe("loadRoles — discovery", () => {
  it("returns no roles for a home with no role skills, without a warning", () => {
    const f = fixture();
    try {
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.ok, true);
      assert.equal(result.source, "skills");
      assert.deepEqual(result.roles, []);
      assert.equal(result.defaultReviewer, null);
      assert.equal(result.routing.text, null);
      assert.deepEqual(result.warnings, []);
    } finally {
      f.cleanup();
    }
  });

  it("discovers a role on one kind and records that platform", () => {
    const f = fixture();
    try {
      writeRole(f, "codex", "turing");
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.roles.length, 1);
      const role = result.roles[0];
      assert.equal(role.id, "turing");
      assert.equal(role.platform, "codex");
      assert.deepEqual(role.installedOn, ["codex"]);
      assert.match(role.workflow, /\.codex\/skills\/turing\/SKILL\.md$/);
    } finally {
      f.cleanup();
    }
  });

  it("prefers the primary kind when a role is installed on several kinds", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs");
      writeRole(f, "codex", "jobs");
      const result = loadRoles({ home: f.home, primaryKind: "codex" });
      assert.equal(result.roles.length, 1);
      assert.equal(result.roles[0].platform, "codex");
      assert.deepEqual(result.roles[0].installedOn, ["codex", "claude"]);
    } finally {
      f.cleanup();
    }
  });

  it("uses the fixed order when the primary kind does not carry the role", () => {
    const f = fixture();
    try {
      writeRole(f, "codex", "linus");
      writeRole(f, "pi", "linus");
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.roles[0].platform, "codex");
      assert.deepEqual(result.roles[0].installedOn, ["codex", "pi"]);
    } finally {
      f.cleanup();
    }
  });

  it("uses the configured kind order when the primary kind does not carry the role", () => {
    const f = fixture();
    try {
      writeRole(f, "codex", "linus");
      writeRole(f, "pi", "linus");
      const result = loadRoles({
        home: f.home,
        primaryKind: "claude",
        kindOrder: ["pi", "claude", "codex"],
      });
      assert.equal(result.roles[0].platform, "pi");
      assert.deepEqual(result.roles[0].installedOn, ["pi", "codex"]);
    } finally {
      f.cleanup();
    }
  });

  it("appends missing kinds and still discovers a role on an unlisted kind", () => {
    const f = fixture();
    try {
      writeRole(f, "codex", "linus");
      const result = loadRoles({ home: f.home, primaryKind: "claude", kindOrder: ["pi"] });
      assert.equal(result.roles.length, 1);
      assert.equal(result.roles[0].platform, "codex");
      assert.deepEqual(result.roles[0].installedOn, ["codex"]);
    } finally {
      f.cleanup();
    }
  });

  it("falls back to the fixed order for an invalid configured order", () => {
    const f = fixture();
    try {
      writeRole(f, "codex", "linus");
      const result = loadRoles({
        home: f.home,
        primaryKind: "claude",
        kindOrder: ["nope", "claude"],
      });
      assert.equal(result.roles[0].platform, "codex");
      assert.deepEqual(result.roles[0].installedOn, ["codex"]);
    } finally {
      f.cleanup();
    }
  });

  it("keeps each kind's copy so a fallback dispatch points at that copy", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs");
      writeRole(f, "codex", "jobs");
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      const role = result.roles[0];
      assert.match(roleVariant(role, "claude").workflow, /\.claude\/skills\/jobs\/SKILL\.md$/);
      assert.match(roleVariant(role, "codex").workflow, /\.codex\/skills\/jobs\/SKILL\.md$/);
      // An unknown kind falls back to the role's own (primary) files.
      assert.equal(roleVariant(role, "pi").workflow, role.workflow);
    } finally {
      f.cleanup();
    }
  });

  it("an explicit roles directory replaces the scanned set", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs");
      const explicit = join(f.base, "team", "custom");
      mkdirSync(explicit, { recursive: true });
      writeFileSync(join(explicit, "SKILL.md"), "# custom\n", "utf8");
      writeFileSync(
        join(explicit, "role.json"),
        JSON.stringify({ schema: "meerkat-role", id: "custom", agent: "Custom", shapes: ["x"] }),
        "utf8",
      );
      const result = loadRoles({ home: f.home, primaryKind: "claude", explicitDir: join(f.base, "team") });
      assert.equal(result.source, "explicit");
      assert.deepEqual(result.roles.map((role) => role.id), ["custom"]);
      assert.equal(result.roles[0].platform, "claude");
    } finally {
      f.cleanup();
    }
  });
});

describe("loadRoles — fail-soft validation", () => {
  it("skips a role without the schema marker", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs", { schema: undefined });
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.deepEqual(result.roles, []);
      assert.ok(result.warnings.some((warning) => /marker/.test(warning)));
    } finally {
      f.cleanup();
    }
  });

  it("skips malformed JSON and invalid ids without throwing", () => {
    const f = fixture();
    try {
      const broken = join(f.home, ".claude", "skills", "broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, "SKILL.md"), "# broken\n", "utf8");
      writeFileSync(join(broken, "role.json"), "{not json", "utf8");
      writeRole(f, "claude", "bad id");
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.deepEqual(result.roles, []);
      assert.ok(result.warnings.length >= 2);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a self-check that escapes the skill directory through a symlink", () => {
    const f = fixture();
    try {
      const dir = writeRole(f, "claude", "jobs", { self_check: "references/check.md" });
      const outside = join(f.base, "outside.md");
      writeFileSync(outside, "# outside\n", "utf8");
      symlinkSync(outside, join(dir, "references", "check.md"));
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.roles.length, 1);
      assert.equal(result.roles[0].selfCheck, null);
      assert.ok(result.warnings.some((warning) => /self_check/.test(warning)));
    } finally {
      f.cleanup();
    }
  });

  it("keeps the first role when two skills claim the same agent, and warns", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs");
      writeRole(f, "claude", "jobs-copy", { id: "jobs-copy", agent: "Jobs" });
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.deepEqual(result.roles.map((role) => role.id), ["jobs"]);
      assert.ok(result.warnings.some((warning) => /duplicate agent/.test(warning)));
    } finally {
      f.cleanup();
    }
  });
});

describe("roles — selection and routing", () => {
  it("selects by agent or id, respecting the lane", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "jobs");
      writeRole(f, "claude", "reviewer", { lanes: ["reviewer"], default_reviewer: true });
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(selectRole(result, "Jobs", "worker")?.id, "jobs");
      assert.equal(selectRole(result, "reviewer", "worker"), null);
      assert.equal(selectReviewerRole(result, "Reviewer")?.id, "reviewer");
      assert.equal(selectReviewerRole(result, "someone-else")?.id, "reviewer");
    } finally {
      f.cleanup();
    }
  });

  it("selects the worker fallback by id or agent", () => {
    const f = fixture();
    try {
      writeRole(f, "claude", "worker", { agent: "Worker" });
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(selectWorkerRole(result)?.id, "worker");
    } finally {
      f.cleanup();
    }
  });

  it("generates the routing table from shapes", () => {
    const roles = [
      { agent: "Jobs", shapes: ["brief", "prototype"], workflow: "/s/jobs/SKILL.md" },
      { agent: "Turing", shapes: ["tests"], workflow: "/s/turing/SKILL.md" },
    ];
    const text = renderRoutingTable(roles);
    assert.match(text, /\| brief \| Jobs \|/);
    assert.match(text, /\| prototype \| Jobs \|/);
    assert.match(text, /\| tests \| Turing \|/);
    assert.match(text, /goes to the Worker role/);
  });

  it("keeps reviewer-lane roles out of the work routing table", () => {
    const roles = [
      { agent: "Linus", lanes: ["worker"], shapes: ["implementation"], workflow: "/s/linus/SKILL.md" },
      { agent: "Reviewer", lanes: ["reviewer"], shapes: ["independent review"], workflow: "/s/reviewer/SKILL.md" },
    ];
    const text = renderRoutingTable(roles);
    assert.match(text, /\| implementation \| Linus \|/);
    assert.doesNotMatch(text, /\| independent review \| Reviewer \|/);
    assert.match(text, /Reviewer roles are never routed/);
  });
});

describe("decision policy", () => {
  it("loads the policy from the primary kind's director skill", () => {
    const f = fixture();
    try {
      writeDirector(f, "claude", "# policy\n");
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.decisionPolicy.source, "director");
      assert.match(result.decisionPolicy.path, /meerkat-director\/references\/decision-policy\.md$/);
      assert.match(result.decisionPolicy.skillDir, /skills\/meerkat-director$/);
      assert.match(result.decisionPolicy.text, /policy/);
    } finally {
      f.cleanup();
    }
  });

  it("a role skill or explicit directory cannot override the policy", () => {
    const f = fixture();
    try {
      writeDirector(f, "claude", "# the director's policy\n");
      const explicit = join(f.base, "team", "jobs");
      mkdirSync(explicit, { recursive: true });
      writeFileSync(join(explicit, "SKILL.md"), "# custom\n", "utf8");
      writeFileSync(
        join(explicit, "role.json"),
        JSON.stringify({ schema: "meerkat-role", id: "custom", agent: "Custom", shapes: ["x"] }),
        "utf8",
      );
      writeFileSync(join(f.base, "team", "decision-policy.md"), "# team policy\n", "utf8");
      const result = loadRoles({ home: f.home, primaryKind: "claude", explicitDir: join(f.base, "team") });
      assert.match(result.decisionPolicy.text, /the director's policy/);
    } finally {
      f.cleanup();
    }
  });

  it("reports no policy rather than failing when the director skill is absent", () => {
    const f = fixture();
    try {
      const result = loadRoles({ home: f.home, primaryKind: "claude" });
      assert.equal(result.decisionPolicy.source, null);
      assert.equal(result.decisionPolicy.path, null);
    } finally {
      f.cleanup();
    }
  });
});

describe("skill loading support", () => {
  it("names only the hosts verified to expand a `/skill` opener, and fails closed", () => {
    assert.equal(supportsSkillOpener("claude"), true);
    assert.equal(supportsSkillOpener("codex"), false);
    assert.equal(supportsSkillOpener("pi"), false);
    assert.equal(supportsSkillOpener(undefined), false);
    assert.equal(supportsSkillOpener(null), false);
  });

  it("loads the skill inside the adapter on Codex and Pi", () => {
    assert.equal(supportsInlineSkill("codex"), true);
    assert.equal(supportsInlineSkill("pi"), true);
    assert.equal(supportsInlineSkill("claude"), false);
    assert.equal(supportsInlineSkill("openclaw"), false);
  });

  it("has one mode per kind", () => {
    assert.equal(skillLoadMode("claude"), "opener");
    assert.equal(skillLoadMode("codex"), "inline");
    assert.equal(skillLoadMode("pi"), "inline");
    assert.equal(skillLoadMode("openclaw"), "none");
    assert.equal(skillLoadMode(undefined), "none");
  });
});

describe("skill fingerprint", () => {
  it("changes when any installed skill file changes, and is null for a missing directory", () => {
    const f = fixture();
    try {
      const dir = writeDirector(f, "claude", "# policy\n");
      const first = skillFingerprint(dir);
      assert.equal(typeof first, "string");
      assert.equal(skillFingerprint(dir), first, "the fingerprint is stable");
      writeFileSync(join(dir, "references", "decision-policy.md"), "# changed\n", "utf8");
      assert.notEqual(skillFingerprint(dir), first, "a changed file changes the fingerprint");
      assert.equal(skillFingerprint(null), null);
      assert.equal(skillFingerprint(join(f.home, "missing")), null);
      assert.equal(skillFingerprint(join(dir, "SKILL.md")), null, "a file is not a skill directory");
    } finally {
      f.cleanup();
    }
  });
});
