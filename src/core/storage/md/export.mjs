/**
 * SQLite → md, reversibly.
 *
 * The export is the *canonical* card: a fixed key order and a fixed section
 * order, so an exported card is byte-identical no matter what the input looked
 * like. Two things are deliberately preserved from the input rather than
 * canonicalised:
 *
 *   * the legacy status word (`ready`/`failed`) — the author's own spelling;
 *   * unrecognised frontmatter keys, in their original order (`meta_json.legacy`).
 *
 * Rewriting a card may not grow it without bound: if the new text is more than
 * `MD_GROWTH_FACTOR` times the old one, the export refuses instead of writing
 * (`MD_GROWTH_GUARD`). That guard is the whole reason the frontmatter serialiser
 * only ever emits syntax the parser accepts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MD_GROWTH_FACTOR } from "../../../shared/constants.mjs";
import { DomainError } from "../../../shared/errors.mjs";
import { serializeFrontmatter } from "./frontmatter.mjs";
import { statusForExport } from "./legacy-status.mjs";
import {
  joinSections,
  renderAcceptanceBlock,
  renderCommentsBlock,
  renderProgressBlock,
  renderReportBlock,
  renderSessionsBlock,
  splitProgressLine,
} from "./sections.mjs";

/** Frontmatter key order for an exported card. */
export const CARD_KEY_ORDER = Object.freeze([
  "id",
  "title",
  "assignee",
  "status",
  "priority",
  "kind",
  "labels",
  "project",
  "target",
  "created_by",
  "created_at",
  "updated_at",
  "status_changed_at",
  "claimed_by",
  "claimed_at",
  "heartbeat_at",
  "blocked_at",
  "depends_on",
  "parent",
  "notify_elon",
]);

/**
 * @param {{repos: object, projectId?: string, outDir: string, now: string, dryRun?: boolean}} input
 */
export function exportMd(input) {
  const { repos, outDir, dryRun = false } = input;
  const tasks = repos.tasks.list({
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    includeArchived: true,
    limit: 10_000,
  });

  if (!dryRun) mkdirSync(outDir, { recursive: true });

  const files = [];
  for (const task of tasks) {
    const project = repos.projects.get(task.projectId);
    const content = renderCard(task, { repos, project });
    const path = join(outDir, `${task.identifier}.md`);

    if (existsSync(path)) {
      const previous = readFileSync(path, "utf8");
      if (previous.length > 0 && content.length > previous.length * MD_GROWTH_FACTOR) {
        throw new DomainError("MD_GROWTH_GUARD", {
          message: `${task.identifier}: rewriting this card would grow it ${(content.length / previous.length).toFixed(1)}× (limit ${MD_GROWTH_FACTOR}×)`,
          details: { identifier: task.identifier, before: previous.length, after: content.length },
          hint: { fix: "the frontmatter serialiser should never grow a card — inspect it before overwriting" },
        });
      }
    }

    if (!dryRun) writeFileSync(path, content, "utf8");
    files.push({ identifier: task.identifier, taskId: task.id, path, bytes: content.length, content });
  }

  return { files, outDir, count: files.length };
}

/**
 * Render one card.
 *
 * @param {object} task a Task DTO
 * @param {{repos: object, project: object|null}} context
 * @returns {string}
 */
export function renderCard(task, context) {
  const { repos, project } = context;
  const meta = decodeMeta(task);
  const legacyStatus = meta.legacy_status ?? null;

  const data = {
    id: task.identifier,
    title: task.title,
    assignee: labelOf(repos, "assignee", task.assigneeId) ?? "",
    status: statusForExport(task.status, legacyStatus),
    priority: task.priority,
    kind: task.kind,
    project: task.projectId,
    target: project?.workspacePath ?? "",
    created_by: labelOf(repos, "reporter", task.reporterId) ?? task.creatorId ?? "",
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    status_changed_at: task.statusChangedAt,
    claimed_by: task.claimedBy ?? "",
    claimed_at: task.claimedAt ?? "",
    heartbeat_at: task.heartbeatAt ?? "",
    blocked_at: task.blockedAt ?? "",
  };
  if (task.labels.length > 0) data.labels = task.labels;

  const dependents = repos.relations
    .listBlockerOf(task.id)
    .map((relation) => repos.tasks.get(relation.source)?.identifier)
    .filter((identifier) => identifier !== undefined);
  if (dependents.length > 0) data.depends_on = dependents;

  const parentEdge = repos.relations.getParent(task.id);
  if (parentEdge !== null) {
    const parent = repos.tasks.get(parentEdge.source);
    if (parent !== null) data.parent = parent.identifier;
  }

  if (meta.notify_elon !== undefined) data.notify_elon = meta.notify_elon;
  // Unrecognised keys go back exactly as they came in, in their original order.
  for (const [key, value] of Object.entries(meta.legacy ?? {})) {
    if (!Object.hasOwn(data, key)) data[key] = value;
  }

  const sections = new Map();
  sections.set("Background", task.description ?? "");
  sections.set(
    "Acceptance",
    renderAcceptanceBlock(meta.acceptance_legacy ?? []),
  );

  const progress = repos.activities
    .list({ taskId: task.id, limit: 10_000 })
    .filter((activity) => activity.event === "progress")
    .map((activity) => activity.changes?.line ?? `${activity.createdAt} ${JSON.stringify(activity.changes ?? {})}`);
  sections.set("Progress", renderProgressBlock(progress.map((line) => splitProgressLine(line))));

  sections.set(
    "Comments",
    renderCommentsBlock(
      repos.comments.list({ taskId: task.id, limit: 10_000 }).map((comment) => ({
        ts: comment.createdAt,
        kind: comment.kind,
        authorId: comment.authorId,
        body: comment.body,
      })),
    ),
  );

  sections.set(
    "Sessions",
    renderSessionsBlock(
      repos.sessions.listByTask(task.id).map((session) => ({
        seg: session.seg,
        owner: session.owner,
        backend: session.backend,
        sessionId: session.sessionId,
        phase: session.phase,
        status: session.status,
        pid: session.pid,
        ts: session.ts,
      })),
    ),
  );

  sections.set(
    "Report",
    renderReportBlock(
      repos.reports.listByTask(task.id).map((report) => ({
        round: report.round,
        ts: report.createdAt,
        authorId: report.authorId,
        conclusion: report.conclusion,
        acceptance: report.acceptance,
        evidence: report.evidence,
        leftovers: report.leftovers,
      })),
    ),
  );

  return `${serializeFrontmatter(data, { order: CARD_KEY_ORDER })}${joinSections(sections)}`;
}

function labelOf(repos, kind, id) {
  if (id === null || id === undefined) return null;
  const entry = repos.dictionary.getById(kind, id);
  return entry?.displayName ?? null;
}

function decodeMeta(task) {
  if (task.meta !== undefined && task.meta !== null) return task.meta;
  return {};
}
