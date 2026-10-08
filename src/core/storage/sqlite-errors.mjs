/**
 * SQLite failure → `DomainError`.
 *
 * The DB is where the invariants are *machine-guaranteed* (ARCHITECTURE §4.2),
 * so every one of those guarantees surfaces to callers as the same reason code
 * the JS side would use. Two families:
 *
 *   1. `RAISE(ABORT,'CODE')` — `errcode` 1811, the message *is* the code.
 *   2. constraint failures — `CHECK` / `UNIQUE` / `NOT NULL` / `FOREIGN KEY`,
 *      whose messages name the offending columns; the map below turns those
 *      into codes (a `UNIQUE` on `task_relations.target_task_id` is a
 *      `SINGLE_PARENT_VIOLATION`, not a generic "constraint failed").
 *
 * Everything is re-messaged through `redactText` so a token can never ride out
 * on a SQL error string.
 */

import { DB_RAISE_CODES, DomainError, isDomainError } from "../../shared/errors.mjs";
import { redactText } from "../../shared/redact.mjs";

/** SQLite extended result codes we care about. */
export const SQLITE_ERRCODE = Object.freeze({
  CHECK: 275,
  FOREIGNKEY: 787,
  NOTNULL: 1299,
  PRIMARYKEY: 1555,
  TRIGGER: 1811,
  UNIQUE: 2067,
});

/** Codes a trigger is allowed to raise (mirrors `DB_RAISE_CODES`). */
export const RAISED_CODES = new Set(DB_RAISE_CODES);

/**
 * Unique-key column sets → reason code.
 *
 * Declared as an array (not a map keyed by hand) because SQLite prints the
 * columns in index order, which is not always alphabetical — `UNIQUE(task_id,
 * round)` prints as `task_reports.task_id, task_reports.round`, while the
 * lookup sorts. Deriving the key with the same sort as `uniqueColumnsFrom`
 * removes a whole class of silent mis-mapping.
 */
export const UNIQUE_KEY_CODES = Object.freeze([
  { columns: ["task_relations.target_task_id"], code: "SINGLE_PARENT_VIOLATION" },
  {
    columns: [
      "task_relations.relation_type",
      "task_relations.source_task_id",
      "task_relations.target_task_id",
    ],
    code: "RELATION_DUPLICATE",
  },
  { columns: ["tasks.project_id", "tasks.identifier"], code: "IDENTIFIER_CONFLICT" },
  { columns: ["tasks.project_id", "tasks.source_path"], code: "ID_CONFLICT" },
  { columns: ["comments.task_id", "comments.source_seq"], code: "COMMENT_DUPLICATE" },
  {
    columns: ["agent_sessions.task_id", "agent_sessions.seg", "agent_sessions.owner"],
    code: "SESSION_DUPLICATE",
  },
  { columns: ["task_reports.task_id", "task_reports.round"], code: "REPORT_ROUND_MISMATCH" },
  { columns: ["assignees.normalized_name", "assignees.kind"], code: "DICTIONARY_CONFLICT" },
  { columns: ["reporters.normalized_name", "reporters.kind"], code: "DICTIONARY_CONFLICT" },
  { columns: ["labels.project_id", "labels.norm"], code: "LABEL_CONFLICT" },
  { columns: ["projects.workspace_path"], code: "ID_CONFLICT" },
  { columns: ["projects.id"], code: "ID_CONFLICT" },
  { columns: ["tasks.id"], code: "ID_CONFLICT" },
  { columns: ["comments.id"], code: "ID_CONFLICT" },
  { columns: ["assignees.id"], code: "ID_CONFLICT" },
  { columns: ["reporters.id"], code: "ID_CONFLICT" },
  { columns: ["labels.id"], code: "ID_CONFLICT" },
  { columns: ["agent_sessions.id"], code: "ID_CONFLICT" },
  { columns: ["attachments.id"], code: "ID_CONFLICT" },
]);

/** @param {string[]} columns */
export function uniqueKey(columns) {
  return [...columns].sort().join(", ");
}

/** `"sorted, column, list"` → reason code. */
export const UNIQUE_COLUMNS_TO_CODE = Object.freeze(
  Object.fromEntries(UNIQUE_KEY_CODES.map((entry) => [uniqueKey(entry.columns), entry.code])),
);

/** `CHECK constraint failed: <text>` → reason code, by substring. */
export const CHECK_TEXT_TO_CODE = Object.freeze([
  { match: "source_task_id <> target_task_id", code: "SELF_REFERENCE" },
  { match: "relation_type <> 'related'", code: "RELATION_DIRECTION_INVALID" },
]);

/** @param {unknown} err */
export function isSqliteError(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof err.message === "string" &&
    typeof err.errcode === "number"
  );
}

/**
 * Pull `a.b, c.d` out of `UNIQUE constraint failed: a.b, c.d`.
 * @param {string} message
 * @returns {string[]}
 */
export function uniqueColumnsFrom(message) {
  const marker = "UNIQUE constraint failed:";
  const at = message.indexOf(marker);
  if (at === -1) return [];
  return message
    .slice(at + marker.length)
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((part) => part.length > 0)
    .sort();
}

/** @param {string} message */
export function checkTextFrom(message) {
  const marker = "CHECK constraint failed:";
  const at = message.indexOf(marker);
  return at === -1 ? "" : message.slice(at + marker.length).trim();
}

/** @param {string} message */
export function notNullColumnsFrom(message) {
  const marker = "NOT NULL constraint failed:";
  const at = message.indexOf(marker);
  if (at === -1) return [];
  return message
    .slice(at + marker.length)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Map any SQLite failure onto a `DomainError`. A `DomainError` passes through
 * untouched, so callers can wrap unconditionally.
 *
 * @param {unknown} err
 * @param {{op?: string, table?: string}} [context]
 * @returns {DomainError}
 */
export function mapSqliteError(err, context = {}) {
  if (isDomainError(err)) return /** @type {DomainError} */ (err);
  if (!isSqliteError(err)) {
    return new DomainError("VALIDATION_FAILED", {
      message: redactText(err instanceof Error ? err.message : String(err)),
      details: { ...context },
      cause: err,
    });
  }

  const message = redactText(err.message);
  const errcode = err.errcode;
  const details = { ...context, sqlite: { errcode, message } };

  if (errcode === SQLITE_ERRCODE.TRIGGER) {
    // RAISE(ABORT,'CODE') — the message is the reason code.
    if (RAISED_CODES.has(message)) {
      return new DomainError(message, { details, message: raiseMessage(message, context), cause: err });
    }
    return new DomainError("VALIDATION_FAILED", {
      message,
      details: { ...details, unmappedRaise: message },
      cause: err,
    });
  }

  if (errcode === SQLITE_ERRCODE.UNIQUE || errcode === SQLITE_ERRCODE.PRIMARYKEY) {
    const columns = uniqueColumnsFrom(message);
    const code = UNIQUE_COLUMNS_TO_CODE[uniqueKey(columns)];
    if (code !== undefined) {
      return new DomainError(code, { details: { ...details, columns }, cause: err });
    }
    return new DomainError("VALIDATION_FAILED", {
      message,
      details: { ...details, columns, unmappedUnique: true },
      cause: err,
    });
  }

  if (errcode === SQLITE_ERRCODE.CHECK) {
    const check = checkTextFrom(message);
    const hit = CHECK_TEXT_TO_CODE.find((entry) => check.includes(entry.match));
    if (hit !== undefined) {
      return new DomainError(hit.code, { details: { ...details, check }, cause: err });
    }
    return new DomainError("VALIDATION_FAILED", {
      message,
      details: { ...details, check },
      cause: err,
    });
  }

  if (errcode === SQLITE_ERRCODE.FOREIGNKEY) {
    return new DomainError("NOT_FOUND", {
      message: "referenced row does not exist",
      details,
      cause: err,
    });
  }

  if (errcode === SQLITE_ERRCODE.NOTNULL) {
    return new DomainError("VALIDATION_FAILED", {
      message,
      details: { ...details, columns: notNullColumnsFrom(message) },
      cause: err,
    });
  }

  return new DomainError("VALIDATION_FAILED", { message, details, cause: err });
}

/**
 * A human sentence for a raised reason code, so a caller reading logs learns
 * something the code name alone does not say.
 * @param {string} code
 * @param {{op?: string, table?: string}} context
 */
function raiseMessage(code, context) {
  const where = context.op === undefined ? "" : ` during ${context.op}`;
  return `database rejected the write${where}: ${code}`;
}
