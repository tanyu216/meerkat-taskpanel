/**
 * Task use-cases: create, update, claim, heartbeat, move, archive, list.
 *
 * Every command here is one transaction containing, in order:
 *   1. the domain checks (so a refusal costs nothing),
 *   2. the write,
 *   3. exactly one `task_activities` row describing it.
 *
 * `moveStatus` is where the delivery gate bites: `→ in_review` without a report
 * for the current round raises 422 with the command that fixes it. The result
 * is the same whether the refusal comes from here or from the trigger.
 */

import { DomainError, isDomainError } from "../../shared/errors.mjs";
import { CLAIM_STALE_ANY_MS, CLAIM_STALE_SAME_MS } from "../../shared/constants.mjs";
import { assertClaimable, decideClaim, explainLostClaim } from "../domain/claim.mjs";
import {
  assertCreationGate,
  assertDeliveryGate,
  assertWaiverRequest,
  checkDeliveryGate,
  WAIVER_MIN_REASON_CHARS,
} from "../domain/delivery-gate.mjs";
import { assertTransition } from "../domain/status.mjs";
import { hasIdemDiscriminator, idemKey, idemSource, normalizeIdem } from "../domain/idem.mjs";
import { isArchivable, normalizeTaskCreate, normalizeTaskUpdate } from "../domain/task.mjs";
import { assertEpicDowngradeAllowed } from "../domain/relation.mjs";
import { normalizeLabelName } from "../domain/labels.mjs";
import { normalizeName } from "../domain/dictionary.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";
import { addComment } from "./comments.mjs";
import { resolveAssignment } from "./dictionary.mjs";
import { resolveLabels } from "./labels.mjs";

/**
 * @param {object} ctx
 * @param {{projectId: string, title: string, actor: object, assignee?: string, assigneeKind?: string, reporter?: string, reporterKind?: string, forceCreate?: boolean, idem?: string, allowDup?: boolean, reviewOf?: string, parent?: string, target?: string, [key: string]: unknown}} input
 */
export function createTask(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const project = ctx.repos.projects.get(input.projectId);
      if (project === null) {
        throw new DomainError("NOT_FOUND", {
          message: `no project ${input.projectId}`,
          details: { field: "projectId", received: input.projectId },
        });
      }

      // Reserve the identifier first: if anything later refuses, the whole
      // transaction (counter included) rolls back, so a serial is never burned.
      const identifier =
        input.identifier ?? ctx.repos.projects.allocateIdentifier(input.projectId).identifier;

      // Validate everything a caller supplied *before* touching the dictionary,
      // so a rejected create cannot leave a stray assignee behind.
      const candidate = normalizeTaskCreate(input, {
        now,
        id: input.id ?? ctx.newId(),
        identifier,
        projectId: input.projectId,
      });

      // The gate's INSERT-shaped half (M3fix D1). `createTask` is the single
      // door the HTTP, CLI and MCP faces all share; refusing here — before any
      // row is written — makes `in_review`/`done` unreachable at creation the
      // same way a reportless `task_move` is refused. The md importer does not
      // call this use-case (it writes history directly), which is why the guard
      // cannot be a trigger: an INSERT trigger would abort an `in_review` import.
      assertCreationGate({ task: candidate, status: candidate.status });

      // --- the mechanical idempotency guard --------------------------------
      // The *main* gate is an LLM reading the existing non-terminal cards and
      // deciding whether the intent is already covered (see `domain/idem.mjs`
      // and `src/core/README.md`); this key only catches the mechanical
      // duplicate a machine can prove. It is derived *before* the dictionary
      // and label resolvers run, so a re-used create has no side effect at all.
      const assigneeKey = String(input.assigneeId ?? input.assignee ?? "").trim();
      const sourceKey = idemSource({
        reviewOf: input.reviewOf ?? input.meta?.review_of,
        parent: input.parent ?? input.meta?.parent,
      });
      const targetKey = String(input.target ?? input.meta?.target ?? "").trim();
      const explicit = normalizeIdem(input.idem);
      const derived = idemKey({
        kind: input.kind ?? "task",
        assignee: assigneeKey,
        source: sourceKey,
        target: targetKey,
      });
      // No discriminator and no explicit key ⇒ no guard: otherwise every generic
      // card would derive `task |  |  | ` and refuse the next one.
      const key =
        explicit ??
        (hasIdemDiscriminator({ assignee: assigneeKey, source: sourceKey, target: targetKey })
          ? derived
          : null);

      if (input.allowDup !== true && key !== null) {
        const existing = ctx.repos.tasks.findByIdemActive(key);
        if (existing !== null) return existing;
      }
      // `--allow-dup` writes NULL: an unkeyed row can never collide, and it does
      // not occupy the key for a later real create.
      candidate.idem = input.allowDup === true ? null : key;

      const dictionaryAudit = [];
      if (input.assignee !== undefined && input.assignee !== null) {
        const resolved = resolveAssignment(ctx, {
          kind: "assignee",
          name: input.assignee,
          actorKind: input.assigneeKind ?? "agent",
          forceCreate: input.forceCreate,
        });
        Object.assign(candidate, resolved.patch);
        dictionaryAudit.push(...resolved.audit);
      }
      if (input.reporter !== undefined && input.reporter !== null) {
        const resolved = resolveAssignment(ctx, {
          kind: "reporter",
          name: input.reporter,
          actorKind: input.reporterKind ?? "human",
          forceCreate: input.forceCreate,
        });
        candidate.reporterId = resolved.patch.reporterId;
        dictionaryAudit.push(...resolved.audit);
      }

      // Labels grow the registry in the same transaction (§4.4): resolve them to
      // the registry's display names before the row is written, and count the
      // uses. A brand-new task references every label it names (F5-B).
      let labelAudit = [];
      if (candidate.labels.length > 0) {
        const resolved = resolveLabels(ctx, {
          projectId: candidate.projectId,
          names: candidate.labels,
          previousLabels: [],
          now,
        });
        candidate.labels = resolved.stored;
        labelAudit = resolved.audit;
      }

      let task;
      try {
        task = ctx.repos.tasks.insert(candidate);
      } catch (err) {
        // Lost a race: another connection committed the same key between the
        // read above and this insert. The partial unique index is the final
        // arbiter, so converge onto whatever it protected — but only for that
        // one code. Anything else (and an `IDEM_EXISTS` with no row to show)
        // is re-thrown untouched so a real failure is never swallowed.
        if (key !== null && input.allowDup !== true && isDomainError(err) && err.code === "IDEM_EXISTS") {
          const existing = ctx.repos.tasks.findByIdemActive(key);
          if (existing !== null) return existing;
        }
        throw err;
      }

      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "task_created",
        changes: {
          identifier: task.identifier,
          status: task.status,
          priority: task.priority,
          ...(task.idem === null ? {} : { idem: task.idem }),
          ...(dictionaryAudit.length > 0 ? { dictionaries: dictionaryAudit } : {}),
          ...(labelAudit.length > 0 ? { labels: labelAudit } : {}),
        },
        createdAt: now,
      });
      return task;
    },
    { op: "tasks.create" },
  );
}

/**
 * @param {object} ctx
 * @param {{id: string, ifVersion?: number, patch?: object, actor: object, assignee?: string, reporter?: string, forceCreate?: boolean}} input
 */
export function updateTask(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();
  const base = input.patch ?? {};
  // An assignee change is a patch in its own right, so the payload may be empty
  // as long as *something* ends up changing (checked once the dictionary has
  // been consulted).
  const patch = Object.keys(base).length === 0 ? {} : normalizeTaskUpdate(base, { now });

  return transaction(
    ctx.db,
    () => {
      const current = ctx.repos.tasks.get(input.id);
      if (current === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }

      const dictionaryAudit = [];
      if (input.assignee !== undefined) {
        const resolved = resolveAssignment(ctx, { kind: "assignee", name: input.assignee, forceCreate: input.forceCreate });
        Object.assign(patch, resolved.patch);
        dictionaryAudit.push(...resolved.audit);
      }
      if (input.reporter !== undefined) {
        const resolved = resolveAssignment(ctx, { kind: "reporter", name: input.reporter, actorKind: "human", forceCreate: input.forceCreate });
        patch.reporterId = resolved.patch.reporterId;
        dictionaryAudit.push(...resolved.audit);
      }

      // A label patch is registered and its use-count delta applied here, against
      // what the task currently names — so `["Bug"] → ["bug", "ui"]` adds one use
      // and re-submitting the same labels changes no count (F5-B).
      let labelAudit = [];
      if (patch.labels !== undefined) {
        const resolved = resolveLabels(ctx, {
          projectId: current.projectId,
          names: patch.labels,
          previousLabels: current.labels,
          now,
        });
        patch.labels = resolved.stored;
        labelAudit = resolved.audit;
      }

      if (Object.keys(patch).length === 0) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "nothing to update: pass a patch or an assignee/reporter",
          details: { allowed: ["title", "description", "priority", "kind", "labels", "assignee", "reporter"] },
        });
      }

      // Downgrading an epic that still has children would orphan a `task → task`
      // parent edge. The DB trigger (0011) is the machine guarantee; this read is
      // the friendly refusal that names the repair before the write is attempted.
      if (patch.kind !== undefined) {
        assertEpicDowngradeAllowed(current, patch.kind, ctx.repos.relations.listChildren(input.id));
      }

      const task = ctx.repos.tasks.updateCas({
        id: input.id,
        ifVersion: input.ifVersion,
        patch,
        now,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "task_updated",
        changes: {
          fields: Object.keys(patch),
          ...(dictionaryAudit.length > 0 ? { dictionaries: dictionaryAudit } : {}),
          ...(labelAudit.length > 0 ? { labels: labelAudit } : {}),
        },
        createdAt: now,
      });
      return task;
    },
    { op: "tasks.update" },
  );
}

/**
 * The injected assignee lookup for the claim policy: the dictionary entry that
 * names the card's assignee, or `null` for an unassigned card (an open pool).
 * @param {object} ctx
 */
function resolveAssigneeFor(ctx) {
  return (task) => (task.assigneeId ? ctx.repos.dictionary.getById("assignee", task.assigneeId) : null);
}

/**
 * An audited takeover needs a reason — the same rule (and the same minimum
 * length) the report waiver uses, because the two are the same kind of thing:
 * a documented exception a reviewer has to be able to read.
 * @param {unknown} reason
 * @returns {string} the trimmed reason
 */
function assertStealReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < WAIVER_MIN_REASON_CHARS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `--allow-steal needs --reason with at least ${WAIVER_MIN_REASON_CHARS} characters`,
      details: {
        field: "reason",
        received: typeof reason === "string" ? reason : null,
        minLength: WAIVER_MIN_REASON_CHARS,
      },
      hint: { fix: 'e.g. --reason "linus is unavailable, taking the card over"' },
    });
  }
  return text;
}

/** The `change` comment an audited takeover leaves behind (the readable trail). */
function stealCommentBody(task, verdict, actor, reason) {
  if (verdict.reclaim === true) {
    return (
      `Stale-claim takeover on ${task.identifier}: the previous holder ${verdict.stolenFrom} ` +
      `left a claim without a heartbeat for more than 6 hours; ${actor.id} re-claimed it.`
    );
  }
  return (
    `Audited takeover on ${task.identifier}: the card was assigned to ${verdict.stolenFrom}; ` +
    `${actor.id} claimed it with --allow-steal. Reason: ${reason}`
  );
}

/**
 * The one place a claim is performed: decide, CAS, audit. Shared by `claim` and
 * by `moveStatus`'s `todo → in_progress` path, so "claim" means the same thing
 * however it is reached.
 *
 * @param {object} ctx
 * @param {{current: object, actor: {kind: string, id: string}, now: string, allowSteal?: boolean, reason?: string, ifVersion?: number}} input
 * @returns {{task: object, reused: boolean, stole: boolean}}
 */
function performClaim(ctx, input) {
  const { current, actor, now, allowSteal, reason, ifVersion } = input;
  const resolveAssignee = resolveAssigneeFor(ctx);
  const verdict = assertClaimable(current, {
    actor: actor.id,
    now,
    allowSteal: allowSteal === true,
    resolveAssignee,
  });

  if (verdict.action === "reuse") {
    // A second claim by the same actor is not an error and not an event:
    // returning the existing claim keeps agents from piling up activity rows.
    return { task: current, reused: true, stole: false };
  }

  // `--allow-steal` must say why. A >6h reclaim is audited too but needs no
  // reason: the staleness *is* the reason.
  const auditedTakeover = verdict.steal === true && verdict.reclaim !== true;
  const stealReason = auditedTakeover ? assertStealReason(reason) : null;

  let task;
  if (verdict.reclaim === true) {
    // Re-claiming an in_progress card: the CAS must match status='in_progress'.
    task = ctx.repos.tasks.stealStaleClaim({ id: current.id, ifVersion, actor: actor.id, now });
  } else {
    const result = ctx.repos.tasks.claimCas({ id: current.id, ifVersion, actor: actor.id, now });
    if (!result.claimed) {
      throw explainLostClaim({
        before: current,
        after: result.task,
        actor: actor.id,
        now,
        ifVersion,
        allowSteal: allowSteal === true,
        resolveAssignee,
      });
    }
    task = result.task;
  }

  ctx.repos.activities.append({
    taskId: task.id,
    actorKind: actor.kind,
    actorId: actor.id,
    event: "task_claimed",
    changes: {
      from: current.status,
      to: task.status,
      ...(verdict.steal === true ? { stoleFrom: verdict.stolenFrom } : {}),
      ...(stealReason === null ? {} : { reason: stealReason }),
    },
    createdAt: now,
  });

  // An audited takeover is only trustworthy if it is readable: leave a `change`
  // comment, which `issue comment list` / `comment list` shows.
  if (verdict.steal === true) {
    addComment(ctx, {
      taskId: task.id,
      kind: "change",
      body: stealCommentBody(task, verdict, actor, stealReason),
      actor,
    });
  }

  return { task, reused: false, stole: verdict.steal === true };
}

/**
 * Claim a task, or reuse the claim this actor already holds.
 *
 * @param {object} ctx
 * @param {{id: string, actor: object, ifVersion?: number, allowSteal?: boolean, reason?: string}} input
 * @returns {{task: object, reused: boolean, stole: boolean}}
 */
export function claim(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const current = ctx.repos.tasks.get(input.id);
      if (current === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }
      return performClaim(ctx, {
        current,
        actor,
        now,
        allowSteal: input.allowSteal,
        reason: input.reason,
        ifVersion: input.ifVersion,
      });
    },
    { op: "tasks.claim" },
  );
}

/**
 * Pulse a claim. Never changes status, so it cannot resurrect finished work.
 * @param {object} ctx
 * @param {{id: string, actor: object}} input
 */
export function heartbeat(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const existing = ctx.repos.tasks.get(input.id);
      if (existing === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }
      // Decide first so a corrupt row is reported rather than half-repaired.
      if (existing.status === "in_progress" && (existing.claimedBy === null || existing.claimedBy === "")) {
        throw new DomainError("EXECUTION_STATE_CORRUPT", {
          message: `${existing.identifier} is in_progress but nobody claims it`,
          details: { taskId: existing.id, status: existing.status },
        });
      }
      const task = ctx.repos.tasks.setHeartbeat({ id: input.id, actor: actor.id, now });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "task_heartbeat",
        changes: { heartbeatAt: task.heartbeatAt },
        createdAt: now,
      });
      return task;
    },
    { op: "tasks.heartbeat" },
  );
}

/**
 * Move a task's status. The delivery gate is enforced here *and* by the
 * database; this pass exists so the refusal carries a repair command.
 *
 * `noReport: true` + `reason` is the audited waiver (F-B1): it satisfies the
 * gate for the current round and is recorded as `report_waived` instead of
 * `task_moved`, so the card's history says what actually happened.
 *
 * @param {object} ctx
 * @param {{id: string, to: string, actor: object, ifVersion?: number, noReport?: boolean, reason?: string, allowSteal?: boolean}} input
 */
export function moveStatus(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();
  const waiverReason = input.noReport === true ? assertWaiverRequest({ noReport: true, reason: input.reason, to: input.to }) : null;

  return transaction(
    ctx.db,
    () => {
      const current = ctx.repos.tasks.get(input.id);
      if (current === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }

      assertTransition(current.status, input.to);

      // `todo → in_progress` **is** a claim (T-20261009-230500): it must respect
      // the routing lock and stamp `claimed_by/claimed_at/heartbeat_at`, so the
      // CLI (`issue move`), HTTP and MCP surfaces all mean the same thing. Every
      // other entry into `in_progress` — a rework from `in_review`/`blocked` —
      // keeps the existing claim untouched.
      if (input.to === "in_progress" && current.status === "todo") {
        return performClaim(ctx, {
          current,
          actor,
          now,
          allowSteal: input.allowSteal,
          reason: input.reason,
          ifVersion: input.ifVersion,
        }).task;
      }

      const waiver =
        waiverReason === null ? null : { round: current.deliveryRound, reason: waiverReason, at: now };

      if (waiver === null) {
        if (input.to === "in_review") {
          assertDeliveryGate({
            task: current,
            reports: ctx.repos.reports.listGateReports(current.id),
            to: input.to,
          });
        }
      } else if (input.to === "in_review") {
        // The same decision, made once, so the service and the trigger cannot
        // disagree about whether this waiver is good enough.
        assertDeliveryGate({
          task: current,
          reports: ctx.repos.reports.listGateReports(current.id),
          to: input.to,
          waiver,
        });
      }

      const task = ctx.repos.tasks.moveCas({
        id: input.id,
        ifVersion: input.ifVersion,
        to: input.to,
        now,
        waiver,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: waiver === null ? "task_moved" : "report_waived",
        changes:
          waiver === null
            ? { from: current.status, to: task.status, deliveryRound: task.deliveryRound }
            : {
                from: current.status,
                to: task.status,
                round: waiver.round,
                reason: waiver.reason,
                deliveryRound: task.deliveryRound,
              },
        createdAt: now,
      });
      return task;
    },
    { op: "tasks.move" },
  );
}

/**
 * Archive a finished task. Status is never touched (I6).
 * @param {object} ctx
 * @param {{id: string, actor: object, ifVersion?: number, days?: number}} input
 */
export function archive(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const current = ctx.repos.tasks.get(input.id);
      if (current === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }
      const { eligible, eligibleAt } = isArchivable(current, {
        now,
        ...(input.days === undefined ? {} : { days: input.days }),
      });
      if (!eligible) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `${current.identifier} can be archived from ${eligibleAt}`,
          details: { taskId: current.id, eligibleAt, statusChangedAt: current.statusChangedAt },
          hint: { fix: "wait out the archive window, or archive with an explicit shorter window" },
        });
      }

      const task = ctx.repos.tasks.archive({ id: input.id, ifVersion: input.ifVersion, now });

      // An archived task no longer holds a *live* reference (F5-B), so each label
      // it carried loses one use. That is what eventually lets an otherwise
      // untouched label reach the GC's `use_count = 0` precondition.
      let released = 0;
      for (const name of current.labels) {
        const label = ctx.repos.labels.getByNorm(current.projectId, normalizeLabelName(name));
        if (label !== null) {
          ctx.repos.labels.removeUse(label.id);
          released += 1;
        }
      }

      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "task_archived",
        changes: { archivedAt: task.archivedAt, ...(released > 0 ? { labelsReleased: released } : {}) },
        createdAt: now,
      });
      return task;
    },
    { op: "tasks.archive" },
  );
}

/**
 * @param {object} ctx
 * @param {{projectId?: string, status?: string|string[], assigneeId?: string, includeArchived?: boolean, limit?: number, offset?: number}} [filter]
 */
export function listTasks(ctx, filter = {}) {
  return ctx.repos.tasks.list(filter);
}

/**
 * The claimable candidates for an assignee — the read a poll performs *before*
 * claiming, kept in lockstep with the openclaw-team `poll.mjs#scanCandidates`
 * criteria so a provider swap changes nothing on the framework side.
 *
 * A candidate is:
 *   * `ready` — `todo`, assigned to `assignee`, not an `epic`, and every
 *     `blocks` edge pointing at it (its `depends_on`) is `done`;
 *   * `unassigned` — with `includeUnassigned: true`, a `todo`, non-`epic`,
 *     `depends_on`-done card with no assignee: the public pool any actor may
 *     claim (see `domain/claim.mjs#isAssignee`). This is the read a supervisor
 *     uses when its policy is "claim unassigned tasks too";
 *   * with `stale: true`, `in_progress` whose heartbeat is stale — the same
 *     holder after 30 minutes (`stale_same`) or anyone after 6 hours
 *     (`stale_any`) — the recovery pool.
 *
 * Read-only: the returned rows are *never* claimed here; claiming still goes
 * through `claim` (and its steal/reuse semantics). The assignee is resolved the
 * way every other read does it — against the dictionary's `id`, `display_name`
 * or `normalized_name` — and an unknown assignee yields an empty list, not an
 * error: asking "what can X claim?" for an X with no cards is a normal answer.
 * The one exception is the pool read: `includeUnassigned` still returns the
 * unassigned cards when the assignee resolves to no dictionary entry, because
 * the pool is not that assignee's to resolve.
 *
 * @param {object} ctx
 * @param {{assignee: string, stale?: boolean, includeUnassigned?: boolean}} input
 */
export function listCandidates(ctx, input = {}) {
  const assignee = String(input.assignee ?? "").trim();
  const includeUnassigned = input.includeUnassigned === true;
  const ids = assigneeEntryIds(ctx, assignee);
  if (ids.length === 0 && !includeUnassigned) return [];

  const now = ctx.now();
  const isAssignee = (task) => task.kind !== "epic" && ids.includes(task.assigneeId);
  const ready = ctx.repos.tasks.list({ status: "todo" }).filter(isAssignee);
  const pool = includeUnassigned
    ? ctx.repos.tasks
        .list({ status: "todo" })
        .filter((task) => task.kind !== "epic" && (task.assigneeId === null || task.assigneeId === undefined || task.assigneeId === ""))
    : [];
  const stale =
    input.stale === true
      ? ctx.repos.tasks
          .list({ status: "in_progress" })
          .filter((task) => isAssignee(task) && staleReason(task, assignee, now) !== null)
      : [];

  const projects = new Map();
  const projectOf = (id) => {
    if (!projects.has(id)) projects.set(id, ctx.repos.projects.get(id));
    return projects.get(id);
  };

  const found = [];
  for (const task of ready) {
    if (allBlockersDone(ctx, task.id)) found.push({ task, reason: "ready" });
  }
  for (const task of pool) {
    if (allBlockersDone(ctx, task.id)) found.push({ task, reason: "unassigned" });
  }
  for (const task of stale) {
    const reason = staleReason(task, assignee, now);
    if (reason !== null && allBlockersDone(ctx, task.id)) found.push({ task, reason });
  }

  // Ready, then the pool this agent may take, then recovery — every rank then
  // falls back to the board's own deterministic order.
  const rank = { ready: 0, unassigned: 1, stale_same: 2, stale_any: 2 };
  found.sort(
    (a, b) =>
      rank[a.reason] - rank[b.reason] ||
      (a.task.sortOrder ?? 0) - (b.task.sortOrder ?? 0) ||
      (a.task.createdAt ?? "").localeCompare(b.task.createdAt ?? "") ||
      (a.task.projectId ?? "").localeCompare(b.task.projectId ?? "") ||
      (a.task.identifier ?? "").localeCompare(b.task.identifier ?? ""),
  );
  return found.map(({ task, reason }) => candidateOf(task, reason, projectOf(task.projectId)));
}

/**
 * The dictionary entries that name `assignee`: by id, by exact display name, or
 * by normalised name. A read is inclusive — every matching entry's id is kept,
 * so a name that happens to match two entries returns both sets of cards rather
 * than guessing (the *write* path refuses ambiguity; a read must not).
 *
 * @param {object} ctx
 * @param {string} assignee
 * @returns {string[]}
 */
function assigneeEntryIds(ctx, assignee) {
  if (assignee === "") return [];
  const normName = normalizeName(assignee);
  const ids = [];
  for (const entry of ctx.repos.dictionary.list("assignee")) {
    if (entry.id === assignee || entry.displayName === assignee || entry.normalizedName === normName) {
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
  }
  return ids;
}

/**
 * Why an `in_progress` task is in the recovery pool, or `null` when it is not.
 * Mirrors `poll.mjs`: `stale_any` wins over `stale_same`, and both are strict
 * `>` comparisons. A task with no heartbeat is not surfaced — it is an
 * execution-state anomaly the claim path refuses anyway, not a candidate.
 *
 * @param {object} task
 * @param {string} assignee
 * @param {string} now
 * @returns {"stale_same"|"stale_any"|null}
 */
function staleReason(task, assignee, now) {
  if (task.heartbeatAt === null || task.heartbeatAt === undefined || task.heartbeatAt === "") return null;
  const age = new Date(now).getTime() - new Date(task.heartbeatAt).getTime();
  if (!Number.isFinite(age) || age < 0) return null;
  if (age > CLAIM_STALE_ANY_MS) return "stale_any";
  if (task.claimedBy === assignee && age > CLAIM_STALE_SAME_MS) return "stale_same";
  return null;
}

/**
 * Every `blocks` edge pointing at `taskId` (its `depends_on`) is `done`.
 * @param {object} ctx
 * @param {string} taskId
 * @returns {boolean}
 */
function allBlockersDone(ctx, taskId) {
  return ctx.repos.relations
    .listBlockerOf(taskId)
    .every((edge) => ctx.repos.tasks.get(edge.source)?.status === "done");
}

/**
 * The candidate projection: exactly the card's fields, plus `reason` so the
 * poll can rank ready against recovery without re-deriving it.
 * @param {object} task
 * @param {string} reason
 * @param {object|null} project
 */
function candidateOf(task, reason, project) {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project: task.projectId,
    target: project?.workspacePath ?? "",
    sort: task.sortOrder ?? 0,
    reason,
  };
}

/**
 * Whether a move would be allowed, without doing it — the question a UI asks
 * before offering a button.
 *
 * @param {object} ctx
 * @param {{taskId: string, to: string}} input
 */
export function canMove(ctx, input) {
  const task = ctx.repos.tasks.get(input.taskId);
  if (task === null) {
    throw new DomainError("NOT_FOUND", { message: `no task ${input.taskId}`, details: { taskId: input.taskId } });
  }
  const verdict = checkDeliveryGate({
    task,
    reports: ctx.repos.reports.listGateReports(task.id),
    to: input.to,
  });
  if (!verdict.ok) return verdict;
  try {
    assertTransition(task.status, input.to);
  } catch (err) {
    return { ok: false, reason: err.code, details: err.details };
  }
  return { ok: true };
}
