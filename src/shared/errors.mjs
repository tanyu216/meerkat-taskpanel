/**
 * Error vocabulary — the single exit for every failure raised by `src/core`.
 *
 * `ERROR_CODES` is the superset. It is partitioned into three buckets so a test
 * can prove the accounting is exhaustive (`test/core/shared.test.mjs` and
 * `test/contract/sql-parity.test.mjs`):
 *
 *   - `DB_RAISE_CODES`      — must appear verbatim as `RAISE(ABORT,'CODE')` in
 *                             `src/core/storage/migrations/*.sql`
 *   - `SQL_CONSTRAINT_CODES`— derived from CHECK/NOT NULL/UNIQUE/FK failures by
 *                             `src/core/storage/sqlite-errors.mjs`
 *   - `JS_ONLY_CODES`       — raised only by domain/command logic
 *
 * Bare `throw new Error(...)` is not allowed in `src/core`: raise a
 * `DomainError` so every failure carries a machine-readable `code` and an HTTP
 * status the server layer can forward verbatim.
 */

import { redactDeep, redactText } from "./redact.mjs";

/** @typedef {import('./errors.mjs').ErrorSpec} ErrorSpec */

/**
 * @param {number} http
 * @param {string} message
 * @param {object|null} [hint]
 */
function spec(http, message, hint = null) {
  return Object.freeze(hint === null ? { http, message } : { http, message, hint });
}

export const ERROR_CODES = Object.freeze({
  // ---- Report entity + delivery gate (card acceptance: A6/A7/A8) -------------
  REPORT_REQUIRED: spec(
    422,
    "Delivering to in_review requires a report for the current delivery round.",
    {
      command: "taskctl issue deliver <identifier> --report-file -",
      note: "One report per (task, round); leaving in_review starts a new round.",
    },
  ),
  REPORT_INVALID: spec(422, "Report content is invalid."),
  REPORT_TOO_LARGE: spec(413, "Report is too large after bounding."),
  REPORT_ROUND_MISMATCH: spec(409, "Report round does not match the task's current delivery round."),
  REPORT_APPEND_ONLY: spec(409, "Reports are append-only; write a new round instead of editing history."),
  REPORT_TASK_MISMATCH: spec(409, "report_latest_id does not belong to this task."),

  // ---- Task state machine + lifecycle ---------------------------------------
  INVALID_TRANSITION: spec(409, "Status transition is not allowed."),
  TERMINAL_STATE: spec(409, "done/canceled are terminal; they cannot be left."),
  VERSION_CONFLICT: spec(409, "Version conflict — re-read the task and retry once."),
  CLAIM_LOST: spec(409, "Claim could not be taken: the task was taken concurrently."),
  EXECUTION_ACTIVE: spec(409, "Another actor holds a fresh claim on this task."),
  EXECUTION_STATE_CORRUPT: spec(500, "in_progress without claimed_by — state is corrupt."),
  ARCHIVE_NOT_TERMINAL: spec(409, "Only done/canceled tasks may be archived."),

  // ---- Creation idempotency (T-20261009-175500-idem-taskpanel) ---------------
  // Raised when the partial unique index is the one that refuses a write, i.e.
  // a racing create lost. The create path catches this and converges onto the
  // existing task, so a caller only ever sees it when the row genuinely cannot
  // be found afterwards.
  IDEM_EXISTS: spec(409, "A non-terminal task with the same idempotency key already exists."),

  // ---- Relations -------------------------------------------------------------
  SINGLE_PARENT_VIOLATION: spec(409, "A task may have at most one parent."),
  SELF_REFERENCE: spec(422, "A task cannot be related to itself."),
  RELATION_CYCLE: spec(422, "Relation would create a parent/child cycle."),
  CHAIN_TOO_LONG: spec(422, "Relation chain would exceed the maximum depth."),
  FANIN_TOO_HIGH: spec(422, "Parent already has the maximum number of children."),
  CROSS_PROJECT_RELATION: spec(422, "Relations must not cross projects."),
  RELATION_IMMUTABLE: spec(409, "Relations are immutable; remove and re-add instead."),
  RELATION_DUPLICATE: spec(409, "That relation already exists."),
  RELATION_DIRECTION_INVALID: spec(422, "related relations are stored with source < target."),

  // ---- Comments / activities -------------------------------------------------
  COMMENT_APPEND_ONLY: spec(409, "Comments are append-only."),
  COMMENT_DUPLICATE: spec(409, "That comment was already imported."),

  // ---- Dictionary entities ---------------------------------------------------
  DICTIONARY_ENTRY_IN_USE: spec(409, "Dictionary entry is referenced by existing tasks."),
  DICTIONARY_AMBIGUOUS: spec(409, "Name matches several dictionary entries; be exact or use --force-create."),
  DICTIONARY_INVALID: spec(422, "Dictionary name must not be empty."),
  DICTIONARY_CONFLICT: spec(409, "Dictionary entry already exists."),

  // ---- Labels (ARCHITECTURE §4.4) -------------------------------------------
  // Labels have no management surface, so the only conflict a caller can reach
  // is the registry's own `UNIQUE(project_id, norm)`.
  LABEL_CONFLICT: spec(409, "Label already exists in this project."),

  // ---- Persistence / migrations ---------------------------------------------
  MIGRATION_CHECKSUM_MISMATCH: spec(500, "A migration file changed after it was applied; migrations are append-only."),
  SCHEMA_MISMATCH: spec(500, "Database schema is not at the expected migration version."),
  SQLITE_UNAVAILABLE: spec(500, "node:sqlite is unavailable in this Node runtime."),
  VALIDATION_FAILED: spec(400, "Input failed validation."),
  ID_CONFLICT: spec(409, "Record already exists."),
  IDENTIFIER_CONFLICT: spec(409, "Identifier already exists in this project."),
  SESSION_DUPLICATE: spec(409, "Agent session already registered for (task, seg, owner)."),
  NOT_FOUND: spec(404, "Not found."),

  // ---- md migrator -----------------------------------------------------------
  MD_PARSE_ERROR: spec(422, "Markdown card could not be parsed."),
  MD_GROWTH_GUARD: spec(422, "Rewriting this card would grow it beyond the guard factor."),
  SOURCE_CHANGED: spec(409, "Imported source file changed since it was imported."),

  // ---- Secrets ---------------------------------------------------------------
  TOKEN_FILE_CORRUPT: spec(500, "Token file exists but is malformed; fix it by hand."),
  RUNTIME_POINTER_TOKEN_LEAK: spec(500, "Refusing to write a runtime pointer that contains a token."),

  // ---- CLI surface (M2) ------------------------------------------------------
  // Raised only by `src/cli`. They exist so a script can tell "you typed it
  // wrong" (exit 2) from "the board refused" (exit 1) without parsing prose.
  CLI_USAGE: spec(400, "Invalid command usage."),
  CLI_IO: spec(400, "Could not talk to the task board."),
});

/** Codes the migration SQL must raise, verbatim, via `RAISE(ABORT,'CODE')`. */
export const DB_RAISE_CODES = Object.freeze([
  "REPORT_REQUIRED",
  "REPORT_APPEND_ONLY",
  "REPORT_TASK_MISMATCH",
  "INVALID_TRANSITION",
  "TERMINAL_STATE",
  "ARCHIVE_NOT_TERMINAL",
  "SELF_REFERENCE",
  "RELATION_CYCLE",
  "CHAIN_TOO_LONG",
  "FANIN_TOO_HIGH",
  "CROSS_PROJECT_RELATION",
  "RELATION_IMMUTABLE",
  "COMMENT_APPEND_ONLY",
  "DICTIONARY_ENTRY_IN_USE",
]);

/** Codes produced by mapping SQLite constraint failures (not `RAISE`). */
export const SQL_CONSTRAINT_CODES = Object.freeze([
  "IDEM_EXISTS",
  "SINGLE_PARENT_VIOLATION",
  "RELATION_DUPLICATE",
  "RELATION_DIRECTION_INVALID",
  "COMMENT_DUPLICATE",
  "IDENTIFIER_CONFLICT",
  "ID_CONFLICT",
  "SESSION_DUPLICATE",
  "DICTIONARY_CONFLICT",
  "LABEL_CONFLICT",
  "VALIDATION_FAILED",
  "NOT_FOUND",
]);

/** Codes raised purely by domain/command logic. */
export const JS_ONLY_CODES = Object.freeze([
  "REPORT_INVALID",
  "REPORT_TOO_LARGE",
  "REPORT_ROUND_MISMATCH",
  "VERSION_CONFLICT",
  "CLAIM_LOST",
  "EXECUTION_ACTIVE",
  "EXECUTION_STATE_CORRUPT",
  "DICTIONARY_AMBIGUOUS",
  "DICTIONARY_INVALID",
  "MIGRATION_CHECKSUM_MISMATCH",
  "SCHEMA_MISMATCH",
  "SQLITE_UNAVAILABLE",
  "MD_PARSE_ERROR",
  "MD_GROWTH_GUARD",
  "SOURCE_CHANGED",
  "TOKEN_FILE_CORRUPT",
  "RUNTIME_POINTER_TOKEN_LEAK",
  // CLI-only: no database trigger and no SQLite constraint can raise these.
  "CLI_USAGE",
  "CLI_IO",
]);

/**
 * A failure with a machine-readable `code`, an HTTP status and redacted details.
 */
export class DomainError extends Error {
  /**
   * @param {string} code one of `ERROR_CODES`
   * @param {{details?: object, message?: string, hint?: object|string|null, cause?: unknown}} [options]
   */
  constructor(code, options = {}) {
    const entry = ERROR_CODES[code];
    if (entry === undefined) {
      throw new TypeError(`DomainError: unknown code ${JSON.stringify(code)}`);
    }
    const { details = {}, message, hint, cause } = options;
    super(redactText(message ?? entry.message));
    this.name = "DomainError";
    this.code = code;
    this.http = entry.http;
    this.details = redactDeep(details) ?? {};
    const resolvedHint = hint === undefined ? entry.hint : hint;
    this.hint = resolvedHint === undefined || resolvedHint === null ? null : redactDeep(resolvedHint);

    if (cause !== undefined) this.cause = cause;
  }

  /** Whether a given ERROR_CODES entry exists and is used by this error. */
  get isDomainError() {
    return true;
  }

  /** JSON-safe projection for HTTP responses / `--json` output. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      http: this.http,
      details: this.details,
      hint: this.hint,
    };
  }
}

/**
 * Is `value` one of ours? Cross-realm safe enough (checks the marker + code).
 * @param {unknown} value
 */
export function isDomainError(value) {
  return (
    value instanceof DomainError ||
    (typeof value === "object" &&
      value !== null &&
      value.name === "DomainError" &&
      typeof value.code === "string" &&
      Object.hasOwn(ERROR_CODES, value.code))
  );
}

/**
 * Normalise any thrown value into `{code, message, http, details, hint}`.
 * Never throws; unknown codes become `VALIDATION_FAILED` at 500.
 * @param {unknown} err
 */
export function toErrorPayload(err) {
  if (isDomainError(err)) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "VALIDATION_FAILED",
    message: redactText(message),
    http: 500,
    details: {},
    hint: null,
  };
}
