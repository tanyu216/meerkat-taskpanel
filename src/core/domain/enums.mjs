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
 * The vocabulary is the SLA-inspection contract's (`§7`), which both the board
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

/**
 * **There is no actor-kind vocabulary.** An actor's kind is `human`, or the
 * platform an agent runs on (`claude`, `codex`, `pi`, `opencode`, …), or
 * whatever a host calls itself — and `0018` already dropped the enumeration from
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

/** Agent session lifecycle. */
export const SESSION_STATUSES = Object.freeze(["running", "closed", "failed"]);

/**
 * Who wrote a report (0008). The delivery path writes `delivery`; the markdown
 * importer writes `import`, because an imported narrative is history and must
 * never satisfy the delivery gate.
 *
 * Declared here for the first time by `0018`: the constraint was added by
 * `ALTER TABLE … ADD COLUMN`, which the SQL-parity reader does not see, so the
 * value set had no JS side to be compared against. `0018` rebuilds the table and
 * the constraint moves into a `CREATE TABLE` body — where the reader *does* see
 * it, and would report it as "a CHECK in SQL that nothing declares" if this were
 * not here.
 */
export const REPORT_ORIGINS = Object.freeze(["delivery", "import"]);

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
  "task_archived",
  "report_written",
  "task_delivered",
  "report_waived",
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
  // The attachment surface writes through its own routes, so its changes need
  // their own rows: the activity stream is a cursor over this table, and a
  // `global_revision` bump alone produces no frame.
  "attachment_added",
  "attachment_updated",
  "attachment_removed",
  // One row at the end of a whole-directory import. Per-card imports would
  // storm the stream; the counters are enough to make a client reload.
  "import_completed",
]);

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
 * CHECK in SQL".
 * `test/core/storage/migrations-0018.test.mjs` closes that gap from the other
 * side: it reads `0018`'s text and asserts both columns really are open.
 */
export const SQL_ENUM_SETS = Object.freeze({
  "tasks.status": STATUSES,
  "tasks.awaiting_reason": AWAITING_REASONS,
  "tasks.priority": PRIORITIES,
  "tasks.kind": TASK_KINDS,
  // `0019` rebuilds `tasks` and moves `blocked_reason`'s `CHECK` (0016, added by
  // `ALTER TABLE … ADD COLUMN`, invisible to the SQL-parity reader) into the
  // `CREATE TABLE` body, where the reader *does* see it. Declaring its literals
  // here is what keeps the two sides paired — exactly the `0018`/`REPORT_ORIGINS`
  // precedent. `BLOCKED_REASONS` above owns the vocabulary.
  "tasks.blocked_reason": BLOCKED_REASONS,
  "task_relations.relation_type": RELATION_TYPES,
  "comments.kind": COMMENT_KINDS,
  "attachments.kind": ATTACHMENT_KINDS,
  "agent_sessions.status": SESSION_STATUSES,
  "task_reports.origin": REPORT_ORIGINS,
});
