/**
 * The only place that opens a database.
 *
 * `node:sqlite` is loaded through a *dynamic* import so a runtime without it
 * (older Node, or a Node that still wants `--experimental-sqlite`) produces an
 * actionable `SQLITE_UNAVAILABLE` instead of a stack trace from module loading.
 * The loader is injectable so the failure path is testable.
 *
 * Pinned connection semantics (ARCHITECTURE §4.3):
 *   journal_mode=WAL, busy_timeout=5000, foreign_keys=ON, synchronous=NORMAL,
 *   recursive_triggers=OFF (explicit — nested DML behaviour must be intentional,
 *   see plan §3.3.6③).
 */

import { DomainError } from "../../shared/errors.mjs";
import { isMemoryPath } from "./paths.mjs";

/** `STRICT` tables need SQLite ≥ 3.37. */
export const MIN_SQLITE_VERSION = "3.37.0";

/** Every connection gets these. */
export const REQUIRED_PRAGMAS = Object.freeze({
  busy_timeout: 5000,
  foreign_keys: 1,
  synchronous: 1, // NORMAL
  recursive_triggers: 0,
});

/** @param {unknown} value */
function defaultLoader() {
  return import("node:sqlite");
}

/**
 * Build the "no sqlite here" error. Exported so the message can be asserted
 * without uninstalling a runtime module.
 *
 * @param {unknown} [cause]
 */
export function sqliteUnavailableError(cause) {
  const err = new DomainError("SQLITE_UNAVAILABLE", {
    message: "node:sqlite is not available in this runtime",
    details: { node: process.version },
    hint: {
      requirements: "Node >= 22 and a Node built with SQLite support",
      flags: "older Node versions need --experimental-sqlite",
      example: "node --experimental-sqlite src/cli/index.mjs",
    },
    cause,
  });
  return err;
}

/**
 * Compare dotted version strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Open a database with the pinned pragmas.
 *
 * @param {{
 *   path: string,
 *   readonly?: boolean,
 *   loadModule?: () => Promise<any>,
 *   minVersion?: string,
 *   pragmas?: Record<string, number|string>,
 * }} options
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
export async function openDatabase(options) {
  const {
    path,
    readonly = false,
    loadModule = defaultLoader,
    minVersion = MIN_SQLITE_VERSION,
    pragmas = {},
  } = options;

  if (typeof path !== "string" || path.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "openDatabase: a database path is required",
      details: { field: "path" },
    });
  }

  let sqlite;
  try {
    sqlite = await loadModule();
  } catch (err) {
    throw sqliteUnavailableError(err);
  }
  if (sqlite === null || sqlite === undefined || typeof sqlite.DatabaseSync !== "function") {
    throw sqliteUnavailableError(new TypeError("module has no DatabaseSync export"));
  }

  const memory = isMemoryPath(path);
  const db = new sqlite.DatabaseSync(path, readonly ? { readOnly: true } : {});

  try {
    // busy_timeout first: changing the journal mode takes a lock, and eight
    // processes opening the same board at once must wait for it rather than
    // fail with SQLITE_BUSY. Everything else is connection-local.
    if (!readonly) db.exec(`PRAGMA busy_timeout = ${REQUIRED_PRAGMAS.busy_timeout}`);
    // WAL is a property of the *file*: `PRAGMA journal_mode` inside a
    // transaction errors, and `:memory:` cannot be WAL at all.
    if (!readonly && !memory) db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA foreign_keys = ${REQUIRED_PRAGMAS.foreign_keys}`);
    if (!readonly) db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`PRAGMA recursive_triggers = ${REQUIRED_PRAGMAS.recursive_triggers}`);
    for (const [name, value] of Object.entries(pragmas)) {
      db.exec(`PRAGMA ${name} = ${value}`);
    }

    const version = sqliteVersion(db);
    if (compareVersions(version, minVersion) < 0) {
      throw new DomainError("SQLITE_UNAVAILABLE", {
        message: `SQLite ${version} is older than the required ${minVersion} (STRICT tables)`,
        details: { version, required: minVersion },
        hint: { fix: "upgrade the SQLite that Node ships with (Node >= 22)" },
      });
    }
  } catch (err) {
    closeDatabase(db);
    throw err;
  }

  return db;
}

/**
 * `sqlite_version()` as reported by the connection.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function sqliteVersion(db) {
  return String(db.prepare("SELECT sqlite_version() AS v").get().v);
}

/**
 * Read back the pragmas the contract test asserts on.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function readPragmas(db) {
  const read = (name) => db.prepare(`PRAGMA ${name}`).get();
  return {
    journal_mode: String(read("journal_mode").journal_mode),
    busy_timeout: Number(read("busy_timeout").timeout),
    foreign_keys: Number(read("foreign_keys").foreign_keys),
    synchronous: Number(read("synchronous").synchronous),
    recursive_triggers: Number(read("recursive_triggers").recursive_triggers),
  };
}

/**
 * Close quietly — `close()` on an already-closed handle throws, and callers
 * close in `finally` blocks.
 * @param {{close?: () => void}|null|undefined} db
 */
export function closeDatabase(db) {
  if (db === null || db === undefined) return;
  try {
    db.close();
  } catch {
    /* already closed — nothing to do */
  }
}
