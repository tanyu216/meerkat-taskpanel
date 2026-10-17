/**
 * The container rollup — the board closes an `epic` when its last child lands.
 *
 * An `epic` is a container: it is never claimable, so nothing *works* it, and
 * its own delivery has to come from somewhere else. Since `0024` an epic may be
 * delivered straight out of `todo`; this module is what fills that door with a
 * body: when every child of the container is `done`, the board writes the
 * container's rollup report and moves it to `in_review` **in the same
 * transaction as the child's own move**. A human still accepts `in_review →
 * done`, so acceptance gates the tree from the bottom up: a nested epic reaches
 * `in_review`, not `done`, and its parent therefore keeps waiting.
 *
 * Why not a database trigger: the closure is a *delivery*, and a delivery is a
 * validated report plus a status move. Only this layer can write a report that
 * satisfies the delivery gate, and the md importer (which writes history rather
 * than workflow) must not trigger a closure.
 *
 * Why `deliver()` is mirrored here instead of called: `commands/reports.mjs`
 * calls *this* module when its own card lands on `done`, so calling back into
 * it would make the two modules a cycle. The writes below are `deliver`'s
 * non-waiver path, one for one — report row first, then the move — and the
 * database trigger (`tr_deliver_gate`) is still the arbiter of whether the
 * report is good enough.
 *
 * Everything here is a no-op unless *all* of the following hold, which keeps the
 * common case (a card with no epic parent) free of extra reads beyond one edge
 * lookup:
 *
 *   * the card has a `parent` edge, and the parent is an `epic`;
 *   * the container's status is one it may be closed from (`todo`,
 *     `in_progress`, `blocked`);
 *   * **every** child of that epic is `done` (a `canceled` child stops the
 *     rollup: whether a container is finished is a human's call, not the
 *     board's);
 *   * the children's delivery evidence, taken together, is non-empty — a
 *     container whose children were all delivered under `--no-report` has
 *     nothing to stand a report on, and is left for a human to close.
 *
 * The rollup is idempotent (a container already in `in_review` is skipped), and
 * concurrent siblings are serialized by SQLite's single writer.
 */

import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { normalizeReportCreate } from "../domain/report.mjs";
import { SYSTEM_ACTOR } from "./context.mjs";
import { resolveActorId } from "./dictionary.mjs";

/** The container statuses the board may close from. */
const OPEN_CONTAINER_STATUSES = Object.freeze([STATUS.TODO, STATUS.IN_PROGRESS, STATUS.BLOCKED]);

/**
 * Advance the container a card belongs to, if that card's completion finished it.
 *
 * @param {object} ctx
 * @param {string} childId the card that just reached `done` (or lost a sibling)
 * @param {string} now
 * @returns {{task: object, report: object}|null} the closed container, or `null` when
 *   nothing was done (no parent, not an epic, siblings unfinished, ...)
 */
export function advanceContainerForChild(ctx, childId, now) {
  const edge = ctx.repos.relations.getParent(childId);
  if (edge === null || edge === undefined) return null;
  return advanceContainer(ctx, edge.source, now);
}

/**
 * Close `containerId` if every one of its children is `done`.
 *
 * @param {object} ctx
 * @param {string} containerId the epic's id
 * @param {string} now
 * @returns {{task: object, report: object}|null}
 */
export function advanceContainer(ctx, containerId, now) {
  const container = ctx.repos.tasks.get(containerId);
  if (container === null || container === undefined) return null;
  if (container.kind !== TASK_KIND.EPIC) return null;
  if (!OPEN_CONTAINER_STATUSES.includes(container.status)) return null;

  const edges = ctx.repos.relations.listChildren(container.id);
  if (edges.length === 0) return null;

  const children = [];
  for (const edge of edges) {
    const child = ctx.repos.tasks.get(edge.target);
    // A dangling edge (should be impossible: relations are FK'd) is not a
    // reason to close anything — leave the container to a human.
    if (child === null || child === undefined) return null;
    if (child.status !== STATUS.DONE) return null;
    children.push(child);
  }

  const evidence = rollupEvidence(ctx, children);
  // No evidence at all means every child was delivered under `--no-report`:
  // there is nothing the gate should accept, so the container stays open.
  if (evidence.length === 0) return null;

  const author = {
    kind: SYSTEM_ACTOR.kind,
    id: resolveActorId({ repos: ctx.repos, now }, { name: SYSTEM_ACTOR.id, actorKind: SYSTEM_ACTOR.kind }),
  };
  const prepared = normalizeReportCreate(
    { ...rollupReport(container, children, evidence), author },
    { taskRound: container.deliveryRound, now },
  );
  const report = ctx.repos.reports.insert({
    ...prepared,
    taskId: container.id,
    // The delivery writer: this row is what the gate accepts (0008 / 0020).
    origin: "delivery",
    seg: null,
    sessionId: null,
  });
  const moved = ctx.repos.tasks.moveCas({
    id: container.id,
    to: STATUS.IN_REVIEW,
    now,
    reportLatestId: report.id,
  });
  ctx.repos.activities.append({
    taskId: container.id,
    actorKind: SYSTEM_ACTOR.kind,
    actorId: SYSTEM_ACTOR.id,
    event: "task_delivered",
    changes: {
      from: container.status,
      to: moved.status,
      round: report.round,
      reportId: report.id,
      deliveryRound: moved.deliveryRound,
      rollup: children.map((child) => child.identifier),
    },
    createdAt: now,
  });
  return { task: moved, report };
}

/**
 * The rollup report for a finished container.
 *
 * The acceptance list is what makes this a *rollup* rather than a summary: one
 * criterion per child, and the only claim each makes — "this child is `done`" —
 * is a fact the board itself holds. It asserts nothing about the children's own
 * acceptance; each of those was accepted by a human already.
 *
 * @param {object} container
 * @param {object[]} children
 * @param {object[]} evidence
 */
function rollupReport(container, children, evidence) {
  const delivered = children.map((child) => child.identifier).join(", ");
  return {
    conclusion:
      `Auto-rollup: all ${children.length} child card(s) of ${container.identifier} are done — ${delivered}.`,
    acceptance: children.map((child) => ({
      text: `${child.identifier} ${child.title} — done`,
      status: "met",
    })),
    evidence,
  };
}

/**
 * The union of the children's latest delivery evidence, de-duplicated.
 *
 * A child delivered under `--no-report` contributes nothing; one whose report
 * was written contributes the anchors it stood on, which is exactly the
 * container's own evidence — the work happened there, not here.
 *
 * @param {object} ctx
 * @param {object[]} children
 * @returns {object[]}
 */
function rollupEvidence(ctx, children) {
  const out = [];
  const seen = new Set();
  for (const child of children) {
    const reports = ctx.repos.reports.listByTask(child.id);
    // `listByTask` is round-ascending: the last delivery report is the one the
    // current round was accepted on.
    const latest = [...reports].reverse().find((report) => report.origin === "delivery");
    if (latest === undefined || latest === null) continue;
    for (const anchor of latest.evidence?.items ?? []) {
      const key = JSON.stringify(anchor);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(anchor);
    }
  }
  return out;
}
