/**
 * 0018 — an actor's `kind` stops being a closed vocabulary, across an existing board.
 *
 * The migration removes an enumeration from **two** columns and moves nothing else,
 * so "nothing else moved" is the property under test — the same standard
 * `test/core/storage/migrations-0013.test.mjs` and `-0015.test.mjs` hold their
 * migrations to, applied to a rebuild that *subtracts* a constraint rather than
 * widening one:
 *
 *   * a value the old `CHECK` refused (`claude`) is now storable on both tables, and
 *     every value it accepted (`agent`, `human`, `system`) still is — the rows the
 *     previous build wrote survive verbatim;
 *   * `NOT NULL` is **kept**: only the enumeration goes. A `NULL` kind is still
 *     refused, on both tables;
 *   * every row and every column survives, on both tables;
 *   * the index set and the **text** of every trigger come back unchanged — the
 *     comparison is on full SQL, not on names, because a trigger recreated with a
 *     mistyped condition would otherwise pass. The two guards that had to be parked
 *     (`tr_latest_report_belongs`, `tr_deliver_gate`, both on `tasks`, both naming
 *     `task_reports`) are the ones this assertion exists for;
 *   * no scratch table survives, foreign key enforcement is back on, and
 *     `PRAGMA integrity_check` / `foreign_key_check` are clean.
 *
 * The last test here is not about the migration at all: it closes the parity gap the
 * migration opens. `SQL_ENUM_SETS` no longer declares these two columns, and the
 * SQL-parity reader can only see that the CHECKs are gone, not that their absence
 * was intended.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SQL_ENUM_SETS } from "../../../src/core/domain/enums.mjs";
import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  insertComment,
  insertProject,
  insertReport,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0018 — a board as the previous build left it. */
function before0018() {
  const dir = makeTempDir("meerkat-taskpanel-pre0018-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0018")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;

const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

/**
 * The **named** indexes on one table, each with the shape that makes it itself —
 * name, columns, uniqueness, partiality. `comments` carries two; `task_reports`
 * carries none of its own (its `UNIQUE (task_id, round)` is an implicit index, which
 * the `sqlite_autoindex` filter drops, exactly as the 0015 suite does for `tasks`).
 */
const indexShapesOf = (db, table) =>
  db
    .prepare(`SELECT name, "unique" AS uniq, partial AS part FROM pragma_index_list(?)`)
    .all(table)
    .filter((row) => !row.name.startsWith("sqlite_autoindex"))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((row) => ({
      name: row.name,
      unique: Number(row.uniq),
      partial: Number(row.part),
      columns: db.prepare("SELECT name FROM pragma_index_info(?)").all(row.name).map((c) => c.name),
    }));

/** Every trigger's text, whitespace-normalised (whitespace is not meaning). */
const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").replace(/CREATE TRIGGER IF NOT EXISTS /i, "CREATE TRIGGER ").trim()]),
  );

/** Build the "previous build" board with rows the migration must not lose. */
function seedLegacyBoard(db) {
  insertProject(db, { id: "legacy", name: "Legacy project", next_task_number: 3 });
  insertTask(db, { id: "task-1", identifier: "LEGACY-0001", project_id: "legacy", status: "todo" });
  // A second card that carries no report: the delivery gate has to be asserted on a
  // task the seed did *not* already satisfy, or the assertion would pass for the
  // wrong reason.
  insertTask(db, { id: "task-2", identifier: "LEGACY-0002", project_id: "legacy", status: "todo" });
  insertComment(db, { id: "c-1", task_id: "task-1", kind: "note", author_kind: "human", author_id: "terry" });
  insertComment(db, { id: "c-2", task_id: "task-1", kind: "discuss", author_kind: "system", author_id: "taskd" });
  insertReport(db, { task_id: "task-1", round: 1, author_kind: "agent", author_id: "linus" });
}

describe("storage/migrations — 0018 opens the actor-kind columns (comments, task_reports)", () => {
  it("carries an existing board across the rebuild, dropping the enumeration", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0018() });
      assert.equal(old.applied.at(-1).version, "0017");

      // Precondition: the previous build really did enumerate both columns.
      assert.match(tableSql(board.db, "comments"), /author_kind\s+TEXT NOT NULL CHECK \(author_kind IN \('agent','human','system'\)\)/);
      assert.match(tableSql(board.db, "task_reports"), /author_kind\s+TEXT NOT NULL CHECK \(author_kind IN \('agent','human','system'\)\)/);
      const indexesBefore = { comments: indexShapesOf(board.db, "comments"), task_reports: indexShapesOf(board.db, "task_reports") };
      seedLegacyBoard(board.db);

      const up = applyMigrations(board.db);
      // 0018 is the last file in the set today; when a later migration lands this
      // list grows by one, as the 0013/0015 suites' equivalents did.
      assert.deepEqual(up.applied.map((m) => m.version), ["0018", "0019", "0020", "0021", "0022", "0023"]);
      assert.deepEqual(up.skipped.slice(-2), ["0016", "0017"]);

      // 1 — the enumeration is gone from both tables, and nothing replaced it.
      const commentsSql = tableSql(board.db, "comments");
      const reportsSql = tableSql(board.db, "task_reports");
      assert.equal(/author_kind IN/.test(commentsSql), false, "comments.author_kind must carry no enumeration");
      assert.equal(/author_kind IN/.test(reportsSql), false, "task_reports.author_kind must carry no enumeration");
      assert.match(commentsSql, /author_kind\s+TEXT NOT NULL/, "only the CHECK goes — NOT NULL is not the enumeration");
      assert.match(reportsSql, /author_kind\s+TEXT NOT NULL/, "only the CHECK goes — NOT NULL is not the enumeration");

      // 2 — the rows the previous build wrote are still there. `author_kind` is
      // untouched; `author_id` is a reference to `actors` since 0020, so it reads
      // back through the actor row as the same name the row carried.
      assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM comments").get().n, 2);
      // `node:sqlite` hands back null-prototype rows, which `deepStrictEqual` treats as
      // a different type from an object literal — so the projection is explicit here.
      assert.deepEqual(
        board.db
          .prepare(
            "SELECT c.id, c.author_kind, a.display_name AS name FROM comments c JOIN actors a ON a.id = c.author_id ORDER BY c.id",
          )
          .all()
          .map((r) => ({ id: r.id, author_kind: r.author_kind, name: r.name })),
        [
          { id: "c-1", author_kind: "human", name: "terry" },
          { id: "c-2", author_kind: "system", name: "taskd" },
        ],
      );
      assert.equal(board.db.prepare("SELECT author_kind FROM task_reports WHERE round = 1").get().author_kind, "agent");

      // 3 — the new value is storable. Both tables are append-only, so the leg has to
      // be an INSERT rather than an UPDATE.
      assert.equal(
        reasonCode(() =>
          insertComment(board.db, { id: "c-3", task_id: "task-1", kind: "note", author_kind: "claude", author_id: "claude-1" }),
        ),
        "NO_ERROR",
        "a platform name is now a legal author kind",
      );
      assert.equal(
        reasonCode(() =>
          insertReport(board.db, { task_id: "task-1", round: 2, author_kind: "codex", author_id: "codex-1" }),
        ),
        "NO_ERROR",
        "a platform name is now a legal report author kind",
      );
      assert.equal(board.db.prepare("SELECT author_kind FROM comments WHERE id = 'c-3'").get().author_kind, "claude");
      assert.equal(board.db.prepare("SELECT author_kind FROM task_reports WHERE round = 2").get().author_kind, "codex");

      // 4 — and `NULL` is still refused. The migration removes the enumeration, not
      // the requirement: a comment from nobody is the state this column's NOT NULL
      // exists to make unrepresentable.
      assert.equal(
        reasonCode(() => insertComment(board.db, { id: "c-null", task_id: "task-1", author_kind: null })),
        "VALIDATION_FAILED",
        "NOT NULL survived the rebuild",
      );
      assert.equal(
        reasonCode(() => insertReport(board.db, { task_id: "task-1", round: 3, author_kind: null })),
        "VALIDATION_FAILED",
        "NOT NULL survived the rebuild",
      );

      // 5 — the foreign keys still have teeth (comments → tasks, and attachments →
      // comments is the inbound one the rebuild had to survive).
      assert.equal(
        reasonCode(() =>
          insertComment(board.db, { id: "c-orphan", task_id: "no-such-task", kind: "note", author_kind: "agent", author_id: "a" }),
        ),
        "NOT_FOUND",
        "the foreign key still has teeth after the rebuild",
      );

      // 6 — the two parked guards are armed again. `task-2` carries no report, so the
      // delivery gate must refuse it; `task-1` does carry one, which is why the gate
      // is asserted here on `task-2` rather than on the card the seed satisfied.
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-2'").run()),
        "NO_ERROR",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'task-2'").run()),
        "REPORT_REQUIRED",
        "tr_deliver_gate came back",
      );
      // …and `tr_latest_report_belongs`: a card may not adopt another card's report.
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET report_latest_id = 9999 WHERE id = 'task-2'").run()),
        "REPORT_TASK_MISMATCH",
        "tr_latest_report_belongs came back",
      );

      // 7 — no scratch table survives, and the connection is not left relaxed.
      assert.deepEqual(
        tableNames(board.db).filter((name) => name.includes("_v2")),
        [],
        "the rebuild must not leave its scratch table behind",
      );
      assert.equal(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "enforcement is restored");

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);

      // 8 — the index sets are what they were.
      assert.deepEqual(indexShapesOf(board.db, "comments"), indexesBefore.comments);
      assert.deepEqual(indexShapesOf(board.db, "task_reports"), indexesBefore.task_reports);
    } finally {
      board.close();
    }
  });

  it("moves no trigger at all — a rebuild is not a rewrite", async () => {
    // The migration drops both tables (taking their triggers) and re-creates them
    // from 0001/0002/0003's text, plus parks and un-parks two guards on `tasks`.
    // It moves **none** of them, so the expected set of changed triggers is empty.
    // A guard quietly rewritten during a rebuild is exactly the loss this makes
    // impossible, and the comparison is on full SQL rather than on names.
    const before = await createTempBoard({ migrate: false });
    const after = await createTempBoard();
    try {
      applyMigrations(before.db, { dir: before0018() });
      const oldTriggers = triggersOf(before.db);
      const newTriggers = triggersOf(after.db);

      // As in the 0013/0015 suites: `after` runs the whole shipped set, so a *later*
      // migration's own trigger is an allowed addition. 0019 — which merged the two
      // dictionary tables into `actors` — removes the four triggers that lived on
      // each old table and adds one delete guard + three revision triggers on
      // `actors`, and re-declares `tr_rev_tasks_upd` during its `tasks` rebuild.
      const DICTIONARY_TRIGGERS_REMOVED = [
        "tr_dict_assignees_delete",
        "tr_dict_reporters_delete",
        "tr_rev_assignees_del",
        "tr_rev_assignees_ins",
        "tr_rev_assignees_upd",
        "tr_rev_reporters_del",
        "tr_rev_reporters_ins",
        "tr_rev_reporters_upd",
      ];
      assert.deepEqual(
        Object.keys(newTriggers)
          .filter((name) => !(name in oldTriggers))
          .sort(),
        ["tr_dict_actors_delete", "tr_rel_block_chain", "tr_rel_parent_block_pair", "tr_rev_actors_del", "tr_rev_actors_ins", "tr_rev_actors_upd"],
        "0018 invents no trigger; 0019's actor triggers and 0021/0022's relation guards are the later additions",
      );
      assert.deepEqual(
        Object.keys(oldTriggers).filter((name) => !(name in newTriggers)).sort(),
        DICTIONARY_TRIGGERS_REMOVED,
        "the rebuild must not lose a trigger (0019 removes the two old tables' triggers)",
      );

      const changed = Object.keys(oldTriggers).filter((name) => oldTriggers[name] !== newTriggers[name]).sort();
      assert.deepEqual(
        changed,
        [...DICTIONARY_TRIGGERS_REMOVED, "tr_rev_tasks_upd"].sort(),
        "0018 must change no trigger — only 0019's own `tasks` rebuild moves `tr_rev_tasks_upd`; 0020 re-declares every trigger it parks verbatim",
      );

      // The four that a careless rebuild would be most likely to mangle, named so a
      // failure says which one rather than only that the set differs.
      for (const name of [
        "tr_comments_no_update",
        "tr_comments_no_delete",
        "tr_reports_no_update",
        "tr_reports_no_delete",
        "tr_latest_report_belongs",
        "tr_deliver_gate",
      ]) {
        assert.equal(newTriggers[name], oldTriggers[name], `${name} must survive the rebuild verbatim`);
      }
    } finally {
      before.close();
      after.close();
    }
  });

  it("lands the upgrade on the index set a fresh board has — no index added, none lost", async () => {
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0018() });
      const before = { comments: indexShapesOf(upgrade.db, "comments"), task_reports: indexShapesOf(upgrade.db, "task_reports") };

      applyMigrations(upgrade.db);

      for (const table of ["comments", "task_reports"]) {
        assert.deepEqual(indexShapesOf(upgrade.db, table), before[table], `an upgrade must not move ${table}'s indexes`);
        assert.deepEqual(
          indexShapesOf(fresh.db, table),
          indexShapesOf(upgrade.db, table),
          `an upgraded board and a fresh board must carry the same ${table} indexes`,
        );
      }
    } finally {
      upgrade.close();
      fresh.close();
    }
  });

  it("is a no-op on a board that is already at 0018", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0018"), true);
    } finally {
      board.close();
    }
  });

  it("leaves neither column declared in SQL_ENUM_SETS — and the absence is deliberate", () => {
    // The parity test above is two-directional: a column declared in JS with no CHECK
    // in SQL reads as drift. `0018` removes both CHECKs, so both columns must leave
    // the registry — otherwise the pairing breaks from the other side. Pinning it here
    // separates "deliberately absent" from "someone deleted a line".
    for (const key of ["comments.author_kind", "task_reports.author_kind"]) {
      assert.equal(Object.hasOwn(SQL_ENUM_SETS, key), false, `${key} must not be declared`);
    }
    // Non-vacuity: other enumerated columns are still declared, so "absent" here
    // means these two specifically, not an empty registry. (The four actor-kind
    // columns `0018` left open — `tasks.assignee_kind`, `tasks.creator_kind`,
    // `assignees.kind`, `reporters.kind` — are gone entirely under `0019`, which
    // drops the columns and merges the two tables, so they are no longer usable as
    // "still declared" witnesses.)
    for (const key of ["tasks.status", "comments.kind", "task_reports.origin"]) {
      assert.equal(Object.hasOwn(SQL_ENUM_SETS, key), true, `${key} must still be declared`);
    }
  });
});
