/**
 * The `meerkat-director` skill — the decision hub.
 *
 * The director is opened only for a content decision: a worker question, an unowned
 * card, an accepted card's required handoff, or an E1–E5 escalation. Its charter is
 * decisions only: `SKILL.md` plus `references/decision-policy.md`. The taskctl
 * mechanics, the board's scheduling, and the human console are other surfaces and
 * must not be restated here.
 *
 * The second half of this file holds the board skill's own invariants (they used to
 * live beside the loop tests); a distributed skill's links must resolve where the
 * skill is installed, not where it was authored.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";
import { acceptanceAllows } from "../../src/core/domain/acceptance-mode.mjs";
import {
  ALLOWED_TRANSITIONS,
  EPIC_ONLY_TRANSITIONS,
} from "../../src/core/domain/status.mjs";
import { STATUSES } from "../../src/core/domain/enums.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIRECTOR_SKILL = join(ROOT, "skills", "meerkat-director");
const DIRECTOR_SKILL_NAME = "meerkat-director";

describe("director skill: docs only", () => {
  it("carries only its decision charter and policy, and no execution body", () => {
    assert.ok(existsSync(join(DIRECTOR_SKILL, "SKILL.md")), "the skill must keep its charter");
    assert.ok(
      existsSync(join(DIRECTOR_SKILL, "references/decision-policy.md")),
      "references/decision-policy.md must land",
    );
    assert.equal(
      existsSync(join(DIRECTOR_SKILL, "references/operation.md")),
      false,
      "the operator mechanics are not the director's charter",
    );
    for (const retired of ["manifest.txt", "scripts", "templates", "src", "body"]) {
      assert.equal(
        existsSync(join(DIRECTOR_SKILL, retired)),
        false,
        `the supervisor ships with the toolkit; the director must not carry ${retired}`,
      );
    }
  });
});

describe("director skill: SKILL.md", () => {
  const text = readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8");

  it("has frontmatter naming the skill with a real description", () => {
    assert.equal(readFrontmatterField(text, "name"), DIRECTOR_SKILL_NAME);
    const description = readFrontmatterField(text, "description");
    assert.ok(typeof description === "string" && description.length >= 20, "description must be substantial");
  });

  it("is command-only: the model may not invoke it by description", () => {
    assert.equal(readFrontmatterField(text, "disable-model-invocation"), "true");
  });

  it("takes no argument placeholder", () => {
    assert.equal(text.includes("$ARGUMENTS"), false);
  });

  it("names the four decisions and their moves", () => {
    assert.match(text, /`question`/);
    assert.match(text, /`route`/);
    assert.match(text, /`triage`/);
    assert.match(text, /escalation/i);
    assert.match(text, /note/i);
    assert.match(text, /assign/i);
    assert.match(text, /`awaiting`/);
    assert.match(text, /E1[–-]E5/);
  });

  it("states the decision boundary without restating the scheduler", () => {
    assert.match(text, /do not do the work/i);
    assert.match(text, /never claim a card/i);
    assert.match(text, /move a card to `done`/i);
    assert.doesNotMatch(
      text,
      /deterministic passes|patrol|workflow|poll|queue|row|attempt|retry|session|prompt/i,
    );
    assert.doesNotMatch(text, /taskctl/i);
  });

  it("names the ladder, the board contract and the single decision-authority source", () => {
    assert.match(text, /worker\s+→\s+director\s+→\s+human/);
    assert.match(text, /single decision-authority source/);
    assert.match(text, /references\/decision-policy\.md/);
    assert.match(
      text,
      /Call the `meerkat` board skill/,
      "the board contract is a call, not a passive reference",
    );
  });
});

describe("director skill: references", () => {
  it("documents the frontier and the E1-E5 table in the policy", () => {
    const policy = readFileSync(join(DIRECTOR_SKILL, "references", "decision-policy.md"), "utf8");
    assert.match(policy, /worker  →  director  →  human/);
    assert.match(policy, /E1/);
    assert.match(policy, /awaiting/);
    assert.match(policy, /Decision rounds/);
    assert.match(policy, /handoff_consumed_round/, "the triage marker has one home");
  });

  it("makes a project's own policy the refinement source for E1-E5", () => {
    const policy = readFileSync(join(DIRECTOR_SKILL, "references", "decision-policy.md"), "utf8");
    assert.match(policy, /docs\/agents\/decision-policy\.md/, "the project policy file is named");
    assert.doesNotMatch(
      policy,
      /docs\/decision-policy\.md/,
      "the top-level path is not discovered",
    );
    assert.match(policy, /item by item/i, "the override is item by item");
    assert.match(policy, /keeps its default/i, "unmentioned items keep the default");
    assert.match(policy, /`human` or `director`/, "a project entry names its decider");
    assert.match(policy, /unreadable[\s\S]*apply the default/i, "an unusable file falls back");
    assert.match(policy, /cannot add a code/i, "the E-code vocabulary is fixed");
    assert.match(policy, /ladder above[\s\S]*fixed/i, "the ladder cannot be overridden");
    assert.match(policy, /escalates only the items the decision map[\s\S]*leaves to the human/i);
    assert.match(policy, /create it only if the map gives E1 to the[\s\S]*director/i);
    assert.match(policy, /Record which source decided/i, "the deciding source is recorded");
  });

  it("carries no human-console or taskctl/scheduler mechanics", () => {
    // The human console is `meerkat-chat`'s, the commands are the board skill's,
    // and the scheduler is the supervisor's. The director's charter must not
    // restate any of them — not even as a pointer.
    const skill = readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8");
    const policy = readFileSync(join(DIRECTOR_SKILL, "references", "decision-policy.md"), "utf8");
    for (const [name, body] of [["SKILL.md", skill], ["decision-policy.md", policy]]) {
      assert.doesNotMatch(
        body,
        /meerkat-chat|human console|TASKCTL_HUMAN|--as-human|loop doctor|loop console/i,
        `${name}: the human console is not the director's`,
      );
      assert.doesNotMatch(
        body,
        /taskctl|issue (assign|move|wait|meta|create)|comment add|--agent|--actor-kind|--if-version|queue|poll|attempt|retry|settle|session|prompt|process directory|\.meerkat/i,
        `${name}: commands and scheduling are other surfaces`,
      );
    }
  });

  it("keeps installation out of the skill", () => {
    const skill = readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /install\.sh/);
    assert.doesNotMatch(skill, /--supervisor=/);
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
      /meerkat-director|handoff|role/i,
    ]) {
      assert.match(description, anchor, `the description must cover ${anchor}`);
    }
  });
});

describe("board skill: references resolve where the skill is installed", () => {
  const skillDir = join(ROOT, "skills/meerkat");

  /** Every markdown page under `references/`, recursively, relative to the skill root. */
  function referenceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...referenceFiles(path));
      else if (entry.endsWith(".md")) out.push(relative(skillDir, path));
    }
    return out;
  }

  const files = ["SKILL.md", ...referenceFiles(join(skillDir, "references"))];
  const read = (rel) => readFileSync(join(skillDir, rel), "utf8");

  it("has no link that climbs out of the installed skills tree into the repository", () => {
    // `../../../docs/…` resolves in this checkout and dangles everywhere the skill is
    // actually installed — the plugin bundles carry `skills/` and nothing above it.
    // A nested page may climb to its own skill root (`../../SKILL.md`) or to a sibling
    // skill that ships with it (`../meerkat-chat/SKILL.md`); it may not leave `skills/`.
    const skillsRoot = resolve(ROOT, "skills");
    for (const file of files) {
      const text = read(file);
      const targets = [...text.matchAll(/\]\((\.\.\/[^)]*)\)/g)].map((match) =>
        match[1].split("#")[0],
      );
      for (const target of targets) {
        const resolved = resolve(dirname(join(skillDir, file)), target);
        const inside =
          resolved === skillsRoot || resolved.startsWith(`${skillsRoot}/`);
        assert.ok(inside, `${file}: ${target} climbs out of the installed skills tree`);
      }
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

  it("points the decision ownership it describes at the director skill", () => {
    const text = read("SKILL.md");
    assert.match(text, /meerkat-director/);
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
  const file = "references/lifecycle/transitions.md";

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
      "the whitelist has exactly one home (lifecycle/transitions.md §2)",
    );
    assert.match(skill, /lifecycle\/transitions\.md#2-the-whitelist/);

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
    ["lifecycle/acceptance.md", join(ROOT, "skills/meerkat/references/lifecycle/acceptance.md")],
    ["review-workflow.md", join(ROOT, "skills/meerkat/references/review-workflow.md")],
    ["docs/acceptance.md", join(ROOT, "docs/acceptance.md")],
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

  it("keeps every copy byte-identical after whitespace normalisation", () => {
    const blocks = copies.map(([, path]) => marked(path));
    for (let i = 1; i < blocks.length; i += 1) {
      assert.equal(
        blocks[i].replace(/\s+/g, " ").trim(),
        blocks[0].replace(/\s+/g, " ").trim(),
        `${copies[i][0]} and ${copies[0][0]} must agree`,
      );
    }
  });

  it("leaves the director skill a charter, not another copy", () => {
    const loopSkill = readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8");
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
    assert.deepEqual(modes, ["off", "auto", "human", "a review card"]);

    // Each mode row's `done` cell is read against the domain's own predicate.
    // The two questions the matrix answers are "may a person?" and "may an agent
    // that is not the reviewer?" — the kind is no longer an allow-list.
    const cellAllows = (cell) => cell.replace(/`/g, "").toLowerCase();
    const admitsAnAgent = (cell) =>
      cell.includes("deliverer") || cell.includes("any actor kind") || cell.includes("anyone but the reviewer");
    for (const [index, mode] of ["off", "auto", "human"].entries()) {
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
    const epic = readFileSync(
      join(ROOT, "skills/meerkat/references/scenarios/epic.md"),
      "utf8",
    );
    assert.match(epic, /epic[^\n]*child/i);
    assert.match(epic, /rollup/);
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
    join(ROOT, "skills/meerkat/references/lifecycle/containers.md"),
    "utf8",
  );
  const epic = readFileSync(
    join(ROOT, "skills/meerkat/references/scenarios/epic.md"),
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
    assert.match(skill, /lifecycle\/containers\.md#6-containers-epic/);
  });

  it("names the shape limits where the card schema defines them", () => {
    const schema = readFileSync(
      join(ROOT, "skills/meerkat/references/schema/records.md"),
      "utf8",
    );
    assert.match(schema, /\*\*8\*\*\s+children/);
    assert.match(schema, /\*\*8\*\*\s+deep/);
  });

  it("sizes a child by what can land alone, not by layer", () => {
    // TP-0002 cut "enforce a 1-4 character prefix on every create path" into core,
    // CLI, web, docs and a fixture sweep. Three children could not land alone and
    // a sixth card existed only to pay the split's debt. The rule names the test.
    assert.match(epic, /land on the base branch alone/i);
    assert.match(epic, /leave the tree coherent/i);
    assert.match(epic, /1-4 character project prefix/i);
    assert.match(epic, /core, CLI, web, docs and fixtures/);
    assert.match(epic, /not a technical layer/i);
    assert.match(lifecycle, /not schema-enforced/i);
    assert.match(
      lifecycle,
      /\.\.\/scenarios\/epic\.md#a-child-is-a-deliverable-not-a-layer/,
    );
  });
});
