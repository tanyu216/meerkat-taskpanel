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

describe("skill frontmatter and the six-step shape", () => {
  it("is a command-only skill with a substantial description", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\n/);
    assert.match(text, /\nname: setup-meerkat\n/);
    assert.match(text, /\ndisable-model-invocation: true\n/);
    const description = text.match(/\ndescription: ([^\n]+)/)?.[1] ?? "";
    assert.ok(description.length >= 20);
  });

  it("runs six steps in the fixed order, each with its own reference", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /## How a run is structured/);
    const headings = [
      "## 1. Install and upgrade",
      "## 2. Configuration",
      "## 3. The director's project rules",
      "## 4. The board skill's project rules",
      "## 5. Roles across agent platforms",
      "## 6. Create a role",
    ];
    let previous = -1;
    for (const heading of headings) {
      const at = skill.indexOf(heading);
      assert.notEqual(at, -1, `missing ${heading}`);
      assert.ok(at > previous, `${heading} is out of order`);
      previous = at;
    }
    for (const reference of [
      "references/install-upgrade.md",
      "references/config.md",
      "references/director-project.md",
      "references/board-project.md",
      "references/roles-platforms.md",
      "references/new-role.md",
    ]) {
      assert.ok(skill.includes(reference), `the skill points at ${reference}`);
      assert.ok(existsSync(join(SKILL, reference)), `${reference} exists`);
    }
    assert.match(skill, /detection runs once|Detection runs once|Run detection once/i, "detection is once");
    assert.match(skill, /six steps in a fixed order/i, "the run is framed as steps");
    assert.doesNotMatch(skill, /\bsix rounds\b|\brounds? [1-6]\b/i, "setup numbering is steps, not rounds");
    assert.match(skill, /round protocol/i, "the director's decision round protocol is untouched");
    assert.match(skill, /fast path/i, "an already-set-up run can stop early");
  });

  it("asks only real decisions and always asks safety confirmations", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /ask only what is still a decision/i);
    assert.match(skill, /detection is the fact source/i);
    assert.match(skill, /answer changes what\s+happens/i);
    assert.match(skill, /recommended option first/i);
    assert.match(skill, /what\s+will happen and what\s+changes as a result/i);
    assert.match(skill, /language the user is writing in/i);
    assert.match(skill, /follow-up is allowed only when/i);
    assert.match(skill, /safety confirmations are always asked/i);
    assert.match(skill, /starting or enabling the daemon or supervisor/i);
    assert.match(skill, /--force/i);
    assert.match(skill, /skipping is always\s+valid|skipping is always valid|skipped/i);
    assert.doesNotMatch(skill, /every\s+listed question is mandatory/i, "the old floor rule is gone");
    assert.doesNotMatch(skill, /floor, not a ceiling/i, "the old floor rule is gone");
  });

  it("delegates the instruction entry to the init skill once and names no host file", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /Call the `init` skill for/, "the delegation is the direct instruction");
    assert.match(skill, /\/meerkat/, "the entry points card work at the board skill");
    assert.match(skill, /docs\/agents\//, "the entry points board rules at docs/agents");
    assert.match(skill, /card scope/i, "the entry carries the card scope");
    assert.match(
      skill,
      /load the matching role skill[^.]*before the first edit/i,
      "the entry loads the role skill for a task or plan that is not a card",
    );
    assert.match(skill, /call `init` once|call the `init` skill once/i, "one call, not per kind");
    assert.match(skill, /never write an entry yourself|never write an entry/i, "setup never writes it");
    assert.match(skill, /no `init` skill|has no `init` skill/i, "the missing-init path is named");
    assert.match(skill, /report `skip`|reports? `skip`/i, "the missing-init outcome is skip");
  });

  it("keeps the setup prose free of host instruction filenames", () => {
    const files = ["SKILL.md", ...readdirSync(join(SKILL, "references")).map((name) => join("references", name))];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(SKILL, file), "utf8");
      assert.doesNotMatch(text, /CLAUDE\.md|AGENTS\.md/, `${file} names a host instruction file`);
    }
  });

  it("keeps the board verbs in the meerkat skill and names the board skill", () => {
    const boardVerb = /\bissue (?:create|move|get|update|deliver|heartbeat|assign)\b|\bcomment add\b|\brelation add\b|\battachment (?:download|list)\b/;
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, boardVerb, "SKILL.md must not restate a board verb");
    assert.match(text, /`meerkat`[^\n]*(board skill|card operation)/i, "it points at the board skill");
    for (const keyword of ["/meerkat", "card", "claim", "heartbeat", "deliver", "in_review", "done"]) {
      assert.ok(text.includes(keyword), `the skill keeps the keyword ${keyword}`);
    }
    assert.doesNotMatch(text, /<!--\s*\/?meerkat:task-entry\s*-->/, "no managed block");
  });

  it("writes one create-card document and no card-scope file", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const reference = readFileSync(join(SKILL, "references/board-project.md"), "utf8");
    for (const name of ["create-card.md", "issue-tracker.md", "triage-labels.md", "domain.md", "decision-policy.md"]) {
      assert.ok(reference.includes(name), `board-project.md names ${name}`);
    }
    assert.doesNotMatch(
      reference,
      /### `docs\/agents\/(?:acceptance-mode|epic-cards)\.md`/,
      "the retired pair is not a document to write",
    );
    assert.match(reference, /no project default/i, "acceptance has no project default");
    assert.match(reference, /outside the roles is outside the board/i, "the card scope has a rule");
    assert.match(reference, /references\/scenarios\/create\.md/, "the default manual is named");
    assert.match(
      reference,
      /agent-dir>?\/skills\/meerkat\/references\/scenarios\/create\.md/,
      "the installed path is spelled out",
    );
    assert.match(reference, /copies differ/i, "a multi-kind divergence is surfaced");
    assert.match(reference, /only their answers/i, "the page records choices, not a copy");
    assert.match(reference, /earlier (?:run|setup)/i, "an existing project's pair is migrated");
    assert.doesNotMatch(reference, /card-scope\.md/, "card scope is not a separate document");
    assert.match(skill, /docs\/agents\//);
    assert.match(skill, /create-card\.md/);
    assert.doesNotMatch(skill, /acceptance-mode\.md|epic-cards\.md/);
    assert.match(reference, /epic-graphs\.md/, "the optional graph document is offered");
    assert.doesNotMatch(reference, /epic-splitting boundary/i, "the old epic boundary is gone");
    assert.doesNotMatch(skill, /epic-splitting boundary/i, "the setup skill no longer asks for it");
    assert.match(skill, /assets\/epic-graphs\.md/, "the bundled default template is named");
    const asset = readFileSync(join(SKILL, "assets/epic-graphs.md"), "utf8");
    for (const graph of ["dev-verify", "requirement"]) {
      assert.match(asset, new RegExp(`^## ${graph}$`, "m"), `the default template carries ${graph}`);
    }
    for (const stage of ["design", "test-design", "test-exec", "product-acceptance"]) {
      assert.match(asset, new RegExp(`### stage ${stage}`), `requirement carries the ${stage} stage`);
    }
    assert.match(asset, /^Epic mode: auto$/m, "the default template carries the epic mode");
  });

  it("keeps the director policy a pointer, never a copy", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const reference = readFileSync(join(SKILL, "references/director-project.md"), "utf8");
    assert.match(skill, /docs\/agents\/decision-policy\.md/);
    assert.match(skill, /never copy it|never copy/i, "the policy is a pointer");
    assert.match(reference, /E1[–-]E5/);
    assert.match(reference, /only the items the user changed/i, "only changed items are written");
    assert.match(reference, /never the full default table|never a wholesale copy/i);
    assert.match(reference, /never copy the installed/i, "the installed policy is not copied");
  });

  it("routes every work shape to exactly one accountable role", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /exactly one\s+accountable role/i, "one accountable role per shape");
    assert.match(skill, /shape none describes goes to \*\*Worker\*\*/i, "Worker is the fallback");
    assert.match(skill, /reviewer must be\s+independent/i, "the reviewer is independent");
    assert.match(skill, /Outside the roles is outside the board/i, "outside work stays out");
    assert.match(skill, /Installation location is the routing/i, "location is routing");
    assert.match(skill, /no copy of their content/i, "the skill ships no role prose");
  });

  it("documents the platform question, its cost, and the explicit multi-kind command", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /which kinds carry which role skills/i);
    assert.match(skill, /one supervisor per machine/i);
    assert.match(skill, /--supervisor-actor-kinds/);
    assert.match(skill, /not\s+claimed at all/i, "the cost of a moved role is named");
    assert.match(skill, /decline and keep one\s+platform/i);
  });

  it("ships a role template and keeps new roles in installed trees", () => {
    const template = join(SKILL, "assets/role-template");
    const roleJson = JSON.parse(readFileSync(join(template, "role.json"), "utf8"));
    assert.equal(roleJson.schema, "meerkat-role");
    assert.match(roleJson.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assert.ok(Array.isArray(roleJson.shapes) && roleJson.shapes.length > 0);
    assert.match(roleJson.self_check, /^references\/.+\.md$/);
    assert.ok(existsSync(join(template, roleJson.self_check)), "the template's self-check resolves");
    assert.ok(
      typeof roleJson.system_prompt === "string" && roleJson.system_prompt.trim() !== "",
      "the template ships the static card-session board text",
    );
    assert.ok(existsSync(join(template, "references", "reviewer-handoff.md")), "the reviewer sample exists");
    const templateSkill = readFileSync(join(template, "SKILL.md"), "utf8");
    assert.match(templateSkill, /\nname: example\n/);
    assert.doesNotMatch(templateSkill, /disable-model-invocation/);
    const reference = readFileSync(join(SKILL, "references/new-role.md"), "utf8");
    assert.match(reference, /--skills-dir/);
    assert.match(reference, /only into an installed kind's skills tree|installed kind's skills tree/i);
    assert.match(reference, /never the repository's `skills\/`|never the repository/i);
    assert.ok(existsSync(join(SKILL, "scripts/scaffold-role.mjs")));
  });

  it("splits downstream cards from a defect follow-up in the shipped template", () => {
    const template = join(SKILL, "assets/role-template");
    const skill = readFileSync(join(template, "SKILL.md"), "utf8");
    assert.match(skill, /downstream cards come from the director's triage/i);
    assert.match(skill, /defect outside this card is filed by\s+its finder in `backlog`/i);
    assert.match(skill, /meta\.fixes/);
    const roleJson = JSON.parse(readFileSync(join(template, "role.json"), "utf8"));
    const boundaries = roleJson.boundaries.join("\n");
    assert.match(boundaries, /downstream cards in the handoff/i);
    assert.match(boundaries, /backlog/i);
    assert.match(boundaries, /bug-labelled/i);
    assert.match(boundaries, /meta\.fixes/);
    const platforms = readFileSync(join(SKILL, "references/roles-platforms.md"), "utf8");
    assert.match(platforms, /downstream cards come from the\s+director's triage/i);
    assert.match(platforms, /filed by its finder in `backlog`/i);
  });

  it("ships the role skills as standalone skills, never a team copy", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /assets\/team/, "the setup skill ships no team template");
    for (const role of ["jobs", "linus", "turing", "reviewer", "worker"]) {
      assert.ok(existsSync(join(ROOT, "skills", role, "SKILL.md")), `${role} is a standalone skill`);
    }
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-director", "roles")), false);
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-loop")), false);
  });

  it("keeps the flags, the no-autostart probe and the Worker claim default", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    for (const flag of ["--dry-run", "--json", "--project", "--actor-kind", "--checkout", "--home", "--human-name", "--yes"]) {
      assert.ok(skill.includes(flag), `the skill documents ${flag}`);
    }
    assert.match(skill, /TASKD_NO_AUTOSTART=1/, "detection never starts a board");
    assert.match(skill, /MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes/);
    assert.match(skill, /claimed as `Worker`/i, "the unassigned-card policy is stated");
  });

  it("keeps the skill-creator eval prompts parseable", () => {
    const evals = JSON.parse(readFileSync(join(SKILL, "evals", "evals.json"), "utf8"));
    assert.equal(evals.skill_name, "setup-meerkat");
    assert.equal(evals.evals.length, 13);
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
      "init-writes-requirements",
    ]) {
      assert.ok(names.has(name), `eval ${name} must exist`);
    }
    const init = evals.evals.find((entry) => entry.name === "init-writes-requirements");
    const text = init.assertions.join("\n");
    assert.match(text, /CLAUDE\.md|AGENTS\.md/, "the eval names the host instruction file");
    assert.match(text, /\/meerkat/);
    assert.match(text, /docs\/agents\//);
    assert.match(text, /card scope/i);
    assert.match(text, /init/i);
    assert.match(text, /role skill/i, "the eval names the card-less role-skill trigger");

    const interview = evals.evals.find((entry) => entry.name === "setup-interview");
    const interviewText = interview.assertions.join("\n");
    assert.match(interviewText, /reported, not asked|ask only .*decision/i);
    assert.match(interviewText, /recommended option (?:comes )?first/i);
    assert.match(interviewText, /user's language/i);
    assert.match(interviewText, /fast path/i);
    assert.doesNotMatch(interviewText, /mandatory/i, "the interview eval no longer demands every listed question");
    assert.doesNotMatch(interview.expected_output, /six rounds/i);
  });

  it("mirrors the loop's actor-kind table", () => {
    assert.deepEqual([...LOOP_KINDS].sort(), Object.keys(AGENT_DIRS).sort());
  });

  it("keeps every reference free of repository-only pages", () => {
    const files = ["SKILL.md", ...readdirSync(join(SKILL, "references")).map((name) => join("references", name))];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(SKILL, file), "utf8");
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
        assert.ok(!text.includes(name), `${file} must not point at ${name}`);
      }
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

  it("marks pi available from the director skill alone — no extension needed", (t) => {
    // A card session spawns nothing, so Pi needs no subagent extension to run
    // the work; the director skill is the whole gate.
    const home = temp(t);
    const project = temp(t);
    const configDir = temp(t);
    mkdirSync(join(home, ".agents", "skills", "meerkat-director"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "meerkat-director", "SKILL.md"), "# director\n");
    const args = ["--home", home, "--project", project, "--actor-kind", "all", "--no-network"];
    const env = { HOME: home, PATH: temp(t), MEERKAT_TASKPANEL_CONFIG_DIR: configDir };

    const result = runJson(t, DETECT, args, { cwd: project, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.platforms.pi.skills.director, true);
    assert.equal(result.body.platforms.pi.available, true);
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

    // pi is not available either, so there is no platform at all.
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

  it("removes every line for a key and preserves the rest", (t) => {
    const dir = temp(t);
    const file = join(dir, ".env.claude");
    writeFileSync(file, "# keep me\nTASKCTL_HUMAN=Terry\nTASKD_URL=http://wrong\nTASKCTL_HUMAN=Sam\n");
    const dry = runJson(t, CONFIGURE, ["--file", file, "--key", "TASKCTL_HUMAN", "--remove", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.body.action, "removed");
    assert.equal(dry.body.removed, 2);
    assert.equal(dry.body.dry_run, true);
    assert.match(readFileSync(file, "utf8"), /TASKCTL_HUMAN=Sam/, "a dry run writes nothing");

    const removed = runJson(t, CONFIGURE, ["--file", file, "--key", "TASKCTL_HUMAN", "--remove"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.body.action, "removed");
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /TASKCTL_HUMAN/, "every line for the key is gone");
    assert.match(text, /# keep me/);
    assert.match(text, /TASKD_URL=http:\/\/wrong/);

    const again = runJson(t, CONFIGURE, ["--file", file, "--key", "TASKCTL_HUMAN", "--remove"]);
    assert.equal(again.status, 0);
    assert.equal(again.body.action, "unchanged");

    const withValue = runJson(t, CONFIGURE, ["--file", file, "--key", "TASKCTL_HUMAN", "--remove", "--value", "Terry"]);
    assert.equal(withValue.status, 2);

    const set = runJson(t, CONFIGURE, ["--file", file, "--key", "TASKCTL_HUMAN", "--value", "Terry"]);
    assert.equal(set.status, 0);
    assert.equal((readFileSync(file, "utf8").match(/TASKCTL_HUMAN/g) ?? []).length, 1);
  });
});

describe("audit-config.mjs — read-only conflict audit", () => {
  const AUDIT = join(SKILL, "scripts", "audit-config.mjs");
  const auditEnv = (home, root) => ({
    HOME: home,
    MEERKAT_TASKPANEL_CONFIG_DIR: root,
    MEERKAT_TASKPANEL_ENV_FILE: join(root, ".env"),
  });

  it("reports mislaid loop keys, silent duplicates and the token pair without leaking a value", (t) => {
    const home = temp(t);
    const root = join(home, ".meerkat-taskpanel");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, ".env"),
      "TASKD_URL=http://localhost:9527\nMEERKAT_TASKPANEL_CONTINUE=yes\nTASKD_TOKEN=secret-value\nTASKD_TOKEN_FILE=/nope\n",
    );
    writeFileSync(
      join(root, ".env.claude"),
      "TASKD_URL=http://remote:9527\nTASKCTL_HUMAN=Terry\nTASKCTL_HUMAN=Sam\n",
    );
    const result = runJson(t, AUDIT, ["--home", home, "--actor-kind", "claude"], {
      cwd: temp(t),
      env: auditEnv(home, root),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.body, "JSON output");
    const keys = result.body.conflicts.map((entry) => entry.key);
    assert.ok(keys.includes("MEERKAT_TASKPANEL_CONTINUE"), "a loop key in the shared file");
    assert.ok(keys.includes("TASKD_URL"), "a TASKD_ key in the per-kind file");
    assert.ok(keys.includes("TASKCTL_HUMAN"), "the per-kind duplicate");
    assert.ok(keys.includes("TASKD_TOKEN"), "the token pair");
    assert.ok(!result.stdout.includes("secret-value"), "a secret value is never printed");
    assert.ok(result.stdout.includes("<set>") === false, "the conflict report does not echo the value at all");
  });

  it("fails on conflict only when asked", (t) => {
    const home = temp(t);
    const root = join(home, ".meerkat-taskpanel");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".env"), "MEERKAT_TASKPANEL_CONTINUE=yes\n");
    const plain = run(t, AUDIT, ["--home", home, "--json"], { cwd: temp(t), env: auditEnv(home, root) });
    assert.equal(plain.status, 0);
    const strict = run(t, AUDIT, ["--home", home, "--json", "--fail-on-conflict"], { cwd: temp(t), env: auditEnv(home, root) });
    assert.equal(strict.status, 1);
  });

  it("reports a clean layered config as OK", (t) => {
    const home = temp(t);
    const root = join(home, ".meerkat-taskpanel");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".env"), "TASKD_URL=http://localhost:9527\n");
    writeFileSync(join(root, ".env.claude"), "MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes\n");
    const result = runJson(t, AUDIT, ["--home", home, "--actor-kind", "claude"], {
      cwd: temp(t),
      env: auditEnv(home, root),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.body.conflicts, []);
  });

  it("never writes", (t) => {
    const home = temp(t);
    const root = join(home, ".meerkat-taskpanel");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".env"), "TASKD_URL=http://localhost:9527\n");
    const before = tree(home);
    runJson(t, AUDIT, ["--home", home, "--actor-kind", "claude"], { cwd: temp(t), env: auditEnv(home, root) });
    assert.deepEqual(tree(home), before);
  });
});

describe("scaffold-role.mjs — render and validate a role skill", () => {
  const SCAFFOLD = join(SKILL, "scripts", "scaffold-role.mjs");
  const spec = (overrides = {}) => ({
    id: "ops",
    agent: "Ops",
    lane: "worker",
    title: "Operations",
    summary: "Owns operations on a running system.",
    shapes: ["operations on a running system", "release execution after a human decision"],
    responsibilities: ["Run the deployment", "Report the outcome"],
    boundaries: ["Stop at in_review; the acceptance_mode names the closer", "Deliver the committed tree"],
    workflow: [{ title: "Prepare", body: "Read the card." }],
    self_check: ["The gate is green"],
    ...overrides,
  });

  function writeSpec(t, value) {
    const path = join(temp(t), "spec.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it("writes a valid role into an installed skills tree, then reports unchanged", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const file = writeSpec(t, spec());
    const first = runJson(t, SCAFFOLD, ["--spec", file, "--skills-dir", skills, "--json"], { cwd: temp(t), env: { HOME: home } });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.body.status, "written");
    const dir = join(skills, "ops");
    const identity = JSON.parse(readFileSync(join(dir, "role.json"), "utf8"));
    assert.equal(identity.schema, "meerkat-role");
    assert.equal(identity.id, "ops");
    assert.deepEqual(identity.lanes, ["worker"]);
    assert.equal(identity.reviewer_handoff, null);
    assert.ok(existsSync(join(dir, identity.self_check)));
    const generated = readFileSync(join(dir, "SKILL.md"), "utf8");
    assert.match(generated, /\nname: ops\n/);
    assert.doesNotMatch(generated, /disable-model-invocation/);
    for (const heading of ["## Steps at a glance", "## Your work", "## Workflow", "## Hard limits"]) {
      assert.ok(generated.includes(heading), `the generated role has ${heading}`);
    }
    assert.match(readFileSync(join(dir, "references", "workflow.md"), "utf8"), /^# Workflow/m);
    assert.match(readFileSync(join(dir, "references", "self-check.md"), "utf8"), /^# Self-check/m);
    const second = runJson(t, SCAFFOLD, ["--spec", file, "--skills-dir", skills, "--json"], { cwd: temp(t), env: { HOME: home } });
    assert.equal(second.status, 0);
    assert.equal(second.body.status, "unchanged");
  });

  it("carries system_prompt, with a default when the spec omits it", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });

    const explicit = "Read the card first.\nHeartbeat and deliver.";
    const file = writeSpec(t, spec({ system_prompt: explicit }));
    const result = runJson(t, SCAFFOLD, ["--spec", file, "--skills-dir", skills, "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const identity = JSON.parse(readFileSync(join(skills, "ops", "role.json"), "utf8"));
    assert.equal(identity.system_prompt, explicit, "the spec's system_prompt round-trips");

    // The field is optional: a spec without one gets the default board text.
    const bare = writeSpec(t, spec({ id: "bare", agent: "Bare" }));
    const bareResult = runJson(t, SCAFFOLD, ["--spec", bare, "--skills-dir", skills, "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(bareResult.status, 0, bareResult.stderr);
    const bareIdentity = JSON.parse(readFileSync(join(skills, "bare", "role.json"), "utf8"));
    assert.ok(typeof bareIdentity.system_prompt === "string", "the default is written");
    assert.match(bareIdentity.system_prompt, /heartbeat/i);
    assert.match(bareIdentity.system_prompt, /in_review/);
  });

  it("renders the generated Hard limits as positive actions", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const result = runJson(t, SCAFFOLD, ["--spec", writeSpec(t, spec()), "--skills-dir", skills, "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(join(skills, "ops", "SKILL.md"), "utf8");
    const limits = generated.slice(generated.indexOf("## Hard limits"));
    assert.doesNotMatch(limits, /\b(?:do not|don't|never|must not|cannot|can't)\b/i);
    assert.match(limits, /in_review/);
  });

  it("refuses different content without --force and replaces with it", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    runJson(t, SCAFFOLD, ["--spec", writeSpec(t, spec()), "--skills-dir", skills, "--json"], { cwd: temp(t), env: { HOME: home } });
    const changed = writeSpec(t, spec({ summary: "A different summary." }));
    const conflict = runJson(t, SCAFFOLD, ["--spec", changed, "--skills-dir", skills, "--json"], { cwd: temp(t), env: { HOME: home } });
    assert.equal(conflict.status, 3);
    assert.equal(conflict.body.status, "conflict");
    const forced = runJson(t, SCAFFOLD, ["--spec", changed, "--skills-dir", skills, "--force", "--json"], { cwd: temp(t), env: { HOME: home } });
    assert.equal(forced.status, 0);
    assert.equal(forced.body.status, "written");
  });

  it("writes a reviewer handoff and the default-reviewer flag for a reviewer lane", (t) => {
    const home = temp(t);
    const skills = join(home, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    const file = writeSpec(t, spec({ id: "grace", agent: "Grace", lane: "reviewer", default_reviewer: true }));
    const result = runJson(t, SCAFFOLD, ["--spec", file, "--skills-dir", skills, "--json"], { cwd: temp(t), env: { HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    const identity = JSON.parse(readFileSync(join(skills, "grace", "role.json"), "utf8"));
    assert.equal(identity.reviewer_handoff, "references/reviewer-handoff.md");
    assert.equal(identity.default_reviewer, true);
    assert.ok(existsSync(join(skills, "grace", "references", "reviewer-handoff.md")));
  });

  it("rejects a traversal id and a non-reviewer default reviewer", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const traversal = runJson(t, SCAFFOLD, ["--spec", writeSpec(t, spec({ id: "../escape" })), "--skills-dir", skills, "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(traversal.status, 2);
    assert.equal(existsSync(join(home, ".claude", "escape")), false);
    const badReviewer = runJson(t, SCAFFOLD, ["--spec", writeSpec(t, spec({ default_reviewer: true })), "--skills-dir", skills, "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(badReviewer.status, 2);
  });

  it("writes nothing in a dry run", (t) => {
    const home = temp(t);
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const result = runJson(t, SCAFFOLD, ["--spec", writeSpec(t, spec()), "--skills-dir", skills, "--dry-run", "--json"], {
      cwd: temp(t),
      env: { HOME: home },
    });
    assert.equal(result.status, 0);
    assert.equal(result.body.status, "would-write");
    assert.deepEqual(tree(skills), []);
  });
});
