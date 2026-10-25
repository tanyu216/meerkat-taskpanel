/**
 * 0040 — the acceptance compatibility layer leaves the schema.
 *
 * Properties:
 *
 *   1. a full board survives: both legacy columns disappear, every other value
 *      is untouched;
 *   2. the retired spellings are not writable any more, and the surviving
 *      `acceptance_mode` is;
 *   3. a review card is still forced to `off` — now by the one trigger that
 *      replaced the mirror pair;
 *   4. the `agent` done gate and the revision cursors still work, including for
 *      the two columns the cursors name;
 *   5. the upgraded board is structurally identical to a fresh one, and the
 *      migration is a no-op the second time.
 *
 * Raw SQL on purpose: the command layer refuses the old spellings before they
 * reach the board, so a fixture that went through `createTask` could not tell a
 * refusal from a dropped column.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { migrationsThrough } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, revision } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **through** 0039 — a board as the previous build left it. */
const through0039 = migrationsThrough("0039");

const columnsOf = (db, table) =>
  db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => row.name);

const raises = (fn, code) =>
  assert.throws(fn, (err) => String(err.message).includes(code));

function seed(db) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, review_policy, acceptance, created_at, updated_at)
     VALUES ('p', 'P', 10, '[]', '{"k":"v"}', 'required', 'agent', ?, ?)`,
  ).run(TS, TS);
  // An `agent` card that was delivered: its review card is already closed, so
  // the done gate has the evidence it wants.
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, acceptance_mode, labels, meta_json, created_at, updated_at, status_changed_at)
     VALUES ('agent-card', 'P-0001', 'p', 'Agent card', 'in_review', 1, 'agent', '["ui"]', '{"target":"x"}', ?, ?, ?)`,
  ).run(TS, TS, TS);
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_of_id, review_round, review_required, acceptance_mode, created_at, updated_at, status_changed_at)
     VALUES ('review-card', 'P-0002', 'p', 'Review', 'done', 'agent-card', 1, 0, 'off', ?, ?, ?)`,
  ).run(TS, TS, TS);
  // An `off` card: no review, and no evidence owed (empty baseline).
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, acceptance_mode, created_at, updated_at, status_changed_at)
     VALUES ('off-card', 'P-0003', 'p', 'Off card', 'in_progress', 0, 'off', ?, ?, ?)`,
  ).run(TS, TS, TS);
  // An `agent` card still waiting on its review — the done gate's red case.
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, acceptance_mode, created_at, updated_at, status_changed_at)
     VALUES ('gate-card', 'P-0004', 'p', 'Gate card', 'in_review', 1, 'agent', ?, ?, ?)`,
  ).run(TS, TS, TS);
}

/** A board at the previous build's head, with rows the migration must keep. */
async function upgradedBoard() {
  const board = await createTempBoard({ migrate: false });
  applyMigrations(board.db, { dir: through0039() });
  seed(board.db);
  const up = applyMigrations(board.db);
  return { board, up };
}

describe("storage/migrations — 0040 retires the review compatibility layer", () => {
  it("drops both legacy columns and keeps every row's decisions", async () => {
    const { board, up } = await upgradedBoard();
    try {
      assert.deepEqual(up.applied.map((m) => m.version), ["0040"]);
      assert.equal(columnsOf(board.db, "tasks").includes("review_required"), false);
      assert.equal(columnsOf(board.db, "projects").includes("review_policy"), false);

      const project = board.db.prepare("SELECT acceptance, meta_json FROM projects WHERE id = 'p'").get();
      assert.equal(project.acceptance, "agent");
      assert.equal(project.meta_json, '{"k":"v"}');

      const agent = board.db.prepare("SELECT * FROM tasks WHERE id = 'agent-card'").get();
      assert.equal(agent.acceptance_mode, "agent");
      assert.equal(agent.status, "in_review");
      assert.equal(agent.labels, '["ui"]');
      assert.equal(agent.meta_json, '{"target":"x"}');

      const review = board.db.prepare("SELECT * FROM tasks WHERE id = 'review-card'").get();
      assert.equal(review.review_of_id, "agent-card");
      assert.equal(review.review_round, 1);
      assert.equal(review.acceptance_mode, "off");
      assert.equal(board.db.prepare("SELECT acceptance_mode FROM tasks WHERE id = 'off-card'").get().acceptance_mode, "off");
    } finally {
      board.close();
    }
  });

  it("makes the retired spellings unwritable, and the surviving one writable", async () => {
    const { board } = await upgradedBoard();
    try {
      raises(
        () => board.db.prepare("UPDATE tasks SET review_required = 1 WHERE id = 'off-card'").run(),
        "no such column: review_required",
      );
      raises(
        () => board.db.prepare("UPDATE projects SET review_policy = 'off' WHERE id = 'p'").run(),
        "no such column: review_policy",
      );
      raises(
        () =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, review_required, created_at, updated_at, status_changed_at)
               VALUES ('x', 'P-0005', 'p', 'x', 'todo', 1, ?, ?, ?)`,
            )
            .run(TS, TS, TS),
        // An INSERT has no column name to look up: SQLite says "table tasks
        // has no column named review_required" instead.
        "review_required",
      );

      assert.doesNotThrow(() =>
        board.db.prepare("UPDATE tasks SET acceptance_mode = 'human' WHERE id = 'off-card'").run(),
      );
      assert.doesNotThrow(() =>
        board.db
          .prepare(
            `INSERT INTO tasks(id, identifier, project_id, title, status, acceptance_mode, created_at, updated_at, status_changed_at)
             VALUES ('new', 'P-0006', 'p', 'new', 'todo', 'agent', ?, ?, ?)`,
          )
          .run(TS, TS, TS),
      );
    } finally {
      board.close();
    }
  });

  it("keeps a review card off — the one trigger that replaced the mirror pair", async () => {
    const { board } = await upgradedBoard();
    try {
      raises(
        () => board.db.prepare("UPDATE tasks SET acceptance_mode = 'agent' WHERE id = 'review-card'").run(),
        "REVIEW_CARD_MARKER_INVALID",
      );
      raises(
        () =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, review_of_id, review_round, acceptance_mode, created_at, updated_at, status_changed_at)
               VALUES ('bad-review', 'P-0007', 'p', 'bad', 'todo', 'agent-card', 1, 'human', ?, ?, ?)`,
            )
            .run(TS, TS, TS),
        "REVIEW_CARD_MARKER_INVALID",
      );
      // An ordinary card may carry every card value.
      for (const mode of ["off", "agent", "human"]) {
        assert.doesNotThrow(() =>
          board.db.prepare("UPDATE tasks SET acceptance_mode = ? WHERE id = 'off-card'").run(mode),
        );
      }
    } finally {
      board.close();
    }
  });

  it("still enforces the agent done gate, and still bumps the revision cursors", async () => {
    const { board } = await upgradedBoard();
    try {
      raises(
        () => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'gate-card'").run(),
        "REVIEW_REQUIRED",
      );
      // A human card has no DB gate (the authority rule is the service layer's).
      board.db.prepare("UPDATE tasks SET acceptance_mode = 'human' WHERE id = 'gate-card'").run();
      assert.doesNotThrow(() =>
        board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'gate-card'").run(),
      );

      let before = revision(board.db);
      board.db.prepare("UPDATE tasks SET acceptance_mode = 'agent' WHERE id = 'off-card'").run();
      assert.equal(revision(board.db), before + 1, "the card cursor names acceptance_mode");

      before = revision(board.db);
      board.db.prepare("UPDATE projects SET acceptance = 'human' WHERE id = 'p'").run();
      assert.equal(revision(board.db), before + 1, "the project cursor names acceptance");
    } finally {
      board.close();
    }
  });

  it("upgrades to exactly the schema a fresh board builds", async () => {
    const { board } = await upgradedBoard();
    const fresh = await createTempBoard();
    try {
      const shape = (db) =>
        db
          .prepare(
            `SELECT type, name, sql FROM sqlite_master
              WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
              ORDER BY type, name`,
          )
          .all()
          .map((row) => ({ ...row }));
      assert.deepEqual(shape(board.db), shape(fresh.db));

      // No surviving object may still name a retired column. `instr` is exact:
      // `LIKE '%review_required%'` would also match the REVIEW_REQUIRED error.
      const offenders = board.db
        .prepare(
          `SELECT type, name FROM sqlite_master
            WHERE instr(COALESCE(sql, ''), 'review_required') > 0
               OR instr(COALESCE(sql, ''), 'review_policy') > 0
            ORDER BY type, name`,
        )
        .all()
        .map((row) => `${row.type}:${row.name}`);
      assert.deepEqual(offenders, []);

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      board.close();
      fresh.close();
    }
  });

  it("is a no-op on a board that already ran it", async () => {
    const { board } = await upgradedBoard();
    try {
      assert.deepEqual(applyMigrations(board.db).applied, []);
    } finally {
      board.close();
    }
  });
});
