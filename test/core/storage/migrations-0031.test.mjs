/**
 * 0031 — the per-project review policy, the per-card review decision, and the
 * project reviewer override.
 *
 * Three properties:
 *
 *   1. the backfill keeps pre-existing ordinary cards on the old "reviewed"
 *      path and leaves review cards at 0;
 *   2. a review card can never be marked as needing its own review (INSERT and
 *      UPDATE);
 *   3. a `review_required = 1` card cannot reach `done` without a current-round
 *      review card that reached the reviewer — a canceled or old-round review
 *      does not count.
 *
 * Raw SQL on purpose: the fixture's `createTask` would hide a backfill bug.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0031 — a board as the previous build left it. */
function before0031() {
  const dir = makeTempDir("meerkat-taskpanel-pre0031-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0031",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
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

function seedProject(db) {
  db.prepare(
    "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("p1", "P1", 20, "[]", "{}", TS, TS);
}

/** One ordinary card, at `status`, with an explicit delivery round. */
function seedTask(db, id, identifier, status = "in_review", round = 1) {
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, delivery_round, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, identifier, "p1", id, status, round, TS, TS, TS);
}

/** A review card for `originalId`, at `status`, auditing `round`. */
function seedReview(db, id, identifier, originalId, status = "in_review", round = 1) {
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_of_id, review_round, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, identifier, "p1", id, status, originalId, round, TS, TS, TS);
}

const setDone = (db, id) => db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);

function seed(db) {
  seedProject(db);
  seedTask(db, "t1", "P1-0001");
  seedTask(db, "t2", "P1-0002");
  seedTask(db, "t3", "P1-0003");
  seedTask(db, "t4", "P1-0004");
  seedTask(db, "t5", "P1-0005");
  seedReview(db, "r1", "P1-0011", "t1", "in_review", 1);
  seedReview(db, "r2", "P1-0012", "t2", "in_review", 2); // wrong round
  seedReview(db, "r3", "P1-0013", "t3", "canceled", 1); // canceled does not count
  seedReview(db, "r4", "P1-0014", "t4", "done", 1); // a closed review counts
}

describe("storage/migrations — 0031 review policy and decision", () => {
  it("backfills ordinary cards to 1, keeps review cards at 0, and defaults the project", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0031() });
      seed(board.db);
      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0031"]);

      const project = board.db
        .prepare("SELECT review_policy, reviewer FROM projects WHERE id = 'p1'")
        .get();
      assert.equal(project.review_policy, "optional");
      assert.equal(project.reviewer, null);

      const plain = (rows) => rows.map((row) => ({ ...row }));
      const rows = board.db
        .prepare("SELECT id, review_required FROM tasks WHERE review_of_id IS NULL ORDER BY id")
        .all();
      assert.deepEqual(plain(rows), [
        { id: "t1", review_required: 1 },
        { id: "t2", review_required: 1 },
        { id: "t3", review_required: 1 },
        { id: "t4", review_required: 1 },
        { id: "t5", review_required: 1 },
      ]);
      assert.deepEqual(
        plain(
          board.db
            .prepare("SELECT id, review_required FROM tasks WHERE review_of_id IS NOT NULL ORDER BY id")
            .all(),
        ),
        [
          { id: "r1", review_required: 0 },
          { id: "r2", review_required: 0 },
          { id: "r3", review_required: 0 },
          { id: "r4", review_required: 0 },
        ],
      );
    } finally {
      board.close();
    }
  });

  it("refuses to mark a review card as requiring its own review", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0031() });
      seed(board.db);
      applyMigrations(board.db);

      assert.throws(
        () => board.db.prepare("UPDATE tasks SET review_required = 1 WHERE id = 'r1'").run(),
        (err) => String(err.message).includes("REVIEW_CARD_MARKER_INVALID"),
      );
      assert.throws(
        () =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, review_of_id, review_round, review_required, created_at, updated_at, status_changed_at)
               VALUES ('r9','P1-0019','p1','r9','todo','t1',1,1,?,?,?)`,
            )
            .run(TS, TS, TS),
        (err) => String(err.message).includes("REVIEW_CARD_MARKER_INVALID"),
      );
    } finally {
      board.close();
    }
  });

  it("requires a current-round review card before a required card can be done", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0031() });
      seed(board.db);
      applyMigrations(board.db);

      // t1 has an in_review review for round 1 — accepted.
      assert.doesNotThrow(() => setDone(board.db, "t1"));

      // t2's review audits round 2, not its current round 1 — refused.
      assert.throws(
        () => setDone(board.db, "t2"),
        (err) => String(err.message).includes("REVIEW_REQUIRED"),
      );

      // t3's only review is canceled — refused.
      assert.throws(
        () => setDone(board.db, "t3"),
        (err) => String(err.message).includes("REVIEW_REQUIRED"),
      );

      // t4 has a done review for round 1 — accepted.
      assert.doesNotThrow(() => setDone(board.db, "t4"));

      // t5 has no review at all; a human waiver sets the decision to 0, after
      // which the card can be accepted without one.
      assert.throws(
        () => setDone(board.db, "t5"),
        (err) => String(err.message).includes("REVIEW_REQUIRED"),
      );
      board.db.prepare("UPDATE tasks SET review_required = 0 WHERE id = 't5'").run();
      assert.doesNotThrow(() => setDone(board.db, "t5"));
    } finally {
      board.close();
    }
  });

  it("upgrades to the same schema as a fresh board", async () => {
    const fresh = await createTempBoard();
    const upgraded = await createTempBoard({ migrate: false });
    try {
      applyMigrations(upgraded.db, { dir: before0031() });
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
