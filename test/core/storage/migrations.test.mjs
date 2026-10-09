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
} from "../../../src/core/storage/migrations-runner.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A private migration dir so a test can add/alter files without touching the real set. */
function stageMigrations(files) {
  const dir = makeTempDir("taskpanel-migrations-");
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
    assert.deepEqual(migrations.map((m) => m.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
    assert.deepEqual(migrations.map((m) => m.name), [
      "core_tables",
      "invariants",
      "reports",
      "dictionary",
      "task_meta",
      "report_waiver",
      "labels",
      "report_origin",
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
      assert.deepEqual(first.applied.map((a) => a.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
      assert.deepEqual(first.skipped, []);
      for (const entry of first.applied) assert.equal(typeof entry.ms, "number");

      const second = applyMigrations(board.db);
      assert.deepEqual(second.applied, [], "re-apply must be a no-op");
      assert.deepEqual(second.skipped, ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);

      const rows = board.db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
      assert.equal(rows.length, 8, "one bookkeeping row per file");
      assert.deepEqual([...appliedMigrations(board.db).keys()], ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
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
      for (const column of ["id", "identifier", "version", "report_latest_id", "delivery_round"]) {
        assert.ok(columnsOf("tasks").includes(column), `tasks.${column}`);
      }
      assert.ok(columnsOf("projects").includes("workspace_path"));
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
    const dup = makeTempDir("taskpanel-dup-");
    writeFileSync(join(dup, "0001_a.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dup, "0001_b.sql"), "SELECT 2;", "utf8");
    assert.throws(() => listMigrations({ dir: dup }), (err) => err.code === "VALIDATION_FAILED");

    const empty = makeTempDir("taskpanel-empty-");
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
    assert.equal(listMigrations().length, 8);
  });
});

describe("storage/migrations — startup check", () => {
  it("is happy when current, and lists the gaps when behind (A3)", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      ensureMigrationsTable(board.db);
      assert.throws(() => assertSchemaCurrent(board.db), (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "SCHEMA_MISMATCH");
        assert.equal(err.http, 500);
        assert.deepEqual(err.details.missing, ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
        assert.deepEqual(err.details.expected, ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
        return true;
      });

      applyMigrations(board.db);
      assert.deepEqual(assertSchemaCurrent(board.db), {
        ok: true,
        missing: [],
        unknownApplied: [],
        expected: ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"],
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
      const trimmed = makeTempDir("taskpanel-trimmed-");
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
