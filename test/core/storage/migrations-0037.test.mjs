/**
 * 0037 — the event stream's two range reads get indexes.
 *
 * The migration only adds indexes, so the test's job is the two things an index
 * migration can still get wrong: losing/altering a row, and ending on a
 * different shape than a fresh board.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { indexShapesOf, migrationsBefore } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertProject, insertTask } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const before0037 = migrationsBefore("0037", { prefix: "meerkat-taskpanel-pre0037-" });

/** @param {import('node:sqlite').DatabaseSync} db */
const activityIndexes = (db) => indexShapesOf(db, "task_activities");

/** @param {import('node:sqlite').DatabaseSync} db @param {string} name */
const indexNamed = (db, name) => activityIndexes(db).find((index) => index.name === name);

describe("storage/migrations — 0037 activity indexes", () => {
  it("adds both cursor indexes and leaves every row untouched", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0037() });
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001" });

      // A hand-written row with no revision (the audit trail is append-only by
      // convention) sits beside rows the command layer wrote.
      board.db
        .prepare("INSERT INTO task_activities(task_id,event,changes_json,created_at) VALUES('task-1','handwritten','{}',?)")
        .run(TS);
      board.db
        .prepare("INSERT INTO task_activities(task_id,event,changes_json,revision,created_at) VALUES('task-1','task_created','{}',1,?)")
        .run(TS);
      board.db
        .prepare("INSERT INTO task_activities(task_id,event,changes_json,revision,created_at) VALUES('task-1','task_updated','{}',2,?)")
        .run(TS);

      const up = applyMigrations(board.db);
      // 0038/0039 are the acceptance model and the `deploy` retirement; this
      // test's subject is 0037, and the later files must not disturb its rows.
      assert.deepEqual(up.applied.map((m) => m.version), ["0037", "0038", "0039", "0040", "0041", "0042"]);

      assert.deepEqual(activityIndexes(board.db).map((index) => index.name), [
        "ix_activities_created",
        "ix_activities_revision",
        "ix_activities_task",
      ]);
      assert.deepEqual(indexNamed(board.db, "ix_activities_revision").columns, ["revision"]);
      assert.deepEqual(indexNamed(board.db, "ix_activities_created").columns, ["created_at"]);

      const rows = board.db.prepare("SELECT event, revision FROM task_activities ORDER BY id").all();
      assert.deepEqual(rows.map((row) => row.event), ["handwritten", "task_created", "task_updated"]);
      assert.equal(rows[0].revision, null, "a hand-written NULL revision survives");
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      board.close();
    }
  });

  it("plans both range reads through their index", async () => {
    const board = await createTempBoard();
    try {
      const plan = (sql, ...params) =>
        board.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => String(row.detail))
          .join(" | ");

      assert.match(
        plan("SELECT * FROM task_activities WHERE revision > ? ORDER BY revision, id LIMIT 500", 0),
        /ix_activities_revision/,
      );
      assert.match(
        plan("SELECT task_id FROM task_activities WHERE created_at >= ?", TS),
        /ix_activities_created/,
      );
    } finally {
      board.close();
    }
  });

  it("ends on the same index shape as a fresh board", async () => {
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir: before0037() });
      applyMigrations(upgraded.db);
      assert.deepEqual(activityIndexes(upgraded.db), activityIndexes(fresh.db));
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
