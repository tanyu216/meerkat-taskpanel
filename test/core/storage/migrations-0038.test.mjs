/**
 * 0038 — the single acceptance vocabulary.
 *
 * Properties:
 *
 *   1. the project default maps `review_policy` faithfully, and the card
 *      backfill keeps in-flight no-review deliveries on the human path;
 *   2. `acceptance_mode` and the legacy `review_required` mirror cannot drift,
 *      and a review card is always `off`;
 *   3. only `off` gains the direct `in_progress → done` edge, and it still owes
 *      its baseline evidence; `agent` still owes a current-round review.
 *
 * Raw SQL on purpose: the fixture's `createTask` would hide a backfill bug.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { migrationsThrough } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

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

/**
 * 0039 — the state these first three cases describe. 0040 drops the mirror
 * columns they exercise; the post-0040 schema is 0040's own suite.
 */
const through0039 = migrationsThrough("0039");

const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").trim()]),
  );

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

const raises = (fn, code) =>
  assert.throws(fn, (err) => String(err.message).includes(code));

function seedProject(db, id, reviewPolicy) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, review_policy, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, id, 20, "[]", "{}", reviewPolicy, TS, TS);
}

function seedTask(db, id, projectId, status, reviewRequired = 0, acceptanceJson = "[]") {
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, acceptance_json, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `${projectId}-${id}`, projectId, id, status, reviewRequired, acceptanceJson, TS, TS, TS);
}

function seedReview(db, id, originalId) {
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_of_id, review_round, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `p1-${id}`, "p1", id, "in_review", originalId, 1, TS, TS, TS);
}

function seed(db) {
  seedProject(db, "p1", "required");
  seedProject(db, "p2", "optional");
  seedProject(db, "p3", "off");
  seedTask(db, "t-req", "p1", "in_progress", 1);
  seedTask(db, "t-off", "p2", "in_progress", 0);
  seedTask(db, "t-inflight", "p2", "in_review", 0);
  seedReview(db, "r1", "t-req");
}

const modeOf = (db, id) =>
  db.prepare("SELECT acceptance_mode FROM tasks WHERE id = ?").get(id).acceptance_mode;

describe("storage/migrations — 0038 acceptance mode", () => {
  it("maps the project policy and backfills card modes conservatively", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0038() });
      seed(board.db);
      const up = applyMigrations(board.db, { dir: through0039() });
      assert.ok(up.applied.some((m) => m.version === "0038"));

      const projects = board.db
        .prepare("SELECT id, acceptance FROM projects ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(projects, [
        { id: "p1", acceptance: "agent" },
        { id: "p2", acceptance: "auto" },
        { id: "p3", acceptance: "off" },
      ]);

      assert.equal(modeOf(board.db, "t-req"), "agent");
      assert.equal(modeOf(board.db, "t-off"), "off");
      // The one conservative grandfather: an in-flight no-review delivery.
      assert.equal(modeOf(board.db, "t-inflight"), "human");
      assert.equal(modeOf(board.db, "r1"), "off");

      // The legacy columns are still there for the compatibility release.
      const cols = board.db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
      assert.ok(cols.includes("review_required"));
      assert.ok(cols.includes("acceptance_mode"));
    } finally {
      board.close();
    }
  });

  it("refuses a raw write that breaks the mirror or the review-card rule", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0038() });
      seed(board.db);
      applyMigrations(board.db, { dir: through0039() });

      raises(
        () => board.db.prepare("UPDATE tasks SET acceptance_mode = 'agent' WHERE id = 't-off'").run(),
        "ACCEPTANCE_MODE_CONFLICT",
      );
      raises(
        () => board.db.prepare("UPDATE tasks SET review_required = 1 WHERE id = 't-off'").run(),
        "ACCEPTANCE_MODE_CONFLICT",
      );
      raises(
        () => board.db.prepare("UPDATE tasks SET acceptance_mode = 'human' WHERE id = 'r1'").run(),
        "REVIEW_CARD_MARKER_INVALID",
      );
      raises(
        () =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, created_at, updated_at, status_changed_at)
               VALUES ('t-bad','p2-t-bad','p2','t-bad','todo',1,?,?,?)`,
            )
            .run(TS, TS, TS),
        "ACCEPTANCE_MODE_CONFLICT",
      );
    } finally {
      board.close();
    }
  });

  it("lets only off take the direct done edge, and still enforces its evidence", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0038() });
      seed(board.db);
      applyMigrations(board.db, { dir: through0039() });

      // off, empty baseline → direct done is allowed.
      assert.doesNotThrow(() =>
        board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-off'").run(),
      );

      // agent from in_progress is not on the whitelist; it must deliver first.
      raises(
        () => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-req'").run(),
        "INVALID_TRANSITION",
      );

      // human from in_progress is likewise refused.
      seedTask(board.db, "t-human", "p2", "in_progress", 0);
      board.db.prepare("UPDATE tasks SET acceptance_mode = 'human' WHERE id = 't-human'").run();
      raises(
        () => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-human'").run(),
        "INVALID_TRANSITION",
      );

      // …but a human card delivered to in_review may be closed by the human path.
      assert.doesNotThrow(() =>
        board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-inflight'").run(),
      );

      // off with a non-empty baseline and no current-round report is refused.
      seedTask(board.db, "t-evidence", "p2", "in_progress", 0, '["criterion"]');
      raises(
        () => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-evidence'").run(),
        "REPORT_REQUIRED",
      );
    } finally {
      board.close();
    }
  });

  it("upgrades to the same schema as a fresh board", async () => {
    const fresh = await createTempBoard();
    const upgraded = await createTempBoard({ migrate: false });
    try {
      applyMigrations(upgraded.db, { dir: before0038() });
      seed(upgraded.db);
      applyMigrations(upgraded.db);

      assert.deepEqual(triggersOf(upgraded.db), triggersOf(fresh.db));
      assert.deepEqual(tableNames(upgraded.db), tableNames(fresh.db));
      assert.equal(upgraded.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      fresh.close();
      upgraded.close();
    }
  });
});
