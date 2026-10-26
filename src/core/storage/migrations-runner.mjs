/**
 * The migration runner: apply `NNNN_*.sql` in order, once, and prove it.
 *
 * Guarantees the card asks for (A3):
 *   * idempotent   — re-applying yields `applied: []`
 *   * append-only  — a changed file is refused, not silently applied
 *   * atomic       — each file runs in its own transaction; a failure leaves
 *                    neither schema changes nor a `schema_migrations` row
 *   * checked      — startup refuses to serve a database that is behind
 *                    (`SCHEMA_MISMATCH`), listing what is missing
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DomainError } from "../../foundation/errors.mjs";
import { MIGRATIONS_DIRNAME, MIGRATION_FILE_PATTERN } from "./schema.mjs";
import { REQUIRED_PRAGMAS } from "./driver.mjs";
import { mapSqliteError } from "./sqlite-errors.mjs";

/** Where the shipped migrations live. */
export function defaultMigrationsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), MIGRATIONS_DIRNAME);
}

/**
 * Line endings must not change a checksum: a Windows checkout should not look
 * like a tampered migration.
 * @param {string} sql
 */
export function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, "\n");
}

/** @param {string} sql */
export function checksumFor(sql) {
  return createHash("sha256").update(normalizeSql(sql), "utf8").digest("hex");
}

/**
 * A migration's explicit request to run with foreign key enforcement **off**,
 * written as a line of its own:
 *
 *   `-- @foreign-keys: off`
 *
 * It exists for exactly one job: rebuilding a table. SQLite has no
 * `ALTER TABLE … MODIFY`, so widening or replacing a `CHECK` constraint means
 * create-new / copy / drop-old / rename-new, and SQLite's own documentation for
 * that procedure begins "if foreign key constraints are enabled, disable them".
 * The pragma has to be issued **before** the transaction — inside one it is a
 * documented no-op — which a migration file cannot do for itself, because the
 * runner wraps every file in `BEGIN IMMEDIATE`. This is that lever, and it is
 * deliberately opt-in and textual: a migration that needs it says so on its
 * face, and the runner restores the pinned pragma afterwards either way.
 *
 * The alternative — leaving enforcement on and hoping a deferred check covers it
 * — does not work: `PRAGMA defer_foreign_keys` postpones *enforcement*, but the
 * failure mode here is foreign key *resolution*, which reports `no such table`
 * the moment a child table's parent is missing, however brief the window.
 */
const FOREIGN_KEYS_OFF = /^[ \t]*--[ \t]*@foreign-keys:[ \t]*off[ \t]*$/m;

/** @param {string} sql */
export function wantsForeignKeysOff(sql) {
  return FOREIGN_KEYS_OFF.test(String(sql));
}

/**
 * Read and validate every migration file, sorted by version.
 *
 * @param {{dir?: string}} [options]
 * @returns {{version: string, name: string, file: string, path: string, sql: string, checksum: string}[]}
 */
export function listMigrations(options = {}) {
  const dir = options.dir ?? defaultMigrationsDir();

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new DomainError("SCHEMA_MISMATCH", {
      message: `migrations directory is unreadable: ${dir}`,
      details: { dir },
      hint: { fix: "restore src/core/storage/migrations (it ships with the package)" },
      cause: err,
    });
  }

  const migrations = [];
  for (const file of entries.filter((f) => f.endsWith(".sql")).sort()) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (match === null) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `migration file must be named NNNN_lower_snake_name.sql: ${file}`,
        details: { file, dir },
      });
    }
    const sql = readFileSync(join(dir, file), "utf8");
    migrations.push({
      version: match[1],
      name: match[2],
      file,
      path: join(dir, file),
      sql,
      checksum: checksumFor(sql),
    });
  }

  const seen = new Set();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `two migration files claim version ${migration.version}`,
        details: { version: migration.version, dir },
      });
    }
    seen.add(migration.version);
  }

  return migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/** The bookkeeping table has to exist before it can be read. */
export function ensureMigrationsTable(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       checksum   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string>} version → checksum
 */
export function appliedMigrations(db) {
  let rows;
  try {
    rows = db.prepare("SELECT version, checksum FROM schema_migrations").all();
  } catch (err) {
    // A read-only handle cannot create the table, and a missing table simply
    // means "nothing has been applied here yet".
    if (/no such table/i.test(String(err.message))) return new Map();
    throw err;
  }
  return new Map(rows.map((row) => [String(row.version), String(row.checksum)]));
}

/**
 * Apply everything that is not applied yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{dir?: string, now?: () => string, logger?: (event: object) => void}} [options]
 * @returns {{applied: {version: string, name: string, ms: number}[], skipped: string[], checksums: Record<string,string>}}
 */
export function applyMigrations(db, options = {}) {
  const { dir, now = () => new Date().toISOString(), logger } = options;

  const migrations = listMigrations({ dir });
  if (migrations.length === 0) {
    throw new DomainError("SCHEMA_MISMATCH", {
      message: "no migration files found",
      details: { dir: dir ?? defaultMigrationsDir() },
    });
  }

  // The bookkeeping table is created by the runner, not by a migration: it has
  // to exist before the first `schema_migrations` write.
  ensureMigrationsTable(db);
  const already = appliedMigrations(db);

  // Refuse before writing anything: a changed migration means history moved.
  for (const migration of migrations) {
    const prior = already.get(migration.version);
    if (prior !== undefined && prior !== migration.checksum) {
      throw new DomainError("MIGRATION_CHECKSUM_MISMATCH", {
        message: `migration ${migration.file} changed after it was applied`,
        details: {
          version: migration.version,
          file: migration.file,
          applied: prior,
          current: migration.checksum,
        },
        hint: { fix: "migrations are append-only — add a new NNNN_*.sql instead of editing this one" },
      });
    }
  }

  const applied = [];
  const skipped = [];
  const checksums = {};

  for (const migration of migrations) {
    checksums[migration.version] = migration.checksum;
    if (already.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }

    const startedAt = Date.now();
    // A rebuild migration asks for this (see `wantsForeignKeysOff`); the pragma
    // is a no-op inside a transaction, so it has to be issued here — before the
    // BEGIN — and put back afterwards, whether the file succeeds or not. The
    // pinned value is the one the driver opened with, so the restore is to the
    // same state the rest of the process expects.
    const fkOff = wantsForeignKeysOff(migration.sql);
    if (fkOff) db.exec(`PRAGMA foreign_keys = ${REQUIRED_PRAGMAS.foreign_keys === 1 ? 0 : 1}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.checksum,
        now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the statement failed hard enough that there is nothing to roll back */
      }
      const mapped = mapSqliteError(err, { op: `apply ${migration.file}` });
      // The process edge can only say "startup failed"; this record is the one
      // that names *which* migration refused the board.
      if (logger !== undefined) {
        logger({
          event: "migration_failed",
          level: "error",
          version: migration.version,
          name: migration.name,
          code: mapped.code,
          message: mapped.message,
        });
      }
      throw mapped;
    } finally {
      if (fkOff) db.exec(`PRAGMA foreign_keys = ${REQUIRED_PRAGMAS.foreign_keys}`);
    }

    applied.push({ version: migration.version, name: migration.name, ms: Date.now() - startedAt });
    if (logger !== undefined) logger({ event: "migration_applied", ...applied.at(-1) });
  }

  // "Already current" and "nothing ran" are different answers; the count is the
  // cheap way to tell them apart on a restart.
  if (logger !== undefined && skipped.length > 0) {
    logger({ event: "migrations_skipped", level: "debug", count: skipped.length });
  }

  return { applied, skipped, checksums };
}

/**
 * Is this database at the expected schema?
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{dir?: string, allowStale?: boolean}} [options]
 * @returns {{ok: boolean, missing: string[], unknownApplied: string[], expected: string[]}}
 */
export function assertSchemaCurrent(db, options = {}) {
  const { dir, allowStale = false } = options;
  const migrations = listMigrations({ dir });
  const applied = appliedMigrations(db);

  const expected = migrations.map((m) => m.version);
  const missing = expected.filter((version) => !applied.has(version));
  const known = new Set(expected);
  const unknownApplied = [...applied.keys()].filter((version) => !known.has(version)).sort();

  const report = { ok: missing.length === 0 && unknownApplied.length === 0, missing, unknownApplied, expected };
  if (report.ok || allowStale) return report;

  throw new DomainError("SCHEMA_MISMATCH", {
    message:
      missing.length > 0
        ? `database is ${missing.length} migration(s) behind: ${missing.join(", ")}`
        : `database has migrations this build does not know: ${unknownApplied.join(", ")}`,
    details: report,
    hint: { fix: "run the migration runner (bootstrap does this on open)" },
  });
}
