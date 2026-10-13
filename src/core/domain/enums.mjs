/**
 * Enumerations — the single source of truth for every closed value set in the
 * domain, and the JS side of the SQL `CHECK (... IN (...))` parity contract.
 *
 * Cardinal rule (F2 ruling): the card's seven states are canonical. The
 * `task-interface v1` words `ready`/`failed` are aliases only and are resolved
 * by `src/shared/status-alias.mjs` — never stored.
 *
 * This module is pure: no `node:` specifiers.
 */

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
 * The **stage** statuses — every canonical status except the `awaiting` overlay.
 * This is the board's column set; `awaiting` is never a member.
 */
export const STAGE_STATUSES = Object.freeze(STATUSES.filter((status) => status !== STATUS.AWAITING));

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

/** Task priorities, least → most urgent. */
export const PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const PRIORITY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
});

/**
 * Task kinds. Only `epic` may be a parent (see `domain/relation.mjs`), and
 * `deploy` is a **work card that no automatic read may offer** (see
 * `domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS`).
 *
 * `deploy` is the marker for a *deployment* card — work that runs against a live
 * instance rather than in the repository (rebuilding `dist`, restarting `taskd`,
 * a full `install.sh` run). It is a `kind` and not a label on purpose: `kind` is
 * the vocabulary the schema, the enum-parity contract and the claim rules all
 * already read, so the marker is checkable at every layer — exactly the shape
 * `epic` uses. It is **not** a third claimability rule: a `deploy` card stays
 * claimable by an explicit dispatch, it is only withheld from the *automatic*
 * candidate read (the difference from `epic`, which is never claimable at all).
 */
export const TASK_KINDS = Object.freeze(["task", "epic", "deploy"]);

/**
 * Named access to the kinds. Callers that mean "the grouping card" say
 * `TASK_KIND.EPIC` rather than indexing `TASK_KINDS` positionally, so adding a
 * kind cannot silently move a rule onto a different one.
 */
export const TASK_KIND = Object.freeze({
  TASK: "task",
  EPIC: "epic",
  DEPLOY: "deploy",
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
  "change",
  "note",
  "defect",
]);

/** Actor kinds — agents, humans, or the system itself. */
export const ACTOR_KINDS = Object.freeze(["agent", "human", "system"]);

/** Human-or-agent only (dictionary entries and task assignees). */
export const DICT_KINDS = Object.freeze(["agent", "human"]);

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

/** Agent session lifecycle. */
export const SESSION_STATUSES = Object.freeze(["running", "closed", "failed"]);

/** Activity event names written to `task_activities`. */
export const ACTIVITY_EVENTS = Object.freeze([
  "project_created",
  "task_created",
  "task_updated",
  "task_claimed",
  "task_heartbeat",
  "task_moved",
  "task_archived",
  "report_written",
  "task_delivered",
  "report_waived",
  "comment_added",
  "relation_added",
  "relation_removed",
  "dictionary_upsert",
  // The label GC's own audit row (§4.4: soft-delete + `task_activities`).
  "label_gc",
  "session_registered",
  "session_closed",
  "progress",
  "anomaly",
]);

/**
 * `table.column` → allowed literals, as checked by the migration SQL. The
 * SQL-parity contract test compares this against the `CHECK (... IN (...))`
 * clauses it parses out of `migrations/*.sql`, both directions.
 */
export const SQL_ENUM_SETS = Object.freeze({
  "tasks.status": STATUSES,
  "tasks.awaiting_reason": AWAITING_REASONS,
  "tasks.priority": PRIORITIES,
  "tasks.kind": TASK_KINDS,
  "tasks.assignee_kind": DICT_KINDS,
  "tasks.creator_kind": ACTOR_KINDS,
  "task_relations.relation_type": RELATION_TYPES,
  "comments.kind": COMMENT_KINDS,
  "comments.author_kind": ACTOR_KINDS,
  "attachments.kind": ATTACHMENT_KINDS,
  "agent_sessions.status": SESSION_STATUSES,
  "assignees.kind": DICT_KINDS,
  "reporters.kind": DICT_KINDS,
  "task_reports.author_kind": ACTOR_KINDS,
});
