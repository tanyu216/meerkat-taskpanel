/**
 * SQLite → md, reversibly.
 *
 * The export is the *canonical* card: a fixed key order and a fixed section
 * order, so an exported card is byte-identical no matter what the input looked
 * like. One thing is deliberately preserved from the input rather than
 * canonicalised: unrecognised frontmatter keys, in their original order
 * (`meta_json.legacy`). The status is always the canonical word — the old
 * `ready`/`failed` aliases are gone.
 *
 * `target` is one of those unrecognised keys (O3): the board owns no project
 * directory, so an inbound `target:` is neither derived nor validated — it rides
 * through `meta_json.legacy` and is re-emitted exactly as it came in. A card
 * that never carried one exports without the key.
 *
 * Rewriting a card may not grow it without bound: if the new text is more than
 * `MD_GROWTH_FACTOR` times the old one, the export refuses instead of writing
 * (`MD_GROWTH_GUARD`). That guard is the whole reason the frontmatter serialiser
 * only ever emits syntax the parser accepts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MD_GROWTH_FACTOR } from "../../../foundation/constants.mjs";
import { DomainError } from "../../../foundation/errors.mjs";
import { serializeFrontmatter } from "./frontmatter.mjs";
import {
  joinSections,
  renderAcceptanceBlock,
  renderAcceptanceList,
  renderAttachmentsBlock,
  renderCommentsBlock,
  renderReportBlock,
  renderSessionsBlock,
} from "./sections.mjs";

/**
 * Frontmatter key order for an exported card.
 *
 * `target` keeps its slot here so a card that carries one (via `meta_json.legacy`)
 * is re-emitted in its historical position, right after `project`.
 */
export const CARD_KEY_ORDER = Object.freeze([
  "id",
  "title",
  "assignee",
  "assignee_kind",
  "status",
  "priority",
  "kind",
  // 0031 — emitted only when the card requires review; absence means "not
  // required", so a card that never needs one does not grow a line.
  "review_required",
  "labels",
  "project",
  "target",
  "created_by",
  "created_by_kind",
  "created_at",
  "updated_at",
  "status_changed_at",
  "claimed_by",
  "claimed_kind",
  "claimed_at",
  "heartbeat_at",
  "blocked_at",
  "blocked_reason",
  // 0032 — the acceptance baseline's revision and the delivery/review facts a
  // reader needs to place the card in the workflow. All optional: a key is
  // written only when it carries something.
  "delivery_round",
  "awaiting_reason",
  "review_of",
  "review_round",
  "acceptance_revision",
  "report_waiver_round",
  "report_waiver_reason",
  "report_waived_at",
  "archived_at",
  "acceptance_derived",
  "accepted_by",
  "accepted_round",
  "auto_accepted",
  "review_verdict",
  "review_verdict_round",
  "rework_round",
  "flow",
  "depends_on",
  "parent",
  "notify_leader",
]);

/** The workflow meta keys the canonical card surfaces when present (0032). */
const EXPORTED_TASK_META = Object.freeze([
  "acceptance_derived",
  "accepted_by",
  "accepted_round",
  "auto_accepted",
  "review_verdict",
  "review_verdict_round",
  "rework_round",
  "flow",
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
    const content = renderCard(task, { repos });
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
 * @param {{repos: object}} context
 * @returns {string}
 */
export function renderCard(task, context) {
  const { repos } = context;
  const meta = decodeMeta(task);

  const data = {
    id: task.identifier,
    title: task.title,
    assignee: labelOf(repos, "assignee", task.assigneeId) ?? "",
    status: task.status,
    priority: task.priority,
    kind: task.kind,
    project: task.projectId,
    // The creator IS the reporter (0019): `created_by` reads the one column that
    // holds it, with no second `creator_id` fallback to consult.
    created_by: labelOf(repos, "reporter", task.reporterId) ?? "",
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    status_changed_at: task.statusChangedAt,
    // Since 0020 `claimed_by` is an actor id; the card writes the person's
    // display name, like `assignee`/`created_by` above (and the importer resolves
    // it back). The md format stays human-readable, and the round trip is exact.
    claimed_by: labelOf(repos, "actor", task.claimedBy) ?? "",
    claimed_at: task.claimedAt ?? "",
    heartbeat_at: task.heartbeatAt ?? "",
    blocked_at: task.blockedAt ?? "",
  };
  // 0031 — only a card that requires review carries the key. Absence is "not
  // required"; writing `no` on every card would grow every golden by a line for
  // the default state.
  if (task.reviewRequired === 1 || task.reviewRequired === true) {
    data.review_required = "yes";
  }
  // 0023 — the three reference kinds, each written **only when it says something**
  // the reader could not otherwise know. Writing an empty key would grow every
  // card that never carried one by a line and break the byte-for-byte goldens:
  //
  //   * `assignee_kind` — default `agent`, the parser's prior for a card that
  //     states nothing;
  //   * `created_by_kind` — default `human`, the role's own definition;
  //   * `claimed_kind` — default `null`: a claim records no kind until a live
  //     claim makes one, and "not recorded" is not the same as a person.
  for (const [key, value, fallback] of [
    ["assignee_kind", task.assigneeKind, "agent"],
    ["created_by_kind", task.reporterKind, "human"],
    ["claimed_kind", task.claimedKind, null],
  ]) {
    if (typeof value === "string" && value.trim() !== "" && value !== fallback) data[key] = value;
  }
  // 0016 — emitted only when the column holds a value. `blocked_at` above is
  // always written (`""` when unset) because every card has carried that key
  // since the beginning; `blocked_reason` has not, so writing an empty one would
  // grow every existing card by a line and break the byte-for-byte goldens.
  // "Unset" is the absence of the key, on both sides of the round trip.
  if (task.blockedReason !== null && task.blockedReason !== undefined && task.blockedReason !== "") {
    data.blocked_reason = task.blockedReason;
  }
  if (task.labels.length > 0) data.labels = task.labels;

  // 0032 — the modern `--target` lives in `meta.target`; the legacy bag is the
  // fallback. The rest are optional workflow facts, written only when set.
  const target = typeof meta.target === "string" ? meta.target : meta.legacy?.target;
  if (typeof target === "string" && target.trim() !== "") data.target = target;
  if (Number(task.deliveryRound ?? 1) > 1) data.delivery_round = task.deliveryRound;
  if (task.awaitingReason !== null && task.awaitingReason !== undefined) {
    data.awaiting_reason = task.awaitingReason;
  }
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) {
    data.review_of = repos.tasks.get(task.reviewOfId)?.identifier ?? task.reviewOfId;
    if (task.reviewRound !== null && task.reviewRound !== undefined) data.review_round = task.reviewRound;
  }
  if (Number(task.acceptanceRevision ?? 0) > 0) data.acceptance_revision = task.acceptanceRevision;
  if (task.reportWaiverRound !== null && task.reportWaiverRound !== undefined) {
    data.report_waiver_round = task.reportWaiverRound;
    if (task.reportWaiverReason !== null && task.reportWaiverReason !== undefined) {
      data.report_waiver_reason = task.reportWaiverReason;
    }
    if (task.reportWaivedAt !== null && task.reportWaivedAt !== undefined) {
      data.report_waived_at = task.reportWaivedAt;
    }
  }
  if (task.archivedAt !== null && task.archivedAt !== undefined) data.archived_at = task.archivedAt;
  for (const key of EXPORTED_TASK_META) {
    if (meta[key] !== undefined) data[key] = meta[key];
  }

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

  if (meta.notify_leader !== undefined) data.notify_leader = meta.notify_leader;
  // Unrecognised keys go back exactly as they came in, in their original order.
  for (const [key, value] of Object.entries(meta.legacy ?? {})) {
    if (!Object.hasOwn(data, key)) data[key] = value;
  }

  const sections = new Map();
  sections.set("Background", task.description ?? "");
  // 0032 — the frozen snapshot is the authority. `meta.acceptance` is the seed
  // (and the visible fallback for a grandfathered card whose snapshot is still
  // empty); the imported checkbox list is the last resort and keeps its
  // checkboxes (the author's intent, not delivery evidence).
  const snapshot = Array.isArray(task.acceptance) ? task.acceptance : [];
  const modernAcceptance =
    snapshot.length > 0
      ? snapshot
      : Array.isArray(meta.acceptance) && meta.acceptance.length > 0
        ? meta.acceptance
        : null;
  const seedOnly = snapshot.length === 0 && modernAcceptance !== null;
  sections.set(
    "Acceptance",
    modernAcceptance !== null
      ? `${renderAcceptanceList(modernAcceptance)}${seedOnly ? "\n\n_(seed; no frozen baseline)_" : ""}`
      : renderAcceptanceBlock(meta.acceptance_legacy ?? []),
  );

  sections.set(
    "Comments",
    renderCommentsBlock(
      repos.comments.list({ taskId: task.id, limit: 10_000 }).map((comment) => ({
        ts: comment.createdAt,
        kind: comment.kind,
        // author_id is an actor id since 0020 — the card carries the name.
        authorId: labelOf(repos, "actor", comment.authorId) ?? "",
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
        ownerKind: session.ownerKind,
        sessionId: session.sessionId,
        goal: session.goal,
        phase: session.phase,
        status: session.status,
        pid: session.pid,
        ts: session.ts,
      })),
    ),
  );

  // Only when the card has files: a card without attachments keeps the same
  // five-section shape it had before this section existed.
  const attachments = repos.attachments.listByTask(task.id);
  if (attachments.length > 0) {
    sections.set("Attachments", renderAttachmentsBlock(attachments));
  }

  sections.set(
    "Report",
    renderReportBlock(
      repos.reports.listByTask(task.id).map((report) => ({
        round: report.round,
        ts: report.createdAt,
        // author_id is an actor id since 0020 — the card carries the name.
        authorId: labelOf(repos, "actor", report.authorId) ?? "",
        conclusion: report.conclusion,
        acceptance: report.acceptance,
        evidence: report.evidence,
        leftovers: report.leftovers,
        isRollup: report.isRollup === true,
        origin: report.origin,
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
