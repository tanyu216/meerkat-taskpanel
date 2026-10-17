/**
 * The container lifecycle — the board drives an `epic` from its children.
 *
 * An `epic` is a container: it is never claimable, so nothing *works* it, and
 * both of its transitions have to come from somewhere else:
 *
 *   * **start** — any child entering `in_progress` moves the container
 *     `todo → in_progress` (a *system* move: no claim is written, because an
 *     epic is nobody's work card; `0024` already leaves `todo → in_progress` on
 *     the whitelist for every kind). This is what makes the board show the
 *     container as live while its children are being worked.
 *   * **close** — when every child of the container is `done`, the board writes
 *     the container's rollup report and moves it to `in_review` **in the same
 *     transaction as the child's own move**. A human still accepts `in_review →
 *     done`, so acceptance gates the tree from the bottom up: a nested epic
 *     reaches `in_review`, not `done`, and its parent therefore keeps waiting.
 *
 * Both moves leave a system-authored `kind=note` comment naming **where the
 * transition came from** (`event` — a child's write; `sweep` — the reconciler),
 * the basis (`N/N` children), and the instant. Nothing here is silent, and a
 * reviewer reading the container's trail can tell a live move from a repair.
 *
 * ## Why this layer
 *
 * Why not a database trigger: the closure is a *delivery*, and a delivery is a
 * validated report plus a status move. Only this layer can write a report that
 * satisfies the delivery gate, and the md importer (which writes history rather
 * than workflow) must not trigger a closure. The start needs no report, but it
 * needs the same one-write-per-transition reasoning and the same system note,
 * so it lives here too.
 *
 * Why `deliver()` is mirrored here instead of called: `commands/reports.mjs`
 * calls *this* module when its own card lands on `done`, so calling back into
 * it would make the two modules a cycle. The writes below are `deliver`'s
 * non-waiver path, one for one — report row first, then the move — and the
 * database trigger (`tr_deliver_gate`) is still the arbiter of whether the
 * report is good enough.
 *
 * ## The reconcile sweep
 *
 * `reconcileContainers` replays those two rules over the board's current rows.
 * It is the idempotent backstop for the two cases an event hook cannot see: a
 * write that bypassed the service layer (an external direct edit) and a card
 * that was attached to its container *after* the child had already started or
 * finished (relations added later fire no status transition). It scans only
 * non-terminal epics, supports `--dry-run`, and writes nothing on a second run
 * over the same state.
 *
 * Everything is a no-op unless the guards hold, which keeps the common case (a
 * card with no epic parent) free of extra reads beyond one edge lookup:
 *
 *   * the card has a `parent` edge, and the parent is an `epic`;
 *   * **start**: the container is `todo`, and at least one child has *left*
 *     `todo`/`backlog` for a working state (`in_progress`, `awaiting`,
 *     `in_review` or `done`) — a child that merely went `todo → blocked` proves
 *     nothing, so it does not start the container;
 *   * **close**: the container's status is one it may be closed from (`todo`,
 *     `in_progress`, `blocked`), **every** child is `done` (a `canceled` child
 *     stops the rollup: whether a container is finished is a human's call, not
 *     the board's), and the children's delivery evidence, taken together, is
 *     non-empty (a delivery report needs at least one anchor; a container whose
 *     children were all delivered under `--no-report` has nothing to stand a
 *     report on, and is left for a human to close).
 */

import { normalizeCommentCreate } from "../domain/comment.mjs";
import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { normalizeReportCreate } from "../domain/report.mjs";
import { assertTransition } from "../domain/status.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { SYSTEM_ACTOR } from "./context.mjs";
import { resolveActorId } from "./dictionary.mjs";

/** The container statuses the board may close from. */
const OPEN_CONTAINER_STATUSES = Object.freeze([STATUS.TODO, STATUS.IN_PROGRESS, STATUS.BLOCKED]);

/**
 * The container status the board may start from.
 *
 * `todo` only. `backlog` is an unreleased container (the whitelist gives it no
 * edge into the work cycle), and every other non-terminal status already means
 * "live" or is waiting on a human.
 */
const STARTABLE_CONTAINER_STATUSES = Object.freeze([STATUS.TODO]);

/**
 * Child statuses that prove the child left `todo`/`backlog` for work.
 *
 * `blocked` is deliberately absent: `todo → blocked` is legal and proves no work
 * happened, so it must not start a container. `awaiting` is reached only from
 * `in_progress`, so it does prove work began (it matters after a lost event).
 */
const CHILD_STARTED_STATUSES = Object.freeze([
  STATUS.IN_PROGRESS,
  STATUS.AWAITING,
  STATUS.IN_REVIEW,
  STATUS.DONE,
]);

/**
 * Advance the container a card belongs to, if that card's completion finished it.
 *
 * @param {object} ctx
 * @param {string} childId the card that just reached `done` (or lost a sibling)
 * @param {string} now
 * @param {{source?: "event"|"sweep"}} [options]
 * @returns {{task: object, report: object|null}|null} the closed container, or
 *   `null` when nothing was done (no parent, not an epic, siblings unfinished,
 *   ...).
 */
export function advanceContainerForChild(ctx, childId, now, options = {}) {
  const edge = ctx.repos.relations.getParent(childId);
  if (edge === null || edge === undefined) return null;
  return advanceContainer(ctx, edge.source, now, options);
}

/**
 * Close `containerId` if every one of its children is `done`.
 *
 * @param {object} ctx
 * @param {string} containerId the epic's id
 * @param {string} now
 * @param {{source?: "event"|"sweep"}} [options]
 * @returns {{task: object, report: object|null}|null}
 */
export function advanceContainer(ctx, containerId, now, options = {}) {
  const container = ctx.repos.tasks.get(containerId);
  if (container === null || container === undefined) return null;
  if (container.kind !== TASK_KIND.EPIC) return null;

  const plan = planClose(ctx, container);
  if (plan === null) return null;

  const author = {
    kind: SYSTEM_ACTOR.kind,
    id: resolveActorId({ repos: ctx.repos, now }, { name: SYSTEM_ACTOR.id, actorKind: SYSTEM_ACTOR.kind }),
  };
  const prepared = normalizeReportCreate(
    { ...rollupReport(container, plan.children, plan.evidence), author },
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
  const refs = plan.children.map((child) => child.identifier);
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
      rollup: refs,
      source: options.source ?? "event",
    },
    createdAt: now,
  });
  appendSystemNote(
    ctx,
    container.id,
    `Auto-rollup (${options.source ?? "event"}): ${refs.length}/${refs.length} child card(s) done ` +
      `(${refs.join(", ")}); epic delivered to ${moved.status} at ${now}; awaiting human acceptance.`,
    now,
    refs,
  );
  return { task: moved, report };
}

/**
 * Start the container a card belongs to, if that card has entered the work.
 *
 * @param {object} ctx
 * @param {string} childId the card that just entered `in_progress`
 * @param {string} now
 * @param {{source?: "event"|"sweep"}} [options]
 * @returns {{task: object}|null} the started container, or `null`
 */
export function startContainerForChild(ctx, childId, now, options = {}) {
  const edge = ctx.repos.relations.getParent(childId);
  if (edge === null || edge === undefined) return null;
  return startContainer(ctx, edge.source, now, options);
}

/**
 * Move `containerId` from `todo` to `in_progress` if one of its children is
 * being worked.
 *
 * This is a **system** move, not a claim: `claimed_by` stays NULL (an epic is
 * never anybody's work card) and the board records a `epic_auto_start`
 * activity plus a system note. A nested container propagates upward: the
 * container that just started is itself a child of a higher container, and by
 * starting it has entered the work too.
 *
 * @param {object} ctx
 * @param {string} containerId the epic's id
 * @param {string} now
 * @param {{source?: "event"|"sweep"}} [options]
 * @returns {{task: object}|null}
 */
export function startContainer(ctx, containerId, now, options = {}) {
  const container = ctx.repos.tasks.get(containerId);
  if (container === null || container === undefined) return null;
  if (container.kind !== TASK_KIND.EPIC) return null;
  if (!STARTABLE_CONTAINER_STATUSES.includes(container.status)) return null;

  const children = childrenOf(ctx, container.id);
  if (children === null || children.length === 0) return null;
  const started = children.find((child) => CHILD_STARTED_STATUSES.includes(child.status));
  if (started === undefined) return null;

  assertTransition(container.status, STATUS.IN_PROGRESS, container.kind);
  const moved = ctx.repos.tasks.moveCas({
    id: container.id,
    to: STATUS.IN_PROGRESS,
    now,
  });
  ctx.repos.activities.append({
    taskId: container.id,
    actorKind: SYSTEM_ACTOR.kind,
    actorId: SYSTEM_ACTOR.id,
    event: "epic_auto_start",
    changes: {
      from: container.status,
      to: moved.status,
      child: started.identifier,
      source: options.source ?? "event",
    },
    createdAt: now,
  });
  appendSystemNote(
    ctx,
    container.id,
    `Auto-start (${options.source ?? "event"}): child ${started.identifier} is in progress; ` +
      `epic moved ${container.status} → ${moved.status} at ${now}.`,
    now,
    [started.identifier],
  );
  // A nested container that starts is, in turn, a child that entered the work
  // — so its own parent may start too.
  startContainerForChild(ctx, container.id, now, options);
  return { task: moved };
}

/**
 * Reconcile every non-terminal container with the state of its children.
 *
 * Deterministic and idempotent: every action is derived from the rows as they
 * are, and a second run over the same state writes nothing. `dryRun` computes
 * the same plan and writes nothing at all (no report, no note, no activity).
 *
 * `in_review` containers are scanned (they are non-terminal) and reported as
 * `none`: a container already waiting for a human has nothing to reconcile.
 *
 * @param {object} ctx
 * @param {{dryRun?: boolean}} [options]
 * @returns {{dryRun: boolean, scanned: number, actions: {epic: string, action: "start"|"close"|"none", reason: string, child?: string}[]}}
 */
export function reconcileContainers(ctx, options = {}) {
  const dryRun = options.dryRun === true;
  const now = ctx.now();
  const epics = ctx.repos.tasks.list({
    kind: TASK_KIND.EPIC,
    status: [
      STATUS.BACKLOG,
      STATUS.TODO,
      STATUS.IN_PROGRESS,
      STATUS.AWAITING,
      STATUS.IN_REVIEW,
      STATUS.BLOCKED,
    ],
    limit: null,
  });

  const actions = [];
  for (const epic of epics) {
    const children = childrenOf(ctx, epic.id);
    const record = (action, reason, extra = {}) =>
      actions.push({ epic: epic.identifier, status: epic.status, action, reason, ...extra });

    if (children === null) {
      record("none", "dangling_child_edge");
      continue;
    }
    if (children.length === 0) {
      record("none", "empty_epic");
      continue;
    }

    const allDone = children.every((child) => child.status === STATUS.DONE);
    if (allDone) {
      if (!OPEN_CONTAINER_STATUSES.includes(epic.status)) {
        record("none", "not_open_for_rollup");
        continue;
      }
      const plan = planClose(ctx, epic);
      if (plan === null) {
        record("none", "no_delivery_evidence");
        continue;
      }
      record("close", "all_children_done", { children: children.length });
      // One transaction per repaired container: the report, the move and the
      // system note either all land or none do (nested as a savepoint when a
      // caller already opened one).
      if (!dryRun) {
        transaction(ctx.db, () => advanceContainer(ctx, epic.id, now, { source: "sweep" }), {
          op: "containers.reconcile.close",
        });
      }
      continue;
    }

    if (epic.status !== STATUS.TODO) {
      record("none", epic.status === STATUS.IN_REVIEW ? "awaiting_acceptance" : "not_startable");
      continue;
    }
    const started = children.find((child) => CHILD_STARTED_STATUSES.includes(child.status));
    if (started === undefined) {
      record("none", "no_child_started");
      continue;
    }
    record("start", "child_in_progress", { child: started.identifier });
    if (!dryRun) {
      transaction(ctx.db, () => startContainer(ctx, epic.id, now, { source: "sweep" }), {
        op: "containers.reconcile.start",
      });
    }
  }

  return { dryRun, scanned: epics.length, actions };
}

/**
 * The children of a container, or `null` when an edge points at a missing row.
 *
 * @param {object} ctx
 * @param {string} containerId
 * @returns {object[]|null}
 */
function childrenOf(ctx, containerId) {
  const edges = ctx.repos.relations.listChildren(containerId);
  const children = [];
  for (const edge of edges) {
    const child = ctx.repos.tasks.get(edge.target);
    // A dangling edge (should be impossible: relations are FK'd) is not a
    // reason to close anything — leave the container to a human.
    if (child === null || child === undefined) return null;
    children.push(child);
  }
  return children;
}

/**
 * The close plan for a container, or `null` when it is not closeable.
 *
 * @param {object} ctx
 * @param {object} container
 * @returns {{children: object[], evidence: object[]}|null}
 */
function planClose(ctx, container) {
  if (!OPEN_CONTAINER_STATUSES.includes(container.status)) return null;

  const children = childrenOf(ctx, container.id);
  if (children === null || children.length === 0) return null;
  if (children.some((child) => child.status !== STATUS.DONE)) return null;

  const evidence = rollupEvidence(ctx, children);
  // No evidence at all means every child was delivered under `--no-report`:
  // there is nothing the gate should accept, so the container stays open.
  if (evidence.length === 0) return null;
  return { children, evidence };
}

/**
 * Append a system `kind=note` comment — the container's own account of a
 * transition it performed on itself.
 *
 * Written here rather than through `commands/comments.mjs#addComment`: that
 * command reads the clock itself, and this row must carry the *same* stamp as
 * the transition it describes (one write, one instant). Everything else is the
 * same three steps `addComment` takes — resolve the system actor through the
 * dictionary, validate, and append the `comment_added` audit row.
 *
 * @param {object} ctx
 * @param {string} taskId
 * @param {string} body
 * @param {string} now
 * @param {string[]} refs
 */
function appendSystemNote(ctx, taskId, body, now, refs) {
  const authorId = resolveActorId(
    { repos: ctx.repos, now },
    { name: SYSTEM_ACTOR.id, actorKind: SYSTEM_ACTOR.kind },
  );
  const comment = normalizeCommentCreate(
    { body, kind: "note", author: { kind: SYSTEM_ACTOR.kind, id: authorId }, refs },
    { now, id: ctx.newId(), taskId },
  );
  ctx.repos.comments.append(comment);
  ctx.repos.activities.append({
    taskId,
    actorKind: SYSTEM_ACTOR.kind,
    actorId: SYSTEM_ACTOR.id,
    event: "comment_added",
    changes: { commentId: comment.id, kind: comment.kind },
    createdAt: now,
  });
  return comment;
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
