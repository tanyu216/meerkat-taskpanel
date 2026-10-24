/**
 * 0038 — the activity log is append-only in the schema.
 *
 * The rows are the change feed: an UPDATE would rewrite history a client
 * already received, and a DELETE would leave a gap the revision cursor can
 * never replay. The migration adds two refusing triggers; the test also checks
 * the upgrade lands on the same trigger set as a fresh board.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { migrationsBefore, triggersOf } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertProject, insertTask, reasonCode } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const before0038 = migrationsBefore("0038", { prefix: "meerkat-taskpanel-pre0038-" });

describe("storage/migrations — 0038 activity immutability", () => {
  it("refuses UPDATE and DELETE, and keeps every row", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0038() });
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001" });
      board.db
        .prepare("INSERT INTO task_activities(task_id,event,changes_json,revision,created_at) VALUES('task-1','task_created','{}',1,?)")
        .run(TS);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0038"]);

      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE task_activities SET event = 'rewritten'").run()),
        "ACTIVITY_APPEND_ONLY",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("DELETE FROM task_activities").run()),
        "ACTIVITY_APPEND_ONLY",
      );

      assert.deepEqual(
        board.db.prepare("SELECT event, revision FROM task_activities").all().map((row) => ({ ...row })),
        [{ event: "task_created", revision: 1 }],
      );
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      board.close();
    }
  });

  it("ends on the same trigger set as a fresh board", async () => {
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir: before0038() });
      applyMigrations(upgraded.db);
      const triggers = triggersOf(upgraded.db);
      assert.ok(triggers.tr_activities_no_update, "the UPDATE guard exists");
      assert.ok(triggers.tr_activities_no_delete, "the DELETE guard exists");
      assert.deepEqual(triggers, triggersOf(fresh.db));
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
