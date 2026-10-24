/**
 * 0034 — questions, and the answered card's way back to the queue.
 *
 * Three properties:
 *
 *   1. the `comments` rebuild keeps every row, the two indexes and the five
 *      triggers, and widens the CHECK by exactly one literal (`question`);
 *   2. `awaiting → todo` is legal at the whitelist, does **not** bump the
 *      delivery round, and the other banned exits (`in_review`, `done`,
 *      `blocked`) stay banned;
 *   3. the upgrade ends on the same schema as a fresh board.
 *
 * Raw SQL on purpose: the command layer's own behaviour is exercised in the
 * command tests; this file pins the schema the command layer relies on.
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
  insertComment,
  insertProject,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0034 — a board as the previous build left it. */
function before0034() {
  const dir = makeTempDir("meerkat-taskpanel-pre0034-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0034",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const indexNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'comments'")
    .all()
    .map((row) => row.name)
    .sort();

const triggerNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all()
    .map((row) => row.name)
    .sort();

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

function seed(db) {
  insertProject(db);
  insertTask(db, { id: "task-1", identifier: "PROJ-0001", status: "awaiting", awaiting_reason: "E2" });
  insertComment(db, { id: "c-1", task_id: "task-1", kind: "discuss", body: "kept as-is", author_id: "linus" });
  insertComment(db, { id: "c-2", task_id: "task-1", kind: "decision", body: "the decision", author_id: "terry", author_kind: "human" });
}

describe("storage/migrations — 0034 questions and awaiting → todo", () => {
  it("rebuilds comments, keeps the rows, and lets `question` through", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0034() });
      seed(board.db);
      const before = {
        indexes: indexNames(board.db),
        triggers: triggerNames(board.db),
      };
      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0034", "0035", "0036", "0038", "0039"]);

      const kinds = board.db
        .prepare("SELECT id, kind, body FROM comments ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(kinds, [
        { id: "c-1", kind: "discuss", body: "kept as-is" },
        { id: "c-2", kind: "decision", body: "the decision" },
      ]);
      assert.deepEqual(indexNames(board.db), before.indexes, "both indexes survive the rebuild");
      // 0038 adds its own triggers and replaces the legacy review-required
      // floor; 0034's rebuild is proved against the rest of the set.
      const LATER_0038_ADDED = [
        "tr_tasks_acceptance_agent_done",
        "tr_tasks_acceptance_mode_ins",
        "tr_tasks_acceptance_mode_upd",
        "tr_deliver_gate_done",
      ];
      const LATER_0038_REMOVED = ["tr_tasks_review_required_done"];
      assert.deepEqual(
        triggerNames(board.db).filter((name) => !LATER_0038_ADDED.includes(name)),
        before.triggers.filter((name) => !LATER_0038_REMOVED.includes(name)),
        "the trigger set (incl. the actor guard) is unchanged by 0034",
      );

      const actorId = ensureActor(board.db, "linus", "agent");
      assert.doesNotThrow(() =>
        board.db
          .prepare(
            `INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at)
             VALUES ('c-3', 'task-1', 'which schema?', 'question', 'agent', ?, '[]', 1, ?)`,
          )
          .run(actorId, TS),
      );
      assert.throws(
        () =>
          board.db
            .prepare(
              `INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at)
               VALUES ('c-4', 'task-1', 'nope', 'essay', 'agent', ?, '[]', 1, ?)`,
            )
            .run(actorId, TS),
        (err) => String(err.message).includes("CHECK"),
      );
    } finally {
      board.close();
    }
  });

  it("allows awaiting → todo without bumping the round, and keeps the other exits shut", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0034() });
      seed(board.db);
      applyMigrations(board.db);

      const roundBefore = board.db
        .prepare("SELECT delivery_round FROM tasks WHERE id = 'task-1'")
        .get().delivery_round;

      const moveTo = (to) =>
        reasonCode(() =>
          board.db
            .prepare("UPDATE tasks SET status = ?, status_changed_at = ? WHERE id = 'task-1'")
            .run(to, TS),
        );

      for (const banned of ["in_review", "done", "blocked"]) {
        assert.equal(moveTo(banned), "INVALID_TRANSITION", `awaiting → ${banned} stays illegal`);
      }
      assert.equal(moveTo("todo"), "NO_ERROR");
      const after = board.db
        .prepare("SELECT status, delivery_round FROM tasks WHERE id = 'task-1'")
        .get();
      assert.equal(after.status, "todo");
      assert.equal(after.delivery_round, roundBefore, "re-queueing is not a reopen");
      // Clearing `awaiting_reason` is `moveCas`'s job (a raw writer leaves it) —
      // pinned by the command tests, not here.
    } finally {
      board.close();
    }
  });

  it("upgrades to the same schema as a fresh board", async () => {
    const fresh = await createTempBoard();
    const upgraded = await createTempBoard({ migrate: false });
    try {
      applyMigrations(upgraded.db, { dir: before0034() });
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
