/**
 * 0033 — an epic's delivery is a rollup over its children.
 *
 * Four properties:
 *
 *   1. the new `is_rollup` column defaults to 0, so a board that predates the
 *      migration keeps its reports as ordinary deliveries;
 *   2. only a *delivery* report on an *epic* may be marked a rollup (the DB
 *      refuses an import row and an ordinary card, whatever the caller says);
 *   3. an epic cannot reach `done` without a rollup for its **current** round —
 *      a rollup for an older round is history;
 *   4. the upgrade ends on the same schema as a fresh board (triggers, tables,
 *      foreign keys, integrity).
 *
 * Raw SQL on purpose: the command layer's `isRollup` argument would hide a
 * trigger that is not actually there.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  ensureActor,
  insertProject,
  insertReport,
  insertTask,
  makeTempDir,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0033 — a board as the previous build left it. */
function before0033() {
  const dir = makeTempDir("meerkat-taskpanel-pre0033-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0033",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

/** A report row with the 0033 marker, on a board that has the column. */
function insertMarkedReport(db, { taskId, round = 1, isRollup = 1 }) {
  db.prepare(
    `INSERT INTO task_reports(task_id, round, conclusion, acceptance_json, evidence_json,
                              author_kind, author_id, created_at, is_rollup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    round,
    "rollup",
    "[]",
    "[]",
    "system",
    ensureActor(db, "taskd", "system"),
    TS,
    isRollup,
  );
}

const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").trim()]),
  );

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

const foreignKeys = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .flatMap((table) =>
      db
        .prepare('SELECT "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)')
        .all(table)
        .map((fk) => ({ child: `${table}.${fk.col}`, parent: fk.parent })),
    );

/** A project, an epic, an ordinary card, and one unmarked report on the epic. */
function seed(db) {
  insertProject(db);
  insertTask(db, { id: "epic-1", identifier: "PROJ-0001", kind: "epic", status: "in_review" });
  insertTask(db, { id: "task-1", identifier: "PROJ-0002", status: "in_review" });
  insertReport(db, { task_id: "epic-1" });
}

describe("storage/migrations — 0033 rollup reports", () => {
  it("adds is_rollup defaulting to 0, leaving existing reports unmarked", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0033() });
      seed(board.db);
      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0033", "0034", "0035"]);

      const rows = board.db
        .prepare("SELECT task_id, is_rollup FROM task_reports ORDER BY task_id")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [{ task_id: "epic-1", is_rollup: 0 }]);
    } finally {
      board.close();
    }
  });

  it("refuses a rollup marker on an ordinary card", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0033() });
      seed(board.db);
      applyMigrations(board.db);

      assert.throws(
        () => insertMarkedReport(board.db, { taskId: "task-1", round: 2 }),
        (err) => String(err.message).includes("ROLLUP_INVALID"),
      );
      // 0035 removed provenance: a rollup is structural, not a writer's badge,
      // so the only question left is whether the card is an epic.
      assert.doesNotThrow(() => insertMarkedReport(board.db, { taskId: "epic-1", round: 2 }));

      // The column is an INTEGER 0/1; a forged value is a CHECK failure.
      assert.throws(
        () => insertMarkedReport(board.db, { taskId: "epic-1", round: 3, isRollup: 2 }),
        (err) => String(err.message).includes("CHECK"),
      );
    } finally {
      board.close();
    }
  });

  it("refuses an epic's done without a current-round rollup, and allows it once one exists", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0033() });
      seed(board.db);
      applyMigrations(board.db);

      const toDone = board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?");
      const setRound = board.db.prepare("UPDATE tasks SET delivery_round = ? WHERE id = 'epic-1'");

      // The only report on file is the unmarked round-1 one: not a rollup.
      assert.throws(
        () => toDone.run("epic-1"),
        (err) => String(err.message).includes("ROLLUP_REQUIRED"),
      );

      // A rollup is what the **current** round names. Round 2 has no report at
      // all yet; the round-1 row cannot stand in for it.
      setRound.run(2);
      assert.throws(
        () => toDone.run("epic-1"),
        (err) => String(err.message).includes("ROLLUP_REQUIRED"),
      );

      insertMarkedReport(board.db, { taskId: "epic-1", round: 2 });
      assert.doesNotThrow(() => toDone.run("epic-1"));
      assert.equal(
        board.db.prepare("SELECT status FROM tasks WHERE id = 'epic-1'").get().status,
        "done",
      );
    } finally {
      board.close();
    }
  });

  it("upgrades to the same schema as a fresh board", async () => {
    const fresh = await createTempBoard();
    const upgraded = await createTempBoard({ migrate: false });
    try {
      applyMigrations(upgraded.db, { dir: before0033() });
      seed(upgraded.db);
      applyMigrations(upgraded.db);

      assert.deepEqual(triggersOf(upgraded.db), triggersOf(fresh.db));
      assert.deepEqual(tableNames(upgraded.db), tableNames(fresh.db));
      assert.deepEqual(foreignKeys(upgraded.db), foreignKeys(fresh.db));
      assert.equal(upgraded.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      fresh.close();
      upgraded.close();
    }
  });
});
