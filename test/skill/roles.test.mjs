/**
 * The five standalone role skills — Jobs, Linus, Turing, Reviewer and Worker.
 *
 * They used to live as a team template under `skills/setup-meerkat/assets/team/`.
 * Each is now a skill in its own right: `SKILL.md` (the workflow entry), `role.json`
 * (the machine-readable identity the setup detector discovers) and `references/`
 * (branch workflows, self-checks, reviewer protocol and security material).
 *
 * This file covers the workflow prose the template carried, retargeted to the role
 * skills that own it, plus the identity and model-invocation contract of each skill.
 *
 * Run with: node --test test/skill/roles.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { reviewerDeniedTools } from "../../src/foundation/role-tools.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = join(ROOT, "skills");
const ROLES = ["jobs", "linus", "turing", "reviewer", "worker"];

const roleDir = (role) => join(SKILLS, role);
const read = (role, rel = "SKILL.md") => readFileSync(join(roleDir(role), rel), "utf8");
const roleJson = (role) => JSON.parse(read(role, "role.json"));

describe("role skills: identity, discovery and model invocation", () => {
  it("validates every discovered role, not only the standard five", () => {
    // Discovery, not a list, is the inventory: a role added under `skills/` is
    // installed and routed, so it must also satisfy the identity contract.
    const discovered = readdirSync(SKILLS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(SKILLS, name, "role.json")))
      .sort();
    for (const role of ROLES) {
      assert.ok(discovered.includes(role), `${role} is missing from the discovered roles`);
    }
    for (const name of discovered) {
      const identity = JSON.parse(readFileSync(join(SKILLS, name, "role.json"), "utf8"));
      assert.equal(identity.schema, "meerkat-role", `${name}: schema marker`);
      assert.match(identity.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, `${name}: id grammar`);
      assert.ok(typeof identity.agent === "string" && identity.agent.trim() !== "", `${name}: agent`);
      assert.ok(existsSync(join(SKILLS, name, "SKILL.md")), `${name}: SKILL.md`);
    }
  });

  it("ships SKILL.md, role.json and references for every role", () => {
    for (const role of ROLES) {
      assert.ok(existsSync(join(roleDir(role), "SKILL.md")), `${role}: SKILL.md must exist`);
      assert.ok(existsSync(join(roleDir(role), "role.json")), `${role}: role.json must exist`);
      const references = join(roleDir(role), "references");
      assert.ok(statSync(references).isDirectory(), `${role}: references/ must exist`);
      assert.ok(read(role).startsWith("---\n"), `${role}: SKILL.md opens with frontmatter`);
    }
  });

  it("declares a valid meerkat-role identity for every role", () => {
    for (const role of ROLES) {
      const identity = roleJson(role);
      assert.equal(identity.schema, "meerkat-role", `${role}: the detector's schema marker`);
      assert.equal(identity.id, role, `${role}: id matches its directory`);
      assert.ok(typeof identity.agent === "string" && identity.agent.length > 0, `${role}: agent`);
      assert.ok(Array.isArray(identity.shapes) && identity.shapes.length > 0, `${role}: shapes`);
      for (const shape of identity.shapes) {
        assert.ok(typeof shape === "string" && shape.trim().length > 0, `${role}: a shape is a sentence`);
      }
      assert.ok(Array.isArray(identity.lanes) && identity.lanes.length > 0, `${role}: lanes`);
      for (const lane of identity.lanes) {
        assert.ok(["worker", "reviewer"].includes(lane), `${role}: ${lane} is a known lane`);
      }
      assert.match(identity.self_check, /^references\/.+\.md$/, `${role}: self_check is skill-relative`);
      assert.ok(
        existsSync(join(roleDir(role), identity.self_check)),
        `${role}: the self-check resolves where the skill is installed`,
      );
    }

    // Only the reviewer is a review-lane role, and it declares itself the default reviewer.
    const reviewer = roleJson("reviewer");
    assert.deepEqual(reviewer.lanes, ["reviewer"]);
    assert.equal(reviewer.default_reviewer, true);
    assert.match(reviewer.reviewer_handoff, /^references\/.+\.md$/);
    assert.ok(existsSync(join(roleDir("reviewer"), reviewer.reviewer_handoff)));
    for (const role of ["jobs", "linus", "turing", "worker"]) {
      assert.deepEqual(roleJson(role).lanes, ["worker"], `${role}: worker lane`);
      assert.equal(roleJson(role).reviewer_handoff, null, `${role}: no reviewer handoff`);
    }
  });

  it("is model-invocable and its description names the role it owns", () => {
    const shapeWords = {
      jobs: /product|design/i,
      linus: /architecture|implementation|engineering/i,
      turing: /test|regression|verification/i,
      reviewer: /review/i,
      worker: /default|fallback/i,
    };
    for (const role of ROLES) {
      const text = read(role);
      const frontmatter = text.slice(0, text.indexOf("\n---", 4));
      assert.match(frontmatter, new RegExp(`\\nname: ${role}\\n`), `${role}: frontmatter name`);
      assert.doesNotMatch(
        frontmatter,
        /disable-model-invocation/,
        `${role}: a role is model-invocable, never command-only`,
      );
      const description = frontmatter.match(/\ndescription: ([^\n]+)/)?.[1] ?? "";
      assert.ok(description.length >= 20, `${role}: description is substantial`);
      assert.match(description, shapeWords[role], `${role}: the description names its shapes`);
      // A plain YAML scalar cannot contain ": " — the host reads frontmatter as YAML, so an
      // unquoted colon-space is a parse error even though the regex validator tolerates it.
      if (!/^["']/.test(description)) {
        assert.doesNotMatch(description, /: /, `${role}: an unquoted colon-space breaks the YAML frontmatter`);
      }
    }
  });

  it("reviews any delivered card by default, whatever its target type", () => {
    const text = read("reviewer");
    const description = text.match(/\ndescription: ([^\n]+)/)?.[1] ?? "";
    assert.match(description, /any delivered card dispatched for review/i);
    assert.match(description, /whatever its target type/i);
    assert.match(description, /nine-step protocol/i);
    assert.match(
      description,
      /product planning.*product prototype.*development.*test case authoring.*test execution.*epic rollup/i,
      "the six named scenarios stay named as refinements",
    );
    assert.match(description, /project-defined scenario/i);
    assert.match(description, /docs\/agents\/review-scenarios\//);
    assert.match(description, /the floor is mandatory/i);
    assert.match(description, /an unlisted type is not itself a REJECT/i);
    assert.match(description, /Return one VERDICT\.$/);

    assert.match(text, /any delivered card dispatched for review is in scope/i);
    assert.match(text, /a type no scenario names, or a\s+mixed type/i);
    assert.match(text, /the floor is mandatory/i);
    assert.match(text, /the loop routes review cards only/i);

    const identity = roleJson("reviewer");
    assert.match(identity.summary, /any delivered card/i);
    assert.match(identity.summary, /scenario floor is a refinement/i);
    assert.ok(
      identity.shapes.some((line) => /^independent review of any delivered card/i.test(line)),
      "the reviewer still owns review cards, and only review cards",
    );
    assert.ok(
      identity.boundaries.some((line) => /ordinary card belongs to a worker role/i.test(line)),
      "the identity keeps the reviewer out of ordinary work routing",
    );
    assert.ok(
      identity.boundaries.some(
        (line) => /give an unlisted or mixed target type the universal floor/i.test(line),
      ),
      "an unlisted type is a normal review path, not a reject",
    );
    assert.ok(
      identity.boundaries.some((line) => /project scenario adds checks/i.test(line)),
      "a project scenario never weakens the protocol",
    );

    const prompt = read("reviewer", "references/reviewer-handoff.md");
    assert.match(prompt, /any target type is in scope/i);

    const check = read("reviewer", "references/self-check.md");
    assert.match(check, /universal floor and every matching scenario/i);
    assert.match(check, /mixed type, is not a skip/i);
    assert.match(
      check,
      /separate passes, each with its own evidence/i,
      "the self-check records a scenario's checks as separate passes",
    );
  });

  it("routes every work shape to exactly one role", () => {
    const shapes = ROLES.flatMap((role) => roleJson(role).shapes.map((line) => `${role}: ${line}`));
    const text = shapes.join("\n");
    for (const [shape, pattern] of [
      ["product planning", /product planning/i],
      ["prototype", /prototype/i],
      ["system architecture", /system architecture/i],
      ["implementation", /implementation/i],
      ["refactor", /refactor/i],
      ["test design", /test design/i],
      ["regression", /regression/i],
      ["performance", /performance/i],
      ["independent review", /independent review/i],
    ]) {
      assert.match(text, pattern, `the role shapes route ${shape}`);
    }
    const setup = readFileSync(join(SKILLS, "setup-meerkat", "SKILL.md"), "utf8");
    assert.match(setup, /exactly one\s+accountable role/i, "one accountable role per shape");
    assert.match(setup, /shape none describes goes to \*\*Worker\*\*/i, "Worker is the fallback");
    assert.match(setup, /reviewer must be\s+independent/i, "the reviewer is independent");
  });
});

describe("role workflows: plan, audit, execute, self-check and deliver", () => {
  it("takes the plan it is handed before work — adopted first, then audited", () => {
    for (const role of ["jobs", "linus"]) {
      const text = read(role);
      const start = text.indexOf("## Before work — the plan");
      assert.ok(start >= 0, `${role} states the pre-work plan step`);
      const end = text.indexOf("\n## ", start + 1);
      const section = text.slice(start, end === -1 ? undefined : end);
      assert.match(section, /attachments?/i, `${role} reads the card's attachments`);
      assert.match(
        section,
        /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
        `${role} points the download at the board skill`,
      );
      assert.match(section, /adopt|fold/i, `${role} adopts an attached plan`);
      assert.match(section, /no plan attached|carries none/i, `${role} writes the plan when none is attached`);
      assert.match(section, /audit the plan/i, `${role} audits the plan before starting`);
      assert.ok(
        section.search(/attachments?/i) < section.search(/audit the plan/i),
        `${role} takes the plan before it audits it`,
      );
    }
  });

  it("takes the plan it is handed in every Turing branch", () => {
    for (const rel of [
      "references/test-design-workflow.md",
      "references/regression-workflow.md",
      "references/performance-workflow.md",
    ]) {
      const text = read("turing", rel);
      assert.match(text, /^## Steps/m, `${rel} opens with a step list`);
      const plan = text.slice(text.indexOf("### 1. Plan"), text.indexOf("### 2."));
      assert.match(plan, /adopt/i, `${rel} adopts an attached plan`);
      assert.match(plan, /audit/i, `${rel} audits it before starting`);
    }
    const testDesign = read("turing", "references/test-design-workflow.md");
    const plan = testDesign.slice(testDesign.indexOf("### 1. Plan"), testDesign.indexOf("### 2."));
    assert.match(plan, /attachments?/i, "test design reads the card's attachments");
    assert.match(
      plan,
      /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
      "test design points attachment handling at the board skill",
    );
    assert.match(plan, /adopt|fold/i, "test design adopts an attached plan");
    assert.match(plan, /no plan attached|carries none/i, "test design writes the plan when none is attached");
    assert.match(plan, /audit the plan/i, "test design audits the plan before starting");
    assert.ok(
      plan.search(/attachments?/i) < plan.search(/audit the plan/i),
      "test design takes the plan before it audits it",
    );
  });

  it("names an adopted plan in every branch's first step", () => {
    for (const [role, rel] of [
      ["linus", "references/implementation-workflow.md"],
      ["linus", "references/refactor-workflow.md"],
      ["turing", "references/regression-workflow.md"],
    ]) {
      assert.match(read(role, rel), /written or adopted by you/, `${role}/${rel} accepts an adopted plan`);
    }
  });

  describe("role workflows: any input, not a prescribed card", () => {
    const PLAIN = /task,\s*plan(?:,|\s+or)\s+(?:a\s+)?requirement/i;

    it("describes the role for a plain task, plan or requirement", () => {
      for (const role of ["jobs", "linus", "turing", "worker"]) {
        const text = read(role);
        const frontmatter = text.slice(0, text.indexOf("\n---", 4));
        const description = frontmatter.match(/\ndescription: ([^\n]+)/)?.[1] ?? "";
        assert.match(description, PLAIN, `${role}: the description invites a task, plan or requirement`);
      }
    });

    it("ships no prescribed input section", () => {
      for (const role of ["jobs", "linus", "turing", "worker"]) {
        const refs = readdirSync(join(roleDir(role), "references"))
          .filter((name) => name.endsWith(".md"))
          .map((name) => `references/${name}`);
        for (const rel of ["SKILL.md", ...refs]) {
          const text = read(role, rel);
          assert.doesNotMatch(text, /^## Inputs\b/m, `${role}/${rel} has no Inputs section`);
          assert.doesNotMatch(text, /^Inputs:/m, `${role}/${rel} has no Inputs line`);
        }
      }
    });

    it("audits a plan through logic, blast radius and the simplest reliable option", () => {
      for (const role of ["jobs", "linus", "turing", "worker"]) {
        const text = read(role);
        assert.match(text, /logic/i, `${role}: the audit names logic`);
        assert.match(text, /blast radius/i, `${role}: checks the blast radius`);
        assert.match(text, /simplest reliable/i, `${role}: chooses the simplest reliable option`);
        assert.doesNotMatch(text, /impact scope/i, `${role}: uses the repo's blast-radius term`);
      }
      for (const rel of ["test-design-workflow.md", "regression-workflow.md", "performance-workflow.md"]) {
        const text = read("turing", `references/${rel}`);
        const plan = text.slice(text.indexOf("### 1. Plan"), text.indexOf("### 2."));
        assert.match(plan, /logic/i, `${rel}: its plan step names logic`);
        assert.match(plan, /blast radius/i, `${rel}: its plan step names the blast radius`);
        assert.match(plan, /simplest reliable/i, `${rel}: its plan step names the simplest reliable option`);
        assert.match(plan, /SKILL\.md/, `${rel}: the canonical wording lives once in SKILL.md`);
      }
    });

    it("runs the pre-delivery self-check in both modes", () => {
      for (const role of ["jobs", "linus", "turing", "worker"]) {
        const skill = read(role);
        assert.match(skill, /self-check\.md/, `${role}: delivery names the pre-delivery audit`);
        const check = read(role, "references/self-check.md");
        assert.match(check, /both modes/i, `${role}: the audit covers both modes`);
        assert.match(check, /not_applicable — no card/, `${role}: card-only items are dispositioned`);
      }
    });

    it("writes the plan from the card when the card carries none", () => {
      for (const role of ["jobs", "linus", "turing", "worker"]) {
        const text = read(role);
        assert.match(text, /no plan attached/i, `${role}: names the card-without-plan path`);
        assert.match(
          text,
          /no plan attached[\s\S]{0,200}(frozen acceptance|acceptance)/i,
          `${role}: writes the plan from the card and its acceptance`,
        );
      }
    });
  });

  it("runs a product card as frame → define → decide → validate → converge → deliver", () => {
    const workflow = read("jobs");
    const ui = read("jobs", "references/ui-workflow.md");
    const selfCheck = read("jobs", "references/self-check.md");

    assert.match(workflow, /ui-workflow\.md/, "the product flow points at the prototype flow");
    assert.match(workflow, /design\/specs\//, "planning artifacts live under design/specs");
    assert.match(workflow, /design\/prototype\//, "prototypes live under design/prototype");
    assert.match(workflow, /design\/prds\//, "PRDs live under design/prds");

    const steps = [
      "### 1. Frame the problem",
      "### 2. Define the outcome and the constraints",
      "### 3. Decide the product direction",
      "### 4. Plan validation and enter the prototype flow",
      "### 5. Converge the solution and specify the PRD",
      "### 6. Deliver",
    ];
    let at = -1;
    for (const step of steps) {
      const next = workflow.indexOf(step);
      assert.ok(next > at, `step must exist in order: ${step}`);
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
    const linus = read("linus");
    const arch = read("linus", "references/architecture-workflow.md");
    const impl = read("linus", "references/implementation-workflow.md");
    const turing = read("turing");
    const regression = read("turing", "references/regression-workflow.md");
    const performance = read("turing", "references/performance-workflow.md");
    const testDesign = read("turing", "references/test-design-workflow.md");
    const jobsWorkflow = read("jobs");
    const jobsCheck = read("jobs", "references/self-check.md");

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
    assert.doesNotMatch(turing, /\|\s*Card\s*\|\s*Branch\s*\|/i, "the branch table is not duplicated");
    assert.match(turing, /the supervisor's acceptance pass lands it/i, "the shared delivery leaves landing to the director");
    assert.match(testDesign, /already landed|landed implementation/i, "test design verifies a landed implementation");
    assert.doesNotMatch(testDesign, /test-first|red-first/i, "red-first belongs to the implementation card");
    assert.match(
      testDesign,
      /for a feature or behaviour change,[\s\S]*archived spec/,
      "test design reads the archived spec through the handoff",
    );
    for (const [name, text] of [
      ["test design", testDesign],
      ["regression", regression],
      ["performance", performance],
    ]) {
      assert.match(text, /^## Steps/m, `${name} opens with its step list`);
      assert.match(text, /workflow\.md|SKILL\.md/, `${name} points at the shared contract`);
    }

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
    const arch = read("linus", "references/architecture-workflow.md");
    const linus = read("linus");
    const check = read("linus", "references/self-check.md");

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
    assert.match(
      arch,
      /configuration (or|versus|vs\.?) constant/i,
      "the configuration surface separates deployment configuration from code constants",
    );
    assert.match(arch, /closed set/i, "an enumeration is a closed set");
    assert.match(arch, /unknown[- ]value/i, "an enumeration records its unknown-value policy");
    assert.match(
      arch,
      /constants? and enumerations?/i,
      "the standard and scaffold carry constants and enumerations",
    );
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
    assert.match(
      scaffold,
      /^\| Constants and enumerations \|/m,
      "the scaffold checklist carries a constants and enumerations row",
    );

    const design = arch.slice(arch.indexOf("### 3."), arch.indexOf("### 4."));
    assert.match(design, /^#### Observability$/m, "observability has its own design section");
    assert.match(
      design,
      /^#### Security boundaries$/m,
      "security boundaries have their own design section",
    );
    const selfCheckStep = arch.slice(arch.indexOf("### 7."), arch.indexOf("### 8."));
    assert.match(
      selfCheckStep,
      /authoritative checklist/i,
      "Step 7 defers to self-check.md instead of keeping a second list",
    );
    const init = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    assert.match(init, /logging contract/i, "the agent-instruction baseline carries the logging contract");

    assert.match(linus, /foundation decision/i, "the routing is foundation-level");
    assert.match(linus, /feature or module/i, "the routing names the implementation side");

    assert.match(check, /design stance|over-?engineer/i, "the self-check audits the stance");
    assert.match(check, /architecture style|domain-driven/i, "the self-check audits the style");
    assert.match(check, /external contract/i, "the self-check audits the contract");
    assert.match(check, /configuration surface/i, "the self-check audits configuration");
    assert.match(
      check,
      /constants? and enumerations?/i,
      "the self-check audits constants and enumerations",
    );
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

  it("hardens the architecture flow for reconstruction, audit and honest gates", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const check = read("linus", "references/self-check.md");
    const linus = read("linus");

    assert.match(arch, /^## Run modes$/m, "the flow names its run modes");
    for (const mode of ["create", "extend", "reconstruct", "conformance audit"]) {
      assert.match(arch, new RegExp(mode, "i"), `the run modes cover ${mode}`);
    }
    assert.match(arch, /reconstructed — <evidence>/, "a reconstruction records its evidence");
    assert.match(arch, /not recorded — review question/, "an unsettled decision stays open");
    assert.match(arch, /not a gate — <reason>/, "a placeholder is named as not a gate");
    assert.match(arch, /failure probe/i, "each gate names the change that fails it");
    assert.match(arch, /blast radius/i, "an exposure-widening default records its blast radius");
    assert.match(arch, /worst-case path that blocks/i, "observability names the blocking path");
    assert.match(arch, /upgrade path/i, "a squashed baseline records its upgrade path");
    assert.match(arch, /coverage floor[\s\S]{0,200}subsystem/i, "the floor names its subsystems");
    assert.match(arch, /parity[\s\S]{0,240}enforcement site/i, "parity lists its sites");
    assert.match(arch, /one rule names one enforcement point/i, "granularity counts enforcement points");
    assert.match(arch, /two enforcement points/i, "an invariant with two homes stays one rule");
    assert.match(arch, /deploy check names the command/i, "a deploy check names its entry point");
    assert.match(arch, /URL or query string/i, "a credential in a URL is a finding");
    assert.match(arch, /E5 pending/i, "a reconstruction records E5 pending");
    assert.match(check, /reconstructed — <evidence>/, "the self-check knows provenance");
    assert.match(check, /not run — <reason>/, "an unexecuted gate is recorded");
    assert.match(check, /only by an observed exit code/i, "an audit never claims a gate");
    assert.match(check, /^[-*] \*\*R1\.\*\*/m, "the reconstruction items start at R1");
    assert.match(linus, /missing or partial|reconstruction/i, "a missing foundation routes here");
    // A role workflow is capped by the runtime; keep headroom rather than drift to the edge.
    assert.ok(
      Buffer.byteLength(arch, "utf8") < 60 * 1024,
      "the architecture workflow stays under the size cap",
    );
  });

  it("gates a refactor on a recorded foundation", () => {
    const refactor = read("linus", "references/refactor-workflow.md");
    assert.match(refactor, /^### 0\. .*foundation/m, "Step 0 checks the recorded foundation");
    assert.match(refactor, /foundation gap/i, "a missing record is a foundation gap");
    assert.match(refactor, /architecture-workflow\.md/, "the gap routes to the architecture flow");
    assert.match(refactor, /reconstructed — <evidence>/, "the provenance vocabulary binds");
    assert.match(refactor, /E5 pending/i, "a reconstruction awaits E5");

    const check = read("linus", "references/self-check.md");
    const branch = check.slice(check.indexOf("## Refactor branch"));
    assert.match(branch, /Step 0|foundation/i, "the self-check audits the foundation gate");
  });

  it("records a standard technical specification and points the baseline at it", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const check = read("linus", "references/self-check.md");
    const linusIdentity = read("linus", "role.json");

    assert.match(arch, /docs\/tech-spec\.md/, "the flow records one standard technical specification");
    const seed = arch.slice(arch.indexOf("### 2."), arch.indexOf("### 3."));
    assert.match(seed, /docs\/tech-spec\.md/, "Step 2 seeds the stack table into the specification");
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
    assert.match(check, /enforcement point/i, "the self-check audits the enforcement points");
    assert.match(arch, /ASVS target level/i, "the flow records the review level in the standard");
    assert.match(arch, /ask the human for it when initializing/i, "the level is asked at initialization");
    assert.match(linusIdentity, /docs\/tech-spec\.md/, "the Linus identity names the specification");
  });

  it("binds the baseline to the project's own standard and gives the review a method", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const baseline = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));

    assert.match(
      baseline,
      /existing project[\s\S]{0,240}(own documents|recorded path|already name)/i,
      "an existing project binds its own recorded standard, not the new-project path",
    );
    assert.doesNotMatch(
      baseline,
      /A project without this file is not an architecture delivery/,
      "the standard rule no longer rejects a project whose standard lives elsewhere",
    );
    assert.match(
      baseline,
      /resolve every line|fabricated path/i,
      "the review has a method that catches a fabricated path",
    );
    assert.match(baseline, /ownership test/i, "the baseline review applies the ownership test");
    assert.match(baseline, /deletion test/i, "the baseline review applies the deletion test");
    assert.match(
      baseline,
      /improve[\s\S]{0,200}regenerat/i,
      "an existing baseline is improved in place, not regenerated",
    );
    assert.match(
      baseline,
      /command, a gate or the\s+layout/i,
      "the baseline's drift trigger covers commands, gates and the layout",
    );
  });

  it("carries the operating rules into the baseline", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const check = read("linus", "references/self-check.md");
    const linusIdentity = read("linus", "role.json");

    const baseline = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    const required = baseline.slice(
      baseline.indexOf("**Purpose and boundary**"),
      baseline.indexOf("Leave out architecture prose"),
    );
    const step7 = arch.slice(arch.indexOf("### 7."), arch.indexOf("### 8."));

    assert.ok(required.includes("**Purpose and boundary**"), "the requirements slice starts at item 1");
    assert.ok(required.includes("**Pointers**"), "the requirements slice reaches the last item");
    assert.match(required, /\*\*Working agreement\*\*/i, "the list requires a working agreement");
    assert.match(
      required,
      /\*\*Change and integration policy\*\*/i,
      "the list requires the project's change and integration policy",
    );
    assert.match(
      required,
      /\*\*Operational invariants\*\*/i,
      "the list requires the operational invariants a fresh session can break",
    );
    assert.match(
      required,
      /decompose[\s\S]{0,160}(test-first|test first|failing test)/i,
      "the working agreement decomposes first and starts from a test where one exists",
    );
    assert.match(required, /one writer per surface/i, "the invariants name the single-writer rule");
    assert.match(
      required,
      /release line/i,
      "the change policy names a protected line by role, not a repository's branch names",
    );
    assert.match(required, /isolat/i, "the change policy isolates parallel work");
    assert.match(required, /cleanup|cleaned up/i, "the change policy states the cleanup order");

    assert.match(
      step7,
      /working agreement/i,
      "the architecture self-check audits the working agreement",
    );
    assert.match(check, /working agreement/i, "Linus's self-check audits the working agreement");
    assert.match(
      check,
      /change and integration policy/i,
      "Linus's self-check audits the change policy",
    );
    assert.match(
      check,
      /operational invariants/i,
      "Linus's self-check audits the operational invariants",
    );
    assert.match(check, /resolves/i, "Linus's self-check audits that every pointer resolves");
    assert.match(linusIdentity, /working agreement/i, "the Linus identity names the operating rules");
  });

  it("applies the six design principles to a feature change", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const impl = read("linus", "references/implementation-workflow.md");
    const check = read("linus", "references/self-check.md");
    const linusIdentity = read("linus", "role.json");

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
      ["linus/SKILL.md", read("linus")],
      ["linus/role.json", linusIdentity],
      ["linus/self-check.md", check],
      ["linus/architecture-workflow.md", arch],
    ]) {
      assert.doesNotMatch(text, /\bfive (design )?principles\b/i, `${name} must not still say five principles`);
    }
    assert.match(linusIdentity, /high cohesion/i, "the Linus identity names the sixth principle");
  });

  it("carries the decision method, split glossaries and the agent baseline", () => {
    const jobs = read("jobs");
    const ui = read("jobs", "references/ui-workflow.md");
    const jobsCheck = read("jobs", "references/self-check.md");
    const linus = read("linus");
    const arch = read("linus", "references/architecture-workflow.md");
    const impl = read("linus", "references/implementation-workflow.md");
    const turing = read("turing");
    const testPlan = read("turing", "references/test-design-workflow.md");

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
    assert.match(jobs, /Archive .*spec\.md.*prd\.md/, "archiving is part of delivery");
    assert.match(jobs, /self-check\.md/, "delivery runs the pre-delivery audit");
    assert.match(jobs, /<content-slug>/, "design filenames use a content slug");
    assert.match(jobsCheck, /Archive check/, "the self-check covers the archive");

    assert.match(linus, /## Product language/);
    assert.match(linus, /design\/glossary\.md/);
    assert.match(arch, /AGENTS\.md/);
    assert.match(arch, /CLAUDE\.md/);
    assert.match(arch, /agent-instruction baseline/i);
    const refactor = read("linus", "references/refactor-workflow.md");
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

  it("makes the decision policy the single home of the round protocol", () => {
    const rounds = readFileSync(
      join(SKILLS, "meerkat-director", "references", "rounds.md"),
      "utf8",
    );
    assert.match(rounds, /## Decision rounds/);
    assert.match(rounds, /frontier/);
    assert.match(rounds, /so "yes" accepts/i);
    assert.match(rounds, /Facts are the asker's job/i);

    let protocolCopies = 0;
    for (const role of ["jobs", "linus", "turing"]) {
      protocolCopies += (read(role).match(/Draw the decision tree/g) ?? []).length;
    }
    assert.equal(protocolCopies, 0, "the six-step protocol lives only in the decision policy");

    for (const role of ["jobs", "linus", "turing"]) {
      const workflow = read(role);
      assert.match(workflow, /Decide before you build/);
      assert.match(workflow, /frontier/i);
      assert.match(workflow, /decision-policy\.md/);
    }
  });

  it("requires the change policy to name where a card starts and lands", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const baseline = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    const policy = baseline.slice(
      baseline.indexOf("**Change and integration policy**"),
      baseline.indexOf("**Operational invariants**"),
    );
    assert.ok(policy.length > 0, "the baseline requirements list a change and integration policy");
    assert.match(policy, /starts? from/i, "the policy names the ref a card starts from");
    assert.match(policy, /lands? into/i, "the policy names the ref acceptance lands into");
    assert.match(
      policy,
      /commit rule/i,
      "the policy names the commit rule that makes a delivery verifiable",
    );

    const linus = read("linus");
    assert.match(linus, /foundation gap/i, "a missing change policy is a foundation gap, not an invention");

    const check = read("linus", "references/self-check.md");
    assert.match(check, /starts? from/i, "the self-check audits where a card starts");
    assert.match(check, /commit rule/i, "the self-check audits the commit rule");
  });

  it("leaves the task entry to the install, not to the architecture flow", () => {
    // One writer per surface: the install writes the entry and its scope, and the
    // architecture flow leaves it alone rather than duplicating it.
    const arch = read("linus", "references/architecture-workflow.md");
    const check = read("linus", "references/self-check.md");
    const setup = readFileSync(join(SKILLS, "setup-meerkat", "SKILL.md"), "utf8");

    const step5 = arch.slice(arch.indexOf("### 5."), arch.indexOf("### 6."));
    const step7 = arch.slice(arch.indexOf("### 7."), arch.indexOf("### 8."));
    assert.match(step5, /install\s+skill/i, "it says whose job the task entry is");
    assert.doesNotMatch(step5, /\*\*Task entry\*\*/, "the entry is not a baseline item here");
    assert.doesNotMatch(step7, /`\/meerkat`/, "the architecture self-check does not audit the entry");
    assert.doesNotMatch(check, /`\/meerkat`/, "Linus's self-check does not audit the entry");
    assert.doesNotMatch(check, /task\s+entry/i, "Linus's self-check leaves the entry to the install");

    assert.doesNotMatch(setup, /<!--\s*\/?meerkat:task-entry\s*-->/, "the install ships no block");
    for (const keyword of ["/meerkat", "card", "claim", "heartbeat", "deliver", "in_review", "done"]) {
      assert.ok(setup.includes(keyword), `the install keeps the keyword ${keyword}`);
    }
  });

  it("keeps operations out of Linus and routes work the roles do not own", () => {
    const linus = read("linus");
    const linusIdentity = roleJson("linus");
    const impl = read("linus", "references/implementation-workflow.md");
    const check = read("linus", "references/self-check.md");
    const setup = readFileSync(join(SKILLS, "setup-meerkat", "SKILL.md"), "utf8");
    const rounds = readFileSync(
      join(SKILLS, "meerkat-director", "references", "rounds.md"),
      "utf8",
    );

    assert.doesNotMatch(linus.split("\n")[0], /\boperations\b/i, "the role title does not claim operations");
    assert.doesNotMatch(linusIdentity.summary, /\boperations\b/i, "the identity summary drops operations");
    assert.doesNotMatch(impl, /^### \d+\. Operations/m, "no operations step");
    assert.match(
      linus,
      /Take architecture, implementation, refactoring and bug-fix work/i,
      "the boundary is stated",
    );
    assert.match(
      linus,
      /operations on a running\s+system belong to the Worker role/i,
      "operations is routed out of the role",
    );

    assert.match(linus, /refactor-workflow\.md/, "the role routes the refactor branch");
    assert.match(check, /## Refactor branch/, "the self-check covers refactoring");
    assert.match(setup, /Outside the roles is outside the board/i, "the setup interview allows an outside worker");
    assert.match(rounds, /outside\s+the\s+roles/i, "the decision policy allows an outside worker");
  });

  it("leaves landing, merging and rebasing to the director", () => {
    for (const role of ["jobs", "linus", "turing"]) {
      assert.match(
        read(role, "references/self-check.md"),
        /nothing was merged, rebased or pushed/i,
        `${role} self-check leaves integration to the director`,
      );
    }

    const protocol = read("reviewer", "references/review-protocol.md");
    assert.match(
      protocol,
      /no longer resolves|does not resolve/i,
      "the reviewer refuses a review whose commit anchor is gone",
    );

    for (const role of ["jobs", "linus", "turing"]) {
      assert.match(
        read(role, "role.json"),
        /the supervisor's acceptance pass merges, rebases, pushes/i,
        `${role}'s identity leaves integration alone`,
      );
    }
  });

  it("makes every self-check say what counts as proof and what may not be a leftover", () => {
    for (const role of ["jobs", "linus", "turing"]) {
      const check = read(role, "references/self-check.md");
      assert.match(check, /falsifiable/i, `${role} requires falsifiable evidence`);
      assert.match(check, /not_applicable/, `${role} names the not_applicable disposition`);
      assert.match(check, /\bowner\b/i, `${role} makes a leftover name its owner`);
      assert.match(check, /a blocker, not a leftover/i, `${role} lists what may not be a leftover`);
    }

    for (const role of ["linus", "turing"]) {
      const check = read(role, "references/self-check.md");
      assert.match(check, /every branch/i, `${role} covers every branch`);
      assert.doesNotMatch(check, /apply to both/i, `${role}: three branches, not two`);
    }

    const reviewer = read("reviewer");
    assert.match(
      reviewer,
      /outside the frozen acceptance/i,
      "the reviewer accepts a leftover only outside the acceptance",
    );
    assert.match(reviewer, /missing acceptance item\s+is a `REJECT`/i, "a missing item is a REJECT");
    assert.match(reviewer, /falsifiable/i, "the reviewer workflow says what counts as proof");
    const prompt = read("reviewer", "references/reviewer-handoff.md");
    assert.match(prompt, /falsifiable/i, "the inlined reviewer handoff says what counts as proof");
    assert.match(prompt, /evidence\[n\]/, "the inlined prompt names the anchor reference");

    const impl = read("linus", "references/implementation-workflow.md");
    assert.match(
      impl,
      /\(Implementation branch\)/,
      "the implementation workflow names its self-check section",
    );
  });

  it("reads the design artifacts on a feature path, not on a bug path", () => {
    const impl = read("linus", "references/implementation-workflow.md");
    const testDesign = read("turing", "references/test-design-workflow.md");
    const regression = read("turing", "references/regression-workflow.md");

    assert.match(impl, /for a feature or behaviour change,[\s\S]*archived spec/, "a feature reads the design artifacts");
    assert.match(impl, /bug fix does not\s+need the design artifacts/, "a bug does not need them");
    assert.match(testDesign, /for a feature or behaviour change,[\s\S]*archived spec/, "test design reads them for a feature");
    assert.match(
      regression,
      /verify against the defect, the reproduction, the frozen acceptance and the baseline/i,
      "regression verifies the defect, not the design",
    );
  });

  it("triages the card shape and hands off design outputs explicitly", () => {
    const jobs = read("jobs");
    const jobsCheck = read("jobs", "references/self-check.md");
    const linus = read("linus");
    const linusIdentity = roleJson("linus");
    const linusCheck = read("linus", "references/self-check.md");
    const impl = read("linus", "references/implementation-workflow.md");
    const turing = read("turing");
    const testDesign = read("turing", "references/test-design-workflow.md");
    const regression = read("turing", "references/regression-workflow.md");
    const turingCheck = read("turing", "references/self-check.md");
    const reviewer = read("reviewer");
    const prompt = read("reviewer", "references/reviewer-handoff.md");
    const setup = readFileSync(join(SKILLS, "setup-meerkat", "SKILL.md"), "utf8");

    assert.match(jobs, /## Handoff/);
    assert.match(jobs, /design\/specs\/<content-slug>\.md/);
    assert.match(jobs, /design\/prototype\/<content-slug>\//);
    assert.match(jobs, /design\/prds\/<content-slug>\.md/);
    assert.match(jobs, /Acceptance source/i);
    assert.match(jobs, /Delivery shape/i);
    assert.match(jobs, /epic/i);
    assert.match(jobs, /children/i);
    assert.match(jobs, /stage_handoff/);
    assert.match(jobs, /Downstream cards:/, "the handoff names an existing graph stage");
    assert.match(jobs, /epic graph/i);
    assert.match(jobs, /director/i);
    assert.match(jobs, /card and plan lifecycle/i, "the director owns the triage lifecycle");
    assert.match(jobs, /the director creates the downstream card/i);
    assert.doesNotMatch(jobs, /five stages/i);
    assert.doesNotMatch(jobs, /inherit or extend/i);

    // A child is a deliverable that can land alone; one change's layers are its scope.
    assert.match(jobs, /not one card per layer/i);
    assert.match(jobsCheck, /one child per layer` is a mis-size/i);
    assert.match(impl, /not the layers of one change/i);
    assert.match(jobs, /can land on the base branch alone/i);

    assert.match(jobsCheck, /## Handoff/);
    assert.match(jobsCheck, /Acceptance source/i);
    assert.match(jobsCheck, /Delivery shape/i);
    assert.match(jobsCheck, /proposed/i);

    for (const [name, text] of [["Linus", linus], ["Turing", turing]]) {
      assert.match(text, /own plan|this card's plan/i, `${name} writes its own plan`);
      assert.match(text, /## Handoff/, `${name} reads the handoff block`);
      assert.doesNotMatch(text, /inherit or extend/i, `${name} does not inherit another card's plan`);
    }
    assert.match(linus, /epic_graph/);
    assert.match(linus, /epic-graphs\.md/);
    assert.match(linus, /product_change/);
    assert.match(linus, /design_stage/);
    assert.match(linus, /optional hints/i);
    // Classification is the graph's or the creator's, never the executor's. TP-0033
    // burned a round because the executor classified the card in `plan.md` and proceeded.
    assert.match(linus, /the creator or the\s+director's triage classifies it/i, "a worker never writes its own classification");
    assert.match(linus, /ask and hold/i, "a card it cannot classify holds instead of proceeding");
    assert.match(impl, /## Handoff/);
    assert.match(impl, /does not\s+need the design artifacts/i);
    assert.match(testDesign, /## Handoff/);
    assert.match(testDesign, /named report/i);
    assert.match(
      regression,
      /verify against the defect, the reproduction, the frozen acceptance and the baseline/i,
    );
    assert.doesNotMatch(regression, /^Inputs:/m, "the branch names no input contract");
    assert.match(testDesign, /test-plan\.md/);
    assert.match(turing, /API/i);
    assert.match(turing, /browser/i);
    assert.match(testDesign, /API/);
    assert.match(testDesign, /browser/i);
    assert.match(regression, /API|browser/i);

    // The reviewer's contract is a procedure, not a gate list: the gate is the
    // project's (`review_gate`), and what the role owns is the ledger, the delivered
    // sha, the anchor behind each claim and the earlier findings. The workflow is the
    // thin router; the protocol carries the procedure.
    const protocol = read("reviewer", "references/review-protocol.md");
    for (const [name, text] of [["protocol", protocol], ["prompt", prompt]]) {
      assert.match(text, /## Handoff/, `${name} reads the handoff`);
      assert.match(
        text,
        /epic_graph|epic-graphs\.md|stage_handoff/,
        `${name} classifies from the graph or the handoff`,
      );
      assert.match(text, /ledger/i, `${name} builds the requirement ledger`);
      assert.match(text, /commit|sha/i, `${name} verifies the delivered commit`);
      assert.match(text, /earlier round|prior finding|earlier finding/i, `${name} re-checks earlier findings`);
      assert.match(text, /declared gate|none declared/i, `${name} runs the project's gate`);
      assert.match(text, /osv-scanner/, `${name} runs the dependency audit`);
      assert.match(text, /falsifiable/i, `${name} says what counts as proof`);
      assert.match(text, /evidence\[n\]/, `${name} requires an anchor reference`);
      assert.match(text, /REJECT/);
      assert.match(text, /not_met/, `${name} refuses to call the unverifiable a pass`);
    }
    assert.match(reviewer, /references\/review-protocol\.md/, "the workflow routes to the protocol");
    assert.match(reviewer, /## Handoff/, "the workflow reads the handoff");
    assert.match(
      reviewer,
      /epic-graphs\.md|stage_handoff/,
      "the workflow classifies from the graph or the handoff",
    );
    assert.match(reviewer, /ledger/i);
    assert.match(reviewer, /earlier rounds/i);
    assert.match(reviewer, /declared gate/i);
    assert.match(reviewer, /rollup/i);
    assert.match(reviewer, /epic/i);
    assert.match(reviewer, /snapshot/i);
    assert.match(reviewer, /generic items/i);
    assert.match(prompt, /snapshot/i);
    assert.match(prompt, /generic items/i);
    assert.match(reviewer, /OWASP Top 10/i);
    assert.match(reviewer, /OWASP ASVS/i);
    for (const text of [linusCheck, turingCheck]) {
      assert.match(text, /100%/);
      assert.match(text, /80%/);
      assert.match(text, /websocket/);
      assert.match(text, /internal/i);
      assert.match(text, /security scan/i);
      assert.match(text, /osv-scanner/, "the security scan names its dependency scanner");
      assert.match(text, /API|browser/i);
    }

    // The identity files carry the same ownership the prose states.
    const turingIdentity = roleJson("turing");
    const reviewerIdentity = roleJson("reviewer");
    assert.ok(
      turingIdentity.responsibilities.some((line) => /API|browser/i.test(line)),
      "Turing owns API and browser tests",
    );
    assert.ok(
      reviewerIdentity.responsibilities.some((line) => /OWASP/i.test(line)),
      "the reviewer audits the security standards",
    );
    assert.ok(
      turingIdentity.responsibilities.some((line) => /osv-scanner/.test(line)),
      "Turing owns the dependency security scan",
    );
    assert.ok(
      reviewerIdentity.responsibilities.some((line) => /osv-scanner/.test(line)),
      "the reviewer runs the dependency audit with the gate",
    );
    assert.equal(reviewerIdentity.self_check, "references/self-check.md", "the reviewer has a pre-verdict audit");
    assert.ok(
      reviewerIdentity.responsibilities.some((line) => /ledger/i.test(line)),
      "the reviewer builds the requirement ledger",
    );
    assert.ok(linusIdentity.responsibilities.some((line) => /architecture/i.test(line)));

    // The setup skill installs the role prose; it never keeps a second copy.
    assert.match(setup, /ships no copy of their content|no copy of their content/i);
  });

  it("names the pre-delivery audit and ends every worker flow in Deliver", () => {
    for (const role of ["jobs", "linus", "turing"]) {
      const check = read(role, "references/self-check.md");
      assert.match(check, /pre-delivery audit/, `${role} self-check names the audit`);
      assert.match(check, /not\s+the `## Handoff` block/, `${role} self-check is not the handoff`);
      if (role === "linus" || role === "jobs") {
        assert.match(
          check,
          /refresh the card brief/i,
          `${role} self-check refreshes the brief through the skill`,
        );
        assert.doesNotMatch(check, /re-export/i, `${role} self-check leaves board mechanics to the skill`);
        assert.doesNotMatch(check, /card\.md/, `${role} self-check leaves the brief file to the skill`);
      } else {
        assert.match(check, /refresh the brief|re-export/i, `${role} self-check refreshes the brief`);
        assert.match(check, /card\.md/, `${role} self-check names the brief`);
      }
      assert.match(check, /`commit` anchor/i, `${role} self-check requires the commit anchor`);
    }

    for (const [role, rel, heading] of [
      ["jobs", "SKILL.md", "### 6. Deliver"],
      ["linus", "references/architecture-workflow.md", "### 9. Deliver"],
      ["linus", "references/implementation-workflow.md", "### 7. Deliver"],
      ["linus", "references/refactor-workflow.md", "### 7. Deliver"],
    ]) {
      const text = read(role, rel);
      assert.ok(text.includes(heading), `${role}/${rel} must end in ${heading}`);
      const deliver = text.slice(text.indexOf(heading));
      assert.match(deliver, /commit/i, `${role}/${rel} commits before it delivers`);
      assert.match(deliver, /DELIVERY_NEEDS_COMMIT/, `${role}/${rel} names the delivery gate`);
      assert.match(deliver, /the\s+supervisor's acceptance pass merges, rebases, pushes/i, `${role}/${rel} leaves landing to the director`);
    }

    const turingWorkflow = read("turing");
    assert.match(turingWorkflow, /## Delivery/, "the shared Turing delivery is the workflow's");
    assert.match(turingWorkflow, /commit/i, "the shared delivery commits before it delivers");
    assert.match(
      turingWorkflow,
      /the supervisor's acceptance pass lands it/i,
      "the shared delivery leaves landing to the director",
    );
    for (const rel of [
      "references/test-design-workflow.md",
      "references/regression-workflow.md",
      "references/performance-workflow.md",
    ]) {
      const text = read("turing", rel);
      assert.match(text, /workflow\.md|SKILL\.md/, `${rel} points at the shared delivery`);
      assert.doesNotMatch(text, /DELIVERY_NEEDS_COMMIT/, `${rel} does not restate the board gate`);
    }

    const testDesign = read("turing", "references/test-design-workflow.md");
    assert.doesNotMatch(testDesign, /^### 4\. Self-check/m, "step 4 is a plan check, not the self-check");

    const prompt = readFileSync(join(roleDir("reviewer"), "references/reviewer-handoff.md"));
    assert.ok(prompt.length <= 2400, "the reviewer handoff must fit its 2,400-character inline budget");
  });

  it("keeps the Linus flows step-navigable, concise and board-delegated", () => {
    const texts = {
      "SKILL.md": read("linus"),
      "references/architecture-workflow.md": read("linus", "references/architecture-workflow.md"),
      "references/implementation-workflow.md": read("linus", "references/implementation-workflow.md"),
      "references/refactor-workflow.md": read("linus", "references/refactor-workflow.md"),
    };
    const check = read("linus", "references/self-check.md");

    for (const [name, text] of Object.entries(texts)) {
      assert.ok(text.includes("## Steps at a glance"), `${name} opens with a step list`);
    }
    for (const name of [
      "references/architecture-workflow.md",
      "references/implementation-workflow.md",
      "references/refactor-workflow.md",
    ]) {
      const text = texts[name];
      const start = text.indexOf("## Steps at a glance");
      const glance = text.slice(start, text.indexOf("\n## ", start + 1));
      const listed = [...glance.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
      const headings = [...text.matchAll(/^### (\d+)\. /gm)].map((match) => Number(match[1]));
      assert.deepEqual(listed, headings, `${name} step list matches its headings`);
    }
    const sharedMoves = [...texts["SKILL.md"].matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(sharedMoves, [1, 2, 3, 4, 5, 6], "the Linus skill lists six shared moves");

    for (const name of [
      "references/architecture-workflow.md",
      "references/implementation-workflow.md",
      "references/refactor-workflow.md",
    ]) {
      for (const block of texts[name].split(/^### \d+\. /m).slice(1)) {
        assert.match(block, /\*\*Purpose\.\*\*/, `${name} step has a purpose`);
        assert.match(block, /\*\*Watch for\.\*\*/, `${name} step has a watch-for`);
        assert.match(block, /\*\*Essentials\.\*\*/, `${name} step has essentials`);
      }
    }

    const ids = [...check.matchAll(/^- \*\*([SAIRF])(\d+)\.\*\*/gm)].map((match) => [match[1], Number(match[2])]);
    assert.ok(ids.length >= 40, "self-check uses prefixed IDs");
    const seen = new Set();
    for (const [prefix, number] of ids) {
      const key = `${prefix}${number}`;
      assert.ok(!seen.has(key), `self-check ID ${key} is unique`);
      seen.add(key);
    }
    for (const prefix of ["S", "A", "R", "I", "F"]) {
      const numbers = ids.filter(([p]) => p === prefix).map(([, n]) => n).sort((a, b) => a - b);
      assert.deepEqual(numbers, numbers.map((_, index) => index + 1), `${prefix} IDs are contiguous`);
    }

    assert.doesNotMatch(texts["SKILL.md"], /\| Card \| Workflow \|/, "the skill has no selection table");
    assert.match(
      texts["SKILL.md"],
      /references\/architecture-workflow\.md/,
      "the skill points at the architecture branch",
    );
    assert.match(
      texts["SKILL.md"],
      /references\/implementation-workflow\.md/,
      "the skill points at the implementation branch",
    );
    assert.match(
      texts["SKILL.md"],
      /references\/refactor-workflow\.md/,
      "the skill points at the refactor branch",
    );

    const arch = texts["references/architecture-workflow.md"];
    const step2 = arch.slice(arch.indexOf("### 2."), arch.indexOf("### 3."));
    assert.match(step2, /Create[^.]*chooses and records/i, "Create chooses the stack");
    assert.match(step2, /Extend[^.]*foundation gap/i, "Extend is the missing-table gap");
    assert.doesNotMatch(step2, /missing[^.]*mode is create/i, "Create is not asked for an inherited table");
    const step8 = arch.slice(arch.indexOf("### 8."), arch.indexOf("### 9."));
    assert.match(step8, /ask through the board/i, "the E5 review asks through the board");
    assert.doesNotMatch(step8, /agent question|in_progress/i, "the E5 review leaves board mechanics to the skill");

    assert.match(check, /committed regression test/i, "the self-check requires the regression test");
    assert.match(check, /follow-up card/i, "Turing verification is a follow-up");
    assert.doesNotMatch(check, /Turing's required regression evidence/, "the old delivery claim is gone");
    assert.match(check, /no-card run/i, "the no-card run is named");
    assert.match(check, /≥80%/, "the coverage floor is a floor");
    for (const name of [
      "references/architecture-workflow.md",
      "references/implementation-workflow.md",
      "references/refactor-workflow.md",
    ]) {
      assert.match(texts[name], /DELIVERY_NEEDS_COMMIT/, `${name} names the delivery gate`);
      assert.match(texts[name], /`commit` anchor/, `${name} requires the commit anchor`);
    }

    const ceilings = {
      "SKILL.md": 120,
      "references/architecture-workflow.md": 460,
      "references/implementation-workflow.md": 140,
      "references/refactor-workflow.md": 160,
    };
    for (const [name, ceiling] of Object.entries(ceilings)) {
      const lines = texts[name].split("\n").length;
      assert.ok(lines <= ceiling, `${name} stays under ${ceiling} lines (${lines})`);
    }
    assert.ok(check.split("\n").length <= 180, "self-check stays under 180 lines");
    for (const [name, text] of Object.entries({ ...texts, selfCheck: check })) {
      assert.doesNotMatch(text, /\| Must contain \| Done when \|/, `${name} has no manual table`);
    }

    for (const [name, text] of Object.entries({ ...texts, selfCheck: check })) {
      if (/card|acceptance|deliver|claim|heartbeat|brief/i.test(text)) {
        assert.match(
          text,
          /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
          `${name} points at the board skill`,
        );
      }
      assert.doesNotMatch(
        text,
        /re-export|card\.md|agent question|in_progress/,
        `${name} leaves board mechanics to the skill`,
      );
    }
  });

  it("keeps the Jobs flows step-navigable, concise and board-delegated", () => {
    const workflow = read("jobs");
    const ui = read("jobs", "references/ui-workflow.md");
    const check = read("jobs", "references/self-check.md");
    const texts = { "SKILL.md": workflow, "references/ui-workflow.md": ui, "references/self-check.md": check };

    for (const [name, text] of [["SKILL.md", workflow], ["references/ui-workflow.md", ui]]) {
      assert.ok(text.includes("## Steps at a glance"), `${name} opens with a step list`);
      const start = text.indexOf("## Steps at a glance");
      const glance = text.slice(start, text.indexOf("\n## ", start + 1));
      const listed = [...glance.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
      const headings = [...text.matchAll(/^### (\d+)\. /gm)].map((match) => Number(match[1]));
      assert.deepEqual(listed, [1, 2, 3, 4, 5, 6], `${name} lists six steps`);
      assert.deepEqual(listed, headings, `${name} step list matches its headings`);
    }
    assert.match(ui, /## Phase 1/, "the prototype flow has a planning phase");
    assert.match(ui, /## Phase 2/, "the prototype flow has a design phase");

    for (const [name, text] of [["SKILL.md", workflow], ["references/ui-workflow.md", ui]]) {
      for (const block of text.split(/^### \d+\. /m).slice(1)) {
        assert.match(block, /\*\*Purpose\.\*\*/, `${name} step has a purpose`);
        assert.match(block, /\*\*Watch for\.\*\*/, `${name} step has a watch-for`);
        assert.match(block, /\*\*Essentials\.\*\*/, `${name} step has essentials`);
      }
    }

    const ceilings = { "SKILL.md": 230, "references/ui-workflow.md": 150, "references/self-check.md": 130 };
    for (const [name, ceiling] of Object.entries(ceilings)) {
      const lines = texts[name].split("\n").length;
      assert.ok(lines <= ceiling, `${name} stays under ${ceiling} lines (${lines})`);
    }

    for (const [name, text] of Object.entries(texts)) {
      assert.match(
        text,
        /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
        `${name} delegates card operations to the board skill`,
      );
      assert.doesNotMatch(
        text,
        /re-export|card\.md|agent question|in_progress|--as-human|TASKCTL_HUMAN|report template/,
        `${name} leaves board mechanics to the skill`,
      );
    }
    assert.match(workflow, /not one card per layer/i);
    assert.match(check, /one child per layer` is a mis-size/i);
  });

  it("keeps the reviewer workflow step-navigable, concise and board-delegated", () => {
    const workflow = read("reviewer");
    const protocol = read("reviewer", "references/review-protocol.md");
    const check = read("reviewer", "references/self-check.md");

    const start = workflow.indexOf("## Steps at a glance");
    assert.ok(start >= 0, "the reviewer workflow opens with a step list");
    const glance = workflow.slice(start, workflow.indexOf("\n## ", start + 1));
    const listed = [...glance.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    const headings = [...protocol.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(listed, headings, "the glance list matches the protocol headings");

    for (const block of protocol.split(/^## \d+\. /m).slice(1)) {
      assert.match(block, /\*\*Purpose\.\*\*/, "the step names its purpose");
      assert.match(block, /\*\*Watch for\.\*\*/, "the step names what to watch");
      assert.match(block, /\*\*Do\.\*\*/, "the step names what to do");
    }
    assert.ok(workflow.split("\n").length <= 120, "the reviewer skill stays a thin router");
    assert.ok(protocol.split("\n").length <= 170, "the protocol carries the procedure");
    assert.ok(check.split("\n").length <= 35, "the pre-verdict audit stays concise");
    assert.match(
      workflow,
      /`meerkat`[^\n]*(board skill|card operation)/,
      "card operations are delegated to the board skill",
    );
    assert.match(protocol, /`meerkat`[^\n]*(board skill|card operation)/, "the protocol delegates too");
    assert.match(check, /security-checklist\.md/, "the audit walks the checklist");
  });

  it("ships the scenario taxonomy and the project extension", () => {
    const universal = read("reviewer");
    const protocol = read("reviewer", "references/review-protocol.md");
    const index = read("reviewer", "references/scenarios/README.md");
    const scenarioDir = join(roleDir("reviewer"), "references", "scenarios");
    const names = [
      "product-plan",
      "prototype",
      "development",
      "test-design",
      "test-execution",
      "epic-rollup",
      "generic",
    ];
    const scenarios = names.map((name) => read("reviewer", `references/scenarios/${name}.md`));

    for (const [name, text] of [
      ["references/reviewer-handoff.md", read("reviewer", "references/reviewer-handoff.md")],
      ["references/self-check.md", read("reviewer", "references/self-check.md")],
      ["role.json", read("reviewer", "role.json")],
    ]) assert.match(text, /SKILL\.md/, `${name} points at the universal floor`);

    for (const name of names) {
      assert.ok(existsSync(join(scenarioDir, `${name}.md`)), `the ${name} scenario ships`);
      assert.ok(universal.includes(`references/scenarios/${name}.md`), `SKILL.md routes to ${name}`);
    }
    for (let i = 0; i < names.length; i += 1) {
      const [name, text] = [names[i], scenarios[i]];
      assert.match(text, /review-protocol\.md/, `${name} points at the protocol`);
      assert.match(text, /\*\*Applies to:\*\*/, `${name} names when it applies`);
      assert.match(text, /## Checks/, `${name} names its checks`);
      assert.match(text, /## Blocks APPROVE/, `${name} names what blocks`);
      assert.match(
        text,
        /`meerkat`[^\n]*(board skill|card operation)/,
        `${name} delegates card operations`,
      );
    }

    // The generic floor is the fallback for any event, not only product and engineering.
    const generic = read("reviewer", "references/scenarios/generic.md");
    assert.match(generic, /any delivered card no built-in scenario names/i);
    for (const domain of [
      "legal",
      "finance",
      "procurement",
      "operations",
      "communication",
      "incident",
    ]) {
      assert.match(generic, new RegExp(domain, "i"), `the generic floor covers ${domain}`);
    }
    for (const question of ["authority", "Completeness", "Provenance", "Consistency", "Risk", "audience"]) {
      assert.match(generic, new RegExp(question, "i"), `the generic floor asks ${question}`);
    }

    // The named scenarios refine the universal floor; they never scope it.
    assert.match(universal, /refinement index, not a scope/i);
    assert.match(universal, /a type no scenario names, or a\s+mixed type/i);
    assert.match(universal, /the floor is mandatory/i);
    assert.match(universal, /the loop routes review cards only/i);
    assert.match(universal, /project's own standards/i);
    assert.match(universal, /not itself a REJECT/i);
    assert.match(universal, /floor, not a ceiling/i);
    assert.match(universal, /any read-only method/i);
    assert.match(universal, /record every extra check/i);
    assert.match(universal, /surface a real problem even outside the list/i);
    assert.match(universal, /extra finding blocks `APPROVE`/i);
    assert.match(universal, /n\/a — <reason>/i);
    for (const status of ["met", "partial", "not_met", "not_applicable"]) {
      assert.match(universal, new RegExp(`\\b${status}\\b`), `the universal floor names ${status}`);
    }
    assert.match(universal, /epic\s*\/\s*rollup/i, "the universal floor keeps epic/rollup");

    // The project extension: one directory, no manifest, add-only precedence.
    assert.match(universal, /docs\/agents\/review-scenarios\//, "SKILL.md names the project directory");
    assert.match(universal, /setup-meerkat/, "SKILL.md names the only writer of project scenarios");
    assert.match(universal, /never weakens the protocol or the verdict rule/i);
    assert.match(protocol, /docs\/agents\/review-scenarios\//, "the protocol applies project scenarios");
    assert.match(index, /Project-defined scenarios/);
    assert.match(index, /no manifest, registry or configuration key/i);
    assert.match(index, /Applies to:/);
    assert.match(index, /never weakens independence/i);
    assert.match(index, /Only the human decision ladder can waive a gate/i);
    assert.match(index, /A delivery cannot loosen its own review/i);
    assert.match(index, /git show <sha>\^:<path>/);
    assert.match(index, /setup-meerkat/, "the project scenario writer is setup-meerkat");
    assert.match(index, /only\*\* writer|only writer/i, "setup-meerkat alone writes project scenarios");
    assert.match(
      index,
      /names the directory and every file in it/i,
      "the instruction entry names every scenario file",
    );

    // The plan-quality refinement is defined once; the scenarios that carry a plan apply it.
    assert.match(protocol, /Plan-quality refinement/);
    for (const name of ["product-plan", "development", "test-design"]) {
      assert.match(
        read("reviewer", `references/scenarios/${name}.md`),
        /plan-quality refinement/i,
        `${name} applies the plan-quality refinement`,
      );
    }
    assert.doesNotMatch(scenarios.join("\n"), /goal → acceptance → step → proof/i, "the three axes live once");

    // The delivered-commit lane and the concurrency rule live in the protocol.
    assert.match(protocol, /git -C/);
    assert.match(protocol, /git diff <sha>\^ <sha>|git show <sha> --/);
    assert.match(protocol, /target[^.]*worktree|original[^.]*worktree/i);
    assert.match(protocol, /parallel|concurren/i);
    assert.match(protocol, /primary checkout/i);
    assert.match(protocol, /shared tree/i);
    const all = [universal, protocol, index, ...scenarios].join("\n");
    assert.doesNotMatch(all, /\.worktrees\//);
    assert.match(universal, /git -C/);
    assert.match(read("reviewer", "references/reviewer-handoff.md"), /git -C/);

    // The verdict rule and dispositions live in SKILL.md.
    assert.match(universal, /`APPROVE` only when/i);
    assert.match(universal, /Otherwise `REJECT`/i);
    assert.match(universal, /Blocking:/);
    assert.match(universal, /Observation:/);
    assert.match(universal, /leftover/i);
    assert.match(universal, /open check/i);
    assert.match(universal, /missing acceptance item\s+is a `REJECT`/i);
    assert.match(universal, /subjective preference/i);
    assert.match(universal, /Risk acceptance belongs to the human/i);
    assert.match(universal, /falsifiable/i);

    // Development keeps the code-specific checks; the project scenario keeps the
    // repository's own commands.
    const development = read("reviewer", "references/scenarios/development.md");
    assert.match(
      development,
      /nine independent audit passes/i,
      "the development floor works its nine checks as nine passes",
    );
    for (const [subject, pattern] of [
      ["unit tests", /unit test/i],
      ["integration tests", /integration test/i],
      ["the contract", /contract/i],
      ["architecture standards", /architecture/i],
      ["technical standards", /technical standard/i],
      ["code review", /code review/i],
      ["the security scan", /security scan/i],
    ]) assert.match(development, pattern, `the development floor names ${subject}`);
    const project = readFileSync(join(ROOT, "docs/agents/review-scenarios/meerkat.md"), "utf8");
    for (const command of [
      "scripts/verify/contract.mjs",
      "route-request.mjs",
      "cli-contract.mjs",
      "scan-gate.mjs",
    ]) assert.ok(project.includes(command), `the project scenario names ${command}`);

    assert.match(universal, /security-checklist\.md/);
    assert.match(protocol, /security-checklist\.md/);
    assert.match(universal, /surface security check/i);
    assert.match(read("reviewer", "references/reviewer-handoff.md"), /a floor/i);
    assert.match(read("reviewer", "references/reviewer-handoff.md"), /surface (security )?check/i);
    assert.match(read("reviewer", "role.json"), /floor/i);

    assert.ok(universal.split("\n").length <= 120, "the reviewer skill stays a thin router");
    assert.ok(protocol.split("\n").length <= 170, "the protocol stays navigable");
    assert.ok(generic.split("\n").length <= 70, "the generic floor stays compact");
    assert.ok(development.split("\n").length <= 80, "the development floor stays compact");
    assert.ok(index.split("\n").length <= 90, "the scenario index stays compact");
  });

  it("keeps project mechanics out of the specialist role files", () => {
    // Worker is the fallback: its SKILL names the read command that fetches the card.
    // Its board delegation and landing limits are asserted separately below.
    const files = ["jobs", "linus", "turing", "reviewer"].flatMap((role) => [
      [role, "SKILL.md"],
      ...[
        "references/architecture-workflow.md",
        "references/implementation-workflow.md",
        "references/refactor-workflow.md",
        "references/self-check.md",
        "references/ui-workflow.md",
        "references/test-design-workflow.md",
        "references/regression-workflow.md",
        "references/performance-workflow.md",
        "references/reviewer-handoff.md",
        "references/security-checklist.md",
        "references/review-protocol.md",
        "references/scenarios/README.md",
        "references/scenarios/product-plan.md",
        "references/scenarios/prototype.md",
        "references/scenarios/development.md",
        "references/scenarios/test-design.md",
        "references/scenarios/test-execution.md",
        "references/scenarios/epic-rollup.md",
        "references/scenarios/generic.md",
      ]
        .filter((rel) => existsSync(join(roleDir(role), rel)))
        .map((rel) => [role, rel]),
    ]);
    const banned = /\bgit (?:worktree|merge|branch|checkout)\b|--no-ff|branch -d|\btaskctl\b|\bissue (?:create|move|get|update|deliver|heartbeat|assign)\b|\bcomment add\b|\brelation add\b|\battachment (?:download|list)\b|`\/init`|\bnpm run\b|\bdocker\b|\bpodman\b|\bsystemctl\b|\blaunchctl\b|\bcore\.hooksPath\b/;
    for (const [role, rel] of files) {
      assert.doesNotMatch(
        read(role, rel),
        banned,
        `${role}/${rel} must describe the task process, not project mechanics`,
      );
    }
  });

  it("points every card-operation passage at the meerkat board skill", () => {
    // The role files are read by workers that may never see the board skill in a skill
    // list. A pointer that names it is what makes the delegation executable under every
    // actor kind, including codex and pi. Worker's fallback prose is asserted separately.
    const files = ["jobs", "linus", "turing", "reviewer"].flatMap((role) => [
      [role, "SKILL.md"],
      ...[
        "references/architecture-workflow.md",
        "references/implementation-workflow.md",
        "references/refactor-workflow.md",
        "references/self-check.md",
        "references/ui-workflow.md",
        "references/test-design-workflow.md",
        "references/regression-workflow.md",
        "references/performance-workflow.md",
        "references/reviewer-handoff.md",
        "references/review-protocol.md",
        "references/scenarios/README.md",
        "references/scenarios/product-plan.md",
        "references/scenarios/prototype.md",
        "references/scenarios/development.md",
        "references/scenarios/test-design.md",
        "references/scenarios/test-execution.md",
        "references/scenarios/epic-rollup.md",
        "references/scenarios/generic.md",
      ]
        .filter((rel) => existsSync(join(roleDir(role), rel)))
        .map((rel) => [role, rel]),
    ]);
    for (const [role, rel] of files) {
      const text = read(role, rel);
      if (!/card\.md|acceptance|deliver|claim|heartbeat|brief/i.test(text)) continue;
      assert.match(
        text,
        /`meerkat`[^\n]*(board skill|card operation|card brief)/i,
        `${role}/${rel} mentions a card operation but does not point at the meerkat board skill`,
      );
    }
  });

  it("keeps the reviewer's only tool restriction to the write tools", () => {
    // A rule the lane cannot execute is a rule the reviewer learns to skip. The
    // reviewer runs the project's gate itself, so its deny list may name only
    // the file-edit tools — never a command surface.
    const denied = reviewerDeniedTools("claude");
    assert.match(denied, /\bEdit\b/);
    assert.match(denied, /\bWrite\b/);
    assert.match(denied, /\bNotebookEdit\b/);
    assert.doesNotMatch(denied, /Bash|node|npm|git|Agent/, "commands and subagents stay available");
  });

  it("runs the Worker fallback through plan, adopt, audit, execute, self-check and deliver", () => {
    const worker = read("worker");
    assert.match(worker, /plan, adopt the plan, execute, self-check and deliver/i);
    assert.match(worker, /Board operations[\s\S]{0,200}`meerkat`\s+board skill/i, "it delegates the board");
    assert.match(worker, /Write or adopt the plan/i);
    assert.match(worker, /Audit the plan before work/i);
    assert.match(worker, /Execute the smallest correct change/i);
    assert.match(worker, /references\/self-check\.md/);
    assert.match(worker, /Deliver with evidence/i);
    assert.match(worker, /acceptance_mode/, "the card's acceptance mode closes it");
    assert.match(worker, /landing and cleanup belong to the supervisor's acceptance pass/i);

    const check = read("worker", "references/self-check.md");
    for (const item of ["met", "not_applicable", "partial", "not_met", "leftover"]) {
      assert.ok(check.includes(item), `the Worker self-check names ${item}`);
    }
    assert.match(check, /`commit` anchor/, "the Worker self-check requires the commit anchor");
  });
});

describe("security: Linus owns the toolchain, the reviewer owns the checklist", () => {
  it("ships the reviewer's manual security checklist", () => {
    const checklist = read("reviewer", "references/security-checklist.md");
    const lines = checklist.split("\n").length;
    assert.ok(lines >= 50 && lines <= 90, `the checklist stays compact (got ${lines} lines)`);
    for (const needle of [
      "OWASP Top 10",
      "OWASP ASVS",
      "not_met",
      "n/a —",
      "floor, not a ceiling",
      "any available read-only method",
      "can block APPROVE",
    ]) {
      assert.ok(checklist.includes(needle), `the checklist names ${needle}`);
    }
    assert.match(checklist, /surface[^.]*security check|security check[^.]*surface/i);
    assert.match(
      checklist,
      /`docs\/tech-spec\.md`[\s\S]{0,200}\*\*L2\*\*/,
      "Tier 3 reads the project's level and defaults to L2",
    );
    for (let i = 1; i <= 10; i += 1) assert.match(checklist, new RegExp(`A0?${i}\\b`));
    for (let i = 1; i <= 14; i += 1) assert.match(checklist, new RegExp(`\\bV${i}\\b`));
  });

  it("ships the free-tool matrix and its checker with Linus", () => {
    const matrix = JSON.parse(read("linus", "assets/security/toolchain.json"));
    assert.equal(matrix.version, 1);
    assert.ok(matrix.arms["dependency-audit"] && matrix.arms["secret-scan"] && matrix.arms.sast);
    assert.ok(existsSync(join(roleDir("linus"), "references", "security-tools.md")), "the matrix is documented");
    assert.ok(existsSync(join(roleDir("linus"), "scripts", "security-tools.mjs")), "the check ships with the skill");
    for (const [arm, entry] of Object.entries(matrix.arms)) {
      assert.ok(Array.isArray(entry.ciMatch) && entry.ciMatch.length > 0, `${arm} names its CI tokens`);
      assert.ok(
        existsSync(join(roleDir("linus"), "assets", "security", entry.ciAsset)),
        `${arm}'s generated workflow ${entry.ciAsset} ships with the skill`,
      );
    }
  });

  it("points the reviewer at the manual checklist from every copy", () => {
    for (const rel of [
      "SKILL.md",
      "references/reviewer-handoff.md",
      "references/self-check.md",
    ]) {
      assert.match(read("reviewer", rel), /security-checklist\.md/, `${rel} points at the checklist`);
    }
    assert.ok(
      roleJson("reviewer").responsibilities.some((line) => /security-checklist\.md/.test(line)),
      "the reviewer's responsibility names the checklist",
    );
  });

  it("checks the security toolchain and installs only on request", () => {
    const doc = read("linus", "references/security-tools.md");
    assert.match(doc, /security-tools\.mjs/);
    assert.match(doc, /--check/);
    assert.match(doc, /--install/);
    assert.match(doc, /--upgrade/);
    assert.match(doc, /read-only and offline/i, "the check never installs on its own");
    assert.match(doc, /--ci-plan/);
    assert.match(doc, /--ci-write/);
    assert.match(doc, /assets\/security\/toolchain\.json/);
  });

  it("asks about a CI security gap only when a pipeline exists", () => {
    const doc = read("linus", "references/security-tools.md");
    assert.match(doc, /CI coverage/, "the matrix names the CI question");
    assert.match(doc, /missing/i, "the question is limited to the missing arms");
    assert.match(doc, /no CI file at all is `absent`/i, "an absent pipeline is reported, not this skill's finding");
    assert.match(doc, /SBOM/, "the optional arm is named as optional");
    assert.match(doc, /existing file is preserved/i, "an existing file is never overwritten");
    assert.match(doc, /everywhere else/i, "a non-GitHub pipeline is still served");
    assert.match(doc, /No per-provider template ships/i, "the addition is composed, not templated");
    assert.match(doc, /Change the fewest lines/i, "an in-place edit stays minimal");
  });

  it("makes the security toolchain record its decision policy, not only its tools", () => {
    const arch = read("linus", "references/architecture-workflow.md");
    const section = arch.slice(arch.indexOf("#### Security toolchain"));
    assert.match(section, /recorded threshold/i, "the block threshold is the project's, not the template's");
    assert.match(section, /waiver window/i);
    assert.match(section, /exit code/i);

    const row = arch.split("\n").find((line) => line.startsWith("| Security toolchain |"));
    assert.ok(row, "the tech-spec table has a Security toolchain row");
    assert.match(row, /block threshold/i);
    assert.match(row, /exit-code/i);
  });
});

describe("card-session system prompts: one static body per lane", () => {
  const WORKER_LANE = ["jobs", "linus", "turing", "worker"];

  it("ships a non-empty, bounded system_prompt in every role.json", () => {
    for (const role of ROLES) {
      const prompt = roleJson(role).system_prompt;
      assert.ok(typeof prompt === "string" && prompt.trim() !== "", `${role}: system_prompt is required`);
      assert.ok(Buffer.byteLength(prompt, "utf8") <= 8 * 1024, `${role}: system_prompt stays under 8 KiB`);
    }
  });

  it("keeps the four worker-lane bodies identical and the reviewer's different", () => {
    const bodies = WORKER_LANE.map((role) => roleJson(role).system_prompt);
    assert.equal(new Set(bodies).size, 1, "a worker-lane drift guard: one static body");
    assert.notEqual(roleJson("reviewer").system_prompt, bodies[0], "the reviewer has its own body");
  });

  it("states the board moves the session needs in the static body", () => {
    const worker = roleJson("linus").system_prompt;
    assert.match(worker, /heartbeat/i);
    assert.match(worker, /10 minutes/);
    assert.match(worker, /in_review/);
    assert.match(worker, /issue wait/);
    const reviewer = roleJson("reviewer").system_prompt;
    assert.match(reviewer, /VERDICT: APPROVE/);
    assert.match(reviewer, /VERDICT: REJECT/);
    assert.match(reviewer, /Step 0/);
  });
});

describe("role prompts: positive language", () => {
  const NEGATIVE = /\b(?:do not|don't|never|must not|cannot|can't)\b/i;

  /** The `Hard limits` / `Hard boundaries` / `Limits` section of a role skill. */
  function limitsSection(skillMd) {
    const lines = skillMd.split("\n");
    const start = lines.findIndex((line) => /^## (?:Hard limits|Hard boundaries|Limits)\b/.test(line));
    assert.notEqual(start, -1, "the role skill names its limits section");
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^## /.test(lines[index])) {
        end = index;
        break;
      }
    }
    return lines.slice(start + 1, end).join("\n");
  }

  it("keeps role.json responsibilities, boundaries and system_prompt positive", () => {
    for (const role of ROLES) {
      const identity = roleJson(role);
      const fields = [
        ...identity.responsibilities.map((line, index) => [`responsibilities[${index}]`, line]),
        ...identity.boundaries.map((line, index) => [`boundaries[${index}]`, line]),
        ["system_prompt", identity.system_prompt],
      ];
      for (const [field, text] of fields) {
        assert.doesNotMatch(text, NEGATIVE, `${role}.${field}: ${text}`);
      }
    }
  });

  it("keeps the SKILL.md limits section positive", () => {
    for (const role of ROLES) {
      const section = limitsSection(read(role));
      assert.doesNotMatch(section, NEGATIVE, `${role}: the limits section reads as positive actions`);
    }
  });

  /**
   * Uses of a negative word that carry no instruction: the plan's `Role skill` rewrite
   * keeps a rhetorical principle ("X, never Y"), a capability limit and a stated failure
   * mode out of the rewrite. Every entry names one of those reasons; anything else in a
   * reference must read as a positive action, so a new `Do not …` cannot hide behind
   * prose the role loads before it acts.
   */
  const REFERENCE_ALLOW = new Map([
    [
      "linus/references/architecture-workflow.md",
      [
        /never adds machinery/i, // rhetorical principle (CLAUDE.md conflict ordering)
        /never a silent edit/i, // rhetorical: a rule changes by recorded decision
      ],
    ],
    [
      "linus/references/implementation-workflow.md",
      [
        /never adds machinery/i, // rhetorical principle (CLAUDE.md conflict ordering)
        /never silent drift/i, // rhetorical: a departure is a recorded decision
      ],
    ],
    [
      "linus/references/refactor-workflow.md",
      [
        /never in what it does/i, // rhetorical: refactoring preserves behaviour
        /cannot fail/i, // definitional: a pinning test proves it can fail
      ],
    ],
  ]);

  it("keeps every role reference positive, with the plan's rhetorical exceptions named", () => {
    for (const role of ROLES) {
      const references = join(roleDir(role), "references");
      const files = readdirSync(references)
        .filter((name) => name.endsWith(".md"))
        .sort();
      assert.ok(files.length > 0, `${role}: references/ has prose to scan`);
      for (const name of files) {
        const rel = `references/${name}`;
        const allowed = REFERENCE_ALLOW.get(`${role}/${rel}`) ?? [];
        const lines = read(role, rel).split("\n");
        lines.forEach((line, index) => {
          if (!NEGATIVE.test(line)) return;
          assert.ok(
            allowed.some((pattern) => pattern.test(line)),
            `${role}/${rel}:${index + 1}: state the positive action, or name the rhetorical ` +
              `exception in REFERENCE_ALLOW: ${line.trim()}`,
          );
        });
      }
    }
  });
});
