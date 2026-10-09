/**
 * The wire vocabulary — core DTOs (camelCase) projected to the `--json` shape
 * (snake_case), exactly once (§F-C1).
 *
 * The card and `task-interface v1` both speak snake_case (`display_name`,
 * `created_at`, `delivery_round`), so the projection happens at the boundary and
 * nowhere else. It lives in `shared` because *both* surfaces need it: the server
 * to build a response, the CLI to render one — and neither may import the other.
 *
 * Pure: no `node:` specifiers, no clock, no database. The one thing a projection
 * cannot know by itself is what an id is *called*, so the caller passes a
 * `lookup(kind, id)`; when it is absent the id stands in for its own name, which
 * keeps the projection usable (and testable) without a board.
 */

/** Assignee/reporter ids are meaningless on their own; this is what resolves them. */
export const NO_LOOKUP = () => null;

/**
 * @param {string|null} id
 * @param {string} kind "assignee" | "reporter"
 * @param {(kind: string, id: string) => object|null} lookup
 * @param {string|null} [fallbackKind] the task's `assignee_kind` when the entry is gone
 */
function actorRef(id, kind, lookup, fallbackKind = null) {
  if (id === null || id === undefined || id === "") return null;
  const entry = lookup === undefined ? null : lookup(kind, id);
  return {
    id,
    display_name: entry?.displayName ?? id,
    kind: entry?.kind ?? fallbackKind ?? kind,
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
  reporter_id: "reporterId",
  creator_kind: "creatorKind",
  creator_id: "creatorId",
  agent_session: "agentSession",
  thread_id: "threadId",
  thread_source: "threadSource",
  claimed_by: "claimedBy",
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
});

/**
 * A task, as the CLI/HTTP surface shows it.
 *
 * @param {object} task a core Task DTO
 * @param {{lookup?: (kind: string, id: string) => object|null}} [options]
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
  out.assignee = actorRef(task.assigneeId, "assignee", lookup, task.assigneeKind);
  out.reporter = actorRef(task.reporterId, "reporter", lookup);
  out.report_waiver = waiverOf(task);
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
    workspace_path: project.workspacePath,
    labels: Array.isArray(project.labels) ? project.labels : [],
    meta: project.meta ?? {},
    readme: project.readme ?? null,
    archived_at: project.archivedAt ?? null,
    created_at: project.createdAt ?? null,
    updated_at: project.updatedAt ?? null,
  };
}

/** @param {object} comment a core Comment DTO */
export function commentToWire(comment) {
  if (comment === null || comment === undefined) return null;
  return {
    id: comment.id,
    task_id: comment.taskId,
    body: comment.body,
    kind: comment.kind,
    author_kind: comment.authorKind,
    author_id: comment.authorId,
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

/** @param {object} entry a dictionary entry (assignee or reporter) */
export function dictionaryEntryToWire(entry) {
  if (entry === null || entry === undefined) return null;
  return {
    id: entry.id,
    kind: entry.kind,
    display_name: entry.displayName,
    normalized_name: entry.normalizedName,
    platform: entry.platform ?? null,
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

/** @param {object} report a core Report DTO */
export function reportToWire(report) {
  if (report === null || report === undefined) return null;
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
    created_at: report.createdAt,
  };
}
