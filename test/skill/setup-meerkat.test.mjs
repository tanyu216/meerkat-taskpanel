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
import { allowedToolsFor } from "../../src/orchestrator/actor-kinds/claude.mjs";
import { baseEnv } from "../helpers/base-env.mjs";
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
      /docs\/agents\//,
      "the stage stands alone — no tracker-integration artifact is required",
    );

    assert.match(
      skill,
      /second run|re-run|idempoten/i,
      "the entry is stated once, not appended on every run",
    );
    const verify = skill.slice(skill.indexOf("## 6. Verify"));
    assert.match(verify, /task entry/i, "the verify stage checks the entry is stated once");

    const team = evals.evals.find((entry) => entry.name === "standard-team");
    assert.ok(
      team.assertions.some((line) => line.includes("/meerkat")),
      "the standard-team eval expects the task entry",
    );
  });

  it("ships the standard team, an ownership guide, and native templates", () => {
    const team = join(SKILL, "assets", "team", "standard");
    for (const rel of [
      "manifest.json",
      "ownership.md",
      "jobs/workflow.md",
      "jobs/ui-workflow.md",
      "jobs/self-check.md",
      "linus/workflow.md",
      "linus/architecture-workflow.md",
      "linus/implementation-workflow.md",
      "linus/refactor-workflow.md",
      "linus/self-check.md",
      "turing/workflow.md",
      "turing/test-design-workflow.md",
      "turing/regression-workflow.md",
      "turing/performance-workflow.md",
      "turing/self-check.md",
      "reviewer/workflow.md",
      "reviewer/self-check.md",
      "reviewer/reviewer-prompt.md",
      "agents/claude/role.md.tmpl",
      "agents/codex/role.toml.tmpl",
      "agents/pi/role.md.tmpl",
    ]) {
      assert.ok(existsSync(join(team, rel)), `${rel} must exist`);
    }
  });

  it("runs a design card as plan → prototype → PRD → self-check → deliver", () => {
    const jobs = join(SKILL, "assets", "team", "standard", "jobs");
    const workflow = readFileSync(join(jobs, "workflow.md"), "utf8");
    const ui = readFileSync(join(jobs, "ui-workflow.md"), "utf8");
    const selfCheck = readFileSync(join(jobs, "self-check.md"), "utf8");

    assert.match(workflow, /ui-workflow\.md/, "the role workflow points at the UI sub-flow");
    assert.match(workflow, /design\/specs\//, "planning artifacts live under design/specs");
    assert.match(workflow, /design\/prototype\//, "prototypes live under design/prototype");
    assert.match(workflow, /design\/prds\//, "PRDs live under design/prds");

    const stages = [
      "### 1. Plan and freeze the direction",
      "### 2. Validate with a prototype",
      "### 3. Write the PRD",
      "### 4. Archive the product artifacts",
      "### 5. Self-check the PRD and the archive",
      "### 6. Deliver",
    ];
    let at = -1;
    for (const stage of stages) {
      const next = workflow.indexOf(stage);
      assert.ok(next > at, `stage must exist in order: ${stage}`);
      at = next;
    }

    assert.match(ui, /3 variants/i, "the sub-flow asks for variants");
    assert.match(ui, /\?variant=/, "variants are switchable by URL");
    assert.match(ui, /screenshot/i, "the sub-flow keeps screenshot evidence");
    assert.match(ui, /design\/prototype\//, "prototype evidence lives under design/prototype");
    assert.match(selfCheck, /design\/prds\//, "the self-check covers the PRD path");
    assert.doesNotMatch(ui, /\bJobs\b/, "the sub-flow must not hard-code the board identity");
  });

  it("routes Linus, Turing and Jobs through their branch workflows", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const linus = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const turing = readFileSync(join(team, "turing", "workflow.md"), "utf8");
    const regression = readFileSync(join(team, "turing", "regression-workflow.md"), "utf8");
    const performance = readFileSync(join(team, "turing", "performance-workflow.md"), "utf8");
    const jobsWorkflow = readFileSync(join(team, "jobs", "workflow.md"), "utf8");
    const jobsCheck = readFileSync(join(team, "jobs", "self-check.md"), "utf8");

    assert.match(linus, /architecture-workflow\.md/, "Linus routes to the architecture branch");
    assert.match(linus, /implementation-workflow\.md/, "Linus routes to the implementation branch");
    assert.match(arch, /pre-commit/i, "the architecture branch records the local gate path");
    assert.match(arch, /pre-push/i, "the architecture branch records pre-push");
    assert.match(arch, /pre-tag/i, "the architecture branch records pre-tag");
    assert.doesNotMatch(arch, /core\.hooksPath|\.githooks\//, "gate mechanics belong to the project");
    assert.match(impl, /failing test|reproduce/i, "implementation starts from a reproduction");
    assert.match(impl, /gates/i, "implementation records the gates");

    assert.match(turing, /test-design-workflow\.md/, "Turing routes to test design");
    assert.match(turing, /regression-workflow\.md/, "Turing routes to regression");
    assert.match(turing, /performance-workflow\.md/, "Turing routes to performance");
    assert.match(performance, /optional|on request|when the card/i, "performance is opt-in");
    assert.match(regression, /production bug/i, "regression covers production bugs");
    assert.match(regression, /before and after|before\/after|pre-fix/i, "regression proves the fix");

    assert.match(jobsWorkflow, /Review ownership/i, "Jobs states who reviews what");
    assert.match(jobsWorkflow, /E3/, "the design direction is an E3 decision");
    for (const section of [
      "Direction check",
      "Prototype check",
      "PRD check",
      "Handoff block and delivery check",
    ]) {
      assert.match(jobsCheck, new RegExp(section), `Jobs self-check has a ${section}`);
    }
  });

  it("designs the system initialization surface before implementation", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const linus = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const check = readFileSync(join(team, "linus", "self-check.md"), "utf8");

    assert.match(arch, /system initialization/i, "the flow is system initialization");
    assert.match(arch, /feature or module design/i, "the flow says what it is not");
    assert.match(arch, /foundation decision/i, "the inclusion test is a foundation decision");
    assert.match(arch, /implementation-workflow\.md/, "out-of-scope cards route to implementation");

    assert.match(arch, /design stance/i, "the design principles are a stance, not a slogan");
    for (const principle of ["simple|simplicity", "reliab", "efficien", "elegan", "over-?engineer"]) {
      assert.match(arch, new RegExp(principle, "i"), `the design stance covers ${principle}`);
    }
    assert.match(
      arch,
      /Design principles[\s\S]{0,400}every agent/i,
      "the agent-instruction baseline carries the principles",
    );

    assert.match(arch, /domain-driven design|DDD/i, "the style decision names DDD");
    assert.match(arch, /bounded context/i, "the style decision names bounded contexts");

    assert.match(arch, /RESTful/, "the API default is RESTful");
    assert.match(arch, /envelope/i, "the API contract designs one envelope");
    for (const key of ["code", "message", "data", "errors"]) {
      assert.match(arch, new RegExp(`"${key}"`), `the envelope carries ${key}`);
    }
    assert.match(arch, /pagination/i, "collections define pagination");
    assert.match(arch, /hot.?reload/i, "the configuration surface defines reload");
    assert.match(arch, /directory tree|directory structure/i, "the tree is planned");
    assert.match(arch, /requirement for every agent/i, "the agent-instruction baseline is required");
    assert.match(arch, /one logging module/i, "logging is one module, not console calls");
    assert.match(
      arch,
      /key flows?[^\n]*\binfo\b/i,
      "key flows must log at info, not by taste",
    );
    assert.match(
      arch,
      /exceptions?[^\n]*\berror\b/i,
      "exceptions must log at error, not by taste",
    );
    const scaffold = arch.slice(arch.indexOf("### 4."), arch.indexOf("### 5."));
    assert.match(scaffold, /^\| Logging \|/m, "the scaffold checklist carries a logging row");
    const init = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    assert.match(init, /logging contract/i, "the agent-instruction baseline carries the logging contract");

    assert.match(linus, /foundation decision/i, "the routing table is foundation-level");
    assert.match(linus, /feature or module/i, "the routing table names the implementation side");

    assert.match(check, /design stance|over-?engineer/i, "the self-check audits the stance");
    assert.match(check, /architecture style|domain-driven/i, "the self-check audits the style");
    assert.match(check, /external contract/i, "the self-check audits the contract");
    assert.match(check, /configuration surface/i, "the self-check audits configuration");
    assert.match(check, /logging/i, "the self-check audits the logging contract");
    assert.match(
      check,
      /key flows?[^\n]*\binfo\b/i,
      "the self-check audits the mandatory info logs",
    );
    assert.match(check, /directory tree/i, "the self-check audits the tree");
    assert.match(check, /agent-instruction baseline/i, "the self-check audits the agent baseline");
    assert.match(
      check,
      /design principles[\s\S]{0,300}every agent/i,
      "the self-check audits the baseline principles",
    );
  });

  it("records a standard technical specification and points the baseline at it", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const check = readFileSync(join(team, "linus", "self-check.md"), "utf8");
    const linus = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const roles = readFileSync(join(SKILL, "references", "roles.md"), "utf8");

    assert.match(
      arch,
      /docs\/tech-spec\.md/,
      "the flow records one standard technical specification",
    );
    const seed = arch.slice(arch.indexOf("### 2."), arch.indexOf("### 3."));
    assert.match(
      seed,
      /docs\/tech-spec\.md/,
      "Step 2 seeds the stack table into the specification",
    );
    const design = arch.slice(arch.indexOf("### 3."), arch.indexOf("### 4."));
    assert.match(
      design,
      /enforcement point/i,
      "every rule names the enforcement that catches a violation",
    );
    assert.match(design, /docs\/tech-spec\.md/, "Step 3 completes the specification");
    const baseline = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    assert.match(
      baseline,
      /docs\/tech-spec\.md[\s\S]{0,600}(point|pointer)/i,
      "the agent-instruction baseline points at the specification",
    );
    assert.match(check, /docs\/tech-spec\.md/, "the self-check audits the specification");
    assert.match(
      check,
      /enforcement point/i,
      "the self-check audits the enforcement points",
    );
    assert.match(
      linus,
      /inherited[\s\S]{0,80}docs\/tech-spec\.md/i,
      "a feature card inherits the stack from the specification",
    );
    assert.match(roles, /docs\/tech-spec\.md/, "the engineering reference names the specification");
  });

  it("applies the six design principles to a feature change", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const check = readFileSync(join(team, "linus", "self-check.md"), "utf8");
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const roles = readFileSync(join(SKILL, "references", "roles.md"), "utf8");
    const manifest = readFileSync(join(team, "manifest.json"), "utf8");

    const stance = arch.slice(arch.indexOf("## Design stance"), arch.indexOf("## When this flow applies"));
    const step2 = impl.slice(impl.indexOf("### 2."), impl.indexOf("### 3."));
    const implCheck = check.slice(check.indexOf("## Implementation branch"), check.indexOf("## Delivery"));

    assert.match(stance, /Six principles/i, "the stance names six principles");
    assert.match(stance, /High cohesion, low coupling/i, "the stance carries the sixth principle");
    assert.match(stance, /boundary is not traded for speed/i, "the sixth has its own conflict rule");

    for (const principle of [
      "simple|simplicity", "reliab", "efficien", "elegan", "over-?engineer",
      "high cohesion", "low coupling",
    ]) {
      assert.match(step2, new RegExp(principle, "i"), `Step 2 applies ${principle}`);
    }
    assert.match(step2, /one reason to change/i, "cohesion has a testable form");
    assert.match(step2, /recorded decision|silent drift/i, "a departure is recorded");
    assert.match(step2, /docs\/architecture\.md/, "Step 2 points at the canonical definitions");

    assert.match(implCheck, /six design principles/i, "the implementation self-check audits the principles");
    assert.match(implCheck, /one reason to change/i, "the implementation self-check audits cohesion");

    for (const [name, text] of [
      ["SKILL.md", skill], ["roles.md", roles], ["manifest.json", manifest],
      ["self-check.md", check], ["architecture-workflow.md", arch],
    ]) {
      assert.doesNotMatch(text, /\bfive (design )?principles\b/i, `${name} must not still say five principles`);
    }
    for (const [name, text] of [["SKILL.md", skill], ["roles.md", roles], ["manifest.json", manifest]]) {
      assert.match(text, /high cohesion/i, `${name} names the sixth principle`);
    }
  });

  it("carries the decision method, split glossaries and the agent baseline", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const jobs = readFileSync(join(team, "jobs", "workflow.md"), "utf8");
    const ui = readFileSync(join(team, "jobs", "ui-workflow.md"), "utf8");
    const jobsCheck = readFileSync(join(team, "jobs", "self-check.md"), "utf8");
    const linus = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const turing = readFileSync(join(team, "turing", "workflow.md"), "utf8");
    const testPlan = readFileSync(join(team, "turing", "test-design-workflow.md"), "utf8");

    for (const [name, text] of [["Jobs", jobs], ["Linus", linus], ["Turing", turing]]) {
      assert.match(text, /Decide before you build/, `${name} carries the decision method`);
      assert.match(text, /frontier/i, `${name} names the frontier`);
    }

    assert.match(jobs, /design\/glossary\.md/);
    assert.match(jobs, /design\/adr\//);
    assert.match(jobs, /## Terminology/);

    assert.match(ui, /## Modes/);
    assert.match(ui, /### Standalone mode/);
    assert.match(ui, /design\/specs\/<content-slug>\.md/);
    assert.match(ui, /on demand|only when/i);

    assert.match(jobs, /\.meerkat\/<id>\/spec\.md/, "the working spec stays in the card");
    assert.match(jobs, /### 4\. Archive the product artifacts/, "archiving is a stage");
    assert.match(jobs, /<content-slug>/, "design filenames use a content slug");
    assert.match(jobsCheck, /Archive check/, "the self-check covers the archive");

    assert.match(linus, /## Product language/);
    assert.match(linus, /design\/glossary\.md/);
    assert.match(arch, /AGENTS\.md/);
    assert.match(arch, /CLAUDE\.md/);
    assert.match(arch, /agent-instruction baseline/i);
    assert.match(arch, /project session/i, "integration stays with the project session");
    const refactor = readFileSync(join(team, "linus", "refactor-workflow.md"), "utf8");
    for (const [name, text] of [
      ["Jobs", jobs],
      ["Linus", linus],
      ["Turing", turing],
      ["architecture", arch],
      ["implementation", impl],
      ["refactor", refactor],
    ]) {
      assert.doesNotMatch(text, /worktree|integration branch/i, `${name} leaves project mechanics to the project`);
    }

    assert.match(turing, /GLOSSARY\.md|canonical term/);
    assert.match(testPlan, /decision round|frontier/i);
    assert.match(jobsCheck, /Standalone mode/);
  });

  it("makes the loop policy the single home of the round protocol", () => {
    const loopPolicy = readFileSync(
      join(ROOT, "skills", "meerkat-loop", "references", "decision-policy.md"),
      "utf8",
    );
    assert.match(loopPolicy, /## Decision rounds/);
    assert.match(loopPolicy, /frontier/);
    assert.match(loopPolicy, /so "yes" accepts/i);
    assert.match(loopPolicy, /Facts are the asker's job/i);

    const team = join(SKILL, "assets", "team", "standard");
    let protocolCopies = 0;
    for (const rel of [
      "ownership.md",
      "jobs/workflow.md",
      "linus/workflow.md",
      "turing/workflow.md",
    ]) {
      protocolCopies += (readFileSync(join(team, rel), "utf8").match(/Draw the decision tree/g) ?? [])
        .length;
    }
    assert.equal(protocolCopies, 0, "the six-step protocol lives only in the loop policy");

    for (const rel of ["jobs/workflow.md", "linus/workflow.md", "turing/workflow.md"]) {
      const workflow = readFileSync(join(team, rel), "utf8");
      assert.match(workflow, /Decide before you build/);
      assert.match(workflow, /frontier/i);
      assert.match(workflow, /decision-policy\.md/);
    }
  });

  it("keeps project mechanics out of the role files", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const files = [
      "ownership.md",
      "manifest.json",
      "jobs/workflow.md",
      "jobs/ui-workflow.md",
      "jobs/self-check.md",
      "linus/workflow.md",
      "linus/architecture-workflow.md",
      "linus/implementation-workflow.md",
      "linus/refactor-workflow.md",
      "linus/self-check.md",
      "turing/workflow.md",
      "turing/test-design-workflow.md",
      "turing/regression-workflow.md",
      "turing/performance-workflow.md",
      "turing/self-check.md",
      "reviewer/workflow.md",
      "reviewer/self-check.md",
      "reviewer/reviewer-prompt.md",
    ];
    const banned = /\bgit (?:worktree|merge|branch|checkout)\b|--no-ff|branch -d|\btaskctl\b|\bissue (?:create|move|get|update|deliver|heartbeat|assign)\b|\bcomment add\b|\brelation add\b|\battachment (?:download|list)\b|`\/init`|\bnpm run\b|\bdocker\b|\bpodman\b|\bsystemctl\b|\blaunchctl\b|\bcore\.hooksPath\b/;
    for (const rel of files) {
      const text = readFileSync(join(team, rel), "utf8");
      assert.doesNotMatch(text, banned, `${rel} must describe the task process, not project mechanics`);
    }
  });

  it("points every card-operation passage at the meerkat board skill", () => {
    // The role files are read by workers that may never see the board skill in a skill
    // list. A pointer that names it — and where it is installed — is what makes the
    // delegation executable under every actor kind, including codex and pi.
    const team = join(SKILL, "assets", "team", "standard");
    const files = [
      "jobs/workflow.md",
      "jobs/ui-workflow.md",
      "jobs/self-check.md",
      "linus/workflow.md",
      "linus/architecture-workflow.md",
      "linus/implementation-workflow.md",
      "linus/refactor-workflow.md",
      "linus/self-check.md",
      "turing/workflow.md",
      "turing/test-design-workflow.md",
      "turing/regression-workflow.md",
      "turing/performance-workflow.md",
      "turing/self-check.md",
      "reviewer/workflow.md",
      "reviewer/reviewer-prompt.md",
    ];
    for (const rel of files) {
      const text = readFileSync(join(team, rel), "utf8");
      if (!/card\.md|acceptance|deliver|claim|heartbeat|brief/i.test(text)) continue;
      assert.match(
        text,
        /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
        `${rel} mentions a card operation but does not point at the meerkat board skill`,
      );
    }
  });

  it("leaves the task entry to the install, not to the architecture flow", () => {
    // One writer per surface. The install writes the entry and its scope; the architecture
    // flow that also ran an init step used to duplicate it, and two writers drift.
    const team = join(SKILL, "assets", "team", "standard");
    const arch = readFileSync(join(team, "linus", "architecture-workflow.md"), "utf8");
    const check = readFileSync(join(team, "linus", "self-check.md"), "utf8");
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");

    const step5 = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    const step7 = arch.slice(arch.indexOf("### 7."), arch.indexOf("### 8."));

    assert.match(step5, /install\s+skill/i, "it says whose job the task entry is");
    assert.doesNotMatch(step5, /\*\*Task entry\*\*/, "the entry is not a baseline item here");

    assert.doesNotMatch(step7, /`\/meerkat`/, "the architecture self-check does not audit the entry");
    assert.doesNotMatch(check, /`\/meerkat`/, "Linus's self-check does not audit the entry");
    assert.doesNotMatch(check, /task\s+entry/i, "Linus's self-check leaves the entry to the install");

    const stage4 = skill.slice(skill.indexOf("## 4."), skill.indexOf("## 5."));
    assert.doesNotMatch(skill, /<!--\s*\/?meerkat:task-entry\s*-->/, "the install ships no block");
    for (const keyword of ["/meerkat", "card", "claim", "heartbeat", "deliver", "in_review", "done"]) {
      assert.ok(stage4.includes(keyword), `the install keeps the keyword ${keyword}`);
    }
  });

  it("keeps board verbs in the meerkat skill, not in the setup reference", () => {
    const boardVerb = /\bissue (?:create|move|get|update|deliver|heartbeat|assign)\b|\bcomment add\b|\brelation add\b|\battachment (?:download|list)\b/;
    for (const rel of ["SKILL.md", "references/roles.md"]) {
      const text = readFileSync(join(SKILL, rel), "utf8");
      assert.doesNotMatch(text, boardVerb, `${rel} must not restate a board verb`);
      assert.match(
        text,
        /`meerkat`[^\n]*(board skill|card operation)/i,
        `${rel} must point at the meerkat board skill`,
      );
    }
  });

  it("ships an ownership routing guide, not a duplicated policy", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const guide = readFileSync(join(team, "ownership.md"), "utf8");

    for (const shape of [
      /product planning/i,
      /prototype/i,
      /system architecture/i,
      /implementation/i,
      /test design/i,
      /regression/i,
      /performance/i,
      /independent review/i,
    ]) {
      assert.match(guide, shape, "every work shape must be routed");
    }
    for (const workflow of [
      "jobs/workflow.md",
      "jobs/ui-workflow.md",
      "linus/architecture-workflow.md",
      "linus/implementation-workflow.md",
      "turing/test-design-workflow.md",
      "turing/regression-workflow.md",
      "turing/performance-workflow.md",
      "reviewer/workflow.md",
    ]) {
      assert.ok(guide.includes(workflow), `${workflow} must be routed`);
    }

    assert.match(guide, /one accountable role/i);
    assert.match(guide, /reviewer is independent/i);
    assert.match(guide, /assignee still selects/i);
    assert.doesNotMatch(guide, /## Decision rounds|\bE1\b|\bE5\b|awaiting|frontier/i);
    assert.equal(existsSync(join(team, "decision-policy.md")), false, "the team ships no policy copy");
  });

  it("keeps operations out of Linus and routes work the roles do not own", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const guide = readFileSync(join(team, "ownership.md"), "utf8");
    const workflow = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const implementation = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const selfCheck = readFileSync(join(team, "linus", "self-check.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(team, "manifest.json"), "utf8"));
    const linus = manifest.roles.find((role) => role.id === "linus");
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const policy = readFileSync(
      join(ROOT, "skills", "meerkat-loop", "references", "decision-policy.md"),
      "utf8",
    );

    assert.doesNotMatch(
      workflow.split("\n")[0],
      /\boperations\b/i,
      "the role title does not claim operations",
    );
    assert.doesNotMatch(linus.summary, /\boperations\b/i, "the agent description drops operations");
    assert.doesNotMatch(implementation, /^### \d+\. Operations/m, "no operations step");
    assert.match(
      workflow,
      /not architecture, implementation, refactoring or a bug fix/i,
      "the boundary is stated",
    );
    assert.match(
      workflow,
      /operations on a running system goes outside the roles/i,
      "operations is routed out of the role",
    );

    assert.match(workflow, /refactor-workflow\.md/, "the role routes the refactor branch");
    assert.match(guide, /refactor-workflow\.md/, "the routing guide names the refactor branch");
    assert.match(selfCheck, /## Refactor branch/, "the self-check covers refactoring");

    assert.match(guide, /outside\s+the\s+roles/i, "a shape outside the rows is not force-fit");
    const implementationRow = guide
      .split("\n")
      .find((line) => line.includes("implementation-workflow.md"));
    assert.ok(implementationRow, "the implementation row exists");
    assert.doesNotMatch(implementationRow, /\boperations\b/i, "operations is not routed to Linus");
    assert.ok(guide.trim().length <= 2500, "the guide fits the project-session prompt budget");
    assert.match(skill, /outside\s+the\s+roles/i, "the setup interview allows an outside worker");
    assert.match(policy, /outside\s+the\s+roles/i, "the decision policy allows an outside worker");
  });

  it("keeps every command the reviewer is told to run inside its lane allowlist", () => {
    // A rule the lane cannot execute is a rule the reviewer learns to skip. If
    // the assets tell the reviewer to run a kind of command, the lane must
    // permit that kind.
    const team = join(SKILL, "assets", "team", "standard");
    const allow = allowedToolsFor("reviewer");
    for (const file of ["reviewer/workflow.md", "reviewer/reviewer-prompt.md"]) {
      const text = readFileSync(join(team, file), "utf8");
      for (const [kind, pattern] of [
        ["Bash(npm run *)", /\bnpm run\b/],
        ["Bash(node *)", /\bnode --?test\b|\bnode [\w./-]+\.mjs\b/],
        ["Bash(git *)", /\bgit (?:show|diff|status|log)\b/],
      ]) {
        if (!pattern.test(text)) continue;
        assert.ok(
          allow.includes(kind),
          `${file} tells the reviewer to run a ${kind} command, but the reviewer lane lacks it`,
        );
      }
    }
  });

  it("makes every self-check say what counts as proof and what may not be a leftover", () => {
    const team = join(SKILL, "assets", "team", "standard");
    for (const role of ["jobs", "linus", "turing"]) {
      const check = readFileSync(join(team, role, "self-check.md"), "utf8");
      assert.match(check, /falsifiable/i, `${role} requires falsifiable evidence`);
      assert.match(check, /not_applicable/, `${role} names the not_applicable disposition`);
      assert.match(check, /\bowner\b/i, `${role} makes a leftover name its owner`);
      assert.match(check, /never a leftover/i, `${role} lists what may not be a leftover`);
    }

    for (const role of ["linus", "turing"]) {
      const check = readFileSync(join(team, role, "self-check.md"), "utf8");
      assert.match(check, /every branch/i, `${role} covers every branch`);
      assert.doesNotMatch(check, /apply to both/i, `${role}: three branches, not two`);
    }

    const reviewer = readFileSync(join(team, "reviewer", "workflow.md"), "utf8");
    assert.match(
      reviewer,
      /outside the frozen acceptance/i,
      "the reviewer accepts a leftover only outside the acceptance",
    );
    assert.match(reviewer, /never a leftover|not a leftover/i, "a missing item is not a leftover");
    // The prompt is the copy that is inlined into the reviewer's first context;
    // a doctrine that lives only in the workflow path is a doctrine the reviewer
    // may never read.
    assert.match(reviewer, /falsifiable/i, "the reviewer workflow says what counts as proof");
    const prompt = readFileSync(join(team, "reviewer", "reviewer-prompt.md"), "utf8");
    assert.match(prompt, /falsifiable/i, "the inlined reviewer prompt says what counts as proof");
    assert.match(prompt, /evidence\[n\]/, "the inlined prompt names the anchor reference");

    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    assert.match(
      impl,
      /\(Implementation branch\)/,
      "the implementation workflow names its self-check section",
    );
  });

  it("reads the design artifacts on a feature path, not on a bug path", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const testDesign = readFileSync(join(team, "turing", "test-design-workflow.md"), "utf8");
    const regression = readFileSync(join(team, "turing", "regression-workflow.md"), "utf8");

    assert.match(impl, /for a feature or behaviour change,[\s\S]*archived spec/, "a feature reads the design artifacts");
    assert.match(impl, /bug fix does not\s+need the design artifacts/, "a bug does not need them");
    assert.match(testDesign, /for a feature or behaviour change,[\s\S]*archived spec/, "test design reads them for a feature");
    assert.match(regression, /are not inputs here/, "regression verifies the defect, not the design");
  });

  it("triages the card shape and hands off design outputs explicitly", () => {
    const team = join(SKILL, "assets", "team", "standard");
    const jobs = readFileSync(join(team, "jobs", "workflow.md"), "utf8");
    const jobsCheck = readFileSync(join(team, "jobs", "self-check.md"), "utf8");
    const linus = readFileSync(join(team, "linus", "workflow.md"), "utf8");
    const linusCheck = readFileSync(join(team, "linus", "self-check.md"), "utf8");
    const impl = readFileSync(join(team, "linus", "implementation-workflow.md"), "utf8");
    const turing = readFileSync(join(team, "turing", "workflow.md"), "utf8");
    const testDesign = readFileSync(join(team, "turing", "test-design-workflow.md"), "utf8");
    const regression = readFileSync(join(team, "turing", "regression-workflow.md"), "utf8");
    const turingCheck = readFileSync(join(team, "turing", "self-check.md"), "utf8");
    const reviewer = readFileSync(join(team, "reviewer", "workflow.md"), "utf8");
    const prompt = readFileSync(join(team, "reviewer", "reviewer-prompt.md"), "utf8");
    const roles = readFileSync(join(SKILL, "references", "roles.md"), "utf8");
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const ownership = readFileSync(join(team, "ownership.md"), "utf8");

    assert.match(jobs, /## Handoff/);
    assert.match(jobs, /design\/specs\/<content-slug>\.md/);
    assert.match(jobs, /design\/prototype\/<content-slug>\//);
    assert.match(jobs, /design\/prds\/<content-slug>\.md/);
    assert.match(jobs, /Acceptance source/i);
    assert.match(jobs, /Delivery shape/i);
    assert.match(jobs, /epic/i);
    assert.match(jobs, /children/i);
    assert.match(jobs, /stage_handoff/);
    assert.match(jobs, /product_change=none/);
    assert.match(jobs, /project session/i);
    assert.match(jobs, /references\/roles\.md/, "the create sequence stays in references/roles.md");
    assert.match(jobs, /Card and plan lifecycle/, "the project session owns the triage lifecycle");
    assert.match(jobs, /do not create .*downstream card/i);
    assert.doesNotMatch(jobs, /five stages/i);
    assert.doesNotMatch(jobs, /inherit or extend/i);

    assert.match(jobsCheck, /## Handoff/);
    assert.match(jobsCheck, /Acceptance source/i);
    assert.match(jobsCheck, /Delivery shape/i);
    assert.match(jobsCheck, /proposed/i);

    for (const [name, text] of [["Linus", linus], ["Turing", turing]]) {
      assert.match(text, /own plan|this card's plan/i, `${name} writes its own plan`);
      assert.match(text, /## Handoff/, `${name} reads the handoff block`);
      assert.doesNotMatch(text, /inherit or extend/i, `${name} does not inherit another card's plan`);
    }
    assert.match(linus, /product_change=none/i);
    assert.match(linus, /design_stage/);
    assert.match(impl, /## Handoff/);
    assert.match(impl, /does not\s+need the design artifacts/i);
    assert.match(testDesign, /## Handoff/);
    assert.match(testDesign, /named report/i);
    assert.match(regression, /not inputs here/);
    assert.match(turing, /test-plan\.md/);
    assert.match(turing, /API/i);
    assert.match(turing, /browser/i);
    assert.match(testDesign, /API/);
    assert.match(testDesign, /browser/i);
    assert.match(regression, /API|browser/i);

    // The reviewer's contract is a procedure, not a gate list: the gate is the
    // project's (`review_gate`), and what the role owns is the ledger, the
    // delivered sha, the anchor behind each claim and the earlier findings.
    for (const [name, text] of [["workflow", reviewer], ["prompt", prompt]]) {
      assert.match(text, /## Handoff/, `${name} reads the handoff`);
      assert.match(text, /design_stage|stage_handoff/, `${name} triages the stage`);
      assert.match(text, /product_change/, `${name} reads the triage marker`);
      assert.match(text, /ledger/i, `${name} builds the requirement ledger`);
      assert.match(text, /commit|sha/i, `${name} verifies the delivered commit`);
      assert.match(text, /earlier round|prior finding|earlier finding/i, `${name} re-checks earlier findings`);
      assert.match(text, /declared gate|none declared/i, `${name} runs the project's gate`);
      assert.match(text, /falsifiable/i, `${name} says what counts as proof`);
      assert.match(text, /evidence\[n\]/, `${name} requires an anchor reference`);
      assert.match(text, /REJECT/);
      assert.match(text, /not_met/, `${name} refuses to call the unverifiable a pass`);
    }
    assert.match(reviewer, /rollup/i);
    assert.match(reviewer, /epic/i);
    assert.match(reviewer, /snapshot/i);
    assert.match(reviewer, /generic items/i);
    assert.match(prompt, /snapshot/i);
    assert.match(prompt, /generic items/i);
    assert.match(reviewer, /CWE Top 25/i);
    assert.match(reviewer, /OWASP Top 10/i);
    assert.match(reviewer, /OWASP ASVS/i);
    assert.doesNotMatch(reviewer, /archived product artifacts named in .*plan\.md/i);
    for (const text of [linusCheck, turingCheck]) {
      assert.match(text, /100%/);
      assert.match(text, /80%/);
      assert.match(text, /websocket/);
      assert.match(text, /internal/i);
      assert.match(text, /security scan/i);
      assert.match(text, /API|browser/i);
    }

    assert.match(roles, /Card and plan lifecycle/);
    assert.match(roles, /Test execution vs review gate/);
    assert.match(roles, /product_change/);
    assert.match(roles, /epic/);
    assert.match(roles, /`meerkat`[^\n]*(board skill|card operation)/i, "card actions delegate to the board skill");
    assert.doesNotMatch(roles, /relation add/, "the relation command lives in the board skill");
    assert.match(roles, /CWE Top 25|OWASP ASVS/);
    assert.match(roles, /API|browser/i);
    const manifest = JSON.parse(readFileSync(join(team, "manifest.json"), "utf8"));
    assert.ok(
      manifest.roles.find((role) => role.id === "turing")
        .responsibilities.some((line) => /API|browser/i.test(line)),
      "Turing owns API and browser tests",
    );
    assert.ok(
      manifest.roles.find((role) => role.id === "reviewer")
        .responsibilities.some((line) => /CWE Top 25|OWASP/i.test(line)),
      "the reviewer audits the security standards",
    );
    const reviewerRole = manifest.roles.find((role) => role.id === "reviewer");
    assert.equal(reviewerRole.self_check, "reviewer/self-check.md", "the reviewer has a pre-verdict audit");
    assert.ok(
      existsSync(join(team, "reviewer", "self-check.md")),
      "the reviewer self-check file exists",
    );
    assert.ok(
      reviewerRole.responsibilities.some((line) => /ledger/i.test(line)),
      "the reviewer builds the requirement ledger",
    );
    assert.match(skill, /## Handoff/);
    assert.match(skill, /triage/i);
    assert.match(skill, /epic/i);
    assert.match(skill, /100%/);
    assert.match(ownership, /split/i);
    assert.match(ownership, /project session/i);
  });

  it("names the pre-delivery audit and ends every worker flow in Deliver", () => {
    const team = join(SKILL, "assets", "team", "standard");
    for (const role of ["jobs", "linus", "turing"]) {
      const check = readFileSync(join(team, role, "self-check.md"), "utf8");
      assert.match(check, /pre-delivery audit/, `${role} self-check names the audit`);
      assert.match(check, /not\s+the `## Handoff` block/, `${role} self-check is not the handoff`);
      assert.match(check, /re-export/i, `${role} self-check re-exports the brief`);
      assert.match(check, /card\.md/, `${role} self-check names the brief`);
    }

    for (const [file, heading] of [
      ["linus/architecture-workflow.md", "### 9. Deliver"],
      ["linus/implementation-workflow.md", "### 7. Deliver"],
      ["linus/refactor-workflow.md", "### 7. Deliver"],
      ["turing/test-design-workflow.md", "### 9. Deliver"],
      ["turing/regression-workflow.md", "### 7. Deliver"],
      ["turing/performance-workflow.md", "### 7. Deliver"],
    ]) {
      const text = readFileSync(join(team, file), "utf8");
      assert.ok(text.includes(heading), `${file} must end in ${heading}`);
    }

    const testDesign = readFileSync(join(team, "turing", "test-design-workflow.md"), "utf8");
    assert.doesNotMatch(testDesign, /^### 4\. Self-check/m, "step 4 is a plan check, not the self-check");

    const prompt = readFileSync(join(team, "reviewer", "reviewer-prompt.md"));
    assert.ok(prompt.length <= 2400, "the reviewer prompt must fit its 2,400-character inline budget");
  });

  it("runs the setup interview as one adversarial frontier round", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.match(skill, /## The setup interview/);
    assert.match(skill, /frontier/);
    assert.match(skill, /numbered round/i);
    assert.match(skill, /"yes" accepts/);
    assert.match(skill, /counterexample/i);
    assert.match(skill, /unowned card shape/i);
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
    assert.match(interview, /ownership/i, "the scope follows the ownership matrix");
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
    const roles = readFileSync(join(SKILL, "references", "roles.md"), "utf8");
    assert.match(roles, /counterexample/i);
    assert.match(roles, /card shape/i);
    assert.match(roles, /exactly one accountable role/i);
    assert.match(roles, /independent reviewer/i);
    assert.match(roles, /subagent → main session → human|only a human comment resumes/i);
  });

  it("does not ship a roles/ directory inside the loop skill", () => {
    assert.equal(existsSync(join(ROOT, "skills", "meerkat-loop", "roles")), false);
  });

  it("keeps the skill-creator eval prompts parseable", () => {
    const evals = JSON.parse(readFileSync(join(SKILL, "evals", "evals.json"), "utf8"));
    assert.equal(evals.skill_name, "setup-meerkat");
    assert.equal(evals.evals.length, 11);
    for (const entry of evals.evals) {
      assert.equal(typeof entry.prompt, "string");
      assert.ok(entry.prompt.length > 20, `eval ${entry.id}: prompt`);
      assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0, `eval ${entry.id}: assertions`);
    }
    const names = new Set(evals.evals.map((entry) => entry.name));
    for (const name of [
      "setup-interview",
      "custom-team-co-design",
      "decision-round",
      "reviewer-catches-omission",
      "card-scope",
    ]) {
      assert.ok(names.has(name), `eval ${name} must exist`);
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
    assert.equal(result.body.roles.effective, null);
    assert.ok(result.body.actions.includes("install-roles"));
    assert.deepEqual(tree(home), before.home);
    assert.deepEqual(tree(project), before.project);
  });

  it("reports the effective roles root", (t) => {
    const home = temp(t);
    const project = temp(t);
    const roles = join(project, ".meerkat", "roles");
    mkdirSync(roles, { recursive: true });
    writeFileSync(
      join(roles, "manifest.json"),
      JSON.stringify({
        version: 1,
        roles: [{ id: "jobs", agent: "Jobs", lanes: ["worker"] }],
      }),
    );
    const result = runJson(
      t,
      DETECT,
      ["--home", home, "--project", project, "--no-network"],
      { cwd: project, env: { HOME: home, PATH: temp(t) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.roles.effective.source, "project");
    assert.equal(result.body.roles.effective.roles, 1);
    assert.equal(result.body.actions.includes("install-roles"), false);
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
    assert.ok(
      existsSync(join(project, ".meerkat", "roles", "ownership.md")),
      "the routing guide ships with the team",
    );
    assert.equal(existsSync(join(project, ".meerkat", "roles", "decision-policy.md")), false);
    assert.ok(existsSync(join(project, ".claude", "agents", "jobs.md")));
    assert.ok(existsSync(join(project, ".codex", "agents", "reviewer.toml")));
    assert.ok(
      existsSync(join(project, ".meerkat", "roles", "jobs", "ui-workflow.md")),
      "the UI sub-flow ships with the role",
    );
    assert.ok(
      existsSync(join(project, ".meerkat", "roles", "linus", "architecture-workflow.md")),
      "the Linus architecture branch ships",
    );
    assert.ok(
      existsSync(join(project, ".meerkat", "roles", "turing", "performance-workflow.md")),
      "the Turing performance branch ships",
    );

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

    const piWorker = readFileSync(join(project, ".pi", "agents", "jobs.md"), "utf8");
    assert.match(piWorker, /^name: jobs$/m);
    assert.match(piWorker, /^tools: read, grep, find, ls, bash, edit, write$/m);
    assert.match(piWorker, /\.meerkat\/roles\/jobs\/workflow\.md/);
    const piReviewer = readFileSync(join(project, ".pi", "agents", "reviewer.md"), "utf8");
    assert.match(piReviewer, /^tools: read, grep, find, ls, bash$/m);
    assert.equal(
      existsSync(join(project, ".agents", "agents")),
      false,
      "Pi native definitions live under .pi/agents, not the skills base",
    );
  });

  it("omits native definitions with --native-agent-defs none", (t) => {
    const home = temp(t);
    const project = temp(t);
    const result = runJson(
      t,
      INSTALL,
      [
        "--scope", "project", "--project", project, "--home", home,
        "--actor-kind", "claude", "--native-agent-defs", "none",
      ],
      { cwd: project },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.agentDefs.length, 0);
    for (const kindDir of [".claude", ".codex", ".pi"]) {
      assert.equal(
        existsSync(join(project, kindDir, "agents")),
        false,
        `${kindDir} must have no native definitions`,
      );
    }
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
    assert.ok(existsSync(join(roles, "ownership.md")));
    assert.equal(existsSync(join(roles, "decision-policy.md")), false);
    assert.ok(existsSync(join(roles, "reviewer", "reviewer-prompt.md")));
    assert.ok(
      existsSync(join(roles, "reviewer", "self-check.md")),
      "the reviewer's pre-verdict audit is installed with the role",
    );
    assert.ok(existsSync(join(home, ".claude", "agents", "jobs.md")));
    assert.ok(existsSync(join(home, ".codex", "agents", "jobs.toml")));
    assert.ok(existsSync(join(home, ".pi", "agent", "agents", "jobs.md")));
    assert.equal(existsSync(join(project, ".meerkat", "roles")), false, "global must not write into the project");
  });

  it("warns when ownership.md is absent and when a legacy policy remains", (t) => {
    const root = temp(t);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, roles: [] }));
    writeFileSync(join(root, "decision-policy.md"), "# old team policy\n");

    const result = runJson(t, INSTALL, ["--validate", root], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const warnings = result.body.warnings.join("\n");
    assert.match(warnings, /ownership\.md is absent/, "a missing guide must be reported");
    assert.match(warnings, /decision-policy\.md is ignored/, "a legacy policy must be reported");
    assert.equal(result.body.ownership, null);
    assert.ok(existsSync(join(root, "decision-policy.md")), "validation never deletes a file");
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
    const jobsWorkflow = readFileSync(join(project, ".meerkat", "roles", "jobs", "workflow.md"), "utf8");
    // The card-identity flags are the board skill's contract now; the rename still proves
    // itself in the role's title and body, which the installer rewrites.
    assert.match(jobsWorkflow, /You are \*\*Alice\*\*/);
    assert.doesNotMatch(jobsWorkflow, /\bJobs\b/);
    const reviewerPrompt = readFileSync(
      join(project, ".meerkat", "roles", "reviewer", "reviewer-prompt.md"),
      "utf8",
    );
    assert.match(reviewerPrompt, /You are Grace/);
    assert.doesNotMatch(reviewerPrompt, /You are Reviewer/);
  });

  it("rewrites cross-references in the manifest when another role is renamed", (t) => {
    const home = temp(t);
    const project = temp(t);
    const result = runJson(
      t,
      INSTALL,
      [
        "--scope", "project", "--project", project, "--home", home,
        "--role", "jobs", "--role", "linus", "--agent", "linus=Bob",
      ],
      { cwd: project },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(project, ".meerkat", "roles", "manifest.json"), "utf8"));
    const jobs = manifest.roles.find((role) => role.id === "jobs");
    assert.ok(jobs.responsibilities.some((line) => line.includes("Bob")));
    assert.equal(jobs.responsibilities.some((line) => /\bLinus\b/.test(line)), false);
    const linus = manifest.roles.find((role) => role.id === "linus");
    assert.equal(linus.agent, "Bob");
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
            native_agent: "../evil",
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
    assert.match(result.body.warnings.join("\n"), /native_agent .* not a slug/);
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
