/**
 * The line 0020 draws: **attribution** is a reference to `actors(id)`, the
 * **log and telemetry** columns are deliberately left free strings.
 *
 * Five columns name a person. `0019` gave `tasks.assignee_id` / `tasks.reporter_id`
 * a foreign key; `0020` gives the other three (`tasks.claimed_by`,
 * `comments.author_id`, `task_reports.author_id`) one. Two more name an actor and
 * **must not** get one, because each would couple a mutable dictionary to a record
 * that has to outlive it:
 *
 *   * `task_activities.actor_id` — an append-only audit log. A hard foreign key
 *     would make archiving a person block the deletion of their history, and the
 *     log must outlive the entities it names. Its companion `actor_kind` has no
 *     CHECK either, for the same reason.
 *   * `agent_sessions.owner` — runtime telemetry, and half of the natural key
 *     `UNIQUE(task_id, seg, owner)`. It records what the session called itself,
 *     not a curated identity.
 *
 * The **reserved names** `taskd` and `md-import` are the synthetic actor ids the
 * board writes for its own housekeeping (`SYSTEM_ACTOR`, the md importer). They
 * are names in the *log* namespace, not people: a board whose only occurrences of
 * them are in those two columns must produce no matching `actors` row, so a
 * roster never shows a "person" called `taskd`.
 *
 * This is the `tasks.blocked_reason` precedent — a deliberate exclusion, pinned
 * from both sides (the schema, and the migration text that could have changed it)
 * rather than left to a comment.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { defaultMigrationsDir } from "../../src/core/storage/migrations-runner.mjs";
import { BOARD_ACTOR } from "../../src/core/commands/index.mjs";
import { TS, cleanupTempDirs, createTempBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** Every `table.column -> parent` foreign key the schema declares. */
function foreignKeys(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .flatMap((table) =>
      db
        .prepare("SELECT \"table\" AS parent, \"from\" AS col FROM pragma_foreign_key_list(?)")
        .all(table)
        .map((fk) => ({ child: `${table}.${fk.col}`, parent: fk.parent })),
    );
}

describe("contract/attribution-boundary — what 0020 does and does not reference", () => {
  it("gives the five attribution columns a reference to `actors`", async () => {
    const board = await createTempBoard();
    try {
      const fks = foreignKeys(board.db);
      const has = (child) => fks.some((fk) => fk.child === child && fk.parent === "actors");
      for (const column of [
        "tasks.assignee_id",
        "tasks.reporter_id",
        "tasks.claimed_by",
        "comments.author_id",
        "task_reports.author_id",
      ]) {
        assert.ok(has(column), `${column} must reference actors(id)`);
      }
    } finally {
      board.close();
    }
  });

  it("leaves the audit log and the session telemetry as free strings", async () => {
    const board = await createTempBoard();
    try {
      const fks = foreignKeys(board.db);
      const has = (child) => fks.some((fk) => fk.child === child);
      assert.equal(has("task_activities.actor_id"), false, "the append-only audit log must not gain a FK");
      assert.equal(has("agent_sessions.owner"), false, "session telemetry must not gain a FK");

      // The columns are still there and still accept a synthetic, non-actor value
      // — that is the whole point of leaving them open.
      board.db
        .prepare(
          "INSERT INTO task_activities(task_id, actor_kind, actor_id, event, changes_json, created_at) VALUES (NULL, 'system', 'taskd', 'anomaly', '{}', ?)",
        )
        .run(TS);
      assert.equal(
        board.db.prepare("SELECT actor_id FROM task_activities WHERE event = 'anomaly'").get().actor_id,
        "taskd",
      );
    } finally {
      board.close();
    }
  });

  it("creates no actor row for the reserved names when they live only in the log", async () => {
    const board = await createTempBoard();
    try {
      // The realistic shape: the board's own housekeeping writes `taskd` to the
      // audit log, and the importer writes `md-import` there too. Nothing writes
      // either into an attribution column.
      board.db
        .prepare(
          "INSERT INTO task_activities(task_id, actor_kind, actor_id, event, changes_json, created_at) VALUES (NULL, 'system', 'taskd', 'anomaly', '{}', ?)",
        )
        .run(TS);
      board.db
        .prepare(
          "INSERT INTO task_activities(task_id, actor_kind, actor_id, event, changes_json, created_at) VALUES (NULL, 'system', 'md-import', 'progress', '{}', ?)",
        )
        .run(TS);
      board.db
        .prepare(
          "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES ('p1','P1',2,'[]','{}',?,?)",
        )
        .run(TS, TS);
      board.db
        .prepare(
          "INSERT INTO tasks(id, identifier, project_id, title, status, created_at, updated_at, status_changed_at) VALUES ('t1','P1-0001','p1','T','todo',?,?,?)",
        )
        .run(TS, TS, TS);
      board.db
        .prepare(
          "INSERT INTO agent_sessions(id, task_id, seg, owner, backend, session_id, status, ts) VALUES ('s1', 't1', 'seg1', 'md-import', 'claude', 'sid', 'running', ?)",
        )
        .run(TS);

      const reserved = board.db
        .prepare("SELECT normalized_name FROM actors WHERE normalized_name IN ('taskd','md-import')")
        .all();
      assert.deepEqual(reserved, [], "a log-only synthetic id must not become a roster entry");

      // And the names really are the ones the code writes.
      assert.equal(BOARD_ACTOR.id, "taskd");
      assert.equal(BOARD_ACTOR.kind, "taskd");
    } finally {
      board.close();
    }
  });

  it("names both reserved ids and both exclusions in the migration that draws the line", () => {
    const sql = readFileSync(join(defaultMigrationsDir(), "0020_attribution_fk.sql"), "utf8");
    // The reserved names are documented where the boundary is drawn…
    assert.match(sql, /taskd/, "0020 names `taskd` as a reserved actor id");
    assert.match(sql, /md-import/, "0020 names `md-import` as a reserved actor id");
    // …and the two log/telemetry columns are named as the deliberate exclusions.
    assert.match(sql, /task_activities\.actor_id/, "0020 names the audit log as deliberately free");
    assert.match(sql, /agent_sessions\.owner/, "0020 names the session owner as deliberately free");
    // The back-fill reads only the three attribution columns: it must not touch
    // either excluded one, or the reserved names would leak into `actors`.
    assert.equal(/FROM\s+task_activities/i.test(sql), false, "the back-fill never reads the audit log");
    assert.equal(/FROM\s+agent_sessions/i.test(sql), false, "the back-fill never reads the sessions table");
  });
});
