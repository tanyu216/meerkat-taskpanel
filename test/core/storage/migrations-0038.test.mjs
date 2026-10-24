/**
 * 0038 — `deploy` leaves the card model.
 *
 * Properties:
 *
 *   1. a historical `deploy` row survives the rebuild as `task`, keeping its
 *      acceptance mode (0037's `agent` snapshot) and every other column;
 *   2. after the rebuild the table's own CHECK refuses `deploy` again — for an
 *      INSERT and for an UPDATE;
 *   3. nothing else moved: the index set, the triggers on `tasks`, the parked
 *      external triggers and the foreign keys are all intact.
 *
 * Raw SQL on purpose: the command layer already refuses `kind=deploy`, so a
 * fixture that went through `createTask` could not tell the backfill from a
 * refusal.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { indexShapesOf, triggersOf } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir, reasonCode } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0038 — a board as the previous build left it. */
function before0038() {
  const dir = makeTempDir("meerkat-taskpanel-pre0038-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0038",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const tasksSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;

function seedDeployBoard(db) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at)
     VALUES ('legacy', 'Legacy', 5, '[]', '{}', ?, ?)`,
  ).run(TS, TS);
  // A deployment card as 0015–0037 stored it: the marker plus the review gate
  // 0037 mirrored as `agent`.
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, kind, meta_json,
                       review_required, acceptance_mode, created_at, updated_at, status_changed_at)
     VALUES ('dep', 'LEGACY-0001', 'legacy', 'Rebuild dist', 'todo', 'deploy', '{"target":"/srv"}',
             1, 'agent', ?, ?, ?)`,
  ).run(TS, TS, TS);
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, kind, created_at, updated_at, status_changed_at)
     VALUES ('plain', 'LEGACY-0002', 'legacy', 'Ordinary', 'todo', 'task', ?, ?, ?)`,
  ).run(TS, TS, TS);
}

describe("storage/migrations — 0038 retires the deploy kind", () => {
  it("copies a deploy row across as a task, keeping its acceptance snapshot", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0038() });
      assert.match(tasksSql(board.db), /'deploy'/, "precondition: the old CHECK names deploy");
      seedDeployBoard(board.db);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0038"]);

      const dep = board.db.prepare("SELECT * FROM tasks WHERE id = 'dep'").get();
      assert.equal(dep.kind, "task", "a historical deployment card becomes an ordinary card");
      assert.equal(dep.acceptance_mode, "agent", "its review gate is untouched");
      assert.equal(dep.review_required, 1);
      assert.equal(dep.identifier, "LEGACY-0001");
      assert.equal(JSON.parse(dep.meta_json).target, "/srv", "every other column survives");
      assert.equal(board.db.prepare("SELECT kind FROM tasks WHERE id = 'plain'").get().kind, "task");

      assert.match(tasksSql(board.db), /CHECK \(kind IN \('task','epic'\)\)/, "the CHECK is narrowed");
      assert.equal(/deploy/.test(tasksSql(board.db)), false);
    } finally {
      board.close();
    }
  });

  it("refuses the retired kind on both write paths, from the table itself", async () => {
    const board = await createTempBoard();
    try {
      board.db.prepare(
        `INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at)
         VALUES ('p', 'P', 5, '[]', '{}', ?, ?)`,
      ).run(TS, TS);
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, kind, created_at, updated_at)
               VALUES ('d', 'P-1', 'p', 'x', 'todo', 'deploy', ?, ?)`,
            )
            .run(TS, TS),
        ),
        "VALIDATION_FAILED",
        "the CHECK refuses a new deploy card",
      );
      board.db
        .prepare(
          `INSERT INTO tasks(id, identifier, project_id, title, status, kind, created_at, updated_at)
           VALUES ('t', 'P-2', 'p', 'x', 'todo', 'task', ?, ?)`,
        )
        .run(TS, TS);
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET kind = 'deploy' WHERE id = 't'").run()),
        "VALIDATION_FAILED",
        "...and an update to the retired kind",
      );
    } finally {
      board.close();
    }
  });

  it("leaves the index set, triggers and foreign keys intact", async () => {
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0038() });
      const indexesBefore = indexShapesOf(upgrade.db, "tasks");
      const triggersBefore = triggersOf(upgrade.db);

      applyMigrations(upgrade.db);

      assert.deepEqual(indexShapesOf(upgrade.db, "tasks"), indexesBefore, "no index lost or added");
      assert.deepEqual(indexShapesOf(upgrade.db, "tasks"), indexShapesOf(fresh.db, "tasks"));
      // Every trigger comes back; the only text that may change is the table's
      // own kind CHECK, which no trigger carries.
      assert.deepEqual(triggersOf(upgrade.db), triggersBefore);

      const leftovers = upgrade.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tasks_%'")
        .all()
        .map((r) => r.name);
      assert.deepEqual(leftovers, [], "the scratch table is gone");
      assert.equal(upgrade.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(upgrade.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(upgrade.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "the pragma is restored");
    } finally {
      upgrade.close();
      fresh.close();
    }
  });
});
