/**
 * The `meerkat-chat` skill — the human's console.
 *
 * The supervisor keeps the board moving and the director makes the decisions the
 * loop cannot. This skill is the conversation a human has with the board: progress,
 * the questions waiting on them, the cards waiting for acceptance, the loop's health
 * and the abnormal cards. It writes only what the human says, after showing the exact
 * write.
 *
 * The manual-mode content used to live in `meerkat-director`; these tests hold the
 * split: the director keeps decisions, the chat skill owns the human front end.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHAT_SKILL = join(ROOT, "skills", "meerkat-chat");
const DIRECTOR_SKILL = join(ROOT, "skills", "meerkat-director");

describe("chat skill: shape", () => {
  it("carries SKILL.md and its references, and no execution body", () => {
    assert.ok(existsSync(join(CHAT_SKILL, "SKILL.md")), "the skill must carry its charter");
    for (const rel of [
      "references/console.md",
      "references/answering.md",
      "references/acceptance.md",
    ]) {
      assert.ok(existsSync(join(CHAT_SKILL, rel)), `${rel} must land`);
    }
    for (const retired of ["manifest.txt", "scripts", "templates", "src", "body"]) {
      assert.equal(
        existsSync(join(CHAT_SKILL, retired)),
        false,
        `the chat skill is prose and commands; it must not carry ${retired}`,
      );
    }
  });

  it("has frontmatter naming the skill with a real, model-invocable description", () => {
    const text = readFileSync(join(CHAT_SKILL, "SKILL.md"), "utf8");
    assert.equal(readFrontmatterField(text, "name"), "meerkat-chat");
    const description = readFrontmatterField(text, "description");
    assert.ok(typeof description === "string" && description.length >= 20, "description must be substantial");
    assert.notEqual(
      readFrontmatterField(text, "disable-model-invocation"),
      "true",
      "the human's console must be invocable by the model, not command-only",
    );
    assert.equal(text.includes("$ARGUMENTS"), false, "the skill takes no argument placeholder");
  });
});

describe("chat skill: the description reaches the human's questions", () => {
  const text = readFileSync(join(CHAT_SKILL, "SKILL.md"), "utf8");
  const description = readFrontmatterField(text, "description");

  it("covers progress, questions, acceptance and loop health", () => {
    // The description is the only trigger surface. A human rarely says "meerkat-chat";
    // they ask what is happening, what needs them, or why a card is stuck. Every one of
    // those phrasings has to point here rather than at the board's mechanics.
    for (const anchor of [
      /progress|status/i,
      /what is left|remaining|next/i,
      /awaiting|waiting/i,
      /question/i,
      /acceptance|in_review|done/i,
      /doctor|health/i,
      /stuck|blocked|abnormal|looping/i,
      /review/i,
    ]) {
      assert.match(description, anchor, `the description must cover ${anchor}`);
    }
  });

  it("triggers in any language without carrying language-specific keywords", () => {
    assert.match(description, /any language|Chinese, English/i);
    assert.match(description, /bare card id or title/i);
  });

  it("hands board mechanics and decisions to their own skills", () => {
    assert.match(description, /`?meerkat`? skill|board operations/i);
    assert.match(description, /director/i);
  });
});

describe("chat skill: the shipped files are language-neutral", () => {
  // The skill is authored in English so it reads the same to every model. Reply
  // language is decided from the human's own messages, never from a phrase list
  // baked into the skill; a CJK example or trigger word would make one language
  // look like the default.
  const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  function filesUnder(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(path));
      else out.push(path);
    }
    return out;
  }

  it("contains no CJK characters in any shipped file", () => {
    const shipped = filesUnder(CHAT_SKILL);
    assert.ok(shipped.length >= 5, "the walk must see the skill, its references and the evals");
    for (const file of shipped) {
      const content = readFileSync(file, "utf8");
      assert.equal(
        CJK.test(content),
        false,
        `${file.slice(ROOT.length + 1)} must stay language-neutral`,
      );
    }
  });
});

describe("chat skill: the four things a human asks for", () => {
  const text = readFileSync(join(CHAT_SKILL, "SKILL.md"), "utf8");

  it("opens the board once with the two read-only reads", () => {
    assert.match(text, /taskctl loop doctor --json/);
    assert.match(text, /taskctl loop console --json/);
    assert.match(text, /read-only|writes nothing|never writes/i);
  });

  it("reads a card with its trail before summarising progress", () => {
    assert.match(text, /issue get <ref> --json --include comments --include reports/);
    assert.match(text, /acceptance\[/);
    assert.match(text, /report/i);
    assert.match(text, /assignee/);
    assert.match(text, /next act|next actor|what is left|next step/i);
  });

  it("keeps a waiting register for questions and pending acceptance", () => {
    assert.match(text, /questions\[\]/);
    assert.match(text, /pending_acceptance/);
    assert.match(text, /one card at a time/i);
    assert.match(text, /awaiting/);
    assert.match(text, /in_review/);
  });

  it("answers a question in the human's own words, after showing them", () => {
    assert.match(text, /comment add <ref>/);
    assert.match(text, /--as-human/);
    assert.match(text, /show .*before|before .*write|show the exact/i);
    assert.match(text, /never paraphrase/i);
    assert.match(text, /you decide|go with your recommendation/i, "delegation is a yes, not a licence to invent");
  });

  it("mirrors the human's language instead of defaulting to English", () => {
    // The skill is written in English, but English is not the reply default: the
    // first writer sets the board's language, and that writer is the human.
    assert.match(text, /human's language/i);
    assert.match(text, /do not default to English|not .{0,20}default/i);
    assert.match(text, /mirror the language/i);
  });

  it("distinguishes an awaiting answer from an agent question on a live card", () => {
    // An `awaiting` card requeues itself when a human comments; an `in_progress`
    // agent question does not, so the chat skill has to move that one to `todo`
    // after recording the answer or the stopped worker's card is left behind.
    assert.match(text, /awaiting[^\n]*todo|todo[^\n]*awaiting/i);
    assert.match(text, /in_progress[^\n]*todo|todo[^\n]*in_progress/i);
    assert.match(text, /do not move it again|never move it again/i);
  });

  it("accepts only a delivered, evidenced card in the mode the card names", () => {
    assert.match(text, /acceptance_mode/);
    assert.match(text, /issue move <ref> done/);
    assert.match(text, /current (delivery )?round/i);
    assert.match(text, /ACCEPTANCE_FORBIDDEN|REVIEW_PENDING|ACCEPTANCE_INCOMPLETE/);
    assert.match(text, /never .*cancel|not .*cancel/i);
  });

  it("reports the loop's health and the abnormal cards without changing them", () => {
    assert.match(text, /attention_reasons/);
    assert.match(text, /stuck_cards/);
    assert.match(text, /blocked_acceptance/);
    assert.match(text, /unlanded/);
    assert.match(text, /looping/);
    assert.match(text, /blocked_reason/);
    assert.match(text, /report only|never .*behind the human|do not .*unblock/i);
  });
});

describe("chat skill: boundaries", () => {
  const text = readFileSync(join(CHAT_SKILL, "SKILL.md"), "utf8");

  it("never becomes the worker, the director or the supervisor", () => {
    assert.match(text, /never claim|does not claim|no claim/i);
    assert.match(text, /never .*deliver|not .*deliver/i);
    assert.match(text, /E1[–-]E5/);
    assert.match(text, /not the supervisor|never .*supervisor/i);
    assert.match(text, /never merge|not the integrator|git merge/i);
    assert.match(text, /--as-human/);
  });

  it("re-reads after every write and handles the two retryable refusals", () => {
    assert.match(text, /re-read|read (it )?back/i);
    assert.match(text, /VERSION_CONFLICT/);
    assert.match(text, /DB_BUSY/);
  });

  it("leaves backlog release and small edits to the human's request", () => {
    assert.match(text, /backlog/);
    assert.match(text, /only (when|if) the human|on request/i);
  });
});

describe("chat skill: references resolve where the skill is installed", () => {
  const skillDir = CHAT_SKILL;
  const files = ["SKILL.md", "references/console.md", "references/answering.md", "references/acceptance.md"];
  const read = (rel) => readFileSync(join(skillDir, rel), "utf8");

  it("has no link that climbs out of the skill into the repository root", () => {
    for (const file of files) {
      // A reference sits one level below the skill root, so a sibling skill needs
      // `../../<skill>/`. Those two siblings are installed together; anything else
      // that climbs is a link into the repository or nowhere.
      const climbing = [...read(file).matchAll(/\]\((\.\.\/[^)]*)\)/g)]
        .map((match) => match[1])
        .filter(
          (target) =>
            target.startsWith("../..") && !/^\.\.\/\.\.\/(meerkat|meerkat-director)\//.test(target),
        );
      assert.deepEqual(climbing, [], `${file}: links must not climb out of the skill`);
    }
  });

  it("has a real target for every relative link", () => {
    for (const file of files) {
      const targets = [...read(file).matchAll(/\]\(([^)]+)\)/g)]
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

  it("points at the board and director skills without reaching into the repo", () => {
    const text = read("SKILL.md");
    assert.match(text, /\.\.\/meerkat\/SKILL\.md/);
    assert.match(text, /\.\.\/meerkat-director\/SKILL\.md/);
    assert.equal(text.includes("src/"), false, "the skill runs taskctl, not repository code");
  });
});

describe("chat skill: the manual front end has one home", () => {
  it("the director carries no manual-mode or console content", () => {
    const skill = readFileSync(join(DIRECTOR_SKILL, "SKILL.md"), "utf8");
    assert.equal(/^## Manual mode/m.test(skill), false, "the director keeps no manual agenda");
    assert.doesNotMatch(skill, /meerkat-chat|human console|--as-human|TASKCTL_HUMAN/i);
    assert.equal(
      existsSync(join(DIRECTOR_SKILL, "references", "operation.md")),
      false,
      "the operator mechanics are not the director's",
    );
  });

  it("the console fields live with the console", () => {
    const consoleDoc = readFileSync(
      join(ROOT, "skills", "meerkat-chat", "references", "console.md"),
      "utf8",
    );
    assert.match(consoleDoc, /age_ms/);
    assert.match(consoleDoc, /answered_pending_release/);
  });

  it("keeps the decision policy's decision-round protocol", () => {
    // The rounds are how a question is asked, not who answers it; the chat skill
    // reuses them, so `rounds.md` keeps its one home.
    const rounds = readFileSync(
      join(DIRECTOR_SKILL, "references", "rounds.md"),
      "utf8",
    );
    assert.match(rounds, /## Decision rounds/);
    assert.match(rounds, /frontier/);
    assert.match(rounds, /so "yes" accepts/i);
  });
});
