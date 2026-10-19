/**
 * The wire vocabulary — core DTOs (camelCase) projected to the `--json` shape
 * (snake_case), exactly once (§F-C1).
 *
 * The card and `task-interface v1` both speak snake_case (`display_name`,
 * `created_at`, `delivery_round`), so the projection happens at the boundary and
 * nowhere else. It lives in `shared` because *both* surfaces need it: the server
 * to build a response, the CLI to render one — and neither may import the other.
 *
 * Pure: no clock, no database. The one thing a projection
 * cannot know by itself is what an id is *called*, so the caller passes a
 * `lookup(kind, id)`; when it is absent the id stands in for its own name, which
 * keeps the projection usable (and testable) without a board.
 */

import { projectPrefix } from "./ids.mjs";

/** Assignee/reporter ids are meaningless on their own; this is what resolves them. */
export const NO_LOOKUP = () => null;

/**
 * One actor reference: the id, the name it resolves to, and **the kind the
 * reference records**.
 *
 * The kind is the caller's, not the registry's, and that is `0023`'s whole
 * result: `actors` is one row per person, so it cannot hold a fact about an act
 * — which platform made *this* claim, wrote *this* comment. The registry is
 * asked only for the name, through the role-less read (`"actor"` names the one
 * table both roles now live in).
 *
 * `null` is a real answer: it means the reference recorded no kind (a claim made
 * before `0023`, or a row the backfill had no actor for). It is deliberately
 * *not* filled in from the registry — that would put the actor's own last-known
 * kind on an act it says nothing about.
 *
 * @param {string|null} id
 * @param {string|null} kind the kind the reference records
 * @param {(kind: string, id: string) => object|null} lookup
 */
function actorRef(id, kind, lookup) {
  if (id === null || id === undefined || id === "") return null;
  const entry = lookup === undefined ? null : lookup("actor", id);
  return {
    id,
    display_name: entry?.displayName ?? id,
    kind: kind ?? null,
  };
}

const COPY_TASK_FIELDS = Object.freeze({
  id: "id",
  identifier: "identifier",
  project_id: "projectId",
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  kind: "kind",
  sort_order: "sortOrder",
  assignee_id: "assigneeId",
  // 0023 — the kind each reference was made under. On the wire beside the id, so
  // a reader gets "who, and on what" from the scalar half of the pair too.
  assignee_kind: "assigneeKind",
  reporter_id: "reporterId",
  reporter_kind: "reporterKind",
  agent_session: "agentSession",
  thread_id: "threadId",
  thread_source: "threadSource",
  claimed_by: "claimedBy",
  claimed_kind: "claimedKind",
  claimed_at: "claimedAt",
  heartbeat_at: "heartbeatAt",
  blocked_at: "blockedAt",
  status_changed_at: "statusChangedAt",
  archived_at: "archivedAt",
  source_path: "sourcePath",
  report_latest_id: "reportLatestId",
  delivery_round: "deliveryRound",
  version: "version",
  created_at: "createdAt",
  updated_at: "updatedAt",
  // M1 — the `awaiting` entry category. `null` unless the card is waiting on a
  // human, so a client can read "is there a question, and of what kind" from
  // one field.
  awaiting_reason: "awaitingReason",
  // 0016 — a `blocked` card's class (SLA-inspection contract §7). `null` unless
  // a reason was written, so a client reads "is there a reason, and which" from
  // one field, exactly as it does for `awaiting_reason`.
  blocked_reason: "blockedReason",
  // 0025 — the structural review marker. `review_of_id` is an internal task id;
  // `review_round` is the delivery round the review audits (`null` = written
  // before the field existed, and conservatively covers every round). The
  // board's waiting projection derives "does this review still hold the
  // original open" from these, client-side, so the value is always current
  // even when only the review card's own event arrived.
  review_of_id: "reviewOfId",
  review_round: "reviewRound",
});

/**
 * A task, as the CLI/HTTP surface shows it.
 *
 * @param {object} task a core Task DTO
 * @param {{lookup?: (kind: string, id: string) => object|null, parentId?: string|null}} [options]
 */
export function taskToWire(task, options = {}) {
  const lookup = options.lookup ?? NO_LOOKUP;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [field, source] of Object.entries(COPY_TASK_FIELDS)) {
    out[field] = task[source] === undefined ? null : task[source];
  }
  out.labels = Array.isArray(task.labels) ? task.labels : [];
  out.meta = task.meta ?? {};
  out.assignee = actorRef(task.assigneeId, task.assigneeKind, lookup);
  out.reporter = actorRef(task.reporterId, task.reporterKind, lookup);
  // `claimed_by` is an actor **id** since 0020 (the execution lock's holder),
  // exactly like `assignee_id`/`reporter_id`. It keeps its scalar field — a
  // client that keys on the id still has one — and gains a companion ref so a
  // consumer can render the holder's name without a second request, the way it
  // already reads `assignee.display_name`. The ref sits *beside* the id: the
  // scalar is not replaced, so nothing that read `claimed_by` breaks. It is
  // named `claimed_by_actor` (not a bare role word like `assignee`) because
  // `claimed_by` already occupies the role word, and the suffix keeps the pair
  // adjacent — same shape as `assignee`/`reporter`, one name apart.
  out.claimed_by_actor = actorRef(task.claimedBy, task.claimedKind, lookup);
  out.report_waiver = waiverOf(task);
  // The parent edge is a relation, not a column, so the caller supplies it (a
  // list read batches the edges; a single read asks `getParent`). `null` means
  // "no parent" — and also "the caller did not ask", which is the same answer
  // for every projection that does not read it.
  out.parent_id = options.parentId ?? null;
  return out;
}

/** The waiver recorded on the row itself, or `null`. */
export function waiverOf(task) {
  if (task?.reportWaiverRound === null || task?.reportWaiverRound === undefined) return null;
  return {
    round: Number(task.reportWaiverRound),
    reason: task.reportWaiverReason ?? "",
    waived_at: task.reportWaivedAt ?? null,
  };
}

/**
 * Every waiver ever recorded, read from the audit trail — what a reviewer looks
 * at when asking "was this delivered without a report?".
 *
 * @param {object[]} activities rows from `task_activities`
 */
export function waiversFromActivities(activities) {
  return (Array.isArray(activities) ? activities : [])
    .filter((activity) => activity?.event === "report_waived")
    .map((activity) => ({
      round: Number(activity.changes?.round ?? 0),
      reason: String(activity.changes?.reason ?? ""),
      waived_at: activity.createdAt ?? null,
      actor_id: activity.actorId ?? null,
    }));
}

/** @param {object} project a core Project DTO */
export function projectToWire(project) {
  if (project === null || project === undefined) return null;
  return {
    id: project.id,
    name: project.name,
    // C-RAIL-1 §4 R-W1 — the project's **effective prefix**, read-only, served so
    // the sidebar rail can show the same token every card of the project is
    // numbered with (`TD-0001` ⇒ rail chip `TD`). It is the *derived* value, not
    // `meta.prefix` verbatim: a project created before the prefix slot existed is
    // numbered from its id, and the browser cannot reproduce that ((web/ and
    // src/ are two builds with no import between them, C-PREFIX-1 §4). The
    // derivation is `projectPrefix` — the same one the counter reads, so the
    // chip and the identifier cannot disagree (C-RAIL-1 §3.1 M2: one derivation,
    // server-side). It is deliberately **not** in the PATCH declaration
    // (C-RAIL-1 §4 R-W2): a prefix is fixed at creation.
    prefix: projectPrefix(project),
    labels: Array.isArray(project.labels) ? project.labels : [],
    meta: project.meta ?? {},
    readme: project.readme ?? null,
    // The sidebar badge's number (design/BLOCKS.md §Projects): the project's
    // **total** task count, served with the list and independent of the order.
    // `null` when the caller did not supply it — this projection counts nothing
    // itself, so a local `taskctl project` read (no board query behind it)
    // reports "not asked for" rather than a fabricated 0.
    task_count: Number.isInteger(project.taskCount) ? project.taskCount : null,
    archived_at: project.archivedAt ?? null,
    created_at: project.createdAt ?? null,
    updated_at: project.updatedAt ?? null,
  };
}

/**
 * @param {object} comment a core Comment DTO
 * @param {{lookup?: (kind: string, id: string) => object|null}} [options]
 *
 * `author_id` is an actor **id** since 0020 (the column is `REFERENCES
 * actors(id)`); `author` is the companion ref that carries the readable
 * `display_name` beside it, so a reader of a comment can name its author without
 * a second request. `author_kind` stays: it is the **append-only column's own
 * record** of the kind the write claimed, which is a different fact from the
 * `actors` row's *current* kind the ref resolves (the dictionary's kind wins on
 * reuse — see `dictionary.mjs#upsert`), so dropping it would lose history.
 */
export function commentToWire(comment, options = {}) {
  if (comment === null || comment === undefined) return null;
  const lookup = options.lookup ?? NO_LOOKUP;
  return {
    id: comment.id,
    task_id: comment.taskId,
    body: comment.body,
    kind: comment.kind,
    author_kind: comment.authorKind,
    author_id: comment.authorId,
    // The comment's own `author_kind` — which platform wrote it — not a role
    // word and not the registry's: a comment is an act, and this is the column
    // that recorded what kind of thing performed it.
    author: actorRef(comment.authorId, comment.authorKind, lookup),
    agent_session: comment.agentSession ?? null,
    refs: comment.refs ?? [],
    version: comment.version,
    created_at: comment.createdAt,
  };
}

/** @param {object} relation a core Relation DTO */
export function relationToWire(relation) {
  if (relation === null || relation === undefined) return null;
  return {
    id: relation.id,
    type: relation.type,
    source: relation.source,
    target: relation.target,
    origin: relation.origin ?? null,
    created_at: relation.createdAt,
  };
}

/**
 * @param {object} attachment a core Attachment DTO
 *
 * `has_content` is deliberately **not** here: whether bytes are stored is a
 * `stat` on the daemon's own filesystem, and a listing that claimed it would be
 * guessing. The download path answers it truthfully on the one request that
 * needs it (a 404 for a row with no bytes — §13's reserved surface).
 */
export function attachmentToWire(attachment) {
  if (attachment === null || attachment === undefined) return null;
  return {
    id: attachment.id,
    task_id: attachment.taskId,
    comment_id: attachment.commentId ?? null,
    filename: attachment.filename,
    content_type: attachment.contentType ?? null,
    size: attachment.size ?? 0,
    kind: attachment.kind,
    created_at: attachment.createdAt,
  };
}

/** @param {object} session a core AgentSession DTO */
export function sessionToWire(session) {
  if (session === null || session === undefined) return null;
  return {
    id: session.id,
    task_id: session.taskId,
    seg: session.seg,
    owner: session.owner,
    backend: session.backend,
    session_id: session.sessionId,
    phase: session.phase ?? null,
    pid: session.pid ?? null,
    status: session.status,
    ts: session.ts,
  };
}

/** @param {object} entry an actor dictionary entry */
export function dictionaryEntryToWire(entry) {
  if (entry === null || entry === undefined) return null;
  return {
    id: entry.id,
    kind: entry.kind,
    display_name: entry.displayName,
    normalized_name: entry.normalizedName,
    first_seen_at: entry.firstSeenAt,
    last_seen_at: entry.lastSeenAt,
    use_count: entry.useCount,
  };
}

/**
 * @param {object} activity a core Activity DTO (a `task_activities` row)
 *
 * The audit trail is the raw material both the board's SSE stream (§5.4) and the
 * `GET /tasks/:id/activities` route hand out, so the projection is shared the
 * same way every other DTO's is.
 */
export function activityToWire(activity) {
  if (activity === null || activity === undefined) return null;
  return {
    id: activity.id,
    task_id: activity.taskId ?? null,
    actor_kind: activity.actorKind ?? null,
    actor_id: activity.actorId ?? null,
    event: activity.event,
    changes: activity.changes ?? {},
    revision: activity.revision,
    created_at: activity.createdAt,
  };
}

/** @param {object} label a core Label DTO */
export function labelToWire(label) {
  if (label === null || label === undefined) return null;
  return {
    id: label.id,
    project_id: label.projectId,
    norm: label.norm,
    display_name: label.displayName,
    color: label.color,
    use_count: label.useCount,
    first_seen_at: label.firstSeenAt,
    last_seen_at: label.lastSeenAt,
    archived_at: label.archivedAt ?? null,
  };
}

/**
 * @param {object} report a core Report DTO
 * @param {{lookup?: (kind: string, id: string) => object|null}} [options]
 *
 * Same attribution shape as a comment: `author_id` is an actor id since 0020,
 * `author` is the companion ref (see `commentToWire` for why `author_kind`
 * stays).
 */
export function reportToWire(report, options = {}) {
  if (report === null || report === undefined) return null;
  const lookup = options.lookup ?? NO_LOOKUP;
  const evidence = report.evidence?.items ?? report.evidence ?? [];
  return {
    id: report.id,
    task_id: report.taskId,
    round: report.round,
    seg: report.seg ?? null,
    session_id: report.sessionId ?? null,
    conclusion: report.conclusion,
    acceptance: report.acceptance ?? [],
    evidence,
    evidence_truncated: report.evidence?.truncated === true || report.truncated === true,
    leftovers: report.leftovers ?? null,
    author_kind: report.authorKind,
    author_id: report.authorId,
    // As with a comment: the report's own `author_kind`.
    author: actorRef(report.authorId, report.authorKind, lookup),
    created_at: report.createdAt,
  };
}
