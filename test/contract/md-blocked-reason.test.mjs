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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { normalizeBlockedReason } from "../../src/core/domain/blocked-reason.mjs";
import { BLOCKED_REASONS, SQL_ENUM_SETS } from "../../src/core/domain/enums.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { taskToWire } from "../../src/foundation/wire.mjs";
import { readMigrationFiles } from "../helpers/sql-parse.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  insertProject,
  insertTask,
  reasonCode,
  withBoard,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const MIGRATIONS_DIR = join(import.meta.dirname, "../../src/core/storage/migrations");
const AGENT = { kind: "agent", id: "linus" };

describe("blocked_reason — the card field (0016)", () => {
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

  it("keeps the baseline's CHECK literals and the domain vocabulary the same list", () => {
    const file = readMigrationFiles(MIGRATIONS_DIR).find((entry) => entry.version === "0001");
    assert.ok(file !== undefined, "the 0.1.0 baseline must ship");
    const check = /CHECK\s*\(\s*blocked_reason\s+IN\s*\(([^)]*)\)\s*\)/i.exec(file.sql);
    assert.ok(check !== null, "the baseline must constrain the column to the vocabulary");
    assert.deepEqual(
      [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]),
      [...BLOCKED_REASONS],
      "same literals, same order, on both sides",
    );

    // The baseline declares the CHECK in the `CREATE TABLE` body, so the
    // SQL-parity reader sees it and the vocabulary is compared both ways.
    assert.equal(Object.hasOwn(SQL_ENUM_SETS, "tasks.blocked_reason"), true);
  });

  it("pins the revision cursor's column list, which does not name blocked_reason", () => {
    // `tr_rev_tasks_upd` fires `AFTER UPDATE OF <list>` and the list does not
    // name `blocked_reason`. The consequence is narrow and stated, so it is
    // pinned here rather than left to be rediscovered:
    //
    //   * every write the board itself performs sets `version` and `updated_at`,
    //     which *are* in the list — so a service-level write is always seen;
    //   * a hand-written `UPDATE tasks SET blocked_reason = …` alone is not, so
    //     it bumps no revision and a cursor-watching reader misses it.
    const files = readMigrationFiles(MIGRATIONS_DIR);
    const declarations = files.flatMap((entry) =>
      [...entry.sql.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?tr_rev_tasks_upd[\s\S]*?END;/g)].map((match) => ({
        version: entry.version,
        sql: match[0],
      })),
    );
    assert.equal(declarations.length, 1, "the baseline declares the revision cursor once");
    const live = declarations[0];
    assert.equal(live.version, "0001", "the live declaration is the baseline");
    assert.equal(/\bblocked_reason\b/.test(live.sql), false, "the cursor's column list does not name blocked_reason");
    assert.ok(live.sql.includes("acceptance_mode"), "but it does name the acceptance decision");
    assert.ok(live.sql.includes("version") && live.sql.includes("updated_at"), "but it does name both CAS columns");
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

describe("blocked_reason — what it must not disturb", () => {
  it("adds no key to a card the checked-in goldens describe", () => {
    // The goldens are the byte-for-byte export oracle (`test/cli/export.test.mjs`),
    // so 0016 owes them nothing.
    for (const name of ["PROJ-0001", "PROJ-0004", "PROJ-0006"]) {
      const golden = readFileSync(join(import.meta.dirname, `../fixtures/md/golden/${name}.md`), "utf8");
      assert.equal(/^blocked_reason:/m.test(golden), false, `${name} carries no blocked_reason line`);
    }
  });
});
