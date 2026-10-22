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
  // ---- Acceptance baseline (0032) -------------------------------------------
  // The card's frozen baseline is the thing a delivery report is evidence
  // against. `ACCEPTANCE_INCOMPLETE` is the report-exists-but-does-not-cover
  // case; `ACCEPTANCE_UNVERIFIED` is "no current-round report at all" (a waived
  // delivery is not acceptance evidence).
  ACCEPTANCE_INCOMPLETE: spec(409, "The current-round report does not cover every acceptance criterion."),
  ACCEPTANCE_UNVERIFIED: spec(409, "This card has an acceptance baseline but no current-round delivery report."),
  ACCEPTANCE_STALE_REVISION: spec(409, "Acceptance revision changed — re-read the card and retry."),
  ACCEPTANCE_PRUNE_FORBIDDEN: spec(409, "Only a human may remove an acceptance criterion."),
  ACCEPTANCE_LOCKED: spec(409, "The acceptance baseline is frozen while the card is in review or terminal."),
  // Raised by 0032's triggers as well as by the command layer: a rewrite must
  // advance `acceptance_revision`, and a shrink needs an audited reason.
  ACCEPTANCE_SNAPSHOT_IMMUTABLE: spec(409, "The acceptance baseline can only grow; a prune needs an audited reason."),
  // Raised by `validateReport` and by 0032's report trigger.
  REPORT_NOT_APPLICABLE_NOTE: spec(422, "A not_applicable acceptance item needs a note saying why."),
  // ---- Epic rollups (0033) --------------------------------------------------
  // An epic's delivery is a rollup over its children, not a summary written
  // beside them. The row is marked `is_rollup=1`; `ROLLUP_REQUIRED` is both the
  // delivery-gate refusal and the DB trigger's done guard.
  ROLLUP_REQUIRED: spec(409, "An epic needs a current-round rollup report before it can be delivered or accepted."),
  ROLLUP_INVALID: spec(409, "Only a delivery report on an epic can carry the rollup marker."),
  ROLLUP_STALE: spec(409, "The rollup no longer matches the epic's children."),

  // ---- Questions (0034) ------------------------------------------------------
  // An agent may only enter `awaiting` with something to wait on: a `--question`
  // (written as a `question` comment) or an earlier unanswered one. A human may
  // park a card silently; the state's payload promise is about workers.
  QUESTION_REQUIRED: spec(422, "Entering awaiting needs a question (or an earlier unanswered one)."),

  // ---- Task state machine + lifecycle ---------------------------------------
  INVALID_TRANSITION: spec(409, "Status transition is not allowed."),
  // Acceptance authority: `done` is a human's or the board's act, never a worker
  // agent's — including on its own card. Raised in the service layer because the
  // actor is not a column of the `tasks` row (see `domain/status.mjs`).
  ACCEPTANCE_FORBIDDEN: spec(409, "Only a human or the board itself may accept a delivery to done.", {
    fix:
      "a worker stops at in_review; an independent reviewer reports a verdict and the loop " +
      "(or a human) applies it",
  }),
  // The card's structural review marker (`review_of_id` / `review_round`, 0025) is
  // set once, at creation, and never rewritten — the review-card exemption is a
  // privilege, so it must not be obtainable by editing a card afterwards.
  REVIEW_OF_IMMUTABLE: spec(409, "A card's review marker is set at creation and cannot be changed."),
  // A human closing a top-level card before the review cards for its current
  // delivery round have resolved. `canceled` counts as resolved (an abandoned
  // review must not deadlock the original).
  REVIEW_PENDING: spec(
    409,
    "This card still has an open review for its current delivery round; close or cancel it first.",
  ),
  // The card's own review_required snapshot says it needs an independent review,
  // but no approving review exists for the current round. Raised by the service
  // layer *and* (coarsely, as "a review card exists") by migration 0031's
  // trigger; see `0031_review_policy.sql`.
  REVIEW_REQUIRED: spec(409, "This card requires an approved review for its current delivery round.", {
    fix:
      "let the loop dispatch a review, or a human may waive the requirement: " +
      'taskctl issue update <ref> --review no --reason "<why>"',
  }),
  // A review card is flow B. Marking it as needing its own review would create an
  // endless chain; the column is forced to 0 by the resolver and the trigger.
  REVIEW_CARD_MARKER_INVALID: spec(
    409,
    "A review card can never be marked as requiring its own review.",
  ),
  // A card may not enter `in_review`/`done` while one of its children is still
  // in flight. Manual and automatic paths apply the same rule.
  CHILDREN_OPEN: spec(409, "This card still has non-terminal child cards."),
  TERMINAL_STATE: spec(409, "done/canceled are terminal; they may only be reopened to todo."),
  VERSION_CONFLICT: spec(409, "Version conflict — re-read the task and retry once."),
  CLAIM_LOST: spec(409, "Claim could not be taken: the task was taken concurrently."),
  EXECUTION_ACTIVE: spec(409, "Another actor holds a fresh claim on this task."),
  EXECUTION_STATE_CORRUPT: spec(500, "in_progress without claimed_by — state is corrupt."),
  ARCHIVE_NOT_TERMINAL: spec(409, "Only done/canceled tasks may be archived."),
  // The execution-side routing lock (T-20261009-230500-claimassignee): a card
  // routed to an assignee is claimable only by that assignee, unless the audited
  // `--allow-steal --reason` escape hatch is taken.
  not_assignee: spec(
    409,
    "This task is assigned to somebody else; only the assignee may claim it.",
    { fix: 'taskctl issue move <ref> in_progress --allow-steal --reason "<why>"' },
  ),
  // An epic is a grouping card: it carries no work, so nothing may claim it.
  not_claimable: spec(409, "Epics are grouping cards and cannot be claimed."),

  // ---- Creation idempotency (T-20261009-175500-idem-meerkat-taskpanel) ---------------
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

  // ---- Project directories (host-local map) ---------------------------------
  // The board holds no directory (O3), so "which directory does work for this
  // project happen in?" is answered on the host, by `projects.json`, and
  // *checked* before it is used. These codes say why a directory could not be
  // used; every one of them stops the caller — the alternative is a worker
  // running in the wrong checkout, which is worse than not starting one. (An
  // entry that names no directory at all is not one of these: that is the
  // complete answer "this project has no local directory".)
  PROJECT_MAP_UNREADABLE: spec(422, "The local project map (projects.json) is missing or malformed."),
  PROJECT_DIR_UNMAPPED: spec(422, "No local directory is registered for this project."),
  PROJECT_DIR_REQUIRED: spec(422, "The project map entry carries no usable directory."),
  PROJECT_DIR_NOT_ABSOLUTE: spec(422, "The project directory is not an absolute path."),
  PROJECT_DIR_MISSING: spec(422, "The project directory does not exist."),
  PROJECT_DIR_NOT_A_DIRECTORY: spec(422, "The project directory is not a directory."),

  // ---- Persistence / migrations ---------------------------------------------
  // `DB_BUSY` (R2): SQLite's `SQLITE_BUSY`/`SQLITE_LOCKED` after a bounded
  // retry budget. It is *contention*, not a defect: the write is safe to repeat,
  // which is why it is a 503 with `Retry-After` and not the 500 a generic
  // `VALIDATION_FAILED` would produce.
  DB_BUSY: spec(503, "The database is locked by another writer; the write was not applied — retry.", {
    retryAfterSeconds: 1,
  }),
  MIGRATION_CHECKSUM_MISMATCH: spec(500, "A migration file changed after it was applied; migrations are append-only."),
  SCHEMA_MISMATCH: spec(500, "Database schema is not at the expected migration version."),
  SQLITE_UNAVAILABLE: spec(500, "node:sqlite is unavailable in this Node runtime."),
  // R1: one `taskd` owns a data directory. A second instance is refused rather
  // than allowed to fight over the runtime pointer.
  BOARD_ALREADY_RUNNING: spec(409, "Another taskd already owns this data directory.", {
    fix: "stop the running taskd (SIGTERM), or point TASKD_DATA_DIR at another directory",
  }),
  VALIDATION_FAILED: spec(400, "Input failed validation."),
  ID_CONFLICT: spec(409, "Record already exists."),
  // The `tasks` table's own CHECK: `claimed_by IS NULL OR status <> 'backlog'`.
  // The service releases the claim on every move out of the work cycle
  // (`domain/status.mjs#CLAIM_HOLDING_STATUSES`), so this is a **defensive**
  // mapping — the path that used to reach it (`in_progress → todo` leaving
  // `claimed_by` behind, then `todo → backlog`) no longer exists. It is mapped
  // rather than left to the `VALIDATION_FAILED` fallback so a state that can
  // only come from a foreign writer (a hand-written row, an md import) names
  // itself instead of going out as "Input failed validation."
  CLAIM_ON_BACKLOG: spec(409, "A backlog task cannot hold a claim."),
  IDENTIFIER_CONFLICT: spec(409, "Identifier already exists in this project."),
  SESSION_DUPLICATE: spec(409, "Agent session already registered for (task, seg, owner)."),
  NOT_FOUND: spec(404, "Not found."),

  // ---- Attachments (the write surface, T-20261014-212017-4) ------------------
  // The two refusals the upload path can decide on its own. `content_type` used
  // to be whatever the caller sent and was served back from the board's own
  // origin; it is now a closed set (`ATTACHMENT_CONTENT_TYPES`) and a type
  // outside it names itself here. The size limit is the board's
  // (`ATTACHMENT_MAX_BYTES`, 64 MiB); the code is what a client branches on when
  // the refusal has to be stated as a sentence (T-20261014-152924 ④).
  ATTACHMENT_TYPE_UNSUPPORTED: spec(422, "That file type is not allowed on the board."),
  ATTACHMENT_TOO_LARGE: spec(413, "That file is larger than the board's 64 MiB attachment limit."),

  // ---- markdown cards ---------------------------------------------------------
  MD_PARSE_ERROR: spec(422, "Markdown card could not be parsed."),
  MD_GROWTH_GUARD: spec(422, "Rewriting this card would grow it beyond the guard factor."),

  // ---- Secrets ---------------------------------------------------------------
  TOKEN_FILE_CORRUPT: spec(500, "Token file exists but is malformed; fix it by hand."),
  RUNTIME_POINTER_TOKEN_LEAK: spec(500, "Refusing to write a runtime pointer that contains a token."),
  // The access policy's config file (the install-root `.env`): written by the
  // Access panel, read by `taskd` at start-up. A malformed or unwritable file is
  // a server-side fault, not a bad request — the panel validates before writing.
  ACCESS_CONFIG_INVALID: spec(500, "Access configuration is malformed or could not be written."),
  // The client/server config file itself: unreadable, malformed, an unknown key
  // in our namespace, both token keys, or a bad URL/port. A bad *value* the
  // server owns (a CIDR, an acceptance policy) keeps ACCESS_CONFIG_INVALID.
  CONFIG_FILE_INVALID: spec(400, "The configuration file is malformed or could not be read."),
  CONFIG_FILE_INSECURE: spec(400, "The configuration file contains a secret but is accessible by other users."),

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
  // 0025 / 0026
  "REVIEW_OF_IMMUTABLE",
  "CHILDREN_OPEN",
  // 0031 — the review-required done gate and the review-card marker invariant.
  "REVIEW_REQUIRED",
  "REVIEW_CARD_MARKER_INVALID",
  // 0032 — the frozen acceptance baseline and the not_applicable note.
  "ACCEPTANCE_SNAPSHOT_IMMUTABLE",
  "REPORT_NOT_APPLICABLE_NOTE",
  // 0033 — the rollup marker and the epic done guard.
  "ROLLUP_REQUIRED",
  "ROLLUP_INVALID",
]);

/** Codes produced by mapping SQLite failures (constraints, and lock contention). */
export const SQL_CONSTRAINT_CODES = Object.freeze([
  "IDEM_EXISTS",
  "SINGLE_PARENT_VIOLATION",
  "RELATION_DUPLICATE",
  "RELATION_DIRECTION_INVALID",
  "COMMENT_DUPLICATE",
  "IDENTIFIER_CONFLICT",
  "ID_CONFLICT",
  "CLAIM_ON_BACKLOG",
  "SESSION_DUPLICATE",
  "DICTIONARY_CONFLICT",
  "LABEL_CONFLICT",
  // Not a constraint failure, but the same seam: `mapSqliteError` turns
  // `SQLITE_BUSY`/`SQLITE_LOCKED` into it (see `storage/sqlite-errors.mjs`).
  "DB_BUSY",
  "VALIDATION_FAILED",
  "NOT_FOUND",
]);

/** Codes raised purely by domain/command logic. */
export const JS_ONLY_CODES = Object.freeze([
  "REPORT_INVALID",
  "REPORT_TOO_LARGE",
  // Acceptance authority reads the *actor*, which is not a row fact a trigger
  // can see — so this one is enforced only by the service layer.
  "ACCEPTANCE_FORBIDDEN",
  // The review-ready check is the same kind of fact (it combines the actor, the
  // policy and the review cards' current state), and the loop's own protocol is
  // exempt from it by design.
  "REVIEW_PENDING",
  // 0032 — the coverage gate combines the task's baseline with a report body;
  // the revision CAS and the human-only prune rule are service-layer facts.
  "ACCEPTANCE_INCOMPLETE",
  "ACCEPTANCE_UNVERIFIED",
  "ACCEPTANCE_STALE_REVISION",
  "ACCEPTANCE_PRUNE_FORBIDDEN",
  "ACCEPTANCE_LOCKED",
  // 0033 — staleness compares the report's `ref` set with the live children,
  // which a trigger cannot do without duplicating the rollup's own rules.
  "ROLLUP_STALE",
  // 0034 — "a question is owed" reads the actor and the comment trail.
  "QUESTION_REQUIRED",
  "REPORT_ROUND_MISMATCH",
  "VERSION_CONFLICT",
  "CLAIM_LOST",
  "EXECUTION_ACTIVE",
  "EXECUTION_STATE_CORRUPT",
  "not_assignee",
  "not_claimable",
  "DICTIONARY_AMBIGUOUS",
  "DICTIONARY_INVALID",
  "MIGRATION_CHECKSUM_MISMATCH",
  "SCHEMA_MISMATCH",
  "SQLITE_UNAVAILABLE",
  "MD_PARSE_ERROR",
  "MD_GROWTH_GUARD",
  // Attachments: both are decided by `src/foundation/attachments.mjs` before any
  // row exists, so no trigger and no SQLite constraint can raise them.
  "ATTACHMENT_TYPE_UNSUPPORTED",
  "ATTACHMENT_TOO_LARGE",
  "TOKEN_FILE_CORRUPT",
  "RUNTIME_POINTER_TOKEN_LEAK",
  "ACCESS_CONFIG_INVALID",
  "CONFIG_FILE_INVALID",
  "CONFIG_FILE_INSECURE",
  // The single-writer guard: raised in JS, before any database is opened.
  "BOARD_ALREADY_RUNNING",
  // Project directories: read from a host-local JSON file, never from a table,
  // a trigger or a SQLite constraint.
  "PROJECT_MAP_UNREADABLE",
  "PROJECT_DIR_UNMAPPED",
  "PROJECT_DIR_REQUIRED",
  "PROJECT_DIR_NOT_ABSOLUTE",
  "PROJECT_DIR_MISSING",
  "PROJECT_DIR_NOT_A_DIRECTORY",
  // CLI-only: no database trigger and no SQLite constraint can raise these.
  "CLI_USAGE",
  "CLI_IO",
]);

/**
 * The storage engine's own vocabulary — the strings that describe SQLite to a
 * programmer and mean nothing to a reader of the board.
 *
 * This is the *shape* of a leak, not a list of messages: it matches the four
 * families SQLite prints for a refused write (`CHECK`/`NOT NULL`/`UNIQUE`/
 * `FOREIGN KEY` constraint failures) plus the engine's own name. A message that
 * matches it is replaced by the sentence its `code` carries
 * (`safeMessage` below); the raw text stays available on the error's `details`
 * (`details.sqlite.message`, the server-side log surface) so nothing is lost
 * for debugging. T-20261014-152924: the UI used to render
 * `CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` verbatim.
 */
export const TECHNICAL_ERROR_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;

/**
 * The sentence this error may show a reader.
 *
 * A `code` is the machine-readable half of a failure and the only half a client
 * is allowed to branch on, so the message is free to be replaced: if the
 * message is missing, empty, or engine text, the code's own sentence is used
 * instead. Anything else is the caller's own words and is passed through.
 *
 * @param {string} code
 * @param {unknown} message
 * @returns {string}
 */
export function safeMessage(code, message) {
  const entry = ERROR_CODES[code];
  if (entry === undefined) return typeof message === "string" ? message : ""; // not ours to rewrite
  if (typeof message !== "string" || message.trim() === "") return entry.message;
  return TECHNICAL_ERROR_TEXT.test(message) ? entry.message : message;
}

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
    // The single chokepoint for "a reader never sees engine text": whatever a
    // caller passes, the message that survives is one a person can read.
    super(redactText(safeMessage(code, message ?? entry.message)));
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
 *
 * This is the envelope every HTTP error body is built from (`server/router.mjs`
 * `errorResponse`), so the message is re-checked here as well as at construction
 * (T-20261014-152924, acceptance ③): a payload that did not come through this
 * module's `DomainError` — a foreign object wearing the same shape, or one built
 * before this guard existed — must not put engine text on the wire either.
 *
 * @param {unknown} err
 */
export function toErrorPayload(err) {
  if (isDomainError(err)) {
    const payload = err.toJSON();
    return { ...payload, message: redactText(safeMessage(payload.code, payload.message)) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "VALIDATION_FAILED",
    message: redactText(safeMessage("VALIDATION_FAILED", message)),
    http: 500,
    details: {},
    hint: null,
  };
}
