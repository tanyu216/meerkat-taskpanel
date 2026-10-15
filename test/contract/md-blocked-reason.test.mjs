/**
 * 0016 — the `blocked_reason` card field, across every layer that has to agree
 * about it: the frontmatter vocabulary, the column, the export, the wire and
 * the status move.
 *
 * The field is the one structural piece of the SLA-inspection contract (§7): a
 * `blocked` card says *who or what it is waiting for*, so an inspector can tell
 * "the leader owes an answer" from "the predecessor has not landed" without
 * reading the comment trail.
 *
 * Four rules this file exists to hold still:
 *
 *   1. **Known, not legacy.** `blocked_reason` is a recognised frontmatter key,
 *      so a card that carries one must never be filed under `meta_json.legacy`
 *      — the exact loss the M5 drill exists to catch.
 *   2. **Unset is the absence of the key**, on both sides of the round trip. A
 *      card that never carried a reason exports byte-identically to how it
 *      always did; that is why the checked-in goldens are not touched by 0016.
 *   3. **A supplied value must be a literal.** No folding to `unknown`, no case
 *      repair — a caller bug surfaces as one, and the refusal names the field
 *      and the allowed set.
 *   4. **The value follows the status.** Written in the same UPDATE that enters
 *      `blocked`, cleared by the one that leaves it — while `blocked_at` keeps
 *      dating the *last* blockage. The two are deliberately asymmetric.
 *
 * The vocabulary itself is pinned to the migration's `CHECK` below, from the
 * other side of the SQL-parity reader: the parity test parses `CREATE TABLE`
 * bodies, and 0016 adds the column with `ALTER TABLE … ADD COLUMN`, so
 * `tasks.blocked_reason` is absent from `SQL_ENUM_SETS` on purpose. If that
 * pairing ever drifts, the drift is caught here rather than nowhere.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { exportMd } from "../../src/core/storage/md/export.mjs";
import { importMd, parseCard } from "../../src/core/storage/md/import.mjs";
import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { normalizeBlockedReason } from "../../src/core/domain/blocked-reason.mjs";
import { BLOCKED_REASONS, SQL_ENUM_SETS } from "../../src/core/domain/enums.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { taskToWire } from "../../src/shared/wire.mjs";
import { readMigrationFiles } from "../helpers/sql-parse.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  createTempBoard,
  insertProject,
  insertTask,
  makeTempDir,
  reasonCode,
  withBoard,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const MIGRATIONS_DIR = join(import.meta.dirname, "../../src/core/storage/migrations");
const AGENT = { kind: "agent", id: "linus" };

/** A card, minimal but valid, with `overrides` merged into the frontmatter. */
function cardText(overrides = {}) {
  const front = {
    id: "PROJ-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    project: "proj",
    target: "/tmp/meerkat-taskpanel-fixture",
    created_by: "Elon",
    created_at: TS,
    ...overrides,
  };
  const lines = Object.entries(front)
    .map(([key, value]) => `${key}: ${typeof value === "string" && value.includes(": ") ? JSON.stringify(value) : value}`)
    .join("\n");
  return `---\n${lines}\n---\n## Background\n\ntext\n`;
}

/** A board plus a directory holding the given cards (the caller closes it). */
async function boardWithCards(cards) {
  const board = await createTempBoard();
  board.repos = createRepositories(board.db);
  board.dir = join(makeTempDir("md-blocked-reason-"), "cards");
  mkdirSync(board.dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(board.dir, name), text, "utf8");
  return board;
}

/** The exported text of one card, from a real import → export round trip. */
function exportOne(board, identifier = "PROJ-0001") {
  const outDir = join(makeTempDir("md-blocked-reason-out-"), "out");
  exportMd({ repos: board.repos, outDir, now: TS });
  return readFileSync(join(outDir, `${identifier}.md`), "utf8");
}

describe("blocked_reason — the card field (0016)", () => {
  it("is a known card key: it lands in the column, never in meta_json.legacy", () => {
    const set = parseCard(cardText({ status: "blocked", blocked_at: TS, blocked_reason: "clarify" }), { file: "x.md" });
    assert.equal(set.blockedReason, "clarify");
    assert.equal("blocked_reason" in set.legacy, false, "a recognised key is never filed as an unknown one");
    assert.equal("blocked_reason" in set.meta, false, "and it is a column, not a meta key");
  });

  it("leaves an unset reason unset — null, and out of legacy as well", () => {
    const card = parseCard(cardText({}), { file: "x.md" });
    assert.equal(card.blockedReason, null);
    assert.equal("blocked_reason" in card.legacy, false, "absence is not an unknown key either");
  });

  it("round-trips a set value verbatim, and writes no key at all for an unset one", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({ status: "blocked", blocked_at: TS, blocked_reason: "dependency" }),
      "PROJ-0002.md": cardText({ id: "PROJ-0002" }),
    });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.warnings.length, 0);
      assert.equal(board.repos.tasks.getByIdentifier("proj", "PROJ-0001").blockedReason, "dependency");

      const withReason = exportOne(board, "PROJ-0001");
      assert.match(withReason, /^blocked_reason: dependency$/m, "the literal survives the round trip");
      assert.match(withReason, /^blocked_at: 2026-10-08T00:00:00\.000Z$/m, "beside blocked_at, as the card wrote it");

      // A card with none: the key is absent, not empty. `blocked_at` is written
      // either way — it has carried a key on every card since the beginning,
      // which is exactly what `blocked_reason` does not do.
      const without = exportOne(board, "PROJ-0002");
      assert.equal(/^blocked_reason:/m.test(without), false, "an unset reason writes no key");
    } finally {
      board.close();
    }
  });

  it("accepts every literal the vocabulary names, and refuses anything else by name", () => {
    for (const reason of BLOCKED_REASONS) {
      assert.equal(normalizeBlockedReason(reason), reason);
    }
    assert.equal(normalizeBlockedReason(null), null);
    assert.equal(normalizeBlockedReason(undefined), null);
    assert.equal(normalizeBlockedReason(""), null, 'the empty string is "unset", never a stored value');

    assert.throws(
      () => normalizeBlockedReason("bogus"),
      (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /unknown blocked_reason "bogus"/);
        assert.deepEqual(err.details.allowed, [...BLOCKED_REASONS], "the refusal names the allowed set");
        return true;
      },
    );
    assert.throws(() => normalizeBlockedReason(7), (err) => err.code === "VALIDATION_FAILED");
  });

  it("refuses the five spellings the implementation card sketched, which are not the contract's", () => {
    // The implementation card's Acceptance ③ sketches the vocabulary as
    // `deps|resource|ambiguity|operator|defect`, but the card also names its own
    // source of truth — `字段语义见 C1` — and C1 §7.2 fixes the eight literals in
    // `BLOCKED_REASONS`. Two of the sketch's five (`resource`, `defect`) are
    // literals; the other three are near-misses for `dependency`, `clarify` and
    // `external`, and a near-miss accepted silently is how a board ends up with
    // two spellings for one state.
    //
    // This test is the ruling written down. If the sketch is ruled normative
    // instead, this is the assertion to change — in `enums.mjs`, in 0016's CHECK
    // and here, together.
    // [the sketch's spelling, is it one of the contract's literals?]
    const sketch = [
      ["deps", false],
      ["ambiguity", false],
      ["operator", false],
      ["resource", true],
      ["defect", true],
    ];
    for (const [spelling, isLiteral] of sketch) {
      assert.equal(BLOCKED_REASONS.includes(spelling), isLiteral, `${spelling} acceptance`);
      if (!isLiteral) {
        assert.throws(() => normalizeBlockedReason(spelling), (err) => err.code === "VALIDATION_FAILED");
      }
    }
  });

  it("keeps the migration's CHECK literals and the domain vocabulary the same list", () => {
    const file = readMigrationFiles(MIGRATIONS_DIR).find((entry) => entry.version === "0016");
    assert.ok(file !== undefined, "0016 must ship");
    const check = /CHECK\s*\(\s*blocked_reason\s+IN\s*\(([^)]*)\)\s*\)/i.exec(file.sql);
    assert.ok(check !== null, "0016 must constrain the column to the vocabulary");
    assert.deepEqual(
      [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]),
      [...BLOCKED_REASONS],
      "same literals, same order, on both sides",
    );

    // 0016's `ALTER TABLE … ADD COLUMN` constraint was invisible to the SQL-parity
    // reader (it walks `CREATE TABLE` statements), so the value set had no JS
    // side — the assertion above covered the pairing instead. `0019` rebuilds
    // `tasks` and declares `blocked_reason` in the `CREATE TABLE` body, where the
    // reader *does* see it, so the vocabulary is now declared in `SQL_ENUM_SETS`
    // and compared **both** ways (the `0018`/`REPORT_ORIGINS` precedent).
    assert.equal(Object.hasOwn(SQL_ENUM_SETS, "tasks.blocked_reason"), true);
  });

  it("pins the revision cursor's column list, which does not name the new column", () => {
    // D3″ (T-20261014-022254-4). `tr_rev_tasks_upd` fires `AFTER UPDATE OF
    // <list>` and 0016 deliberately does not re-declare it to add
    // `blocked_reason`. The consequence is narrow and stated, so it is pinned
    // here rather than left to be rediscovered:
    //
    //   * every write the board itself performs sets `version` and `updated_at`,
    //     which *are* in the list — so a service-level write is always seen;
    //   * a hand-written `UPDATE tasks SET blocked_reason = …` alone is not, so
    //     it bumps no revision and a cursor-watching reader misses it.
    //
    // 0015 and 0019 own the trigger's text (both re-create it during a `tasks`
    // rebuild — 0019's list loses the three columns 0019 drops); 0016's header owns
    // the explanation. If a caller ever needs the bare-write case, this is the
    // test that says so.
    const files = readMigrationFiles(MIGRATIONS_DIR);
    const declarations = files.flatMap((entry) =>
      [...entry.sql.matchAll(/CREATE TRIGGER tr_rev_tasks_upd[\s\S]*?END;/g)].map((match) => ({
        version: entry.version,
        sql: match[0],
      })),
    );
    assert.ok(declarations.length >= 1, "the revision cursor is declared somewhere");
    // `readMigrationFiles` sorts by filename, so the last declaration is the one
    // a board at the head of the set actually has — 0019 re-declares it (during
    // its `tasks` rebuild) and 0016 does not.
    const live = declarations.at(-1);
    assert.equal(live.version, "0020", "the live declaration is 0020's — the last `tasks` rebuild re-declares the trigger");
    assert.equal(/\bblocked_reason\b/.test(live.sql), false, "the cursor's column list does not name blocked_reason");
    assert.ok(live.sql.includes("version") && live.sql.includes("updated_at"), "but it does name both CAS columns");

    const ours = files.find((entry) => entry.version === "0016");
    assert.match(ours.sql, /tr_rev_tasks_upd/, "0016's header states the consequence, so the hole is documented");
  });

  it("stores the reason as a nullable column the database itself constrains", async () => {
    await withBoard((board) => {
      const column = board.db
        .prepare("SELECT * FROM pragma_table_info('tasks') WHERE name = 'blocked_reason'")
        .get();
      assert.equal(column.type, "TEXT");
      assert.equal(Number(column.notnull), 0, "a block with no stated reason is legal");
      assert.equal(column.dflt_value, null);

      insertProject(board.db);
      insertTask(board.db, { id: "t1", identifier: "PROJ-0001" });
      const write = (value) => () => board.db.prepare("UPDATE tasks SET blocked_reason = ? WHERE id = 't1'").run(value);

      assert.equal(reasonCode(write(null)), "NO_ERROR", "NULL passes the CHECK — that is what makes it optional");
      for (const reason of BLOCKED_REASONS) assert.equal(reasonCode(write(reason)), "NO_ERROR", reason);
      assert.equal(reasonCode(write("bogus")), "VALIDATION_FAILED", "the column cannot hold a non-literal");
    });
  });

  it("follows the status: written on entry, cleared on exit, with blocked_at kept", async () => {
    await withBoard((board) => {
      const repos = createRepositories(board.db);
      insertProject(board.db);
      const id = insertTask(board.db, { id: "t1", identifier: "PROJ-0001" });

      const blocked = repos.tasks.moveCas({ id, ifVersion: 1, to: "blocked", now: TS2, blockedReason: "external" });
      assert.equal(blocked.blockedReason, "external");
      assert.equal(blocked.blockedAt, TS2);

      const back = repos.tasks.moveCas({ id, ifVersion: 2, to: "todo", now: TS });
      assert.equal(back.blockedReason, null, "the reason describes the *current* block, so leaving clears it");
      assert.equal(back.blockedAt, TS2, "blocked_at still dates the last blockage");
    });
  });

  it("refuses a non-literal through the command layer, and records the one it accepts", async () => {
    await withBoard((board) => {
      const repos = createRepositories(board.db);
      const ctx = createContext({ db: board.db, repos });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "Project", actor: AGENT });
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });

      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "blocked", actor: AGENT, blockedReason: "deps" }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.match(err.message, /unknown blocked_reason/);
          return true;
        },
      );
      assert.equal(repos.tasks.get(task.id).status, "todo", "a refused move writes nothing");

      const blocked = commands.moveStatus({ id: task.id, to: "blocked", actor: AGENT, blockedReason: "clarify" });
      assert.equal(blocked.blockedReason, "clarify");
      // The trail keeps the reason even after the column is cleared, so history
      // is not lost — only the current-state field is.
      const moved = repos.activities.list({ taskId: task.id, limit: 10 }).filter((a) => a.event === "task_moved");
      assert.equal(moved.at(-1).changes.blockedReason, "clarify");
    });
  });

  it("carries the reason on the wire, and reports it on the activity trail of an exit", async () => {
    await withBoard((board) => {
      const repos = createRepositories(board.db);
      insertProject(board.db);
      const id = insertTask(board.db, { id: "t1", identifier: "PROJ-0001" });
      const blocked = repos.tasks.moveCas({ id, ifVersion: 1, to: "blocked", now: TS2, blockedReason: "decision" });

      const wire = taskToWire(blocked);
      assert.equal(wire.blocked_reason, "decision");
      assert.equal(Object.keys(wire).some((key) => key === "blockedReason"), false, "the wire spelling is snake_case");

      const none = taskToWire({ ...blocked, blockedReason: null });
      assert.equal(none.blocked_reason, null, "a card with no reason says so explicitly on the wire");
    });
  });
});

describe("blocked_reason — a value the board cannot classify (D2)", () => {
  // Before the key was known, a card carrying `blocked_reason: <not a literal>`
  // rode through `meta_json.legacy` untouched. Recognising the key may not turn
  // that card into a lost one: markdown is the only way a provider's work
  // reaches the board. So the *read* edge preserves what it cannot classify and
  // warns, while the *write* entries stay strict.
  const ODD = "quantum_entanglement";

  it("keeps the card's own wording in legacy, leaves the column empty, and says so", () => {
    const card = parseCard(
      cardText({ status: "blocked", blocked_at: TS, blocked_reason: ODD }),
      { file: "x.md" },
    );
    assert.equal(card.blockedReason, null, "a value that is not a literal is never stored in the column");
    assert.equal(card.legacy.blocked_reason, ODD, "the card's own wording is preserved verbatim");
    assert.equal(card.blockedReasonUnrecognized, true);
    assert.ok(card.meta.import_warnings.includes("blocked_reason_unrecognized"));
    // …while the write entry still refuses it: the leniency belongs to the
    // import edge, where the input is not under the board's control.
    assert.throws(() => normalizeBlockedReason(ODD), (err) => err.code === "VALIDATION_FAILED");
  });

  it("imports such a card instead of skipping it, warns, and exports it word for word", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({ status: "blocked", blocked_at: TS, blocked_reason: ODD }),
    });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.parseSkipped.length, 0, "the card is imported, not skipped");
      assert.equal(stats.warnings.length, 1, "and the mismatch is a warning, not a silent repair");
      assert.match(stats.warnings[0], /blocked_reason/);

      const task = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(task.blockedReason, null, "the column stays empty");
      assert.deepEqual(task.meta.import_warnings, ["blocked_reason_unrecognized"]);

      const text = exportOne(board);
      assert.match(text, new RegExp(`^blocked_reason: ${ODD}$`, "m"), "the value goes back out as it came in");
    } finally {
      board.close();
    }
  });

  it("holds the same line for a value that is not even a scalar", () => {
    // The frontmatter subset hands every bare scalar back as a string, so a list
    // is the shape that reaches the non-string branch at all.
    const card = parseCard(cardText({ blocked_reason: "[clarify, later]" }), { file: "x.md" });
    assert.equal(card.blockedReason, null);
    assert.deepEqual(card.legacy.blocked_reason, ["clarify", "later"]);
  });

  it("trims surrounding whitespace and nothing else (D3′)", () => {
    const quoted = parseCard(
      cardText({ status: "blocked", blocked_reason: '"  dependency  "' }),
      { file: "x.md" },
    );
    assert.equal(quoted.blockedReason, "dependency", "space around a word is not a second spelling of it");
    assert.equal("blocked_reason" in quoted.legacy, false, "it is a literal — so there is nothing to preserve");
    // A different *word* is still refused: no case repair, no near-match folding.
    assert.throws(() => normalizeBlockedReason("Dependency"), (err) => err.code === "VALIDATION_FAILED");
    assert.throws(() => normalizeBlockedReason("dependencies"), (err) => err.code === "VALIDATION_FAILED");
  });
});

describe("blocked_reason — what it must not disturb (Acceptance ⑤)", () => {
  it("still files a key the importer does not know under meta_json.legacy, in order", () => {
    const card = parseCard(
      cardText({ git_rules: "x", blocked_reason: "clarify", subsession_ids: "a b" }),
      { file: "x.md" },
    );
    // `target` is legacy by the O3 ruling (the board owns no project directory),
    // so it is an *unknown* key here like the other two — and its position is
    // the card's own order, which is what "preserved verbatim" means.
    assert.deepEqual(Object.keys(card.legacy), ["target", "git_rules", "subsession_ids"], "unknown keys keep their order");
    assert.equal("blocked_reason" in card.legacy, false);
  });

  it("exports an unknown key exactly where the card had it", async () => {
    const board = await boardWithCards({ "PROJ-0001.md": cardText({ git_rules: "x" }) });
    try {
      importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.match(exportOne(board), /^git_rules: x$/m);
    } finally {
      board.close();
    }
  });

  it("adds no key to a card the checked-in goldens describe", () => {
    // The goldens are the byte-for-byte oracle for a fixture that carries no
    // reason (`test/contract/md-golden.test.mjs`), so 0016 owes them nothing —
    // asserted here directly rather than inferred from that file staying green.
    for (const name of ["PROJ-0001", "PROJ-0004", "PROJ-0006"]) {
      const golden = readFileSync(join(import.meta.dirname, `../fixtures/md/golden/${name}.md`), "utf8");
      assert.equal(/^blocked_reason:/m.test(golden), false, `${name} carries no blocked_reason line`);
    }
  });
});
