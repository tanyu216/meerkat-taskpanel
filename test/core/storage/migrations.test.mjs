/**
 * Step 5: the migration runner's contract (card A3, V2, V3).
 *
 * Apply once, apply again (no-op), refuse a tampered file, refuse to serve a
 * database that is behind, roll back a failing file completely, and refuse
 * mis-named files. The "table list" half of V3 is asserted here via
 * `PRAGMA table_info`; the SQL↔JS half lives in `contract/sql-parity`.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { TABLES } from "../../../src/core/storage/schema.mjs";
import {
  appliedMigrations,
  applyMigrations,
  assertSchemaCurrent,
  checksumFor,
  defaultMigrationsDir,
  ensureMigrationsTable,
  listMigrations,
  normalizeSql,
  wantsForeignKeysOff,
} from "../../../src/core/storage/migrations-runner.mjs";
import { DomainError } from "../../../src/foundation/errors.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  insertProject,
  insertTask,
  makeTempDir,
  reasonCode,
  withBoard,
} from "../../helpers/sqlite-fixture.mjs";
import { checkInSets } from "../../helpers/sql-parse.mjs";

after(cleanupTempDirs);

/** A private migration dir so a test can add/alter files without touching the real set. */
function stageMigrations(files) {
  const dir = makeTempDir("meerkat-taskpanel-migrations-");
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, "utf8");
  return dir;
}

const TINY = {
  "0001_first.sql": "CREATE TABLE IF NOT EXISTS alpha(id TEXT PRIMARY KEY) STRICT;",
  "0002_second.sql":
    "CREATE TABLE IF NOT EXISTS beta(id TEXT PRIMARY KEY) STRICT;\nINSERT INTO alpha(id) VALUES('seeded');",
};

describe("storage/migrations — the shipped set", () => {
  it("reads the shipped migrations in version order with stable checksums", () => {
    const migrations = listMigrations();
    assert.deepEqual(migrations.map((m) => m.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
    assert.deepEqual(migrations.map((m) => m.name), [
      "init",
      "card_acceptance_model",
      "drop_project_reviewer",
      "review_kind",
      "transition_edges",
      "blocked_to_backlog",
      "intake_requests",
    ]);
    for (const migration of migrations) {
      assert.match(migration.checksum, /^[0-9a-f]{64}$/);
      assert.equal(migration.checksum, checksumFor(migration.sql));
    }
    assert.equal(checksumFor("a\r\nb"), checksumFor("a\nb"), "line endings are normalised");
    assert.equal(normalizeSql("a\rb"), "a\nb");
  });

  it("applies every file once, then reports a no-op (V2)", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const first = applyMigrations(board.db);
      assert.deepEqual(first.applied.map((a) => a.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
      assert.deepEqual(first.skipped, []);
      for (const entry of first.applied) assert.equal(typeof entry.ms, "number");

      const second = applyMigrations(board.db);
      assert.deepEqual(second.applied, [], "re-apply must be a no-op");
      assert.deepEqual(second.skipped, ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);

      const rows = board.db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
      assert.equal(rows.length, listMigrations().length, "one bookkeeping row per shipped file");
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
    } finally {
      board.close();
    }
  });

  it("creates every table the schema declares, with the columns the card names (V3)", async () => {
    const board = await createTempBoard();
    try {
      const names = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      assert.deepEqual(names, [...TABLES].sort());

      const columnsOf = (table) =>
        board.db
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table)
          .map((row) => row.name);

      // Card A6: the report table's column list, literally. `is_rollup` (0033)
      // is part of the 0.1.0 baseline; `origin` (0008) was retired by 0035.
      assert.deepEqual(columnsOf("task_reports"), [
        "id",
        "task_id",
        "round",
        "seg",
        "session_id",
        "conclusion",
        "acceptance_json",
        "evidence_json",
        "leftovers",
        "author_kind",
        "author_id",
        "source_seq",
        "created_at",
        "is_rollup",
      ]);
      // Card A4: the double id + optimistic-concurrency version.
      for (const column of ["id", "identifier", "version", "report_latest_id", "delivery_round", "idem"]) {
        assert.ok(columnsOf("tasks").includes(column), `tasks.${column}`);
      }
      // The board owns no directory: `workspace_path` is absent from the baseline.
      assert.equal(columnsOf("projects").includes("workspace_path"), false, "projects.workspace_path must not exist");
      assert.ok(columnsOf("projects").includes("meta_json"));

      const strict = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get().sql;
      assert.match(strict, /STRICT/, "tables must be STRICT");

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(Number(board.db.prepare("SELECT revision FROM global_revision WHERE singleton=1").get().revision), 0);
    } finally {
      board.close();
    }
  });
});

describe("storage/migrations — 0004 review kind", () => {
  /** A dir holding the shipped files up to (and including) `version`. */
  function stageThrough(version) {
    const dir = makeTempDir("meerkat-taskpanel-review-kind-");
    for (const migration of listMigrations()) {
      if (migration.version <= version) writeFileSync(join(dir, migration.file), migration.sql, "utf8");
    }
    return dir;
  }

  function addMigration(dir, version) {
    const migration = listMigrations().find((m) => m.version === version);
    writeFileSync(join(dir, migration.file), migration.sql, "utf8");
  }

  /** Seed the pre-0004 shape: a review is kind=task + marker. */
  function seedOldBoard(db) {
    insertProject(db);
    insertTask(db, { id: "orig", identifier: "PROJ-1", status: "in_review", kind: "task", acceptance_mode: "off" });
    insertTask(db, {
      id: "rev",
      identifier: "PROJ-2",
      status: "in_review",
      kind: "task",
      acceptance_mode: "off",
      review_of_id: "orig",
      review_round: 1,
    });
    insertTask(db, { id: "plain", identifier: "PROJ-3", kind: "task" });
    insertTask(db, { id: "plainEpic", identifier: "PROJ-4", kind: "epic" });
    // A legacy mirror was never subject to the marker trigger, so it may carry
    // any acceptance mode. The copy must land it on `off` once it becomes a
    // review, or the migrated row breaks the review invariant.
    insertTask(db, {
      id: "legacy",
      identifier: "PROJ-5",
      kind: "task",
      acceptance_mode: "auto",
      meta_json: JSON.stringify({ review_of: "PROJ-1", review_round: 1 }),
    });
    insertTask(db, {
      id: "legacyStr",
      identifier: "PROJ-6",
      kind: "task",
      acceptance_mode: "human",
      meta_json: JSON.stringify({ review_of: "PROJ-1", review_round: "2" }),
    });
    insertTask(db, {
      id: "badLegacy",
      identifier: "PROJ-7",
      kind: "task",
      meta_json: JSON.stringify({ review_of: "NOPE-9" }),
    });
    insertTask(db, {
      id: "selfRef",
      identifier: "PROJ-8",
      kind: "task",
      meta_json: JSON.stringify({ review_of: "PROJ-8" }),
    });
  }

  it("flips every marker row, backfills resolvable legacy mirrors, and leaves the rest alone", async () => {
    const dir = stageThrough("0003");
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      seedOldBoard(board.db);

      addMigration(dir, "0004");
      const applied = applyMigrations(board.db, { dir });
      assert.deepEqual(applied.applied.map((entry) => entry.version), ["0004"]);

      const rows = Object.fromEntries(
        board.db
          .prepare("SELECT id, kind, review_of_id, review_round, acceptance_mode, meta_json FROM tasks")
          .all()
          .map((row) => [row.id, row]),
      );
      assert.equal(rows.orig.kind, "task", "an original card stays task");
      assert.equal(rows.rev.kind, "review", "a marker row is now a review kind");
      assert.equal(rows.rev.review_of_id, "orig");
      assert.equal(rows.rev.review_round, 1);
      assert.equal(rows.plain.kind, "task");
      assert.equal(rows.plainEpic.kind, "epic");

      assert.equal(rows.legacy.kind, "review", "a resolvable meta mirror is backfilled and flipped");
      assert.equal(rows.legacy.review_of_id, "orig");
      assert.equal(rows.legacy.review_round, 1, "the meta round lands in the column");
      assert.equal(rows.legacy.acceptance_mode, "off", "a backfilled review lands on the review mode");
      assert.equal(rows.legacyStr.kind, "review");
      assert.equal(rows.legacyStr.review_round, 2, "a digit-string round is read as an integer");
      assert.equal(rows.legacyStr.acceptance_mode, "off", "the copy overrides any legacy mode");

      assert.equal(rows.badLegacy.kind, "task", "an unresolvable mirror is the documented read-only exception");
      assert.equal(rows.badLegacy.review_of_id, null);
      assert.match(rows.badLegacy.meta_json, /NOPE-9/, "its meta mirror is kept");
      assert.equal(rows.selfRef.kind, "task", "a mirror naming its own card is not a review");
      assert.equal(rows.selfRef.review_of_id, null);

      // The invariant is structural, in both directions.
      assert.equal(
        board.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE (kind = 'review') <> (review_of_id IS NOT NULL)").get().n,
        0,
      );
      const ddl = board.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;
      assert.match(ddl, /kind IN \('task','epic','review'\)/);
      assert.match(ddl, /\(kind = 'review'\) = \(review_of_id IS NOT NULL\)/);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("rebuilds all eight indexes and every trigger", async () => {
    const dir = stageThrough("0004");
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      const indexes = (prefix) =>
        board.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name LIKE ?")
          .all(`${prefix}%`)
          .map((row) => row.name)
          .sort();
      assert.deepEqual(indexes("ix_"), [
        "ix_tasks_assignee",
        "ix_tasks_board",
        "ix_tasks_heartbeat",
        "ix_tasks_review_of",
        "ix_tasks_source",
      ]);
      assert.deepEqual(indexes("ux_"), ["ux_tasks_idem_active", "ux_tasks_identifier", "ux_tasks_source"]);

      const taskTriggers = board.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'")
        .all();
      assert.equal(taskTriggers.length, 22, "every task trigger came back");
      const immutable = taskTriggers.find((row) => row.name === "tr_tasks_review_marker_immutable");
      assert.match(immutable.sql, /UPDATE OF kind, review_of_id, review_round/);
      assert.match(immutable.sql, /OLD\.kind='review'\) <> \(NEW\.kind='review'/);

      for (const name of [
        "tr_dict_actors_delete",
        "tr_rel_block_chain",
        "tr_rel_block_cycle",
        "tr_rel_cross_project",
        "tr_rel_parent_block_pair",
        "tr_rel_parent_epic",
        "tr_rel_parent_guard",
        "tr_reports_rollup_valid",
        "tr_rel_review_no_parent",
      ]) {
        assert.equal(
          board.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).n,
          1,
          `${name} was recreated`,
        );
      }
    } finally {
      board.close();
    }
  });

  it("refuses a kind without its marker, a marker without the review kind, and every kind flip", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "orig", identifier: "PROJ-9", status: "in_review", acceptance_mode: "off" });
      assert.throws(
        () => insertTask(db, { id: "noMarker", identifier: "PROJ-10", kind: "review", acceptance_mode: "off" }),
        /CHECK constraint failed/,
        "kind=review without review_of_id is refused by the CHECK",
      );
      assert.throws(
        () =>
          insertTask(db, {
            id: "markerTask",
            identifier: "PROJ-11",
            kind: "task",
            review_of_id: "orig",
            acceptance_mode: "off",
          }),
        /CHECK constraint failed/,
        "a marker without kind=review is refused",
      );

      insertProject(db, { id: "flip" });
      insertTask(db, { id: "flipOrig", identifier: "PROJ-12", status: "in_review", acceptance_mode: "off", kind: "task", project_id: "flip" });
      insertTask(db, {
        id: "flipRev",
        identifier: "PROJ-13",
        kind: "review",
        status: "in_review",
        acceptance_mode: "off",
        review_of_id: "flipOrig",
        review_round: 1,
        project_id: "flip",
      });
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET kind = 'task' WHERE id = 'flipRev'").run()),
        "REVIEW_OF_IMMUTABLE",
        "review → non-review is refused",
      );
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET kind = 'review' WHERE id = 'flipOrig'").run()),
        "REVIEW_OF_IMMUTABLE",
        "non-review → review is refused",
      );
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET review_of_id = NULL WHERE id = 'flipRev'").run()),
        "REVIEW_OF_IMMUTABLE",
        "clearing the marker is refused",
      );
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET kind = 'epic' WHERE id = 'flipOrig'").run()),
        "NO_ERROR",
        "an ordinary task → epic is still allowed",
      );
    });
  });

  it("moves the SQL enum parity to the three-value set", () => {
    const allSql = listMigrations().map((m) => m.sql).join("\n");
    assert.deepEqual(checkInSets(allSql).get("tasks.kind"), ["epic", "review", "task"]);
  });
});

describe("storage/migrations — failure modes", () => {
  it("refuses a file that changed after it was applied (V2)", async () => {
    const dir = stageMigrations(TINY);
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      // Same version, different content — exactly what "editing history" looks like.
      writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE IF NOT EXISTS alpha(id TEXT) STRICT;", "utf8");

      assert.throws(() => applyMigrations(board.db, { dir }), (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "MIGRATION_CHECKSUM_MISMATCH");
        assert.equal(err.http, 500);
        assert.equal(err.details.version, "0001");
        assert.match(err.hint.fix, /append-only/);
        return true;
      });
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001", "0002"], "history intact");
    } finally {
      board.close();
    }
  });

  it("rolls a failing file back completely — no partial schema, no version row", async () => {
    const dir = stageMigrations({
      ...TINY,
      "0003_broken.sql":
        "CREATE TABLE IF NOT EXISTS gamma(id TEXT PRIMARY KEY) STRICT;\nSELECT this_is_not_sql;",
    });
    const board = await createTempBoard({ migrate: false });
    try {
      const events = [];
      assert.throws(() => applyMigrations(board.db, { dir, logger: (event) => events.push(event) }));
      const failed = events.find((event) => event.event === "migration_failed");
      assert.ok(failed, "a failed migration is recorded");
      assert.equal(failed.level, "error");
      assert.equal(failed.version, "0003");
      assert.match(failed.name, /broken/);
      assert.ok(failed.code, "the mapped domain code rides along");
      const tables = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);
      assert.deepEqual(tables.includes("gamma"), false, "gamma must be rolled back");
      assert.equal(board.db.prepare("SELECT COUNT(*) n FROM alpha").get().n, 1, "0002 survived");
    } finally {
      board.close();
    }
  });

  it("names the file when its name does not follow NNNN_lower_snake.sql", async () => {
    const dir = stageMigrations({ "1_first.sql": "SELECT 1;" });
    const board = await createTempBoard({ migrate: false });
    try {
      assert.throws(() => listMigrations({ dir }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /NNNN_lower_snake_name\.sql/);
        assert.equal(err.details.file, "1_first.sql");
        return true;
      });
      assert.throws(() => applyMigrations(board.db, { dir }), (err) => err.code === "VALIDATION_FAILED");
    } finally {
      board.close();
    }
  });

  it("refuses two files claiming the same version, and an empty directory", async () => {
    const dup = makeTempDir("meerkat-taskpanel-dup-");
    writeFileSync(join(dup, "0001_a.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dup, "0001_b.sql"), "SELECT 2;", "utf8");
    assert.throws(() => listMigrations({ dir: dup }), (err) => err.code === "VALIDATION_FAILED");

    const empty = makeTempDir("meerkat-taskpanel-empty-");
    assert.deepEqual(listMigrations({ dir: empty }), []);
    const board = await createTempBoard({ migrate: false });
    try {
      assert.throws(() => applyMigrations(board.db, { dir: empty }), (err) => {
        assert.equal(err.code, "SCHEMA_MISMATCH");
        return true;
      });
      assert.throws(() => listMigrations({ dir: join(empty, "nope") }), (err) => err.code === "SCHEMA_MISMATCH");
    } finally {
      board.close();
    }
  });

  it("ships a default migrations dir that exists", () => {
    assert.match(defaultMigrationsDir(), /src\/core\/storage\/migrations$/);
    assert.ok(listMigrations().length >= 1, `suspiciously few migrations: ${listMigrations().length}`);
  });
});

describe("storage/migrations — startup check", () => {
  it("is happy when current, and lists the gaps when behind (A3)", async () => {
    // Derived, not transcribed: the shipped set moves with the migrations, and a
    // hand-copied list only ever tells you that you forgot to update it.
    const shipped = listMigrations().map((m) => m.version);
    const board = await createTempBoard({ migrate: false });
    try {
      ensureMigrationsTable(board.db);
      assert.throws(() => assertSchemaCurrent(board.db), (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "SCHEMA_MISMATCH");
        assert.equal(err.http, 500);
        assert.deepEqual(err.details.missing, shipped);
        assert.deepEqual(err.details.expected, shipped);
        return true;
      });

      applyMigrations(board.db);
      assert.deepEqual(assertSchemaCurrent(board.db), {
        ok: true,
        missing: [],
        unknownApplied: [],
        expected: shipped,
      });

      // A database that knows a migration this build does not ship.
      board.db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?,?,?)").run("9999", "x", TS);
      assert.throws(() => assertSchemaCurrent(board.db), (err) => {
        assert.equal(err.code, "SCHEMA_MISMATCH");
        assert.deepEqual(err.details.unknownApplied, ["9999"]);
        return true;
      });

      // `allowStale` is the read-only/export escape hatch: report, do not throw.
      const stale = assertSchemaCurrent(board.db, { allowStale: true });
      assert.equal(stale.ok, false);
      assert.deepEqual(stale.unknownApplied, ["9999"]);
    } finally {
      board.close();
    }
  });

  it("fails the startup check when a migration is deleted from disk", async () => {
    const dir = stageMigrations(TINY);
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      // Now pretend the build ships only 0001 (0002 was removed).
      const trimmed = makeTempDir("meerkat-taskpanel-trimmed-");
      mkdirSync(trimmed, { recursive: true });
      writeFileSync(join(trimmed, "0001_first.sql"), TINY["0001_first.sql"], "utf8");
      assert.throws(() => assertSchemaCurrent(board.db, { dir: trimmed }), (err) => {
        assert.equal(err.code, "SCHEMA_MISMATCH");
        assert.deepEqual(err.details.unknownApplied, ["0002"]);
        return true;
      });
    } finally {
      board.close();
    }
  });
});

describe("storage/migrations — the `-- @foreign-keys: off` request (a table rebuild)", () => {
  /** A parent table with a child that references it — the shape a rebuild disturbs. */
  const REBUILD_FIXTURE = {
    "0001_base.sql":
      "CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT;\n" +
      "CREATE TABLE child(id TEXT PRIMARY KEY, pid TEXT NOT NULL REFERENCES parent(id)) STRICT;\n" +
      "INSERT INTO parent(id) VALUES('p1');\n" +
      "INSERT INTO child(id, pid) VALUES('c1','p1');",
  };
  /** create-new / copy / drop-old / rename-new — SQLite's documented rebuild. */
  const REBUILD_BODY =
    "CREATE TABLE parent_new(id TEXT PRIMARY KEY) STRICT;\n" +
    "INSERT INTO parent_new(id) SELECT id FROM parent;\n" +
    "DROP TABLE parent;\n" +
    "ALTER TABLE parent_new RENAME TO parent;";

  it("recognises the request, and only as a line of its own", () => {
    assert.equal(wantsForeignKeysOff("-- @foreign-keys: off\nSELECT 1;"), true);
    assert.equal(wantsForeignKeysOff("  -- @foreign-keys: off\nSELECT 1;"), true, "leading indent is fine");
    assert.equal(wantsForeignKeysOff("-- @foreign-keys: on\nSELECT 1;"), false);
    assert.equal(wantsForeignKeysOff("-- a note about -- @foreign-keys: off\nSELECT 1;"), false, "only a line of its own counts");
    assert.equal(wantsForeignKeysOff("SELECT '-- @foreign-keys: off';"), false);
  });

  it("applies a rebuild with enforcement off, and puts the pragma back", async () => {
    const dir = stageMigrations({ ...REBUILD_FIXTURE, "0002_rebuild.sql": `-- @foreign-keys: off\n${REBUILD_BODY}` });
    const board = await createTempBoard({ migrate: false });
    try {
      const result = applyMigrations(board.db, { dir });
      assert.deepEqual(result.applied.map((m) => m.version), ["0001", "0002"]);
      assert.equal(Number(board.db.prepare("SELECT COUNT(*) n FROM parent").get().n), 1, "the row survived the rebuild");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
        1,
        "the pinned pragma must be restored, whatever the migration asked for",
      );
    } finally {
      board.close();
    }
  });

  it("is the marker doing the work — the same rebuild without it is refused", async () => {
    const dir = stageMigrations({ ...REBUILD_FIXTURE, "0002_rebuild.sql": REBUILD_BODY });
    const board = await createTempBoard({ migrate: false });
    try {
      assert.throws(() => applyMigrations(board.db, { dir }));
      // ...and the rollback is complete: the failing file left no version row.
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001"]);
      assert.equal(Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      board.close();
    }
  });

  it("leaves the pragma untouched for a migration that does not ask", async () => {
    const dir = stageMigrations({ ...REBUILD_FIXTURE, "0002_plain.sql": "CREATE TABLE extra(id TEXT PRIMARY KEY) STRICT;" });
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      assert.equal(Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      board.close();
    }
  });
});

describe("storage/migrations — the 0002 card-acceptance upgrade", () => {
  const shipped = listMigrations();
  const one = shipped.find((m) => m.version === "0001");
  const two = shipped.find((m) => m.version === "0002");
  const fileName = (m) => `${m.version}_${m.name}.sql`;

  it("drops the project default, rewrites agent to auto, and keeps every guard", async () => {
    const dir = stageMigrations({ [fileName(one)]: one.sql });
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      const now = TS;
      board.db
        .prepare("INSERT INTO projects (id, name, created_at, updated_at, acceptance) VALUES (?, ?, ?, ?, ?)")
        .run("p1", "P", now, now, "human");
      board.db
        .prepare(
          "INSERT INTO actors (id, display_name, normalized_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("a1", "A", "a", now, now);
      const insertTask = board.db.prepare(
        "INSERT INTO tasks (id, identifier, project_id, title, status, created_at, updated_at, acceptance_mode, review_of_id, review_round) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertTask.run("auto1", "P-1", "p1", "auto card", "in_review", now, now, "agent", null, null);
      insertTask.run("human1", "P-2", "p1", "human card", "in_review", now, now, "human", null, null);
      insertTask.run("off1", "P-3", "p1", "off card", "in_review", now, now, "off", null, null);
      insertTask.run("autoRev", "P-4", "p1", "review auto", "in_review", now, now, "off", "auto1", 1);
      insertTask.run("humanRev", "P-5", "p1", "review human", "in_review", now, now, "off", "human1", 1);

      writeFileSync(join(dir, fileName(two)), two.sql, "utf8");
      const upgraded = applyMigrations(board.db, { dir });
      assert.deepEqual(upgraded.applied.map((m) => m.version), ["0002"]);
      assert.deepEqual(applyMigrations(board.db, { dir }).applied, [], "the second apply is a no-op");

      const projectColumns = board.db.prepare("PRAGMA table_info(projects)").all().map((row) => row.name);
      assert.equal(projectColumns.includes("acceptance"), false, "the project default is gone");

      const modes = Object.fromEntries(
        board.db.prepare("SELECT id, acceptance_mode FROM tasks ORDER BY id").all().map((row) => [row.id, row.acceptance_mode]),
      );
      assert.equal(modes.auto1, "auto", "agent becomes auto");
      assert.equal(modes.human1, "human");
      assert.equal(modes.off1, "off");
      assert.equal(modes.autoRev, "off", "a review card stays off");
      assert.equal(
        board.db.prepare("SELECT review_of_id FROM tasks WHERE id = 'autoRev'").get().review_of_id,
        "auto1",
        "the review marker survived the rebuild",
      );
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);

      // The human rule is now structural: an open review is not a finished audit.
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'human1'").run()),
        "REVIEW_REQUIRED",
      );
      board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'humanRev'").run();
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'human1'").run()), "NO_ERROR");
      // `auto` keeps the loop's original-then-review order: an open review is enough.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'auto1'").run()), "NO_ERROR");

      const taskIndexes = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name LIKE 'ix_%'")
        .all()
        .map((row) => row.name);
      const uniqueIndexes = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name LIKE 'ux_%'")
        .all()
        .map((row) => row.name);
      assert.deepEqual(taskIndexes.sort(), [
        "ix_tasks_assignee",
        "ix_tasks_board",
        "ix_tasks_heartbeat",
        "ix_tasks_review_of",
        "ix_tasks_source",
      ]);
      assert.deepEqual(uniqueIndexes.sort(), ["ux_tasks_idem_active", "ux_tasks_identifier", "ux_tasks_source"]);

      const taskTriggers = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'")
        .all()
        .map((row) => row.name);
      assert.equal(taskTriggers.length, 22, "every task trigger came back");
      assert.ok(taskTriggers.includes("tr_tasks_acceptance_review_done"));
      assert.equal(taskTriggers.includes("tr_tasks_acceptance_agent_done"), false, "the old trigger is gone");

      for (const name of [
        "tr_dict_actors_delete",
        "tr_rel_block_chain",
        "tr_rel_block_cycle",
        "tr_rel_cross_project",
        "tr_rel_parent_block_pair",
        "tr_rel_parent_epic",
        "tr_rel_parent_guard",
        "tr_reports_rollup_valid",
        "tr_rel_review_no_parent",
      ]) {
        assert.equal(
          Number(board.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).n),
          1,
          `${name} was recreated`,
        );
      }
      assert.deepEqual(
        board.db.prepare("PRAGMA foreign_key_list(tasks)").all().map((row) => `${row.table}(${row.from})`).sort(),
        ["actors(assignee_id)", "actors(claimed_by)", "actors(reporter_id)", "projects(project_id)", "tasks(review_of_id)"],
      );
    } finally {
      board.close();
    }
  });

  it("rebuilds the schema without drifting any other trigger or index", async () => {
    const dir = stageMigrations({ [fileName(one)]: one.sql });
    const board = await createTempBoard({ migrate: false });
    // Definitions are compared with comments and whitespace gone: the point is
    // the logic, not the prose. A dropped index or a retyped trigger body fails.
    const definition = (sql) =>
      String(sql)
        .replace(/--[^\n]*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const snapshot = () =>
      new Map(
        board.db
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','index') AND sql IS NOT NULL")
          .all()
          .map((row) => [`${row.type}:${row.name}`, definition(row.sql)]),
      );
    try {
      applyMigrations(board.db, { dir });
      const before = snapshot();
      writeFileSync(join(dir, fileName(two)), two.sql, "utf8");
      applyMigrations(board.db, { dir });
      const after = snapshot();

      const removed = "trigger:tr_tasks_acceptance_agent_done";
      const added = "trigger:tr_tasks_acceptance_review_done";
      assert.equal(before.has(removed), true);
      assert.equal(after.has(removed), false, "the old acceptance trigger is gone");
      assert.equal(before.has(added), false);
      assert.equal(after.has(added), true, "the review-done trigger replaces it");

      for (const [key, sql] of before) {
        if (key === removed || key === "trigger:tr_rev_projects_upd") continue;
        assert.equal(after.get(key), sql, `${key} kept its definition`);
      }
      assert.equal(after.size, before.size, "one trigger out, one in");
      assert.deepEqual(
        [...after.keys()].filter((key) => !before.has(key)),
        [added],
        "nothing else was added",
      );
      // The project revision trigger is the second intended change: the retired
      // `acceptance` column leaves its `AFTER UPDATE OF` list.
      assert.doesNotMatch(after.get("trigger:tr_rev_projects_upd"), /acceptance/);
    } finally {
      board.close();
    }
  });
});

describe("storage/migrations — the 0003 project-reviewer drop", () => {
  const shipped = listMigrations();
  const one = shipped.find((m) => m.version === "0001");
  const two = shipped.find((m) => m.version === "0002");
  const three = shipped.find((m) => m.version === "0003");
  const fileName = (m) => `${m.version}_${m.name}.sql`;

  it("drops the column, keeps the rows and every guard, and recreates the revision triggers", async () => {
    const dir = stageMigrations({ [fileName(one)]: one.sql, [fileName(two)]: two.sql });
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir });
      const now = TS;
      board.db
        .prepare("INSERT INTO projects (id, name, created_at, updated_at, reviewer) VALUES (?, ?, ?, ?, ?)")
        .run("p1", "P", now, now, "jobs");
      board.db
        .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("batch", "P2", now, now);
      board.db
        .prepare("INSERT INTO actors (id, display_name, normalized_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
        .run("a1", "A", "a", now, now);
      board.db
        .prepare("INSERT INTO tasks (id, identifier, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("t1", "P-1", "p1", "kept", "todo", now, now);

      writeFileSync(join(dir, fileName(three)), three.sql, "utf8");
      const upgraded = applyMigrations(board.db, { dir });
      assert.deepEqual(upgraded.applied.map((m) => m.version), ["0003"]);
      assert.deepEqual(applyMigrations(board.db, { dir }).applied, [], "the second apply is a no-op");

      const columns = board.db.prepare("PRAGMA table_info(projects)").all().map((row) => row.name);
      assert.deepEqual(columns, [
        "id",
        "name",
        "next_task_number",
        "labels",
        "meta_json",
        "readme",
        "archived_at",
        "created_at",
        "updated_at",
      ]);
      const rows = board.db.prepare("SELECT id, name, next_task_number FROM projects ORDER BY id").all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { id: "batch", name: "P2", next_task_number: 1 },
        { id: "p1", name: "P", next_task_number: 1 },
      ]);
      assert.equal(Number(board.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n), 1, "the card survived");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
        1,
        "the pinned pragma is restored",
      );

      const triggers = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'projects' ORDER BY name")
        .all()
        .map((row) => row.name);
      assert.deepEqual(triggers, ["tr_rev_projects_del", "tr_rev_projects_ins", "tr_rev_projects_upd"]);
      const upd = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_rev_projects_upd'")
        .get().sql;
      assert.doesNotMatch(upd, /reviewer/);

      // The recreated trigger still bumps the revision.
      const before = Number(board.db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision);
      board.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run("Renamed", "p1");
      const after = Number(board.db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision);
      assert.equal(after, before + 1);
    } finally {
      board.close();
    }
  });

  it("rebuilds the schema without drifting any other trigger or index", async () => {
    const dir = stageMigrations({ [fileName(one)]: one.sql, [fileName(two)]: two.sql });
    const board = await createTempBoard({ migrate: false });
    const definition = (sql) =>
      String(sql)
        .replace(/--[^\n]*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const snapshot = () =>
      new Map(
        board.db
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','index') AND sql IS NOT NULL")
          .all()
          .map((row) => [`${row.type}:${row.name}`, definition(row.sql)]),
      );
    try {
      applyMigrations(board.db, { dir });
      const before = snapshot();
      assert.match(before.get("trigger:tr_rev_projects_upd"), /reviewer/);
      writeFileSync(join(dir, fileName(three)), three.sql, "utf8");
      applyMigrations(board.db, { dir });
      const after = snapshot();

      for (const [key, sql] of before) {
        if (key === "trigger:tr_rev_projects_upd") continue;
        assert.equal(after.get(key), sql, `${key} kept its definition`);
      }
      assert.equal(after.size, before.size, "no trigger or index was added or dropped");
      assert.doesNotMatch(after.get("trigger:tr_rev_projects_upd"), /reviewer/);
    } finally {
      board.close();
    }
  });
});
