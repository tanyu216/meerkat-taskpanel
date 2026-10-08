/**
 * Transaction boundary, revision cursor and the activity trail.
 *
 * One write command = one transaction (ARCHITECTURE §4.3). These helpers are
 * deliberately small: `transaction()` never retries and never swallows — it
 * rolls back and re-raises as a `DomainError`, and every command in
 * `src/core/commands` is built on it.
 */

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
 * @param {{op?: string}} [options]
 * @returns {T}
 */
export function transaction(db, fn, options = {}) {
  const nested = inTransaction(db);
  const name = nested ? `sp_${Math.abs(hashString(options.op ?? "tx"))}` : null;
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK");
      if (nested) db.exec(`RELEASE ${name}`);
    } catch {
      /* the transaction is already gone — the original error is what matters */
    }
    throw mapSqliteError(err, options.op === undefined ? {} : { op: options.op });
  }
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
