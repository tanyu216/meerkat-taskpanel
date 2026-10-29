/**
 * The one-off repair for repeated loop-acceptance notes.
 *
 * The script deletes rows from two append-only tables, so the test proves the
 * guard rails rather than just the happy path: the selection keeps exactly one
 * row per `(task_id, body)`, the no-delete triggers are restored byte-for-byte,
 * and a second run is a no-op.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import {
  applyRepair,
  assertBoardStopped,
  backupBoard,
  planDuplicates,
  writeRepairRecord,
} from "../../scripts/repair/dedupe-loop-acceptance-comments.mjs";
import { cleanupTempDirs, withBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HUMAN = { kind: "human", id: "Terry" };
const REPEATED = "Loop acceptance after review PROJ-0002 (round 1): VERDICT: APPROVE.";
const SINGLE = "Loop acceptance after review PROJ-0003 (round 1): VERDICT: APPROVE.";
const UNRELATED = "Hand-written note that must survive.";

function commandsFor(db) {
  return createCommands(createContext({ db, repos: createRepositories(db) }));
}

function insertComment(db, { id, taskId, body, at }) {
  // `comments.author_id` references actors; the board's own actor already exists.
  const authorId = db.prepare("SELECT id FROM actors LIMIT 1").get().id;
  db.prepare(
    `INSERT INTO comments (id, task_id, body, kind, author_kind, author_id, version, created_at)
     VALUES (?, ?, ?, 'note', 'taskd', ?, 1, ?)`,
  ).run(id, taskId, body, authorId, at);
  db.prepare(
    `INSERT INTO task_activities (task_id, actor_kind, actor_id, event, changes_json, created_at)
     VALUES (?, 'taskd', ?, 'comment_added', ?, ?)`,
  ).run(taskId, authorId, JSON.stringify({ commentId: id, kind: "note" }), at);
}

/** A board with three identical loop notes, one legitimate loop note, and a human note. */
function seed(db) {
  const commands = commandsFor(db);
  commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
  const task = commands.createTask({ projectId: "proj", title: "Card", actor: HUMAN });
  insertComment(db, { id: "c1", taskId: task.id, body: REPEATED, at: "2026-10-29T17:16:51.000Z" });
  insertComment(db, { id: "c2", taskId: task.id, body: REPEATED, at: "2026-10-29T17:27:00.000Z" });
  insertComment(db, { id: "c3", taskId: task.id, body: REPEATED, at: "2026-10-29T17:36:53.000Z" });
  insertComment(db, { id: "c4", taskId: task.id, body: SINGLE, at: "2026-10-29T18:00:00.000Z" });
  insertComment(db, { id: "c5", taskId: task.id, body: UNRELATED, at: "2026-10-29T18:01:00.000Z" });
  return task;
}

describe("dedupe-loop-acceptance-comments", () => {
  it("keeps the earliest row per (task_id, body) and ignores everything else", async () => {
    await withBoard(({ db }) => {
      seed(db);
      const plan = planDuplicates(db, { keep: 1 });

      assert.equal(plan.total, 4, "only the four loop notes are in scope");
      assert.equal(plan.keeping, 2);
      assert.equal(plan.deleting, 2);

      const repeated = plan.groups.find((group) => group.body === REPEATED);
      assert.deepEqual(repeated.delete, ["c2", "c3"], "the earliest survives");
      const single = plan.groups.find((group) => group.body === SINGLE);
      assert.deepEqual(single.delete, [], "a real one-off acceptance is untouched");
      assert.equal(plan.groups.some((group) => group.body === UNRELATED), false);
    });
  });

  it("deletes the redundant rows, their activity rows, and restores the triggers", async () => {
    await withBoard(({ db, dir }) => {
      const task = seed(db);
      const plan = planDuplicates(db, { keep: 1 });

      const backup = backupBoard(db, join(dir, "backups", "board.pre-repair.sqlite"));
      assert.ok(existsSync(backup), "a backup is written before any delete");

      const result = applyRepair(db, plan);
      assert.equal(result.deletedComments, 2);
      assert.equal(result.deletedActivities, 2, "no phantom `commented` feed rows are left");

      assert.deepEqual(
        db
          .prepare("SELECT id FROM comments WHERE task_id = ? AND body = ?")
          .all(task.id, REPEATED)
          .map((row) => row.id),
        ["c1"],
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND body = ?").get(task.id, UNRELATED).n,
        1,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM task_activities WHERE event = 'comment_added'").get().n,
        3,
        "three comments remain, three activity rows",
      );

      // The append-only invariant is back: a raw writer is refused again.
      assert.throws(() => db.exec("DELETE FROM comments"), /COMMENT_APPEND_ONLY/);
      assert.throws(() => db.exec("DELETE FROM task_activities"), /ACTIVITY_APPEND_ONLY/);

      const record = JSON.parse(readFileSync(writeRepairRecord(dir, plan, result, backup), "utf8"));
      assert.deepEqual(
        record.groups.find((group) => group.body === REPEATED).deletedIds,
        ["c2", "c3"],
      );
      assert.equal(record.deletedComments, 2);
    });
  });

  it("is a no-op on a second run", async () => {
    await withBoard(({ db }) => {
      seed(db);
      applyRepair(db, planDuplicates(db, { keep: 1 }));
      const again = planDuplicates(db, { keep: 1 });
      assert.equal(again.deleting, 0);
      assert.deepEqual(applyRepair(db, again), { deletedComments: 0, deletedActivities: 0 });
    });
  });

  it("refuses to run while the board's writer pid is alive", async () => {
    await withBoard(({ dir }) => {
      writeFileSync(join(dir, "writer.lock"), JSON.stringify({ pid: process.pid }));
      assert.throws(() => assertBoardStopped(dir), /taskd is still running/);
      assert.doesNotThrow(() => assertBoardStopped(dir, { force: true }));

      writeFileSync(join(dir, "writer.lock"), JSON.stringify({ pid: 99_999_999 }));
      assert.doesNotThrow(() => assertBoardStopped(dir), "a stale lock does not block");
    });
  });
});
