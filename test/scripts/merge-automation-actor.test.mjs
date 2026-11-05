/**
 * The one-off repair that merges the two historical automation actors into
 * `Board`.
 *
 * The script updates and deletes rows in append-only tables, so the test proves
 * the guard rails rather than just the happy path: the append-only triggers and
 * the dictionary's no-delete rule are restored byte-for-byte, a second run is a
 * no-op, a task still pointing at a legacy actor refuses the merge, and the
 * foreign keys survive.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { norm } from "../../src/foundation/norm.mjs";
import {
  ATOMICITY_TRIGGERS,
  applyMerge,
  formatPlan,
  planMerge,
  writeRepairRecord,
} from "../../scripts/repair/merge-automation-actor.mjs";
import { backupBoard } from "../../scripts/repair/dedupe-loop-acceptance-comments.mjs";
import { TS, cleanupTempDirs, withBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HUMAN = { kind: "human", id: "Terry" };

function commandsFor(db) {
  return createCommands(createContext({ db, repos: createRepositories(db) }));
}

function insertActor(db, { id, displayName = id, firstSeenAt = TS, lastSeenAt = TS, useCount = 1 }) {
  db.prepare(
    `INSERT INTO actors (id, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, displayName, norm(displayName), firstSeenAt, lastSeenAt, useCount);
}

function insertCommentRow(db, { id, taskId, authorId, kind = "note", at = TS }) {
  db.prepare(
    `INSERT INTO comments (id, task_id, body, kind, author_kind, author_id, version, created_at)
     VALUES (?, ?, ?, ?, 'system', ?, 1, ?)`,
  ).run(id, taskId, `comment by ${authorId}`, kind, authorId, at);
}

function insertReportRow(db, { taskId, round, authorId, at = TS }) {
  db.prepare(
    `INSERT INTO task_reports (task_id, round, conclusion, acceptance_json, evidence_json, author_kind, author_id, created_at)
     VALUES (?, ?, 'done', '[]', '[]', 'system', ?, ?)`,
  ).run(taskId, round, authorId, at);
}

/** A project + card, then the historical automation authors and their rows. */
function seed(db) {
  const commands = commandsFor(db);
  commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
  const task = commands.createTask({ projectId: "proj", title: "Card", actor: HUMAN });

  insertActor(db, { id: "system", displayName: "system", firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-02T00:00:00.000Z", useCount: 4 });
  insertActor(db, { id: "Orchestrator", displayName: "Orchestrator", firstSeenAt: "2026-10-03T00:00:00.000Z", lastSeenAt: "2026-10-04T00:00:00.000Z", useCount: 6 });

  insertCommentRow(db, { id: "c1", taskId: task.id, authorId: "system" });
  insertCommentRow(db, { id: "c2", taskId: task.id, authorId: "system", kind: "change" });
  insertCommentRow(db, { id: "c3", taskId: task.id, authorId: "Orchestrator" });
  insertReportRow(db, { taskId: task.id, round: 1, authorId: "system" });

  return task;
}

function triggerSql(db) {
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${ATOMICITY_TRIGGERS.map(() => "?").join(",")})`)
    .all(...ATOMICITY_TRIGGERS);
  return new Map(rows.map((row) => [row.name, row.sql]));
}

describe("merge-automation-actor", () => {
  it("plans one Board row from the two legacy actors", async () => {
    await withBoard(({ db }) => {
      seed(db);
      const plan = planMerge(db, { now: TS });

      assert.deepEqual(
        plan.legacy.map((row) => [row.displayName, row.comments, row.reports, row.useCount]),
        [
          ["Orchestrator", 1, 0, 6],
          ["system", 2, 1, 4],
        ],
      );
      assert.deepEqual(plan.merged, {
        comments: 3,
        reports: 1,
        useCount: 10,
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        lastSeenAt: "2026-10-04T00:00:00.000Z",
      });
      assert.equal(plan.board.create, true, "the board has no `Board` actor yet");
      assert.equal(plan.board.displayName, "Board");
      assert.deepEqual(plan.blocked.tasks, []);
      assert.match(formatPlan(plan), /MERGE → Board/);
    });
  });

  it("merges the rows, deletes the old actors, and restores every trigger verbatim", async () => {
    await withBoard(({ db, dir }) => {
      const task = seed(db);
      const before = triggerSql(db);
      const plan = planMerge(db, { now: TS });

      const backup = backupBoard(db, join(dir, "backups", "board.pre-merge.sqlite"));
      assert.ok(existsSync(backup), "a backup is written before any write");

      const result = applyMerge(db, plan);
      assert.deepEqual(result, {
        mergedComments: 3,
        mergedReports: 1,
        deletedActors: 2,
        boardId: plan.board.id,
      });

      const board = db.prepare("SELECT * FROM actors WHERE normalized_name = ?").get("board");
      assert.equal(board.display_name, "Board");
      assert.equal(board.use_count, 10);
      assert.equal(board.first_seen_at, "2026-10-01T00:00:00.000Z");
      assert.equal(board.last_seen_at, "2026-10-04T00:00:00.000Z");

      assert.deepEqual(
        db.prepare("SELECT id FROM comments WHERE author_id = ? ORDER BY id").all(board.id).map((row) => row.id),
        ["c1", "c2", "c3"],
      );
      assert.deepEqual(
        db.prepare("SELECT round FROM task_reports WHERE author_id = ?").all(board.id).map((row) => row.round),
        [1],
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM actors WHERE normalized_name IN ('system', 'orchestrator')").get().n,
        0,
        "the two legacy rows are gone",
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

      assert.deepEqual(triggerSql(db), before, "the five triggers are byte-for-byte restored");
      // The append-only invariant and the dictionary rule are live again.
      assert.throws(() => db.exec("DELETE FROM comments"), /COMMENT_APPEND_ONLY/);
      assert.throws(() => db.exec("DELETE FROM task_reports"), /REPORT_APPEND_ONLY/);
      assert.throws(() => db.exec(`DELETE FROM actors WHERE id = '${board.id}'`), /DICTIONARY_ENTRY_IN_USE/);

      // The task itself was never re-pointed: this repair owns comments/reports.
      assert.equal(db.prepare("SELECT id FROM tasks WHERE id = ?").get(task.id).id, task.id);
      assert.equal(db.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(task.id).assignee_id, null);
    });
  });

  it("is a no-op on a second run", async () => {
    await withBoard(({ db }) => {
      seed(db);
      applyMerge(db, planMerge(db, { now: TS }));
      const again = planMerge(db, { now: TS });
      assert.deepEqual(again.legacy, []);
      assert.equal(again.board.create, false);
      assert.equal(again.board.update, false);
      assert.deepEqual(applyMerge(db, again), {
        mergedComments: 0,
        mergedReports: 0,
        deletedActors: 0,
        boardId: again.board.id,
      });
      assert.equal(again.merged.comments, 0, "a merged count never double-counts");
    });
  });

  it("adds to an existing Board row instead of replacing it", async () => {
    await withBoard(({ db }) => {
      seed(db);
      insertActor(db, { id: "board-existing", displayName: "Board", useCount: 2 });
      insertCommentRow(db, { id: "existing", taskId: seedTaskId(db), authorId: "board-existing" });

      const plan = planMerge(db, { now: TS });
      assert.equal(plan.board.id, "board-existing");
      assert.equal(plan.board.create, false);
      applyMerge(db, plan);

      const board = db.prepare("SELECT * FROM actors WHERE id = 'board-existing'").get();
      assert.equal(board.use_count, 12, "the previous use count is kept and the legacy counts added");
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = 'board-existing'").get().n,
        4,
        "the existing Board comment is not lost",
      );
    });
  });

  it("refuses to merge while a task still references a legacy actor", async () => {
    await withBoard(({ db }) => {
      seed(db);
      // `tr_dict_actors_delete` would refuse this delete anyway; the plan must
      // name it before a write is attempted.
      db.prepare("UPDATE tasks SET assignee_id = 'system' WHERE id = ?").run(seedTaskId(db));
      const plan = planMerge(db, { now: TS });
      assert.equal(plan.blocked.tasks.length, 1);
      assert.throws(() => applyMerge(db, plan), /still reference a legacy actor/);
    });
  });

  it("writes a repair record naming the backup and the merged ids", async () => {
    await withBoard(({ db, dir }) => {
      seed(db);
      const plan = planMerge(db, { now: TS });
      const backup = backupBoard(db, join(dir, "backups", "board.pre-merge.sqlite"));
      const result = applyMerge(db, plan);

      const path = writeRepairRecord(dir, plan, result, backup);
      const record = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(record.backup, backup);
      assert.deepEqual(record.board, { id: plan.board.id, displayName: "Board", kind: "system" });
      assert.equal(record.mergedComments, 3);
      assert.equal(record.mergedReports, 1);
      assert.equal(record.deletedActors, 2);
      assert.deepEqual(
        record.legacy.map((row) => row.displayName).sort(),
        ["Orchestrator", "system"],
      );
    });
  });
});

function seedTaskId(db) {
  return db.prepare("SELECT id FROM tasks LIMIT 1").get().id;
}
