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

/** Canonical task statuses (F2 — the card's seven). */
export const STATUSES = Object.freeze([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
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
});

/** Task priorities, least → most urgent. */
export const PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const PRIORITY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
});

/** Task kinds. Only `epic` may be a parent (see `domain/relation.mjs`). */
export const TASK_KINDS = Object.freeze(["task", "epic"]);

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
