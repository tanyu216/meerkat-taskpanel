/**
 * The `meerkat-loop` skill (T-20261012-163500-loopdecouple-b).
 *
 * The loop used to be an implicit side effect of installing the board skill. Its
 * implementation now lives in `src/orchestrator/` (reached through `taskctl loop …`),
 * and the skill carries decisions only: `SKILL.md` plus its references.
 *
 * These tests hold the things that make that split real rather than cosmetic:
 *
 *   1. the skill carries a charter, not a second implementation — no scripts, templates
 *      or manifest;
 *   2. the skill declares the board interface it needs, and `taskctl loop compat`
 *      enforces it against a board's own `--version --json` answer;
 *   3. the board skill no longer points into the repository root — a distributed skill's
 *      links have to resolve where the skill is installed, not where it was authored.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";
import { LOOP_SKILL_COMMAND } from "../../src/foundation/scheduling.mjs";
import { acceptanceAllows } from "../../src/core/domain/acceptance-mode.mjs";
import {
  ALLOWED_TRANSITIONS,
  EPIC_ONLY_TRANSITIONS,
} from "../../src/core/domain/status.mjs";
import { STATUSES } from "../../src/core/domain/enums.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOOP_SKILL = join(ROOT, "skills", "meerkat-loop");
const LOOP_SKILL_NAME = "meerkat-loop";

describe("loop skill: docs only", () => {
  it("carries SKILL.md and its references, and no execution body", () => {
    assert.ok(existsSync(join(LOOP_SKILL, "SKILL.md")), "the skill must keep its prompt");
    assert.ok(existsSync(join(LOOP_SKILL, "references", "operation.md")), "its references must land");
    for (const retired of ["manifest.txt", "scripts", "templates", "src", "body"]) {
      assert.equal(
        existsSync(join(LOOP_SKILL, retired)),
        false,
        `the loop ships with the toolkit; the skill must not carry ${retired}`,
      );
    }
  });
});

describe("loop skill: SKILL.md", () => {
  const text = readFileSync(join(LOOP_SKILL, "SKILL.md"), "utf8");

  it("has frontmatter naming the skill with a real description", () => {
    assert.equal(readFrontmatterField(text, "name"), LOOP_SKILL_NAME);
    const description = readFrontmatterField(text, "description");
    assert.ok(typeof description === "string" && description.length >= 20, "description must be substantial");
  });

  it("is command-only: the model may not invoke it by description", () => {
    assert.equal(readFrontmatterField(text, "disable-model-invocation"), "true");
  });

  it("documents explicit invocation and takes no argument placeholder", () => {
    assert.match(text, /^#{2,3} Invocation$/m);
    assert.match(text, /\/meerkat-loop/);
    assert.equal(text.includes("$ARGUMENTS"), false);
  });

  it("points the continue prompt at this skill's command", () => {
    assert.equal(LOOP_SKILL_COMMAND, `/${LOOP_SKILL_NAME}`);
  });

  it("documents one control turn with two drivers, and the live-session console", () => {
    const begin = text.indexOf("### Execution modes");
    assert.notEqual(begin, -1, "the two execution modes must have their own section");
    const next = text.indexOf("\n### ", begin + 1);
    const section = text.slice(begin, next === -1 ? text.length : next);

    assert.match(section, /mode: supervised/);
    assert.match(section, /no marker/);
    assert.match(section, /taskctl loop status/);
    assert.match(section, /taskctl loop console/);
    assert.match(section, /--take-over/);
    assert.match(section, /--stop/);
    assert.match(section, /external-control/);
    assert.match(section, /--as-human/);
    assert.match(section, /re-read/);
    assert.match(section, /board UI/);
    assert.match(section, /duplicate/i);
    assert.match(section, /E1[–-]E5/);
    assert.match(section, /never claim/i);
  });

  it("makes supervisor mode headless: questions only as board comments", () => {
    assert.match(text, /mode: supervised/);
    assert.match(text, /headless/i);
    assert.match(text, /Never ask a question there/);
    assert.match(text, /board comment/i);
  });

  it("documents the live-session mode in operation.md", () => {
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /## Manual mode/);
    assert.match(operation, /taskctl loop status/);
    assert.match(operation, /taskctl loop console/);
    assert.match(operation, /--control=external/);
    assert.match(operation, /--as-human/);
    assert.match(operation, /re-read/);
    assert.match(operation, /UI/);
    assert.match(operation, /frontier/i);
    assert.match(operation, /one numbered block/i);
    assert.match(operation, /one card at a time/i);
    assert.match(operation, /backlog/);
    assert.match(operation, /blocked/);
  });

  it("walks the question queue one card at a time in manual mode", () => {
    const begin = text.indexOf("#### Manual mode");
    assert.notEqual(begin, -1, "manual mode must have its own sub-section");
    const next = text.indexOf("\n### ", begin + 1);
    const manual = text.slice(begin, next === -1 ? text.length : next);

    assert.match(manual, /frontier/i);
    assert.match(manual, /one card at a time/i);
    assert.match(manual, /one numbered block/i);
    assert.match(manual, /one question string/i);
    assert.match(manual, /Only a human comment resumes awaiting/);
    assert.match(manual, /backlog/i);
    assert.match(manual, /blocked/i);
    assert.match(manual, /60 s/);
    assert.match(manual, /settle what is knowable/i);
  });

  it("documents the decision round in the decision policy", () => {
    const policy = readFileSync(join(LOOP_SKILL, "references", "decision-policy.md"), "utf8");
    assert.match(policy, /## Decision rounds/);
    assert.match(policy, /frontier/);
    assert.match(policy, /Facts are the asker's job/i);
    assert.match(policy, /counterexample/i);
    assert.match(policy, /Only a human comment resumes/);
    assert.match(policy, /one question string/i);
    assert.doesNotMatch(policy, /wins over|takes precedence|replaces the loop/i);
  });

  it("makes the loop policy the single authority and names the ownership guide", () => {
    const begin = text.indexOf("### Team roles (optional)");
    assert.notEqual(begin, -1, "the team section must exist");
    const next = text.indexOf("\n### ", begin + 1);
    const section = text.slice(begin, next === -1 ? text.length : next);

    assert.match(section, /decision-policy\.md/, "the loop policy must be named");
    assert.match(section, /single|only|authoritative|cannot override|ignored/i, "its authority must be stated");
    assert.doesNotMatch(section, /replaces|wins over/i, "a team must not be said to override it");
    assert.match(section, /ownership\.md/, "the team's routing guide must be named");
    assert.match(section, /routing|assignee still selects/i, "the guide routes; the assignee executes");
  });

  it("declares the board interface it requires", () => {
    assert.match(text, /task-interface v1/, "the required board interface generation must be stated");
    assert.match(text, /board release >= 0\.1\.0/, "…and the release floor a machine can check");
    assert.ok(text.includes("taskctl loop compat"), "the gate must be named at the point of declaration");
  });

  it("keeps installation out of the skill, and ships no committed loop bundle", () => {
    assert.doesNotMatch(text, /install\.sh/, "the loop skill must not carry installation instructions");
    assert.doesNotMatch(text, /--supervisor=/, "the loop skill must not carry the supervisor opt-in");
    // No agent kind takes a generated copy of the loop: every harness reads the repository's own
    // skills/ tree. There is no loop bundle in the marketplace any more, and no `plugins/` tree
    // for one to live in (asserted against the checkout in test/scaffold.test.mjs, which is
    // where the "exactly one skills tree" invariant lives).
    assert.equal(
      existsSync(join(ROOT, "plugins")),
      false,
      "the loop ships through install.sh only — no committed bundle may carry it",
    );
  });

  it("records what the loop needs from its runtime tree, rather than implying it needs none", () => {
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /MEERKAT_TASKPANEL_REPO/);
    assert.match(operation, /runtime tree/);
  });

  it("documents the workflow alert ledger flag", () => {
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /--workflow-ledger/);
  });

  it("documents the task process directory and the read-only card brief", () => {
    assert.match(text, /\.meerkat\/<identifier>\//);
    assert.match(text, /authoritative brief/);
    assert.match(text, /never edit it/i);
    assert.match(text, /attachment/i, "the process directory still names attachments");
    assert.match(
      text,
      /`meerkat`[^\n]*(board skill|card operation|capabilit)/i,
      "the brief section delegates card operations to the meerkat board skill",
    );

    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /Register before claim/);
    assert.match(operation, /The hub refreshes every registered file/);
    assert.match(operation, /deferred\s+\*\*unclaimed\*\*|deferred\nunclaimed|deferred/);
    assert.match(
      operation,
      /`meerkat`[^\n]*(board skill|card operation|capabilit)/i,
      "operation.md delegates card operations to the meerkat board skill",
    );
  });

  it("delegates card writes to the meerkat board skill instead of restating its verbs", () => {
    const boardVerb = /\btaskctl (issue|comment|relation|report|attachment)\b/;
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    for (const [file, content] of [["SKILL.md", text], ["references/operation.md", operation]]) {
      assert.doesNotMatch(content, boardVerb, `${file} must not restate a board verb`);
    }
  });

  it("names the attachment download command in the board skill's CLI reference", () => {
    const cli = readFileSync(
      join(ROOT, "skills", "meerkat", "references", "cli.md"),
      "utf8",
    );
    assert.match(cli, /attachment download <attachment-id> --out <file>/);
    assert.match(cli, /--out \.meerkat\/PROJ-0007\/shot\.png/);
  });
});

describe("board skill: the description covers indirect card operations", () => {
  const text = readFileSync(join(ROOT, "skills", "meerkat", "SKILL.md"), "utf8");

  it("triggers on the briefing and delivery language the loop and roles use", () => {
    // A loop handoff or a role workflow rarely says "claim a card"; it says "read the
    // brief", "re-export card.md" or "deliver the card". The description is the only
    // trigger surface, so it must cover those phrasings, not just the direct commands.
    const description = readFrontmatterField(text, "description");
    assert.ok(typeof description === "string" && description.length > 0, "description exists");
    for (const anchor of [
      // The *format* is what a reader needs to recognise, not a filename:
      // `card.md` is the loop's location, and `export md --out` may name
      // anything. Accept any of the ways the description can say it.
      /card\.md|card file|export md/i,
      /re-export/i,
      /brief/i,
      /deliver/i,
      /heartbeat/i,
      /acceptance/i,
      /taskctl/i,
      /meerkat-loop|handoff|role/i,
    ]) {
      assert.match(description, anchor, `the description must cover ${anchor}`);
    }
  });
});

describe("board skill: references resolve where the skill is installed", () => {
  const skillDir = join(ROOT, "skills/meerkat");
  const references = readdirSync(join(skillDir, "references"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `references/${name}`);
  const files = ["SKILL.md", ...references];
  const read = (rel) => readFileSync(join(skillDir, rel), "utf8");

  it("has no link that climbs out of the skill into the repository root", () => {
    // `../../../docs/…` resolves in this checkout and dangles everywhere the skill is
    // actually installed — the plugin bundles carry `skills/<name>/` and nothing above it.
    // A distributed skill links out by absolute URL or not at all.
    for (const file of files) {
      const text = read(file);
      const climbing = [...text.matchAll(/\]\((\.\.\/[^)]*)\)/g)]
        .map((match) => match[1])
        .filter((target) => target.startsWith("../.."));
      assert.deepEqual(climbing, [], `${file}: links must not climb out of the skill`);
    }
  });

  it("has a real target for every relative link", () => {
    for (const file of files) {
      const text = read(file);
      const targets = [...text.matchAll(/\]\(([^)]+)\)/g)]
        .map((match) => match[1])
        .filter((target) => !/^(https?:|mailto:|#)/.test(target))
        .map((target) => target.split("#")[0])
        .filter((target) => target !== "");
      for (const target of targets) {
        assert.ok(
          existsSync(join(dirname(join(skillDir, file)), target)),
          `${file}: ${target} does not resolve`,
        );
      }
    }
  });

  it("resolves every #fragment against the target file's headings", () => {
    // GitHub's slug rules, as far as these pages use them: strip backticks and stars, keep
    // letters, digits, spaces, underscores and hyphens, then turn each space into a hyphen.
    // A punctuation run leaves the double hyphen that `policy × scope` produces.
    const slug = (heading) =>
      heading
        .trim()
        .toLowerCase()
        .replace(/[`*]/g, "")
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/ /g, "-");

    const headings = (text) => {
      const slugs = new Map();
      let fence = null;
      for (const line of text.split("\n")) {
        const marker = /^\s*(```|~~~)/.exec(line);
        if (marker !== null) {
          fence = fence === null ? marker[1] : fence === marker[1] ? null : fence;
          continue;
        }
        if (fence !== null) continue;
        const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading === null) continue;
        const base = slug(heading[1]);
        const seen = slugs.get(base) ?? 0;
        slugs.set(base, seen + 1);
        if (seen > 0) slugs.set(`${base}-${seen}`, 1);
      }
      return slugs;
    };

    const cache = new Map();
    const slugsFor = (path) => {
      if (!cache.has(path)) cache.set(path, headings(readFileSync(path, "utf8")));
      return cache.get(path);
    };

    for (const file of files) {
      for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:)/.test(target) || !target.includes("#")) continue;
        const [pathPart, fragment] = target.split("#");
        if (fragment === "") continue;
        const targetFile =
          pathPart === "" ? join(skillDir, file) : join(dirname(join(skillDir, file)), pathPart);
        assert.ok(existsSync(targetFile), `${file}: ${target} does not resolve`);
        assert.ok(slugsFor(targetFile).has(fragment), `${file}: ${target} is not a heading anchor`);
      }
    }
  });

  it("points the loop ownership it describes at the loop skill", () => {
    const text = read("SKILL.md");
    assert.match(text, /meerkat-loop/);
    assert.equal(text.includes("scripts/supervisor.mjs]("), false, "no relative link to the executor");
  });

  it("teaches the review workflow in the main prompt, not only in a reference", () => {
    const text = read("SKILL.md");
    assert.match(text, /review_of_id/, "the structural review marker is named");
    assert.match(text, /VERDICT/, "the verdict line is named");
    assert.match(text, /flow B/i, "the flow vocabulary is present");
    assert.match(
      text,
      /references\/review-workflow\.md/,
      "the main prompt links the full protocol",
    );
  });
});

describe("board skill: the status whitelist matches the domain", () => {
  const file = "references/status-lifecycle.md";

  function block(text, file) {
    const begin = text.indexOf("<!-- status-whitelist:begin -->");
    const end = text.indexOf("<!-- status-whitelist:end -->");
    assert.ok(begin >= 0 && end > begin, `${file}: missing status-whitelist markers`);
    return text.slice(begin, end);
  }

  function parse(raw, file) {
    const table = {};
    const epic = [];
    for (const line of raw.split("\n")) {
      if (!line.includes("→")) continue;
      const arrow = line.indexOf("→");
      const from = line
        .slice(0, arrow)
        .replace(/`/g, "")
        .trim()
        .split(/\s+/)[0];
      let right = line.slice(arrow + 1);
      const epicMatch = right.match(/\(an epic also →\s*([^)]+)\)/);
      if (epicMatch !== null) {
        epic.push([from, epicMatch[1].replace(/`/g, "").trim()]);
        right = right.replace(epicMatch[0], "");
      }
      if (/\(terminal\)/.test(right)) {
        table[from] = [];
        continue;
      }
      table[from] = right
        .split(",")
        .map((target) => target.replace(/`/g, "").trim())
        .filter((target) => target !== "");
    }
    assert.ok(Object.keys(table).length > 0, `${file}: no rows parsed`);
    return { table, epic };
  }

  it("has one home and re-encodes ALLOWED_TRANSITIONS with the epic overlay", () => {
    const skill = readFileSync(join(ROOT, "skills/meerkat/SKILL.md"), "utf8");
    assert.equal(
      skill.includes("<!-- status-whitelist:begin -->"),
      false,
      "the whitelist has exactly one home (status-lifecycle.md §2)",
    );
    assert.match(skill, /status-lifecycle\.md#2-the-whitelist/);

    const raw = block(readFileSync(join(ROOT, "skills/meerkat", file), "utf8"), file);
    const { table, epic } = parse(raw, file);
    for (const status of STATUSES) {
      assert.deepEqual(
        [...table[status]].sort(),
        [...ALLOWED_TRANSITIONS[status]].sort(),
        `${status} row`,
      );
    }
    assert.deepEqual(table.done, ["todo"]);
    assert.deepEqual(table.canceled, ["todo"]);
    assert.equal(epic.length, 1, "exactly one epic-only overlay");
    const [from, to] = epic[0];
    assert.ok(EPIC_ONLY_TRANSITIONS[from]?.includes(to), `epic overlay ${from} → ${to}`);
  });
});

describe("board skill: the acceptance matrix has one home", () => {
  const BEGIN = "<!-- acceptance-matrix:begin -->";
  const END = "<!-- acceptance-matrix:end -->";
  const copies = [
    ["status-lifecycle.md", join(ROOT, "skills/meerkat/references/status-lifecycle.md")],
    ["review-workflow.md", join(ROOT, "skills/meerkat/references/review-workflow.md")],
  ];

  /** The raw block between the markers, asserting the markers appear exactly once. */
  function marked(path) {
    const text = readFileSync(path, "utf8");
    const begin = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    assert.ok(begin >= 0 && end > begin, `${path}: missing acceptance-matrix markers`);
    assert.equal(text.indexOf(BEGIN, begin + 1), -1, `${path}: more than one begin marker`);
    return text.slice(begin + BEGIN.length, end);
  }

  const cells = (line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

  it("keeps both copies byte-identical after whitespace normalisation", () => {
    const blocks = copies.map(([, path]) => marked(path));
    for (let i = 1; i < blocks.length; i += 1) {
      assert.equal(
        blocks[i].replace(/\s+/g, " ").trim(),
        blocks[0].replace(/\s+/g, " ").trim(),
        `${copies[i][0]} and ${copies[0][0]} must agree`,
      );
    }
  });

  it("leaves the loop skill a charter, not another copy", () => {
    const loopSkill = readFileSync(join(LOOP_SKILL, "SKILL.md"), "utf8");
    assert.equal(loopSkill.includes(BEGIN), false, "the loop restates no matrix");
    assert.match(loopSkill, /acceptance_mode[^\n]*authoritative/i);
  });

  it("re-encodes the board's acceptance modes", () => {
    const raw = marked(copies[0][1]);
    const rows = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|") && !/^\|[\s:|-]+\|$/.test(line))
      .map(cells);
    assert.equal(rows.length, 5, "one header plus four modes");

    const data = rows.slice(1);
    const modes = data.map((row) => row[0].replace(/`/g, "").trim());
    assert.deepEqual(modes, ["off", "agent", "human", "a review card"]);

    // Each mode row's `done` cell is read against the domain's own predicate.
    // The two questions the matrix answers are "may a person?" and "may an agent
    // that is not the reviewer?" — the kind is no longer an allow-list.
    const cellAllows = (cell) => cell.replace(/`/g, "").toLowerCase();
    const admitsAnAgent = (cell) =>
      cell.includes("deliverer") || cell.includes("any actor kind") || cell.includes("anyone but the reviewer");
    for (const [index, mode] of ["off", "agent", "human"].entries()) {
      const cell = cellAllows(data[index][2]);
      assert.equal(cell.includes("human"), acceptanceAllows("human", mode), `${mode} × human`);
      assert.equal(
        admitsAnAgent(cell),
        acceptanceAllows("claude", mode, { actorId: "w1", verdictAuthorId: "r1" }),
        `${mode} × another agent`,
      );
    }

    const review = cellAllows(data[3][2]);
    assert.ok(review.includes("human") && review.includes("never"), "the verdict's author never closes it");
    assert.equal(
      acceptanceAllows("claude", "off", { reviewCard: true, actorId: "r1", verdictAuthorId: "r1" }),
      false,
      "never the reviewer",
    );
    assert.equal(
      acceptanceAllows("claude", "off", { reviewCard: true, actorId: "w1", verdictAuthorId: "r1" }),
      true,
      "another agent closes it after the verdict",
    );
  });
});

describe("board skill: the acceptance list rule", () => {
  const text = readFileSync(join(ROOT, "skills/meerkat/SKILL.md"), "utf8");

  it("reads the card as JSON and derives only when the list is empty", () => {
    assert.match(text, /issue get <ref> --json/);
    assert.match(text, /acceptance_derived=yes/);
    assert.match(text, /1[–-]6/);
    assert.match(text, /frozen/);
    assert.match(text, /never replace or remove/i);
  });

  it("says an epic's acceptance is its children", () => {
    assert.match(text, /epic[^\n]*child/i);
    assert.match(text, /rollup/);
  });
});

describe("board skill: the language of a card", () => {
  const text = readFileSync(join(ROOT, "skills/meerkat/SKILL.md"), "utf8");
  const section = text.slice(
    text.indexOf("## The language of a card"),
    text.indexOf("## Claim one card"),
  );

  it("decides the language from the conversation, not English by default", () => {
    // The board stores text verbatim, so the first writer sets the language of the whole
    // trail. A skill that says nothing leaves the model on its English default.
    assert.ok(section.length > 0, "the skill has a language section before the write workflow");
    assert.match(section, /not the default|never the default|not .{0,20}default/i);
    assert.match(section, /the human/i);
    assert.match(section, /conversation/i);
    for (const surface of ["title", "comment", "question", "report"]) {
      assert.match(section, new RegExp(surface, "i"), `the rule covers the ${surface}`);
    }
  });

  it("inherits the card's language when no human is in the session", () => {
    // A loop tick or a subagent has no human message to read, so the rule needs a fallback
    // chain; otherwise the "no human" case silently becomes the English default again.
    assert.match(section, /inherit/i);
    assert.match(section, /README|CLAUDE\.md|GLOSSARY/);
  });

  it("keeps the matching keys and the protocol literals verbatim", () => {
    // Acceptance coverage is matched by normalised text, so a translated item does not
    // match its baseline and the delivery is refused.
    assert.match(section, /matching key|matched[^.\n]*text/i);
    assert.match(section, /character for character|verbatim/i);
    assert.match(section, /VERDICT: APPROVE/);
    assert.match(section, /identifiers|command lines/i);
  });
});

describe("board skill: the container decision", () => {
  const skill = readFileSync(join(ROOT, "skills/meerkat/SKILL.md"), "utf8");
  const lifecycle = readFileSync(
    join(ROOT, "skills/meerkat/references/status-lifecycle.md"),
    "utf8",
  );

  it("does not promote a card that already delivered", () => {
    assert.match(skill, /current-round report/i);
    assert.match(skill, /do \*\*not\*\* promote/i);
    assert.match(lifecycle, /terminal container never rolls up/i);
  });

  it("takes rollup evidence from the children only", () => {
    assert.match(lifecycle, /children's, not the container's/i);
    assert.match(lifecycle, /delivery report/i);
  });

  it("leaves the board-enforced container codes to the refusal", () => {
    assert.doesNotMatch(skill, /CHILDREN_OPEN/);
    assert.doesNotMatch(skill, /ROLLUP_REQUIRED|ROLLUP_STALE/);
    assert.match(skill, /status-lifecycle\.md#6-containers-epic/);
  });

  it("names the shape limits where the card schema defines them", () => {
    const schema = readFileSync(
      join(ROOT, "skills/meerkat/references/card-schema.md"),
      "utf8",
    );
    assert.match(schema, /\*\*8\*\*\s+children/);
    assert.match(schema, /\*\*8\*\*\s+deep/);
  });

  it("sizes a child by what can land alone, not by layer", () => {
    // TP-0002 cut "enforce a 1-4 character prefix on every create path" into core,
    // CLI, web, docs and a fixture sweep. Three children could not land alone and
    // a sixth card existed only to pay the split's debt. The rule names the test.
    assert.match(skill, /land on the base branch alone/i);
    assert.match(skill, /leave the tree coherent/i);
    assert.match(skill, /1-4 character project prefix/i);
    assert.match(skill, /core, CLI, web, docs and fixtures/);
    assert.match(skill, /not a technical layer/i);
    assert.match(lifecycle, /not schema-enforced/i);
    assert.match(lifecycle, /\.\.\/SKILL\.md#containers-when-the-card-is-an-epic/);
  });
});
