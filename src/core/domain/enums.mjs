/**
 * Enumerations — the single source of truth for every closed value set in the
 * domain, and the JS side of the SQL `CHECK (... IN (...))` parity contract.
 *
 * Cardinal rule: the card's statuses are canonical. The old
 * `task-interface v1` words `ready`/`failed` are gone — neither stored nor
 * accepted on any surface.
 *
 * This module is pure: no `node:` specifiers.
 */

// The 0.1.0 baseline declares both acceptance CHECKs in its CREATE TABLE bodies,
// so the SQL-parity reader sees them and the vocabulary must be declared below.
// `acceptance-mode.mjs` is pure and imports nothing from here.
import { CARD_ACCEPTANCE_MODES, PROJECT_ACCEPTANCES } from "./acceptance-mode.mjs";

/**
 * Canonical task statuses (F2 — the card's seven stage statuses, plus M1's
 * first-class `awaiting` overlay).
 *
 * The **first seven are the board's stage statuses, in board order** — they are
 * the column set, and `test/web/blocks.contract.mjs` freezes them as
 * `DOMAINS.STATUS`. `awaiting` (M1) is deliberately appended *after* them: it is
 * an **attention/overlay** state, not an eighth stage, so it must not appear as
 * an eighth column. A card that enters `awaiting` stays on its stage visually
 * (it is listed under `in_progress`); only the state machine and the human
 * payload read the word "awaiting".
 */
export const STATUSES = Object.freeze([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
  "awaiting",
]);

/** Named access to the canonical statuses. */
export const STATUS = Object.freeze({
  BACKLOG: "backlog",
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  BLOCKED: "blocked",
  DONE: "done",
  CANCELED: "canceled",
  AWAITING: "awaiting",
});

/**
 * Why a card needed a human (M1 · design §2.1). An **enumeration, never free
 * text** — `E1..E5` is the whole vocabulary:
 *
 *   E1 scope change · E2 acceptance-baseline change · E3 design/aesthetic
 *   direction · E4 security/data safety · E5 architecture direction.
 *
 * Entering `awaiting` must carry one of these (`awaiting_reason` on the task);
 * the *payload* the human reads is still the triggering human comment — these
 * codes name the category, they are not the question.
 */
export const AWAITING_REASONS = Object.freeze(["E1", "E2", "E3", "E4", "E5"]);

/**
 * Why a card is `blocked` — an enumeration, never free text. The value names
 * **who or what the block is waiting for**, which is the one thing `blocked_at`
 * (a timestamp) cannot say; it is not a severity and not an explanation, because
 * those are read from the comment trail.
 *
 * The vocabulary is `docs/sla.md` §6.1's, which both the board
 * and the two inspection mechanisms share — the board must not invent its own
 * spelling for a value the inspectors switch on:
 *
 *   * `clarify`        — the leader owes an answer to an ambiguous requirement;
 *   * `decision`       — a decision fork / gate sign-off is outstanding;
 *   * `dependency`     — a predecessor card or upstream artifact has not landed;
 *   * `out_of_bounds`  — handed back: the card is outside the worker's duties;
 *   * `defect`         — waiting on the defect loop;
 *   * `external`       — waiting on something outside the team (third-party
 *                        service, an operator input, a host resource);
 *   * `resource`       — waiting on capacity (host / model / concurrency);
 *   * `unknown`        — present, but not classified. This is a value a writer
 *                        may choose deliberately; it is **not** how an absent
 *                        reason is spelled (absence is NULL — see below).
 *
 * **Absent is a first-class state and is not a member of this list.** A card
 * blocked without a reason stays legal: the column is NULL, and a reader treats
 * it exactly as it treats `clarify` — absence never silences the block. `unknown`
 * exists so a writer can say "there is a block and I cannot classify it", which
 * is a different statement from saying nothing at all.
 *
 * The matching `CHECK` is added by 0016 by `ALTER TABLE … ADD COLUMN`, which the
 * SQL-parity reader does not see (it reads `CREATE TABLE` bodies), so
 * `tasks.blocked_reason` is deliberately **absent from `SQL_ENUM_SETS` below** —
 * declaring it there would report "declared in JS but no CHECK in SQL".
 * `test/contract/md-blocked-reason.test.mjs` closes that gap from the other side:
 * it reads 0016's text and asserts its literals are these, in this order.
 */
export const BLOCKED_REASONS = Object.freeze([
  "clarify",
  "decision",
  "dependency",
  "out_of_bounds",
  "defect",
  "external",
  "resource",
  "unknown",
]);

/** Task priorities, least → most urgent. */
export const PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const PRIORITY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
});

/**
 * Task kinds. Only `epic` may be a parent (see `domain/relation.mjs`) and only
 * `epic` is withheld from the automatic candidate read (see
 * `domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS`).
 *
 * 0038 retired `deploy` from the card model. Whether a card belongs to a
 * release line — and what confirming that means — is the loop's own decision;
 * a card that needs an independent gate says so with `acceptance_mode: agent`.
 */
export const TASK_KINDS = Object.freeze(["task", "epic"]);

/**
 * Named access to the kinds. Callers that mean "the grouping card" say
 * `TASK_KIND.EPIC` rather than indexing `TASK_KINDS` positionally, so adding a
 * kind cannot silently move a rule onto a different one.
 */
export const TASK_KIND = Object.freeze({
  TASK: "task",
  EPIC: "epic",
});

/** Relation types. */
export const RELATION_TYPES = Object.freeze(["parent", "blocks", "related"]);
export const RELATION_TYPE = Object.freeze({
  PARENT: "parent",
  BLOCKS: "blocks",
  RELATED: "related",
});

/** Comment kinds (§4.4 / card A4). */
export const COMMENT_KINDS = Object.freeze([
  "discuss",
  "decision",
  "confirm",
  // `confirm_request` is a *request*, not a decision: it opens a confirmation
  // gate (`docs/sla.md` §11). It is deliberately absent from DECISION_KINDS.
  "confirm_request",
  "change",
  "note",
  "defect",
  // 0034 — a worker's question. The `awaiting` payload is a `question` comment;
  // any human comment answers it. `decision` / `confirm` / `change`
  // (DECISION_KINDS) are the I5 record, not the resume gate.
  // Deliberately absent from DECISION_KINDS: asking is not deciding.
  "question",
]);

/**
 * **There is no actor-kind vocabulary.** An actor's kind is `human`, or the
 * platform an agent runs on (`claude`, `codex`, `pi`, …), or
 * whatever an actor kind calls itself — and `0018` already dropped the enumeration from
 * `comments.author_kind` and `task_reports.author_kind` for exactly that reason.
 *
 * What stood here instead was `ACTOR_KINDS = ["agent", "human", "system"]`, and
 * `DICT_KINDS = ["agent", "human"]` — a closed list re-imposed **in the app
 * layer** on top of the open column. That is not "being stricter than the
 * schema is safe"; it is a second answer to a question the schema had already
 * stopped asking, and it had two consequences worth naming:
 *
 *   * **A platform was unrepresentable.** `--actor-kind claude` was refused by
 *     the dictionary and rewritten to `human` at the server, so the board could
 *     not record *which* agent did the work — the one thing the kind is for.
 *   * **`agent` was not a kind either.** It is a *category* — "not the human" —
 *     and every decision the board makes from a kind is `kind === HUMAN_KIND`.
 *     A three-valued list therefore carried one bit and two ways to spell the
 *     other one.
 *
 * The one value with meaning is `HUMAN_KIND`. Everything else is an agent.
 */
export { HUMAN_KIND } from "../../foundation/constants.mjs";

/**
 * Is this usable as an actor kind? Anything non-blank.
 *
 * The app layer enforces this where the schema cannot: the column is
 * `TEXT NOT NULL`, which permits `""`, and an empty kind would read as neither
 * human nor any platform.
 *
 * @param {unknown} value
 */
export function isActorKind(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Dictionary tables that grow from usage (§4.4). */
export const DICTIONARY_KINDS = Object.freeze(["assignee", "reporter"]);

/** Per-acceptance-item status inside a report (§4.5). */
export const ACCEPTANCE_STATUSES = Object.freeze([
  "met",
  "partial",
  "not_met",
  "not_applicable",
]);

/** Evidence anchor kinds (§4.5 — bounded, structured only). */
export const EVIDENCE_KINDS = Object.freeze(["commit", "path", "command", "coverage"]);

/** Attachment kinds. */
export const ATTACHMENT_KINDS = Object.freeze(["inline", "attachment"]);

/**
 * `task_reports.is_rollup` (0033) — a 0/1 storage marker, not a word set. 0035
 * declares it in a `CREATE TABLE` body (the rebuild), so the SQL-parity reader
 * sees it; this is the JS side of that CHECK.
 */
export const REPORT_ROLLUP_MARKERS = Object.freeze([0, 1]);

/** Agent session lifecycle. */
export const SESSION_STATUSES = Object.freeze(["running", "closed", "failed"]);

/** Activity event names written to `task_activities`. */
export const ACTIVITY_EVENTS = Object.freeze([
  "project_created",
  "project_updated",
  "task_created",
  "task_updated",
  "task_claimed",
  "task_heartbeat",
  "task_moved",
  "task_reopened",
  // 0034 — a human comment answered an `awaiting` question and the board moved
  // the card back to `todo` in the same transaction.
  "task_resumed",
  "task_archived",
  "report_written",
  "task_delivered",
  "report_waived",
  // 0032 — the frozen acceptance baseline: a successful append, and the audited
  // prune a human performs with a reason.
  "acceptance_changed",
  "acceptance_pruned",
  // A card's acceptance mode was changed after creation (an agent tightening
  // it, or a human waiving a review with a reason). The card column is the
  // decision; this event is the audit trail for changing that decision.
  "acceptance_override",
  // The container's own start: a child entered the work and the board moved
  // its epic `todo → in_progress` (an automated move, never a claim).
  "epic_auto_start",
  "comment_added",
  "relation_added",
  "relation_removed",
  // The label GC's own audit row (§4.4: soft-delete + `task_activities`).
  "label_gc",
  "session_registered",
  "session_closed",
  "progress",
  // The attachment commands write their own rows: the activity stream is a
  // cursor over this table, and a `global_revision` bump alone produces no
  // frame.
  "attachment_added",
  "attachment_updated",
  "attachment_removed",
  // One row at the end of a whole-directory import. Per-card imports would
  // storm the stream; the counters are enough to make a client reload.
  "import_completed",
]);

/**
 * Declared words whose writer is gone (the markdown importer was removed).
 *
 * They stay in `ACTIVITY_EVENTS` so historical rows remain readable, and this
 * list is what keeps a second writer from appearing — see
 * `test/contract/activity-events.test.mjs`. Consumers must classify them, but
 * no surface should expect a new one.
 */
export const HISTORICAL_ACTIVITY_EVENTS = Object.freeze(["progress", "import_completed"]);

/**
 * `table.column` → allowed literals, as checked by the migration SQL. The
 * SQL-parity contract test compares this against the `CHECK (... IN (...))`
 * clauses it parses out of `migrations/*.sql`, both directions.
 *
 * **Two actor-kind columns are deliberately absent.** `0018` drops the
 * enumeration from `comments.author_kind` and `task_reports.author_kind`: an
 * actor's kind is an opaque string whose only reserved value is `human`, so
 * there is no literal list left for this table to declare. The app layer is
 * still free to validate a narrower set on its own write paths (`ACTOR_KINDS`
 * below), and being stricter than the schema is safe; what must not linger is a
 * *declaration* here, which the parity test would read as "declared in JS but no
 * CHECK in SQL". The baseline declares every CHECK in its `CREATE TABLE` bodies,
 * so the reader sees them all; `BLOCKED_REASONS` and the acceptance vocabularies
 * own the literals.
 */
export const SQL_ENUM_SETS = Object.freeze({
  "tasks.status": STATUSES,
  "tasks.awaiting_reason": AWAITING_REASONS,
  "tasks.priority": PRIORITIES,
  "tasks.kind": TASK_KINDS,
  "tasks.blocked_reason": BLOCKED_REASONS,
  "tasks.acceptance_mode": CARD_ACCEPTANCE_MODES,
  "projects.acceptance": PROJECT_ACCEPTANCES,
  "task_relations.relation_type": RELATION_TYPES,
  "comments.kind": COMMENT_KINDS,
  "attachments.kind": ATTACHMENT_KINDS,
  "agent_sessions.status": SESSION_STATUSES,
  "task_reports.is_rollup": REPORT_ROLLUP_MARKERS,
});
