/**
 * Who the importer reads as a person.
 *
 * The importer used to answer this from a **roster of names** baked into
 * `md/import.mjs` — a case-insensitive alternation of several person-names, each
 * accepted as a human and every other author filed as an agent. This file is what
 * replaced it, and two things were wrong with the old answer:
 *
 *   1. **It was a machine's list of who its people are, in a public repository** —
 *      the same class of leak `md-golden.test.mjs` already scans fixtures for.
 *   2. **It was a silent misread.** Every author the list did not name was filed
 *      as an agent, so the board's answer to "did a person say this" depended on a
 *      regex nobody outside one machine could know to update.
 *
 * The rule that replaced it is one sentence: **the board knows exactly one human,
 * the one the install named** (`TASKCTL_HUMAN`, `--human-name`), and a card's
 * handle is compared to that name through the registry's own key function
 * (`norm`). Everything else is an agent.
 *
 * The card can do better than the default where it has something to say —
 * `created_by_kind` on the provenance key — which is the other half of the
 * ruling: *a card declares, and the board defaults.*
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { importMd, parseCard } from "../../src/core/storage/md/import.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const IMPORTER = join(import.meta.dirname, "../../src/core/storage/md/import.mjs");

/** A card with a comment and a report, so both author paths are in play. */
function cardText({ commentAuthor = "linus", reportAuthor = "linus", ...front } = {}) {
  const head = {
    id: "PROJ-0001",
    title: "A card",
    status: "in_progress",
    priority: "medium",
    project: "proj",
    target: "/tmp/meerkat-taskpanel-fixture",
    created_by: "linus",
    created_at: TS,
    ...front,
  };
  const lines = Object.entries(head).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---
${lines}
---
## Background

text

## Comments

- ${TS} · discuss · ${commentAuthor} — a note

## Sessions

## Report

### R1 · ${TS} · ${reportAuthor}

Done.

acceptance:
- [met] one criterion

evidence:
- commit abc1234
`;
}

/** A board plus a directory holding the given cards (the caller closes it). */
async function boardWithCards(cards) {
  const board = await createTempBoard();
  board.repos = createRepositories(board.db);
  board.dir = join(makeTempDir("md-author-kind-"), "cards");
  mkdirSync(board.dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(board.dir, name), text, "utf8");
  return board;
}

/** The kinds a card's comment author and report author landed with. */
function kindsOf(db, taskId) {
  return {
    comment: db.prepare("SELECT author_kind FROM comments WHERE task_id = ?").get(taskId).author_kind,
    report: db.prepare("SELECT author_kind FROM task_reports WHERE task_id = ?").get(taskId).author_kind,
  };
}

describe("md author kinds — the board's one human, and nobody else", () => {
  it("reads the configured human as the person, on both author paths", async () => {
    const board = await boardWithCards({ "PROJ-0001.md": cardText({ commentAuthor: "elon", reportAuthor: "elon" }) });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS, human: "elon" });
      assert.equal(stats.warnings.length, 0);
      const task = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.deepEqual(kindsOf(board.db, task.id), { comment: "human", report: "human" });
    } finally {
      board.close();
    }
  });

  it("is the *configuration* doing it, not the name — the same handle on two boards", async () => {
    // The identical card, two boards, two configured humans. `elon` is a person on
    // one and an agent on the other, and `linus` is the mirror image. That is the
    // whole difference from the roster: nothing about the handle decides.
    const elonsBoard = await boardWithCards({
      "PROJ-0001.md": cardText({ commentAuthor: "elon", reportAuthor: "elon" }),
    });
    const linusBoard = await boardWithCards({
      "PROJ-0001.md": cardText({ commentAuthor: "linus", reportAuthor: "linus" }),
    });
    try {
      importMd({ db: elonsBoard.db, repos: elonsBoard.repos, dir: elonsBoard.dir, now: TS, human: "elon" });
      importMd({ db: linusBoard.db, repos: linusBoard.repos, dir: linusBoard.dir, now: TS, human: "elon" });

      const onElonsBoard = elonsBoard.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      const onLinusBoard = linusBoard.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.deepEqual(kindsOf(elonsBoard.db, onElonsBoard.id), { comment: "human", report: "human" });
      assert.deepEqual(
        kindsOf(linusBoard.db, onLinusBoard.id),
        { comment: "agent", report: "agent" },
        "a handle that is not the configured human is an agent",
      );
    } finally {
      elonsBoard.close();
      linusBoard.close();
    }
  });

  it("matches through `norm`, so case and padding are not a second person", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({ commentAuthor: "  tanyu  ", reportAuthor: "TANYU" }),
    });
    try {
      importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS, human: "tanyu" });
      const task = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.deepEqual(kindsOf(board.db, task.id), { comment: "human", report: "human" });
    } finally {
      board.close();
    }
  });

  it("reads every undeclared author as an agent when the board has no human configured", async () => {
    // The honest answer for a board that was never told who its person is: it
    // cannot recognise one. (The installer writes `TASKCTL_HUMAN`, so this is the
    // no-`--human-name` case, not the normal one.) It is also what a `check` run
    // outside the environment would see, which is why it is stated rather than
    // left to be discovered.
    const board = await boardWithCards({ "PROJ-0001.md": cardText({ commentAuthor: "elon", reportAuthor: "elon" }) });
    try {
      importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      const task = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.deepEqual(kindsOf(board.db, task.id), { comment: "agent", report: "agent" });
    } finally {
      board.close();
    }
  });

  it("no longer carries a roster, and decides the kind in one place", () => {
    // The regression pin. Two halves, because either alone can be satisfied by
    // accident: the *source* must not classify by name, and the *behaviour* must
    // not treat one specially (the tests above). This is the half that fails if
    // the list is ever pasted back in.
    const source = readFileSync(IMPORTER, "utf8");

    // A roster is an *alternation* — several names accepted as one class — so
    // that, and not the bare appearance of a name, is what is scanned for.
    // (`notify_elon` is a frontmatter key and is legitimately in this file; it
    // names a role, not a person.)
    assert.equal(
      /\/\^\([^)]*\|[^)]*\)\$\/i/.test(source),
      false,
      "no name-alternation regex: a board's human is configuration, not source",
    );
    // The scan is for a *roster*, and a roster is an alternation — not the bare
    // appearance of a name. This file legitimately contains a person's spelling in
    // a comment that illustrates the dictionary's whitespace folding, and a guard
    // that reds on unrelated prose is one that gets deleted rather than fixed. The
    // leak this does guard is the list; `md-golden.test.mjs` guards fixtures.

    // ...and what it *does* say is the one rule, in one place: declared once, and
    // called at each author path (the comment block and the report block).
    assert.match(source, /function authorKindOf\(/);
    assert.equal((source.match(/authorKindOf\(/g) ?? []).length, 3, "declared once, called at each author path");
  });
});

describe("md author kinds — the card declares, the board defaults", () => {
  it("agrees with the service layer on what a card's provenance key is", () => {
    // The parser's `created_by_kind` is the card's own statement, and its default
    // is `human` — the same ruling `commands/tasks.mjs` records for a reporter
    // ("a reporter is the person who filed the card — that is what the role means
    // here"). Neither is a guess about somebody's handle.
    const card = parseCard(cardText({ created_by: "linus", created_by_kind: "claude" }), { file: "x.md" });
    assert.equal(card.createdByKind, "claude");
    assert.equal("created_by_kind" in card.legacy, false, "a recognised key is never filed as an unknown one");
    assert.equal("created_by_kind" in card.meta, false, "and it is a column, not a meta key");

    const undeclared = parseCard(cardText({ created_by: "linus" }), { file: "x.md" });
    assert.equal(undeclared.createdByKind, null, "nothing declared reads as nothing, not as a category");
  });
});
