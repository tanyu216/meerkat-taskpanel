/**
 * The setup-meerkat skill's deterministic surface.
 *
 * The scripts are standalone (Node builtins only), so the tests drive them as child
 * processes against throwaway HOMEs and projects. Detection must never write; the role
 * installer must be idempotent, refuse a conflict without `--force`, and keep every
 * path inside the roles root.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { AGENT_DIRS } from "../../scripts/loop/options.mjs";
import { LOOP_KINDS } from "../../skills/setup-meerkat/scripts/lib/agent-kinds.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = join(ROOT, "skills", "setup-meerkat");
const DETECT = join(SKILL, "scripts", "detect.mjs");
const INSTALL = join(SKILL, "scripts", "install-roles.mjs");
const CONFIGURE = join(SKILL, "scripts", "configure-env.mjs");

function temp(t, prefix = "tp-setup-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(t, script, args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result;
}

function runJson(t, script, args, options) {
  const result = run(t, script, [...args, "--json"], options);
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  return { ...result, body };
}

function tree(dir) {
  const files = [];
  const walk = (path, prefix) => {
    let entries;
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(path, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(dir, "");
  return files.sort();
}

describe("skill frontmatter and assets", () => {
  it("is a command-only skill with a substantial description", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\n/);
    assert.match(text, /\nname: setup-meerkat\n/);
    assert.match(text, /\ndisable-model-invocation: true\n/);
    const description = text.match(/\ndescription: ([^\n]+)/)?.[1] ?? "";
    assert.ok(description.length >= 20);
  });

  it("ships the standard team, a decision policy, and native templates", () => {
    const team = join(SKILL, "assets", "team", "standard");
    for (const rel of [
      "manifest.json",
      "decision-policy.md",
      "jobs/workflow.md",
      "jobs/self-check.md",
      "linus/workflow.md",
      "linus/self-check.md",
      "turing/workflow.md",
      "turing/self-check.md",
      "reviewer/workflow.md",
      "reviewer/reviewer-prompt.md",
      "agents/claude/role.md.tmpl",
      "agents/codex/role.toml.tmpl",
    ]) {
      assert.ok(existsSync(join(team, rel)), `${rel} must exist`);
    }
  });

  it("does not ship a roles/ directory inside the loop skill", () => {
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-loop", "roles")), false);
  });

  it("keeps the skill-creator eval prompts parseable", () => {
    const evals = JSON.parse(readFileSync(join(SKILL, "evals", "evals.json"), "utf8"));
    assert.equal(evals.skill_name, "setup-meerkat");
    assert.equal(evals.evals.length, 6);
    for (const entry of evals.evals) {
      assert.equal(typeof entry.prompt, "string");
      assert.ok(entry.prompt.length > 20, `eval ${entry.id}: prompt`);
      assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0, `eval ${entry.id}: assertions`);
    }
  });

  it("mirrors the loop's actor-kind table", () => {
    assert.deepEqual([...LOOP_KINDS].sort(), Object.keys(AGENT_DIRS).sort());
  });
});

describe("detect.mjs — read-only discovery", () => {
  it("reports a bare host without writing a file", (t) => {
    const home = temp(t);
    const project = temp(t);
    const emptyPath = temp(t);
    const before = { home: tree(home), project: tree(project) };
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: emptyPath } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.body, "JSON output");
    assert.equal(result.body.checkout.found, false);
    assert.equal(result.body.taskctl.found, false);
    assert.equal(result.body.server.probed, false);
    assert.ok(result.body.missing.includes("taskctl"));
    assert.equal(result.body.human.configured, false);
    assert.deepEqual(tree(home), before.home);
    assert.deepEqual(tree(project), before.project);
  });

  it("reads the fixed human name and the tracker state", (t) => {
    const home = temp(t);
    const project = temp(t);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { TASKCTL_HUMAN: "Terry" } }));
    mkdirSync(join(project, "docs", "agents"), { recursive: true });
    writeFileSync(join(project, "docs", "agents", "issue-tracker.md"), "# GitHub tracker\n");
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.human.configured, true);
    assert.equal(result.body.human.name, "Terry");
    assert.equal(result.body.human.source, "settings");
    assert.equal(result.body.mattPocock.tracker.exists, true);
    assert.equal(result.body.mattPocock.tracker.unrelated, true);
  });

  it("recognises a tracker that already mentions taskpanel", (t) => {
    const home = temp(t);
    const project = temp(t);
    mkdirSync(join(project, "docs", "agents"), { recursive: true });
    writeFileSync(join(project, "docs", "agents", "issue-tracker.md"), "# taskctl cards\n");
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.mattPocock.tracker.mentionsTaskpanel, true);
    assert.equal(result.body.mattPocock.tracker.unrelated, false);
  });
});

describe("install-roles.mjs — project scope", () => {
  it("dry-runs without writing, installs, and is idempotent", (t) => {
    const home = temp(t);
    const project = temp(t);
    const args = ["--scope", "project", "--project", project, "--home", home, "--actor-kind", "claude"];

    const dry = runJson(t, INSTALL, [...args, "--dry-run"], { cwd: project });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(join(project, ".meerkat")), false, "dry-run must not create the roles root");
    assert.ok(dry.body.files.every((entry) => entry.action === "would-write"));

    const first = runJson(t, INSTALL, args, { cwd: project });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.body.ok, true);
    assert.ok(existsSync(join(project, ".meerkat", "roles", "manifest.json")));
    assert.ok(existsSync(join(project, ".claude", "agents", "jobs.md")));
    assert.ok(existsSync(join(project, ".codex", "agents", "reviewer.toml")));

    const second = runJson(t, INSTALL, args, { cwd: project });
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.body.files.every((entry) => entry.action === "unchanged"));
    assert.ok(second.body.agentDefs.every((entry) => entry.action === "unchanged"));

    const validate = runJson(t, INSTALL, ["--validate", join(project, ".meerkat", "roles")]);
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(validate.body.ok, true);
    assert.equal(validate.body.roles.length, 4);
    assert.equal(validate.body.defaultReviewer, "reviewer");

    const claude = readFileSync(join(project, ".claude", "agents", "jobs.md"), "utf8");
    assert.match(claude, /^name: jobs$/m);
    assert.match(claude, /\.meerkat\/roles\/jobs\/workflow\.md/);
    assert.match(claude, /Self-check:/);
    const codex = readFileSync(join(project, ".codex", "agents", "reviewer.toml"), "utf8");
    assert.match(codex, /^name = "reviewer"$/m);
    assert.match(codex, /\.meerkat\/roles\/reviewer\/workflow\.md/);
  });

  it("refuses a differing file without --force, then replaces it with --force", (t) => {
    const home = temp(t);
    const project = temp(t);
    const args = ["--scope", "project", "--project", project, "--home", home, "--actor-kind", "claude"];
    assert.equal(runJson(t, INSTALL, args, { cwd: project }).status, 0);
    const workflow = join(project, ".meerkat", "roles", "jobs", "workflow.md");
    writeFileSync(workflow, "# edited by the user\n", "utf8");

    const conflict = runJson(t, INSTALL, args, { cwd: project });
    assert.equal(conflict.status, 3);
    assert.equal(conflict.body.ok, false);
    assert.ok(conflict.body.files.some((entry) => entry.path === workflow && entry.action === "conflict"));
    assert.equal(readFileSync(workflow, "utf8"), "# edited by the user\n", "a conflict writes nothing");

    const forced = runJson(t, INSTALL, [...args, "--force"], { cwd: project });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(workflow, "utf8"), /# Jobs/);
  });

  it("requires the loop skill for a global install", (t) => {
    const home = temp(t);
    const project = temp(t);
    const result = runJson(
      t,
      INSTALL,
      ["--scope", "global", "--project", project, "--home", home, "--actor-kind", "claude"],
      { cwd: project },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /loop skill is not installed/);
  });

  it("installs globally under the loop skill's roles directory", (t) => {
    const home = temp(t);
    const project = temp(t);
    const loopSkill = join(home, ".claude", "skills", "meerkat-loop");
    mkdirSync(loopSkill, { recursive: true });
    writeFileSync(join(loopSkill, "SKILL.md"), "---\nname: meerkat-loop\n---\n");
    const result = runJson(
      t,
      INSTALL,
      ["--scope", "global", "--project", project, "--home", home, "--actor-kind", "claude"],
      { cwd: project },
    );
    assert.equal(result.status, 0, result.stderr);
    const roles = join(loopSkill, "roles");
    assert.ok(existsSync(join(roles, "manifest.json")));
    assert.ok(existsSync(join(roles, "decision-policy.md")));
    assert.ok(existsSync(join(roles, "reviewer", "reviewer-prompt.md")));
    assert.ok(existsSync(join(home, ".claude", "agents", "jobs.md")));
    assert.ok(existsSync(join(home, ".codex", "agents", "jobs.toml")));
    assert.equal(existsSync(join(project, ".meerkat", "roles")), false, "global must not write into the project");
  });

  it("honours role, agent and reviewer renames", (t) => {
    const home = temp(t);
    const project = temp(t);
    const result = runJson(
      t,
      INSTALL,
      [
        "--scope", "project", "--project", project, "--home", home,
        "--role", "jobs", "--role", "reviewer",
        "--agent", "jobs=Alice", "--reviewer", "Grace",
      ],
      { cwd: project },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(project, ".meerkat", "roles", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.roles.map((role) => role.id).sort(), ["jobs", "reviewer"]);
    assert.equal(manifest.roles.find((role) => role.id === "jobs").agent, "Alice");
    assert.equal(manifest.roles.find((role) => role.id === "reviewer").agent, "Grace");
    assert.equal(result.body.reviewerAgent, "Grace");
  });

  it("rejects a workflow that escapes the team root", (t) => {
    const source = temp(t);
    const roles = join(source, ".meerkat", "roles");
    mkdirSync(join(roles, "jobs"), { recursive: true });
    writeFileSync(join(roles, "jobs", "workflow.md"), "# Jobs\n");
    writeFileSync(
      join(roles, "manifest.json"),
      JSON.stringify({
        version: 1,
        roles: [
          {
            id: "jobs",
            agent: "Jobs",
            workflow: "../escape.md",
            lanes: ["worker"],
          },
        ],
      }),
    );
    const result = runJson(t, INSTALL, ["--validate", roles]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.roles[0].workflows.worker, null);
    assert.match(result.body.warnings.join("\n"), /escapes/);
  });
});

describe("configure-env.mjs", () => {
  it("preserves comments, is idempotent, and refuses a different value", (t) => {
    const dir = temp(t);
    const file = join(dir, ".env");
    writeFileSync(file, "# keep me\nTASKD_URL=http://localhost:9527\n", "utf8");

    const first = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_AGENTS", "--value", "Jobs,Linus,Turing"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(file, "utf8"), /# keep me/);
    assert.match(readFileSync(file, "utf8"), /TASKD_URL=http:\/\/localhost:9527/);

    const second = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_AGENTS", "--value", "Jobs,Linus,Turing"]);
    assert.equal(second.status, 0);
    assert.equal(second.body.action, "unchanged");

    const conflict = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_AGENTS", "--value", "Alice"]);
    assert.equal(conflict.status, 3);
    assert.equal(conflict.body.action, "conflict");

    const forced = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_AGENTS", "--value", "Alice", "--force"]);
    assert.equal(forced.status, 0);
    assert.match(readFileSync(file, "utf8"), /MEERKAT_TASKPANEL_AGENTS=Alice/);
  });
});
