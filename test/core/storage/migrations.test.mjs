/**
 * Step 5: the migration runner's contract (card A3, V2, V3).
 *
 * Apply once, apply again (no-op), refuse a tampered file, refuse to serve a
 * database that is behind, roll back a failing file completely, and refuse
 * mis-named files. The "table list" half of V3 is asserted here via
 * `PRAGMA table_info`; the SQL↔JS half lives in `contract/sql-parity`.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
import { DomainError } from "../../../src/shared/errors.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  createTempBoard,
  insertTask,
  makeTempDir,
  revision,
} from "../../helpers/sqlite-fixture.mjs";

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
    assert.deepEqual(migrations.map((m) => m.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"]);
    assert.deepEqual(migrations.map((m) => m.name), [
      "core_tables",
      "invariants",
      "reports",
      "dictionary",
      "task_meta",
      "report_waiver",
      "labels",
      "report_origin",
      "task_idem",
      "parent_epic",
      "parent_kind_update",
      "drop_project_workspace",
      "awaiting_status",
      "task_source_index",
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
      assert.deepEqual(first.applied.map((a) => a.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"]);
      assert.deepEqual(first.skipped, []);
      for (const entry of first.applied) assert.equal(typeof entry.ms, "number");

      const second = applyMigrations(board.db);
      assert.deepEqual(second.applied, [], "re-apply must be a no-op");
      assert.deepEqual(second.skipped, ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"]);

      const rows = board.db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
      assert.equal(rows.length, listMigrations().length, "one bookkeeping row per shipped file");
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"]);
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

      // Card A6: the report table's column list, literally. `origin` (0008) is
      // appended by ALTER, so it comes last.
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
        "origin",
      ]);
      // Card A4: the double id + optimistic-concurrency version.
      for (const column of ["id", "identifier", "version", "report_latest_id", "delivery_round", "idem"]) {
        assert.ok(columnsOf("tasks").includes(column), `tasks.${column}`);
      }
      // The board owns no directory (0012): the column 0001 created is gone.
      assert.equal(columnsOf("projects").includes("workspace_path"), false, "projects.workspace_path must be dropped by 0012");
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
      assert.throws(() => applyMigrations(board.db, { dir }));
      const tables = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);
      assert.deepEqual(tables.includes("gamma"), false, "gamma must be rolled back");
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001", "0002"]);
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
    assert.ok(listMigrations().length >= 12, `suspiciously few migrations: ${listMigrations().length}`);
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

describe("storage/migrations — 0012 drops projects.workspace_path (O3)", () => {
  /** The shipped set **before** 0012 — a board as the previous build left it. */
  function before0012() {
    const dir = makeTempDir("meerkat-taskpanel-pre0012-");
    for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0012")) {
      copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
    }
    return dir;
  }

  const columnsOf = (db) =>
    db.prepare("SELECT name FROM pragma_table_info('projects')").all().map((r) => r.name);
  const indexNames = (db) =>
    db.prepare("SELECT name FROM pragma_index_list('projects')").all().map((r) => r.name);

  it("carries an existing board across, keeping every row and its task links", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      // A board from the previous build: the column is there, with its rows.
      const old = applyMigrations(board.db, { dir: before0012() });
      assert.equal(old.applied.at(-1).version, "0011");
      assert.ok(columnsOf(board.db).includes("workspace_path"), "precondition: the old schema has the column");
      assert.ok(indexNames(board.db).includes("ux_projects_workspace"), "precondition: the old schema has the index");

      board.db
        .prepare(
          `INSERT INTO projects(id, name, workspace_path, next_task_number, labels, meta_json, readme, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy", "Legacy project", "/tmp/demo", 7, '["m1"]', '{"k":"v"}', "# notes", TS, TS);
      insertTask(board.db, { id: "task-legacy", identifier: "LEGACY-0001", project_id: "legacy" });

      // The upgrade is everything above 0011, on top of what was already there.
      const up = applyMigrations(board.db);
      // 0012 and everything after it — this board stopped before 0012, so the
      // upgrade carries it to the head of the shipped set.
      assert.deepEqual(up.applied.map((m) => m.version), ["0012", "0013", "0014"]);
      assert.deepEqual(up.skipped.slice(-2), ["0010", "0011"]);

      // The column and its unique index are gone; the table is otherwise intact.
      assert.equal(columnsOf(board.db).includes("workspace_path"), false, "projects.workspace_path must be gone");
      assert.equal(indexNames(board.db).includes("ux_projects_workspace"), false, "the unique index must be gone");

      // Every other value on the row survived (only the directory string is lost
      // on purpose — it now lives on the skill side).
      const row = board.db.prepare("SELECT * FROM projects WHERE id = 'legacy'").get();
      assert.equal(row.name, "Legacy project");
      assert.equal(Number(row.next_task_number), 7);
      assert.equal(row.labels, '["m1"]');
      assert.equal(row.meta_json, '{"k":"v"}');
      assert.equal(row.readme, "# notes");
      assert.equal(row.created_at, TS);
      assert.equal(row.updated_at, TS);

      // The task, and the link to its project, are untouched.
      const task = board.db.prepare("SELECT project_id, identifier FROM tasks WHERE id = 'task-legacy'").get();
      assert.equal(task.project_id, "legacy");
      assert.equal(task.identifier, "LEGACY-0001");

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("re-leaves the projects update trigger naming only live columns", async () => {
    const board = await createTempBoard(); // fully migrated
    try {
      const sql = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_rev_projects_upd'")
        .get().sql;
      assert.match(sql, /AFTER UPDATE OF/);
      assert.equal(sql.includes("workspace_path"), false, "the trigger must not name a dropped column");

      // And it still does its job: a project update bumps the revision cursor.
      board.db.prepare("INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("p", "P", TS, TS);
      const before = revision(board.db);
      board.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = 'p'").run("Q", TS2);
      assert.equal(revision(board.db), before + 1, "the revision trigger must still fire");
    } finally {
      board.close();
    }
  });

  it("is a no-op on a board that already dropped the column", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0012"), true);
      assert.equal(columnsOf(board.db).includes("workspace_path"), false);
    } finally {
      board.close();
    }
  });
});

describe("storage/migrations — the `-- @foreign-keys: off` request (0013's rebuild)", () => {
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
