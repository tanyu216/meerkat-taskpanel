/**
 * Transaction boundary, revision cursor and the activity trail.
 *
 * One write command = one transaction (ARCHITECTURE §4.3). These helpers are
 * deliberately small: `transaction()` rolls back and re-raises as a
 * `DomainError` rather than swallowing anything, and every command in
 * `src/core/commands` is built on it.
 *
 * R2 — the one thing it *does* retry is lock contention. `SQLITE_BUSY` after
 * `busy_timeout` means the transaction rolled back and changed nothing, so the
 * whole transaction is safe to run again; it is attempted a bounded number of
 * times (see `DB_BUSY_MAX_ATTEMPTS`) and only when it is the outermost one,
 * because a nested savepoint already holds the connection's write lock and
 * cannot hit `SQLITE_BUSY` at all. Past the budget the failure surfaces as
 * `DB_BUSY` (503 + `Retry-After`), never as a generic 500.
 */

import { DB_BUSY_BACKOFF_MS, DB_BUSY_MAX_ATTEMPTS } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { mapSqliteError } from "./sqlite-errors.mjs";
import { GLOBAL_REVISION_SINGLETON } from "./schema.mjs";

/** Does this handle already have an open transaction? */
export function inTransaction(db) {
  if (typeof db.isTransaction === "boolean") return db.isTransaction;
  // Older/odd handles: ask SQLite itself.
  return Number(db.prepare("SELECT autocommit AS a FROM pragma_autocommit").get().a) === 0;
}

/**
 * Run `fn` inside a transaction.
 *
 * Nested calls use SAVEPOINTs rather than throwing: a repository may be used
 * standalone or as one step of a bigger command, and both must work.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @param {{op?: string, attempts?: number}} [options] `attempts` overrides the
 *   retry budget (tests use 1 to observe a single attempt).
 * @returns {T}
 * @throws {DomainError} `DB_BUSY` when contention outlives the retry budget
 */
export function transaction(db, fn, options = {}) {
  const nested = inTransaction(db);
  if (nested) return runNested(db, fn, options);

  const attempts = Math.max(1, options.attempts ?? DB_BUSY_MAX_ATTEMPTS);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return runOutermost(db, fn, options);
    } catch (err) {
      const mapped = mapSqliteError(err, options.op === undefined ? {} : { op: options.op });
      if (mapped.code !== "DB_BUSY" || attempt >= attempts) throw mapped;
      // The rollback already happened; wait a beat and take the lock again.
      sleepSync(DB_BUSY_BACKOFF_MS * attempt);
    }
  }
}

/**
 * One attempt at the outermost transaction. `BEGIN IMMEDIATE` is what actually
 * takes the write lock, so it is inside the same try as the body: a `SQLITE_BUSY`
 * out of either is the same "nothing happened" answer.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @param {{op?: string}} options
 * @returns {T}
 */
function runOutermost(db, fn, options) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone — the original error is what matters */
    }
    throw mapSqliteError(err, options.op === undefined ? {} : { op: options.op });
  }
}

/**
 * One attempt at a nested (savepoint) transaction. Never retried, never
 * mapped twice: `mapSqliteError` passes a `DomainError` through untouched.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @param {{op?: string}} options
 * @returns {T}
 */
function runNested(db, fn, options) {
  const name = `sp_${Math.abs(hashString(options.op ?? "tx"))}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* the transaction is already gone — the original error is what matters */
    }
    throw mapSqliteError(err, options.op === undefined ? {} : { op: options.op });
  }
}

/**
 * Sleep without yielding the event loop.
 *
 * The driver is synchronous (`node:sqlite`'s `DatabaseSync`), so the retry has
 * to be too — an `await` here would make every command async and let another
 * request interleave inside a transaction. `Atomics.wait` on a scratch buffer is
 * the standard synchronous sleep and needs no dependency.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  const wait = Math.max(0, Math.trunc(ms));
  if (wait === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

/** Current value of the global SSE/incremental cursor. */
export function currentRevision(db) {
  const row = db
    .prepare("SELECT revision FROM global_revision WHERE singleton = ?")
    .get(GLOBAL_REVISION_SINGLETON);
  return row === undefined ? 0 : Number(row.revision);
}

/**
 * Append one audit row.
 *
 * `revision` records the global revision that the *change being described*
 * produced — read before this insert, so the activity row can be found from a
 * client's cursor. The insert itself also bumps the cursor (it is a write),
 * which is why the recorded number is not "the revision after this row".
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   taskId?: string|null,
 *   actorKind?: string|null,
 *   actorId?: string|null,
 *   event: string,
 *   changes?: object,
 *   createdAt: string,
 * }} activity
 * @returns {number} the new activity row id
 */
export function recordActivity(db, activity) {
  const {
    taskId = null,
    actorKind = null,
    actorId = null,
    event,
    changes = {},
    createdAt,
  } = activity;

  if (typeof event !== "string" || event.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "recordActivity: event is required",
      details: { field: "event" },
    });
  }
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "recordActivity: createdAt is required",
      details: { field: "createdAt" },
    });
  }

  const revision = currentRevision(db);
  const info = db
    .prepare(
      `INSERT INTO task_activities(task_id, actor_kind, actor_id, event, changes_json, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, actorKind, actorId, event, JSON.stringify(changes ?? {}), revision, createdAt);
  return Number(info.lastInsertRowid);
}

/** Deterministic small integer for savepoint names. */
function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}
