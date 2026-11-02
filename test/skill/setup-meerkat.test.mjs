/**
 * The setup-meerkat skill's deterministic surface.
 *
 * The scripts are standalone (Node builtins only), so the tests drive them as child
 * processes against throwaway HOMEs and projects. Detection must never write: it reports
 * role skills per kind from each `<home>/<agent-dir>/skills/<role>/role.json`, and names
 * retired role trees without reading or deleting them.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { AGENT_DIRS } from "../../src/orchestrator/options.mjs";
import { baseEnv } from "../helpers/base-env.mjs";
import { LOOP_KINDS } from "../../skills/setup-meerkat/scripts/lib/agent-kinds.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = join(ROOT, "skills", "setup-meerkat");
const DETECT = join(SKILL, "scripts", "detect.mjs");
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
    env: baseEnv(env),
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

  it("leaves the /meerkat task entry in the project's instruction file", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const evals = JSON.parse(readFileSync(join(SKILL, "evals", "evals.json"), "utf8"));

    assert.match(skill, /^## 4\. The project's task entry$/m, "the task entry is its own stage");
    assert.match(skill, /\/init/, "the stage runs the host's init step before writing");
    assert.match(
      skill,
      /init step[\s\S]{0,300}(never|does not)[\s\S]{0,120}task entry/i,
      "the stage says an init draft does not carry the entry",
    );
    assert.match(skill, /CLAUDE\.md[\s\S]{0,200}AGENTS\.md/, "the entry lands in the host's file");
    assert.doesNotMatch(
      skill,
      /<!--\s*\/?meerkat:task-entry\s*-->/,
      "the skill ships requirements, not a managed block",
    );

    const stage4 = skill.slice(skill.indexOf("## 4."), skill.indexOf("## 5."));
    for (const keyword of ["/meerkat", "card", "claim", "heartbeat", "deliver", "in_review", "done"]) {
      assert.ok(stage4.includes(keyword), `the stage keeps the keyword ${keyword}`);
    }
    assert.match(stage4, /card scope/i, "the stage requires the card scope");
    assert.match(stage4, /a role owns|role owns/i, "its default is the roles' remit");
    assert.match(stage4, /question|lookup|one-off/i, "it names what stays out");
    assert.doesNotMatch(
      stage4,
      /docs\/agents\/(?!decision-policy\.md)/,
      "the stage stands alone — no tracker-integration artifact is required",
    );
    assert.match(stage4, /skills\/<role>\//, "the stage names the role-skill discovery path");
    assert.match(stage4, /skill\.md/i, "it sends that session to the role's SKILL.md");
    assert.match(stage4, /supervisor injects the handoff/i, "the handoff is the supervisor's");
    assert.match(
      stage4,
      /installed[^.]{0,40}authoritative/i,
      "the installed copy wins over the template it was seeded from",
    );
    assert.match(stage4, /decision rights/i, "the entry carries the decision-rights section");
    assert.match(stage4, /worker\s*→\s*director\s*→\s*human/, "the ladder is stated");
    assert.match(stage4, /E1[–-]E5/, "the escalation classes are named");
    assert.match(stage4, /decision-policy\.md/, "it points at the installed policy");
    assert.match(
      stage4,
      /never copy|pointer, never a copy|not a copy/i,
      "it writes a pointer, not a second copy of the policy",
    );

    assert.match(stage4, /team contract/i, "the entry carries the team contract");
    for (const marker of [
      "stage_handoff=required",
      "design_stage",
      "product_change=none",
      "review_gate",
      "handoff_consumed_round",
      "handoff_declined_round",
    ]) {
      assert.ok(stage4.includes(marker), `the contract names the marker ${marker}`);
    }
    assert.match(stage4, /supervisor[^.]{0,80}(land|merge|clean)/i, "landing is the supervisor's");
    assert.match(stage4, /reviewer is never routed/i, "the reviewer takes no ordinary card");
    assert.match(
      stage4,
      /index, not a copy|not a copy/i,
      "the contract is an index, not a second copy of the role workflows",
    );
    assert.doesNotMatch(
      stage4,
      /team-roles\.md/,
      "the contract points at the installed role skills, not a removed repository document",
    );

    assert.match(
      skill,
      /second run|re-run|idempoten/i,
      "the entry is stated once, not appended on every run",
    );
    const verify = skill.slice(skill.indexOf("## 7. Verify"));
    assert.match(verify, /task entry/i, "the verify stage checks the entry is stated once");
    assert.match(verify, /team contract/i, "it verifies the team contract landed");
    assert.match(verify, /decision policy|decision-policy/i, "it verifies the director policy exists");

    const team = evals.evals.find((entry) => entry.name === "standard-team");
    assert.ok(
      team.assertions.some((line) => line.includes("/meerkat")),
      "the standard-team eval expects the task entry",
    );
    assert.ok(
      team.assertions.some((line) => line.includes("role.json")),
      "the standard-team eval expects a role.json per installed role skill",
    );
  });


  it("runs the setup interview as one adversarial frontier round", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /## The setup interview/);
    assert.match(skill, /frontier/);
    assert.match(skill, /numbered round/i);
    assert.match(skill, /"yes" accepts/);
    assert.match(skill, /counterexample/i);
    assert.match(skill, /shape none describes goes to \*\*Worker\*\*/i);
    assert.match(skill, /frontier is empty[\s\S]*install/i);
    assert.match(skill, /--yes.*never authorizes/);
  });

  it("asks which work becomes a card and writes the answer into the baseline", () => {
    // A board that accepts every request stops being a signal, and a card costs a claim, a
    // heartbeat, an acceptance and a report. The scope is a setup decision, so the interview
    // must ask it and the baseline must carry the answer.
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const interview = skill.slice(skill.indexOf("## The setup interview"), skill.indexOf("## 2. Install"));

    assert.match(interview, /card scope/i, "the frontier carries the card scope");
    assert.match(interview, /recommended/i, "it is a question with a recommended answer");
    assert.match(interview, /a role owns|role owns/i, "the default is the roles' remit");
    assert.match(interview, /role skills'?\s+shapes|shapes assign/i, "the scope follows the role shapes");
    assert.match(interview, /product design/i, "the default names product design");
    assert.match(interview, /bug fix/i, "the default names bug fixes");
    assert.match(interview, /not every|not everything|does not become|is not a card/i, "routine work stays out");

    const stage4 = skill.slice(skill.indexOf("## 4."), skill.indexOf("## 5."));
    assert.match(stage4, /card scope/i, "the stage requires the scope");
    assert.match(stage4, /a role owns|role owns/i, "the default scopes cards to what a role owns");
    assert.match(stage4, /question|lookup|one-off/i, "the stage names what stays out");
    assert.match(
      skill,
      /rewrite[^\n]*scope|scope[^\n]*rewrite|answer[^\n]*block/i,
      "a non-default answer rewrites the scope, it is not ignored",
    );
    assert.doesNotMatch(
      skill,
      /<!--\s*\/?meerkat:task-entry\s*-->/,
      "no managed block backs the scope",
    );
  });

  it("co-designs a custom team against card shapes", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /counterexample/i);
    assert.match(skill, /card shape/i);
    assert.match(skill, /exactly one\s+accountable role/i);
    assert.match(skill, /reviewer must be\s+independent/i);
    assert.match(skill, /only a human comment resumes/i);
  });

  it("seeds an unassigned card to Worker instead of racing a role", () => {
    // With routing at creation, an unassigned card has no role; claiming it as whichever
    // role scans first would hide the gap. Worker is the default assignee for that card.
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes/, "the documented default is Worker");
    assert.match(skill, /claimed as\s+`Worker`|claimed as `Worker`/i, "the policy is stated, not just the key");
  });

  it("keeps board verbs in the meerkat skill, not in the setup reference", () => {
    const boardVerb = /\bissue (?:create|move|get|update|deliver|heartbeat|assign)\b|\bcomment add\b|\brelation add\b|\battachment (?:download|list)\b/;
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, boardVerb, "SKILL.md must not restate a board verb");
    assert.match(
      text,
      /`meerkat`[^\n]*(board skill|card operation)/i,
      "SKILL.md must point at the meerkat board skill",
    );
  });

  it("distinguishes copying the policy from a project refinement", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /never copy the policy into the project instruction file/i);
    assert.match(skill, /docs\/agents\/decision-policy\.md/, "the refinement path is named");
    assert.match(skill, /refinement/i, "a refinement is not a copy");
  });

  it("ships the role skills as standalone skills, never a team copy", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /five \*\*standalone role skills\*\*|standalone\s+skills/i);
    assert.match(skill, /Installation location is the routing/i);
    assert.match(skill, /no roles\s+root, no manifest/i);
    assert.doesNotMatch(skill, /assets\/team/, "the setup skill ships no team template");
    for (const role of ["jobs", "linus", "turing", "reviewer", "worker"]) {
      assert.ok(existsSync(join(ROOT, "skills", role, "SKILL.md")), `${role} is a standalone skill`);
    }
  });

  it("does not ship a roles/ directory inside the director skill", () => {
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-director", "roles")), false);
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-loop")), false);
  });

  it("keeps the skill-creator eval prompts parseable", () => {
    const evals = JSON.parse(readFileSync(join(SKILL, "evals", "evals.json"), "utf8"));
    assert.equal(evals.skill_name, "setup-meerkat");
    assert.equal(evals.evals.length, 12);
    for (const entry of evals.evals) {
      assert.equal(typeof entry.prompt, "string");
      assert.ok(entry.prompt.length > 20, `eval ${entry.id}: prompt`);
      assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0, `eval ${entry.id}: assertions`);
    }
    const names = new Set(evals.evals.map((entry) => entry.name));
    for (const name of [
      "setup-interview",
      "standard-team",
      "move-role-between-platforms",
      "decision-round",
      "reviewer-catches-omission",
      "card-scope",
      "security-toolchain-belongs-to-linus",
    ]) {
      assert.ok(names.has(name), `eval ${name} must exist`);
    }
  });


  it("mirrors the loop's actor-kind table", () => {
    assert.deepEqual([...LOOP_KINDS].sort(), Object.keys(AGENT_DIRS).sort());
  });

  it("keeps the generated entry free of repository-only pages", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const stage4 = skill.slice(skill.indexOf("## 4."), skill.indexOf("## 5."));
    for (const name of [
      "docs/scheduling.md",
      "docs/lifecycle.md",
      "docs/acceptance.md",
      "docs/sla.md",
      "docs/projects.md",
      "docs/access.md",
      "docs/events.md",
      "docs/README.md",
      "docs/im-integration.md",
      "docs/maintenance/",
      "docs/ops/install.md",
      "docs/ops/observability.md",
      "docs/ops/publishing.md",
      "ARCHITECTURE.md",
    ]) {
      assert.ok(!stage4.includes(name), `stage 4 must not point at ${name}`);
    }
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
    assert.equal(result.body.roles.effective, false);
    assert.equal(result.body.roles.source, null);
    assert.equal(result.body.legacy.length, 0);
    assert.ok(result.body.missing.includes("role-skills"));
    assert.ok(result.body.actions.includes("install-role-skills"));
    assert.deepEqual(tree(home), before.home);
    assert.deepEqual(tree(project), before.project);
  });

  it("reports role skills discovered in each kind's skills tree", (t) => {
    const home = temp(t);
    const project = temp(t);
    const roleDir = join(home, ".claude", "skills", "jobs");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "jobs", agent: "Jobs", lanes: ["worker"] }),
    );
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.roles.source, "skills");
    assert.equal(result.body.roles.effective, true);
    assert.deepEqual(result.body.roles.installedOn.claude, ["Jobs"]);
    assert.equal(result.body.roles.list.length, 1);
    const [role] = result.body.roles.list;
    assert.equal(role.id, "jobs");
    assert.equal(role.agent, "Jobs");
    assert.equal(role.skill, "jobs");
    assert.deepEqual(role.installedOn, ["claude"]);
    assert.equal(role.effective, "claude");
    assert.equal(role.fallback, null);
    assert.equal(result.body.actions.includes("install-role-skills"), false);
  });

  it("reports retired role trees without reading or deleting them", (t) => {
    const home = temp(t);
    const project = temp(t);
    // A retired loop skill, a project roles tree and the retired env pointer.
    mkdirSync(join(home, ".claude", "skills", "meerkat-loop", "roles"), { recursive: true });
    mkdirSync(join(project, ".meerkat", "roles"), { recursive: true });
    const retired = join(project, ".meerkat", "roles");
    const before = tree(retired);
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_ROLES_DIR: retired } },
    );
    assert.equal(result.status, 0, result.stderr);
    const kinds = result.body.legacy.map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ["loop-skill-roles", "project-roles", "roles-dir-env", "skill"]);
    assert.ok(result.body.actions.includes("report-retired-role-trees"));
    assert.match(result.body.warnings.join("\n"), /retired/);
    assert.deepEqual(tree(retired), before, "detection never reads or deletes a retired tree");
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

  it("does not inherit the caller's TASKCTL_HUMAN", (t) => {
    // A developer's shell exports TASKCTL_HUMAN; detection must report the
    // *configured* human (none here), not whoever ran the suite.
    const home = temp(t);
    const project = temp(t);
    const had = Object.hasOwn(process.env, "TASKCTL_HUMAN");
    const previous = process.env.TASKCTL_HUMAN;
    process.env.TASKCTL_HUMAN = "Parent Leak";
    let result;
    try {
      result = runJson(
        t,
        DETECT,
        ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
        { cwd: project, env: { HOME: home, PATH: temp(t) } },
      );
    } finally {
      if (had) process.env.TASKCTL_HUMAN = previous;
      else delete process.env.TASKCTL_HUMAN;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.human.configured, false);
    assert.notEqual(result.body.human.source, "env");
    assert.notEqual(result.body.human.name, "Parent Leak");
  });

  it("reads the human from <program root>/.env.<kind>", (t) => {
    const home = temp(t);
    const project = temp(t);
    // A program root the detector accepts as a checkout.
    mkdirSync(join(project, "src", "cli"), { recursive: true });
    writeFileSync(join(project, "src", "cli", "index.mjs"), "");
    mkdirSync(join(project, "skills"), { recursive: true });
    writeFileSync(join(project, ".env.claude"), "TASKCTL_HUMAN=Sam\n");

    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    // The child's cwd is the physical path (`/private/var/...` on macOS).
    assert.equal(result.body.kindConfig.path, realpathSync(join(project, ".env.claude")));
    assert.equal(result.body.kindConfig.present, true);
    assert.equal(result.body.human.name, "Sam");
    assert.equal(result.body.human.source, "config");
  });

  it("honours MEERKAT_TASKPANEL_CONFIG_DIR", (t) => {
    const home = temp(t);
    const project = temp(t);
    const configDir = temp(t);
    writeFileSync(join(configDir, ".env.codex"), "TASKCTL_HUMAN=Codexer\n");

    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "codex", "--no-network"],
      {
        cwd: project,
        env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: configDir },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.kindConfig.path, join(configDir, ".env.codex"));
    assert.equal(result.body.human.name, "Codexer");
    assert.equal(result.body.human.source, "config");
  });

  it("finds the per-kind config in the installed tree", (t) => {
    const home = temp(t);
    const project = temp(t);
    const tree = join(home, ".meerkat-taskpanel");
    mkdirSync(join(tree, "src", "cli"), { recursive: true });
    writeFileSync(join(tree, "src", "cli", "index.mjs"), "");
    writeFileSync(join(tree, ".env.claude"), "TASKCTL_HUMAN=Tree\n");

    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.kindConfig.source, "installed-tree");
    assert.equal(result.body.kindConfig.path, join(tree, ".env.claude"));
    assert.equal(result.body.human.name, "Tree");
  });

  it("ignores a legacy <agent-dir>/meerkat-taskpanel.env", (t) => {
    const home = temp(t);
    const project = temp(t);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "meerkat-taskpanel.env"), "TASKCTL_HUMAN=Legacy\n");

    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.kindConfig.path, null);
    assert.equal(result.body.human.configured, false);
  });

  it("warns about an unspecified board address", (t) => {
    const home = temp(t);
    const project = temp(t);
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--url", "http://0.0.0.0:19527", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.server.class, "remote");
    assert.match(result.body.warnings.join("\n"), /unspecified address/);
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

  it("reports a missing pi subagent extension, and clears it once installed", (t) => {
    const home = temp(t);
    const project = temp(t);
    const env = { HOME: home, PATH: temp(t) };
    const args = ["--home", home, "--project", project, "--actor-kind", "pi", "--no-network"];

    const missing = runJson(t, DETECT, args, { cwd: project, env });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.body.piSubagents.installed, false);
    assert.match(missing.body.piSubagents.recommended, /pi install npm:pi-subagents/);
    assert.ok(missing.body.missing.includes("pi-subagents"));
    assert.ok(missing.body.actions.includes("install-pi-subagents"));
    assert.match(missing.body.warnings.join("\n"), /pi install npm:pi-subagents/);

    const claude = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "claude", "--no-network"],
      { cwd: project, env },
    );
    assert.equal(claude.body.piSubagents.installed, false);
    assert.equal(claude.body.missing.includes("pi-subagents"), false, "a non-pi host is not blocked");
    assert.equal(claude.body.actions.includes("install-pi-subagents"), false);

    mkdirSync(join(home, ".pi", "agent", "extensions", "subagent"), { recursive: true });
    const present = runJson(t, DETECT, args, { cwd: project, env });
    assert.equal(present.body.piSubagents.installed, true);
    assert.equal(present.body.piSubagents.recommended, null);
    assert.equal(present.body.missing.includes("pi-subagents"), false);
    assert.equal(present.body.actions.includes("install-pi-subagents"), false);
  });

  it("recognises the npm layout `pi install npm:pi-subagents` uses", (t) => {
    // pi 1.x writes the package under ~/.pi/agent/npm/node_modules and does not
    // create ~/.pi/agent/extensions; the legacy-only check reported a working
    // install as missing.
    const home = temp(t);
    const project = temp(t);
    mkdirSync(join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents"), { recursive: true });
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "pi", "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.piSubagents.installed, true);
    assert.equal(result.body.piSubagents.recommended, null);
    assert.equal(result.body.missing.includes("pi-subagents"), false);
    assert.equal(result.body.actions.includes("install-pi-subagents"), false);
  });
});

describe("detect.mjs — platforms and the role→platform proposal", () => {
  /** A home with two ready platforms, their per-kind config and role skills per kind. */
  function twoPlatformHome(t) {
    const home = temp(t);
    const project = temp(t);
    const configDir = temp(t);
    const director = (kind) => {
      const dir = join(home, `.${kind}`, "skills", "meerkat-director");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "# director\n");
    };
    const chat = (kind) => {
      const dir = join(home, `.${kind}`, "skills", "meerkat-chat");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "# chat\n");
    };
    const role = (kind, id, agent, lanes = ["worker"]) => {
      const dir = join(home, `.${kind}`, "skills", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${id}\n`);
      writeFileSync(join(dir, "role.json"), JSON.stringify({ schema: "meerkat-role", id, agent, lanes }));
    };
    director("claude");
    director("codex");
    chat("claude");
    chat("codex");
    role("claude", "jobs", "Jobs");
    role("claude", "linus", "Linus");
    role("claude", "reviewer", "Reviewer", ["reviewer"]);
    role("codex", "turing", "Turing");
    mkdirSync(join(home, ".claude", "skills", "tdd"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "tdd", "SKILL.md"), "# tdd\n");
    mkdirSync(join(home, ".claude", "meerkat-taskpanel"), { recursive: true });
    writeFileSync(
      join(configDir, ".env.claude"),
      "MEERKAT_TASKPANEL_AGENT_KIND_ORDER=claude,codex,pi\n",
    );
    return { home, project, configDir };
  }

  const detectAll = (t, { home, project, configDir }) =>
    runJson(t, DETECT, ["--home", home, "--project", project, "--actor-kind", "all", "--no-network"], {
      cwd: project,
      env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: configDir },
    });

  it("reports per-kind skills, role skills, loop state, supervisor and config", (t) => {
    const fixture = twoPlatformHome(t);
    const result = detectAll(t, fixture);
    assert.equal(result.status, 0, result.stderr);

    const claude = result.body.platforms.claude;
    assert.equal(claude.skills.director, true);
    assert.equal(claude.skills.chat, true, "the human console is part of the bundle");
    assert.ok(claude.skills.names.includes("tdd"), "the installed skill names are reported");
    assert.ok(claude.skills.names.includes("jobs"), "the installed role skill is named");
    assert.equal(claude.loopState.installed, true);
    assert.equal(typeof claude.supervisor.installed, "boolean");
    assert.deepEqual(claude.roles.sort(), ["Jobs", "Linus", "Reviewer"]);
    assert.deepEqual(claude.config.kindOrder, ["claude", "codex", "pi"]);
    assert.equal(claude.config.reviewer, undefined, "the role catalog owns the reviewer");
    assert.equal(claude.available, true);

    assert.deepEqual(result.body.platforms.codex.roles, ["Turing"]);

    assert.deepEqual(result.body.roles.installedOn.claude.sort(), ["Jobs", "Linus", "Reviewer"]);
    assert.deepEqual(result.body.roles.installedOn.codex, ["Turing"]);
    assert.equal(result.body.roles.source, "skills");

    // No director skill on pi, so it cannot host a supervisor.
    assert.equal(result.body.platforms.pi.available, false);
  });

  it("accepts a custom team from an explicit roles directory", (t) => {
    const home = temp(t);
    const project = temp(t);
    const configDir = temp(t);
    const team = join(project, "team");
    const role = join(team, "reviewer");
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, "SKILL.md"), "# reviewer\n");
    writeFileSync(
      join(role, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "reviewer", agent: "Grace", lanes: ["reviewer"] }),
    );
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--actor-kind", "all", "--roles-dir", team, "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: configDir } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.roles.source, "explicit");
    assert.deepEqual(result.body.roles.list.map((entry) => entry.agent), ["Grace"]);
    assert.deepEqual(result.body.roles.installedOn.claude, ["Grace"]);
    assert.equal(result.body.legacy.some((entry) => entry.kind.startsWith("roles-dir")), false);
  });

  it("marks pi available only when its subagent extension is installed", (t) => {
    // Pi's loop cannot spawn a worker without `pi-subagents`, so a platform that cannot
    // run the work is never offered — the same gate the interview relies on.
    const home = temp(t);
    const project = temp(t);
    const configDir = temp(t);
    mkdirSync(join(home, ".agents", "skills", "meerkat-director"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "meerkat-director", "SKILL.md"), "# director\n");
    const args = ["--home", home, "--project", project, "--actor-kind", "all", "--no-network"];
    const env = { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: configDir };

    const without = runJson(t, DETECT, args, { cwd: project, env });
    assert.equal(without.status, 0, without.stderr);
    assert.equal(without.body.platforms.pi.skills.director, true, "the director skill alone is not enough");
    assert.equal(without.body.platforms.pi.available, false);

    mkdirSync(join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents"), { recursive: true });
    const withExtension = runJson(t, DETECT, args, { cwd: project, env });
    assert.equal(withExtension.status, 0, withExtension.stderr);
    assert.equal(withExtension.body.platforms.pi.available, true);
    assert.equal(withExtension.body.platforms.pi.piSubagents.installed, true);
  });

  it("proposes the configured kind order — a proposal, never a write", (t) => {
    const fixture = twoPlatformHome(t);
    const result = detectAll(t, fixture);
    assert.equal(result.status, 0, result.stderr);
    // The default order is claude → codex → pi, and claude covers every tag.
    assert.equal(result.body.rolePlatforms.status, "single");
    assert.deepEqual(result.body.rolePlatforms.byPlatform, {
      claude: ["Jobs", "Linus", "Reviewer", "Turing"],
    });
    // The one-supervisor alternative is always offered alongside.
    assert.equal(result.body.rolePlatforms.singlePlatform, "claude");
  });

  it("honors a configured kind order in the role report and the proposal", (t) => {
    const fixture = twoPlatformHome(t);
    // Move codex ahead of claude in the primary kind's config.
    writeFileSync(
      join(fixture.configDir, ".env.claude"),
      "MEERKAT_TASKPANEL_AGENT_KIND_ORDER=codex,claude,pi\n",
    );
    const result = detectAll(t, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.body.roles.kindOrder, ["codex", "claude", "pi"]);
    // Capabilities still gate: design/architecture stay on claude, while the
    // review/test roles follow the configured codex-first order.
    assert.equal(result.body.rolePlatforms.status, "split");
    assert.deepEqual(result.body.rolePlatforms.byPlatform, {
      codex: ["Reviewer", "Turing"],
      claude: ["Jobs", "Linus"],
    });
    assert.equal(result.body.rolePlatforms.singlePlatform, "claude");
  });

  it("is deterministic and never forces a split: one platform, or none", async () => {
    const { recommendRolePlatforms } = await import("../../skills/setup-meerkat/scripts/detect.mjs");
    const roles = [
      { id: "jobs", agent: "Jobs", lanes: ["worker"] },
      { id: "linus", agent: "Linus", lanes: ["worker"] },
      { id: "turing", agent: "Turing", lanes: ["worker"] },
      { id: "reviewer", agent: "Reviewer", lanes: ["reviewer"] },
    ];
    const caps = {
      claude: ["design", "architecture", "implementation", "tests", "review"],
      codex: ["implementation", "tests", "review"],
      pi: ["implementation", "tests"],
    };

    const single = recommendRolePlatforms(roles, {
      claude: { available: true, capabilities: caps.claude },
      codex: { available: false, capabilities: caps.codex },
      pi: { available: false, capabilities: caps.pi },
    });
    assert.equal(single.status, "single");
    assert.deepEqual(single.byPlatform, { claude: ["Jobs", "Linus", "Turing", "Reviewer"] });

    // pi without pi-subagents is not available, so there is no platform at all.
    const none = recommendRolePlatforms(roles, {
      claude: { available: false, capabilities: caps.claude },
      codex: { available: false, capabilities: caps.codex },
      pi: { available: false, capabilities: caps.pi },
    });
    assert.equal(none.status, "no-platform");

    // A custom role with no known id falls back to its lane, not to a guess.
    const custom = recommendRolePlatforms(
      [{ id: "ops", agent: "Ops", lanes: ["reviewer"] }],
      { claude: { available: true, capabilities: caps.claude }, codex: { available: true, capabilities: caps.codex } },
    );
    assert.equal(custom.assignments[0].platform, "claude");
    assert.deepEqual(custom.assignments[0].tags, ["review"]);
  });

  it("documents the platform question, its cost, and the explicit multi-kind command", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /which kinds carry which role skills/i);
    assert.match(skill, /one supervisor per machine/i);
    assert.match(skill, /--supervisor-actor-kinds/);
    assert.match(skill, /not\s+claimed at all/i, "the cost of a moved role is named");
    assert.match(skill, /decline and keep one\s+platform/i);
  });
});

describe("configure-env.mjs", () => {
  it("preserves comments, is idempotent, and refuses a different value", (t) => {
    const dir = temp(t);
    const file = join(dir, ".env");
    writeFileSync(file, "# keep me\nTASKD_URL=http://localhost:9527\n", "utf8");

    const first = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_CUSTOM", "--value", "Jobs,Linus,Turing"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(file, "utf8"), /# keep me/);
    assert.match(readFileSync(file, "utf8"), /TASKD_URL=http:\/\/localhost:9527/);

    const second = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_CUSTOM", "--value", "Jobs,Linus,Turing"]);
    assert.equal(second.status, 0);
    assert.equal(second.body.action, "unchanged");

    const conflict = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_CUSTOM", "--value", "Alice"]);
    assert.equal(conflict.status, 3);
    assert.equal(conflict.body.action, "conflict");

    const forced = runJson(t, CONFIGURE, ["--file", file, "--key", "MEERKAT_TASKPANEL_CUSTOM", "--value", "Alice", "--force"]);
    assert.equal(forced.status, 0);
    assert.match(readFileSync(file, "utf8"), /MEERKAT_TASKPANEL_CUSTOM=Alice/);
  });
});
