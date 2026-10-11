/**
 * 0013 — `awaiting` becomes a first-class status, across an existing board.
 *
 * The card asks for the *upgrade* to be proven, not just the fresh schema: a
 * board the previous build left behind (rows already in `in_progress`,
 * `in_review` and `blocked`, comments pointing at them) must come out the other
 * side with
 *
 *   * the widened status enum (and only that — an unknown word is still
 *     refused, and so is a reason code outside `E1..E5`);
 *   * the re-encoded transition whitelist, with `awaiting` reachable from
 *     `in_progress` and `in_review`/`done` still out of its reach;
 *   * the delivery gate, the terminal guard, the round bump and the revision
 *     cursor intact — a rebuild that silently dropped a trigger would be a
 *     missing invariant, which is exactly what this file exists to catch;
 *   * every row, every other column, and every foreign key still pointing at
 *     `tasks`.
 *
 * The rebuild is the only supported way to widen a SQLite `CHECK` (there is no
 * `ALTER TABLE … MODIFY`), so "nothing else moved" is the property under test —
 * see the migration's own header for why it is a rebuild and not an edit.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  createTempBoard,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set without 0013 — a board as the previous build left it. */
function before0013() {
  const dir = makeTempDir("meerkat-taskpanel-pre0013-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && !n.startsWith("0013"))) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const columnsOf = (db) => db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
const indexNames = (db) => db.prepare("SELECT name FROM pragma_index_list('tasks')").all().map((r) => r.name);
const triggerNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'").all().map((r) => r.name);
const tasksSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;

/** Every index and trigger `tasks` must still have after the rebuild. */
const EXPECTED_INDEXES = [
  "ux_tasks_identifier",
  "ux_tasks_source",
  "ix_tasks_board",
  "ix_tasks_assignee",
  "ix_tasks_heartbeat",
  "ux_tasks_idem_active",
];
const EXPECTED_TRIGGERS = [
  "tr_tasks_terminal",
  "tr_tasks_transition",
  "tr_tasks_archive_terminal",
  "tr_tasks_kind_downgrade",
  "tr_latest_report_belongs",
  "tr_deliver_gate",
  "tr_tasks_round_bump",
  "tr_rev_tasks_ins",
  "tr_rev_tasks_upd",
  "tr_rev_tasks_del",
];

/** Build the "previous build" board with rows the migration must not lose. */
function seedLegacyBoard(db) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, readme, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy", "Legacy project", 7, '["m1"]', '{"k":"v"}', "# notes", TS, TS);
  insertTask(db, { id: "running", identifier: "LEGACY-0001", project_id: "legacy", status: "in_progress" });
  insertTask(db, { id: "reviewed", identifier: "LEGACY-0002", project_id: "legacy", status: "in_review" });
  insertTask(db, { id: "paused", identifier: "LEGACY-0003", project_id: "legacy", status: "blocked", blocked_at: TS });
  db.prepare(
    "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("c1", "running", "hello", "note", "human", "terry", "[]", 1, TS);
}

describe("storage/migrations — 0013 makes `awaiting` a first-class status (M1)", () => {
  it("carries an existing board across the rebuild, widening the status enum", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0013() });
      assert.equal(old.applied.at(-1).version, "0012");
      assert.equal(/awaiting/.test(tasksSql(board.db)), false, "precondition: the old CHECK has no `awaiting`");
      seedLegacyBoard(board.db);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0013"]);
      assert.deepEqual(up.skipped.slice(-2), ["0011", "0012"]);

      // 1 — the enum: the new word is storable, the old ones still are, and an
      // unknown word / a bad reason code are still refused.
      assert.match(tasksSql(board.db), /awaiting/, "the rebuilt CHECK must name `awaiting`");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting', awaiting_reason = 'E3', status_changed_at = ? WHERE id = 'running'").run(TS2)),
        "NO_ERROR",
      );
      assert.equal(board.db.prepare("SELECT awaiting_reason FROM tasks WHERE id='running'").get().awaiting_reason, "E3");
      // A word the whitelist does not know is refused by the *trigger*, which is
      // what 0002 documents: BEFORE triggers run first, so their reason code wins
      // over the table's CHECK. The CHECK is the backstop for the INSERT path,
      // asserted directly below.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'nonsense' WHERE id = 'running'").run()), "INVALID_TRANSITION");
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, created_at, updated_at)
               VALUES ('t-check','CHECK-1','legacy','x','nonsense', ?, ?)`,
            )
            .run(TS, TS),
        ),
        "VALIDATION_FAILED",
        "the widened CHECK still refuses a word the vocabulary does not have",
      );
      // ...and the reason code's own vocabulary, which no trigger shadows.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET awaiting_reason = 'E9' WHERE id = 'running'").run()), "VALIDATION_FAILED");
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET awaiting_reason = 'free text' WHERE id = 'running'").run()), "VALIDATION_FAILED");

      // 2 — the whitelist speaks `awaiting`; the gate and the terminal guard bite.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_progress', status_changed_at = ? WHERE id = 'running'").run(TS2)), "NO_ERROR");
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting' WHERE id = 'running'").run()), "NO_ERROR");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'running'").run()),
        "INVALID_TRANSITION",
        "an awaiting card may not reach review",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'reviewed'").run()),
        "REPORT_REQUIRED",
        "the delivery gate survived the rebuild",
      );
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = 'paused'").run()), "NO_ERROR");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting' WHERE id = 'reviewed'").run()),
        "INVALID_TRANSITION",
        "awaiting is entered from in_progress only",
      );

      // 3 — nothing was rebuilt away.
      assert.deepEqual(indexNames(board.db).sort(), EXPECTED_INDEXES.slice().sort());
      assert.deepEqual(triggerNames(board.db).sort(), EXPECTED_TRIGGERS.slice().sort());
      for (const name of EXPECTED_TRIGGERS) {
        const row = board.db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name = ?").get(name);
        assert.equal(row.tbl_name, "tasks", `${name} must still be attached to tasks`);
      }

      // 4 — every row, every other column, and every foreign key survived.
      for (const column of ["id", "identifier", "title", "delivery_round", "idem", "meta_json", "report_waiver_reason", "awaiting_reason"]) {
        assert.ok(columnsOf(board.db).includes(column), `tasks.${column} must survive the rebuild`);
      }
      const legacy = board.db.prepare("SELECT * FROM projects WHERE id = 'legacy'").get();
      assert.equal(legacy.name, "Legacy project");
      assert.equal(Number(legacy.next_task_number), 7);
      assert.equal(legacy.meta_json, '{"k":"v"}');
      assert.equal(board.db.prepare("SELECT blocked_at FROM tasks WHERE id = 'paused'").get().blocked_at, TS);
      assert.equal(board.db.prepare("SELECT body FROM comments WHERE id = 'c1'").get().body, "hello");
      assert.equal(
        board.db.prepare("SELECT COUNT(*) n FROM pragma_foreign_key_list('comments') WHERE \"table\" = 'tasks'").get().n,
        1,
        "comments must still reference the rebuilt tasks table, not the old one",
      );
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at) VALUES ('orphan','no-such-task','x','note','agent','a','[]',1,?)",
            )
            .run(TS),
        ),
        "NOT_FOUND",
        "the foreign key still has teeth after the rebuild",
      );

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("moves exactly one trigger and nothing else — a rebuild is not a rewrite", async () => {
    // The rebuild drops and re-creates 15 triggers because dropping `tasks`
    // takes its own with it and parks the five that merely *name* `tasks` from
    // other tables. Every one of them must come back byte-identical to the
    // definition the history shipped, except the one this migration exists to
    // change. A guard quietly rewritten during a rebuild is exactly the kind of
    // loss this card is supposed to make impossible, so it is asserted by text.
    // Whitespace and `IF NOT EXISTS` are not part of a guard's meaning, so they
    // are normalised away rather than compared.
    const squeeze = (s) =>
      String(s)
        .replace(/\s+/g, " ")
        .replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+/i, "CREATE TRIGGER ")
        .trim();
    const triggersOf = (db) =>
      Object.fromEntries(
        db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all().map((r) => [r.name, squeeze(r.sql)]),
      );

    const before = await createTempBoard({ migrate: false });
    const after = await createTempBoard();
    try {
      applyMigrations(before.db, { dir: before0013() });
      const oldTriggers = triggersOf(before.db);
      const newTriggers = triggersOf(after.db);

      assert.deepEqual(
        Object.keys(newTriggers).sort(),
        Object.keys(oldTriggers).sort(),
        "the rebuild must not add or lose a trigger",
      );
      // Two triggers may change, and both are intentional: the transition
      // whitelist gains its `awaiting` clause, and the revision cursor's column
      // domain gains `awaiting_reason` (a real content change a watching client
      // has to see). Everything else must be identical.
      const changed = Object.keys(oldTriggers).filter((name) => oldTriggers[name] !== newTriggers[name]).sort();
      assert.deepEqual(changed, ["tr_rev_tasks_upd", "tr_tasks_transition"], "only these two may change");

      // ...and the parked five really are the shipped guards, not lookalikes.
      for (const name of ["tr_dict_assignees_delete", "tr_dict_reporters_delete", "tr_rel_cross_project", "tr_rel_parent_guard", "tr_rel_parent_epic"]) {
        assert.equal(newTriggers[name], oldTriggers[name], `${name} must survive the rebuild verbatim`);
      }
    } finally {
      before.close();
      after.close();
    }
  });

  it("is a no-op on a board that is already at 0013", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0013"), true);
      assert.match(tasksSql(board.db), /awaiting/);
      assert.equal(columnsOf(board.db).includes("awaiting_reason"), true);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("leaves no scratch table behind, and no deferred foreign keys", async () => {
    const board = await createTempBoard();
    try {
      const leftovers = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tasks_%'")
        .all()
        .map((r) => r.name);
      assert.deepEqual(leftovers, [], "the scratch table must be renamed away, not orphaned");
      // The rebuild asks the runner for foreign keys off (see the marker in the
      // file); the runner has to put the pinned pragma back, or every later write
      // in this connection would run unchecked.
      assert.equal(
        Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
        1,
        "foreign key enforcement must be back on after the rebuild",
      );
      // The rename must not have rewritten the children's REFERENCES clauses:
      // they have to name `tasks`, which is the table that exists.
      for (const child of ["task_relations", "comments", "attachments", "agent_sessions", "task_reports"]) {
        const parents = board.db
          .prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list('${child}')`)
          .all()
          .map((r) => r.parent);
        assert.equal(parents.includes("tasks"), true, `${child} must still reference tasks`);
        assert.equal(parents.some((name) => name.startsWith("tasks_") && name !== "tasks"), false, `${child} references a scratch name`);
      }
    } finally {
      board.close();
    }
  });
});
