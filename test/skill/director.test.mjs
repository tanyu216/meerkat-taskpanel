/**
 * The `meerkat-director` skill — the decision hub.
 *
 * The director is opened only for a content decision: a worker question, an unowned
 * card, an accepted card's required handoff, or an E1–E5 escalation. Its charter is
 * decisions only: `SKILL.md` plus its references, split into the shared core, one
 * file per decision, and the round method. The taskctl mechanics, the board's
 * scheduling, and the human console are other surfaces and must not be restated here.
 *
 * The second half of this file holds the board skill's own invariants (they used to
 * live beside the loop tests); a distributed skill's links must resolve where the
 * skill is installed, not where it was authored.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
    for (const name of [
      "decision-policy.md",
      "question.md",
      "route.md",
      "triage.md",
      "escalation.md",
      "rounds.md",
    ]) {
      assert.ok(
        existsSync(join(DIRECTOR_SKILL, "references", name)),
        `references/${name} must land`,
      );
    }
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
    assert.match(text, /stay with the board and the roles/i);
    assert.match(text, /Claims, execution and closure belong to the roles, the board and the human/i);
    assert.match(text, /the decision and the release/i);
    assert.match(text, /a note records the answer/i, "the release concludes; the note records");
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
  const refsDir = join(DIRECTOR_SKILL, "references");
  const ref = (name) => readFileSync(join(refsDir, name), "utf8");

  it("is the shared core plus one file per decision and the round method", () => {
    assert.deepEqual(
      readdirSync(refsDir)
        .filter((name) => name.endsWith(".md"))
        .sort(),
      ["decision-policy.md", "escalation.md", "question.md", "rounds.md", "route.md", "triage.md"],
    );
  });

  it("keeps the ladder, the director's authority and the recording in the shared core", () => {
    const core = ref("decision-policy.md");
    assert.match(core, /worker  →  director  →  human/);
    assert.match(core, /The director decides/);
    assert.match(core, /The reviewer/);
    assert.match(core, /## Recording/);
    assert.match(core, /awaiting/);
    assert.doesNotMatch(core, /## Decision rounds/);
    assert.doesNotMatch(core, /## The human decides/);
  });

  it("puts the worker boundary and the question rule in question.md", () => {
    const question = ref("question.md");
    assert.match(question, /worker/i);
    assert.match(question, /escalates only the items the decision map[\s\S]*leaves to the human/i);
    assert.match(question, /one round is one question per card/i);
    assert.equal(
      (question.match(/one round is one question per card/gi) ?? []).length,
      1,
      "the rule is stated once",
    );
  });

  it("puts the route rule in route.md", () => {
    const route = ref("route.md");
    assert.match(route, /one accountable role/i);
    assert.match(route, /Worker/);
    assert.match(route, /role catalog/i);
  });

  it("puts the triage markers and the E1 check in triage.md", () => {
    const triage = ref("triage.md");
    assert.match(triage, /handoff_consumed_round/, "the triage marker has one home");
    assert.match(triage, /handoff_declined_round/);
    assert.match(triage, /create it only if the map gives E1 to the[\s\S]*director/i);
  });

  it("reads the project graph, adopts a producer and only fills what is missing", () => {
    const triage = ref("triage.md");
    assert.match(triage, /docs\/agents\/epic-graphs\.md/, "the project graph is the content source");
    assert.match(
      triage,
      /classification lives in the\s+project's `docs\/agents\/epic-graphs\.md`/i,
      "classification meta's home is named",
    );
    assert.match(triage, /adopt the delivered producer\s+as its matching stage/i);
    assert.match(triage, /fill only what is missing/i);
    assert.match(triage, /--parent <epic> --target <stage-id>/, "the recipe's idempotency convention");
    assert.match(triage, /Epic mode/, "the graph's epic mode is honored");
    assert.doesNotMatch(triage, /--idem/, "no second, loop-handoff idempotency for a graph stage");
  });

  it("puts the E1-E5 map and the project refinement in escalation.md", () => {
    const policy = ref("escalation.md");
    assert.match(policy, /E1/);
    assert.match(policy, /awaiting/);
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
    assert.match(policy, /code set itself\s+stays fixed/i, "the E-code vocabulary is fixed");
    assert.match(policy, /ladder[\s\S]{0,120}fixed/i, "the ladder cannot be overridden");
    assert.match(policy, /Record which source decided/i, "the deciding source is recorded");
  });

  it("states every boundary as a positive action", () => {
    const files = [
      ["SKILL.md", readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8")],
      ...readdirSync(refsDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => [name, ref(name)]),
    ];
    const negative = /\b(?:do not|don't|never|must not|cannot|can't)\b/i;
    for (const [name, body] of files) {
      assert.doesNotMatch(body, negative, `${name}: state the positive action`);
    }
  });

  it("puts the round protocol in rounds.md", () => {
    const rounds = ref("rounds.md");
    assert.match(rounds, /## Decision rounds/);
    assert.match(rounds, /frontier/);
    assert.match(rounds, /so "yes" accepts/i);
    assert.match(rounds, /Facts are the asker's job/i);
    assert.match(rounds, /outside\s+the\s+roles/i, "the design mode allows an outside worker");
  });

  it("carries no human-console or taskctl/scheduler mechanics", () => {
    // The human console is `meerkat-chat`'s, the commands are the board skill's,
    // and the scheduler is the supervisor's. The director's charter must not
    // restate any of them — not even as a pointer.
    const files = [
      ["SKILL.md", readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8")],
      ...readdirSync(refsDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => [`references/${name}`, ref(name)]),
    ];
    for (const [name, body] of files) {
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

  it("keeps each file within its line ceiling", () => {
    const lines = (name) => readFileSync(join(refsDir, name), "utf8").split("\n").length;
    for (const name of [
      "decision-policy.md",
      "question.md",
      "route.md",
      "triage.md",
      "escalation.md",
      "rounds.md",
    ]) {
      assert.ok(lines(name) <= 130, `${name}: ${lines(name)} lines`);
    }
    assert.ok(
      readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8").split("\n").length <= 90,
      "SKILL.md stays an index",
    );
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

  it("points the decision ownership it describes at the director skill", () => {
    const text = read("SKILL.md");
    assert.match(text, /meerkat-director/);
    assert.equal(text.includes("scripts/supervisor.mjs]("), false, "no relative link to the executor");
  });

  it("teaches the review protocol in the main prompt, not only in a reference", () => {
    const text = read("SKILL.md");
    assert.match(text, /review_of_id/, "the structural review marker is named");
    assert.match(text, /VERDICT/, "the verdict line is named");
    assert.match(text, /flow B/i, "the flow vocabulary is present");
    assert.match(
      text,
      /references\/review-protocol\.md/,
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
    ["review-protocol.md", join(ROOT, "skills/meerkat/references/review-protocol.md")],
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
    const epic = readFileSync(join(ROOT, "skills/meerkat/references/scenarios/epic.md"), "utf8");
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

  it("follows the card's own body for card-surface text, not the conversation", () => {
    // A card is one trail of text. A Chinese card takes a Chinese report even when the
    // session is English; an English card takes an English comment even when the human
    // typed Chinese. The conversation only sets the language of a card being created.
    assert.ok(section.length > 0, "the skill has a language section before the write workflow");
    assert.match(section, /card'?s own (body|text)/i);
    assert.match(section, /not the default|never the default/i);
    assert.match(section, /not\s+the\s+authority/i);
    for (const surface of ["comment", "question", "report", "leftovers", "acceptance"]) {
      assert.match(section, new RegExp(surface, "i"), `the rule covers the ${surface}`);
    }
  });

  it("lets the first writer set the language of a card with no body yet", () => {
    // A new card has nothing to inherit, so the create needs a fallback chain; otherwise
    // the "no body" case silently becomes the English default again.
    assert.match(section, /creating|no body yet|first writer/i);
    assert.match(section, /the human/i);
    assert.match(section, /conversation/i);
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
  const manual = readFileSync(join(ROOT, "skills/meerkat/references/scenarios/epic.md"), "utf8");
  const lifecycle = readFileSync(
    join(ROOT, "skills/meerkat/references/lifecycle/containers.md"),
    "utf8",
  );

  it("does not promote a card that already delivered", () => {
    assert.match(manual, /current-round report/i);
    assert.match(manual, /do \*\*not\*\* promote/i);
    assert.match(lifecycle, /terminal container never rolls up/i);
  });

  it("takes rollup evidence from the children only", () => {
    assert.match(lifecycle, /children's, not the container's/i);
    assert.match(lifecycle, /delivery report/i);
  });

  it("leaves the board-enforced container codes to the refusal", () => {
    assert.doesNotMatch(manual, /CHILDREN_OPEN/);
    assert.doesNotMatch(manual, /ROLLUP_REQUIRED|ROLLUP_STALE/);
    assert.match(manual, /lifecycle\/containers\.md#6-containers-epic/);
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
    assert.match(manual, /land on the base branch alone/i);
    assert.match(manual, /leave the tree coherent/i);
    assert.match(manual, /1-4 character project prefix/i);
    assert.match(manual, /core, CLI, web, docs and fixtures/);
    assert.match(manual, /not a technical layer/i);
    assert.match(lifecycle, /not schema-enforced/i);
    assert.match(lifecycle, /scenarios\/epic\.md#a-child-is-a-deliverable-not-a-layer/);
  });
});
