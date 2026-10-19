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
import {
  CLAIM_STALE_ANY_MS,
  CLAIM_STALE_SAME_MS,
  HEARTBEAT_FRESH_MS,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_ORDER_DEFAULT,
  TASK_ORDER_MODES,
} from "../../shared/constants.mjs";
import { orderTasks, taskOrderDebugEntry } from "../../shared/task-order.mjs";
import {
  assertClaimable,
  decideClaim,
  explainLostClaim,
  isAutoClaimableKind,
  isUnownedContainer,
} from "../domain/claim.mjs";
import {
  assertCreationGate,
  assertDeliveryGate,
  assertWaiverRequest,
  checkDeliveryGate,
  WAIVER_MIN_REASON_CHARS,
} from "../domain/delivery-gate.mjs";
import { assertAcceptanceAuthority, assertTransition } from "../domain/status.mjs";
import { assertAwaitingReason } from "../domain/awaiting.mjs";
import { normalizeBlockedReason } from "../domain/blocked-reason.mjs";
import { STATUS } from "../domain/enums.mjs";
import { hasIdemDiscriminator, idemKey, idemSource, normalizeIdem } from "../domain/idem.mjs";
import { isArchivable, normalizeTaskCreate, normalizeTaskUpdate } from "../domain/task.mjs";
import { assertEpicDowngradeAllowed } from "../domain/relation.mjs";
import { normalizeLabelName } from "../domain/labels.mjs";
import { normalizeName } from "../domain/dictionary.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";
import { addComment } from "./comments.mjs";
import { resolveActorId, resolveAssignment } from "./dictionary.mjs";
import { resolveLabels } from "./labels.mjs";
import { advanceContainerForChild, startContainerForChild } from "./rollup.mjs";

/**
 * @param {object} ctx
 * @param {{projectId: string, title: string, actor: object, assignee?: string, assigneeKind?: string, reporter?: string, reporterKind?: string, forceCreate?: boolean, idem?: string, allowDup?: boolean, reviewOf?: string, parent?: string, [key: string]: unknown}} input
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
      // door the HTTP and CLI faces share; refusing here — before any
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
      // The card's own `target` — an opaque value now, carried in its meta. It is
      // not a top-level create field: the board no longer owns a project
      // directory, so there is nothing to derive it from.
      const targetKey = String(input.meta?.target ?? "").trim();
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
        const resolved = resolveAssignment({ repos: ctx.repos, now }, {
          kind: "assignee",
          name: input.assignee,
          actorKind: input.assigneeKind ?? "agent",
          forceCreate: input.forceCreate,
        });
        Object.assign(candidate, resolved.patch);
        dictionaryAudit.push(...resolved.audit);
      }
      if (input.reporter !== undefined && input.reporter !== null) {
        const resolved = resolveAssignment({ repos: ctx.repos, now }, {
          kind: "reporter",
          name: input.reporter,
          actorKind: input.reporterKind ?? "human",
          forceCreate: input.forceCreate,
        });
        // Both columns, not just the id: `resolveAssignment` carries the kind the
        // reference was made under, and assigning only the id here was how the
        // kind went missing on this path before `0023` put it back on the record.
        Object.assign(candidate, resolved.patch);
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
        const resolved = resolveAssignment({ repos: ctx.repos, now }, { kind: "assignee", name: input.assignee, forceCreate: input.forceCreate });
        Object.assign(patch, resolved.patch);
        dictionaryAudit.push(...resolved.audit);
      }
      if (input.reporter !== undefined) {
        const resolved = resolveAssignment({ repos: ctx.repos, now }, { kind: "reporter", name: input.reporter, actorKind: "human", forceCreate: input.forceCreate });
        Object.assign(patch, resolved.patch);
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

/**
 * The staleness bound a takeover hands to the repository (R3).
 *
 * The verdict already decided *that* the claim may be taken; this says *how
 * old* the heartbeat it is taking must be, so the predicate reaches SQL instead
 * of living only here. `verdict.steal` distinguishes the two cases
 * `decideClaim` folds into `reclaim`: a claim rotted past six hours (anybody may
 * take it) versus one that merely went stale for its holder (only the holder
 * may). Each bound is the threshold that verdict was decided on, one instant
 * earlier — the same comparison `decideClaim` makes, now also made by the
 * writer.
 *
 * @param {string} now @param {boolean} stolen
 */
function staleBound(now, stolen) {
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `claim: 'now' is not a usable timestamp (${String(now)})`,
      details: { field: "now", received: String(now) },
    });
  }
  return new Date(at - (stolen ? CLAIM_STALE_ANY_MS : HEARTBEAT_FRESH_MS)).toISOString();
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
  // Since `0020` `tasks.claimed_by` holds an actor **id**, not a name. The claim
  // holder and the actor `--agent`/`$USER` named are the same person only through
  // the dictionary, so the name is resolved here — once, in the command layer —
  // and every comparison below (`assertClaimable`'s `holder === actor`, the CAS,
  // the loss explainer) works on ids. The audit row still records the *name*:
  // `task_activities.actor_id` is deliberately a free string (0020's boundary).
  const claimantId = resolveActorId(
    { repos: ctx.repos, now },
    { name: actor.id, actorKind: actor.kind },
  );
  const verdict = assertClaimable(current, {
    actor: claimantId,
    now,
    allowSteal: allowSteal === true,
    resolveAssignee,
    // The holder is an actor id since 0020; name it in the refusal message the
    // way the audit trail names it (the command layer is what has the dictionary).
    describeHolder: (id) => readableHolder(ctx, id),
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
    // Re-claiming an in_progress card: the CAS must match status='in_progress'
    // *and* the heartbeat the verdict judged stale — the repository enforces the
    // bound rather than trusting this call site (R3).
    task = ctx.repos.tasks.stealStaleClaim({
      id: current.id,
      ifVersion,
      actor: claimantId,
      // The claim is a record, so it records the kind it was made under — the
      // acting platform, beside the holder (0023).
      claimedKind: actor.kind,
      now,
      staleBefore: staleBound(now, verdict.steal === true),
    });
  } else {
    const result = ctx.repos.tasks.claimCas({
      id: current.id,
      ifVersion,
      actor: claimantId,
      claimedKind: actor.kind,
      now,
    });
    if (!result.claimed) {
      throw explainLostClaim({
        before: current,
        after: result.task,
        actor: claimantId,
        now,
        ifVersion,
        allowSteal: allowSteal === true,
        resolveAssignee,
        describeHolder: (id) => readableHolder(ctx, id),
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
      ...(verdict.steal === true ? { stoleFrom: readableHolder(ctx, verdict.stolenFrom) } : {}),
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
      body: stealCommentBody(task, { ...verdict, stolenFrom: readableHolder(ctx, verdict.stolenFrom) }, actor, stealReason),
      actor,
    });
  }

  // A child that enters the work starts its container (commands/rollup.mjs).
  // This is the claim path — `issue claim` and `issue move <ref> in_progress`
  // both land here — and it is guarded on a real transition so a re-claim of a
  // card already in progress does not write a second note.
  if (task.status === STATUS.IN_PROGRESS && current.status !== STATUS.IN_PROGRESS) {
    startContainerForChild(ctx, task.id, now);
  }

  return { task, reused: false, stole: verdict.steal === true };
}

/**
 * The held-by value a takeover message names, as a person rather than an id.
 *
 * `decideClaim` reports the previous holder straight off the row, which since
 * `0020` is an actor **id**; the audit comment and the activity's `stoleFrom`
 * should read like a sentence, so it is resolved to the display name. An
 * `--allow-steal` takeover already reports the assignee's display name (it never
 * had an id), so the lookup misses and the value passes through unchanged.
 */
function readableHolder(ctx, value) {
  if (value === undefined || value === null) return value;
  const entry = ctx.repos.dictionary.getById("actor", value);
  return entry?.displayName ?? value;
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
        // An epic's unowned `in_progress` is the container auto-start, by
        // design (`rollup.mjs#startContainer`). There is still nothing to
        // pulse — an epic is never anybody's work card — but it is not I2
        // corruption, which is about a work card that lost its holder.
        if (isUnownedContainer(existing)) {
          throw new DomainError("INVALID_TRANSITION", {
            message: `${existing.identifier} is an epic; a container carries no claim — nothing to pulse`,
            details: { taskId: existing.id, status: existing.status, kind: existing.kind },
          });
        }
        throw new DomainError("EXECUTION_STATE_CORRUPT", {
          message: `${existing.identifier} is in_progress but nobody claims it`,
          details: { taskId: existing.id, status: existing.status },
        });
      }
      // `claimed_by` is an actor id since 0020, so the holder is matched through
      // the dictionary: the pulsing actor's name resolves to the same row the
      // claim wrote (the audit row below keeps the name).
      const holderId = resolveActorId({ repos: ctx.repos, now }, { name: actor.id, actorKind: actor.kind });
      const task = ctx.repos.tasks.setHeartbeat({
        id: input.id,
        actor: holderId,
        now,
        // Name the holder in an `EXECUTION_ACTIVE` refusal (0020: `claimed_by` is
        // an id), the same way the claim refusals do.
        describeHolder: (id) => readableHolder(ctx, id),
      });
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
 * @param {{id: string, to: string, actor: object, ifVersion?: number, noReport?: boolean, reason?: string, allowSteal?: boolean, awaitingReason?: string|null, blockedReason?: string|null}} input
 */
export function moveStatus(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();
  const waiverReason = input.noReport === true ? assertWaiverRequest({ noReport: true, reason: input.reason, to: input.to }) : null;
  // M1 — entering `awaiting` must name *which* category of question it is
  // (design §2.1: an enumeration, never free text). Validated here, before the
  // transaction, so a missing reason is refused without having read the board;
  // a move to any other status carries no reason (the column is cleared).
  const awaitingReason =
    input.to === STATUS.AWAITING ? assertAwaitingReason(input.awaitingReason) : null;
  // 0016 — entering `blocked` *may* name the class of the block (SLA-inspection
  // contract §7). Normalized, not asserted: an unstated reason is legal — the
  // inspector reads it as `clarify` — so the only refusal here is a supplied
  // value that is not one of the literals. Any other destination clears it.
  const blockedReason =
    input.to === STATUS.BLOCKED ? normalizeBlockedReason(input.blockedReason) : null;

  return transaction(
    ctx.db,
    () => {
      const current = ctx.repos.tasks.get(input.id);
      if (current === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
      }

      assertTransition(current.status, input.to, current.kind);
      // `done` is acceptance, not delivery: only a human or the board itself may
      // perform it. A worker stops at `in_review` (the review card is how the
      // loop's independent reviewer reports; the loop — `system` — applies it).
      if (input.to === STATUS.DONE) assertAcceptanceAuthority(actor);

      // `todo → in_progress` **is** a claim (T-20261009-230500): it must respect
      // the routing lock and stamp `claimed_by/claimed_at/heartbeat_at`, so the
      // CLI (`issue move`) and HTTP surfaces mean the same thing. Every
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
        awaitingReason,
        blockedReason,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: waiver === null ? "task_moved" : "report_waived",
        changes:
          waiver === null
            ? {
                from: current.status,
                to: task.status,
                deliveryRound: task.deliveryRound,
                // M1 — record the entry category alongside the move, so the
                // card's history says *why* it stopped for a human.
                ...(awaitingReason === null ? {} : { awaitingReason }),
                // 0016 — and the same for a block's class, so the trail keeps
                // the reason even after `blocked_reason` is cleared on exit.
                ...(blockedReason === null ? {} : { blockedReason }),
              }
            : {
                from: current.status,
                to: task.status,
                round: waiver.round,
                reason: waiver.reason,
                deliveryRound: task.deliveryRound,
              },
        createdAt: now,
      });
      // A card that re-enters the work (a rework from `in_review`, an unblock)
      // starts its container too: the claim path above is not the only way into
      // `in_progress` (commands/rollup.mjs).
      if (task.status === STATUS.IN_PROGRESS) startContainerForChild(ctx, task.id, now);
      // The container closes itself when its last child lands
      // (commands/rollup.mjs): the same transaction, so a child can never be
      // `done` on a board where its epic still looks unfinished. `canceled` is
      // terminal too, so a cancellation can be the transition that completes the
      // set — it re-checks the container for the same reason `done` does.
      if (task.status === STATUS.DONE || task.status === STATUS.CANCELED) {
        advanceContainerForChild(ctx, task.id, now);
      }
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
 * The board / list read.
 *
 * Two orders exist and one of them is opt-in (contract §7.1):
 *
 *   * `board` (the default, and what every caller got before this existed) — the
 *     repository's `sort_order, created_at, project_id, identifier`;
 *   * `weight` — the assignee weight order (`shared/task-order.mjs`), requested
 *     with `?order=weight`.
 *
 * The default is deliberately untouched: the existing order is a frozen
 * commitment (md export reuses the same `ORDER BY`) and the weight order is
 * clock-dependent, so switching the default would change behaviour where nothing
 * tests it.
 *
 * @param {object} ctx
 * @param {{projectId?: string, status?: string|string[], assigneeId?: string|string[], includeArchived?: boolean, limit?: number, offset?: number, order?: string, orderDebug?: boolean}} [filter]
 */
export function listTasks(ctx, filter = {}) {
  return readOrdered(ctx, filter).tasks;
}

/**
 * `listTasks` plus the `order_debug` projection, for the surface that wants both.
 *
 * A separate function rather than a changed return shape: every existing caller
 * of `listTasks` receives a bare array and must keep receiving one.
 *
 * @param {object} ctx
 * @param {object} [filter] as `listTasks`, plus `orderDebug`
 * @returns {{tasks: object[], orderDebug: object[]|null}}
 */
export function listOrderedTasks(ctx, filter = {}) {
  const { tasks, orderDebug } = readOrdered(ctx, filter);
  return { tasks, orderDebug };
}

/**
 * Validate `?order=` and let `order_debug` select the order it projects.
 *
 * `order_debug=1` is the *weight* order's diagnostic, so asking for it selects
 * that order — there is no board-order debug projection to return, and silently
 * ignoring the flag would be worse than honouring it.
 *
 * @param {unknown} value @param {boolean} debug
 */
function resolveOrder(value, debug) {
  if (debug) return "weight";
  if (value === undefined || value === null || value === "") return TASK_ORDER_DEFAULT;
  const word = String(value).trim().toLowerCase();
  if (TASK_ORDER_MODES.includes(word)) return word;
  throw new DomainError("VALIDATION_FAILED", {
    message: `unknown order ${JSON.stringify(value)}`,
    details: { field: "order", received: value, allowed: TASK_ORDER_MODES },
  });
}

/**
 * Read a scope and order it.
 *
 * **Scope first, then order** (R16). Under `order=weight` the filter goes into
 * SQL with **no `LIMIT`**, the weight order is computed over that whole set, and
 * only then is the page sliced. Ordering the `LIMIT 200` page would be "the wrong
 * page, very neatly sorted" — the defect the contract names.
 *
 * The relation counts come from one batched read (`relations.openEdgeCounts`),
 * never one per card.
 *
 * @param {object} ctx @param {object} filter
 * @returns {{tasks: object[], orderDebug: object[]|null}}
 */
function readOrdered(ctx, filter) {
  const { order: requestedOrder, orderDebug: debugFlag, ...scope } = filter;
  const order = resolveOrder(requestedOrder, debugFlag === true);
  if (order !== "weight") return { tasks: ctx.repos.tasks.list(scope), orderDebug: null };

  const scoped = ctx.repos.tasks.list({ ...scope, limit: null });
  const counts = ctx.repos.relations.openEdgeCounts(scoped.map((task) => task.id));
  const ranked = orderTasks(withRelationCounts(scoped, counts), { now: ctx.now() });

  const offset = Number.isInteger(scope.offset) ? scope.offset : 0;
  // `limit: null` is the caller's "give me the whole set" (the repository reads it
  // the same way), so the JS page must not re-impose the default on top of it.
  const limit = Number.isInteger(scope.limit) ? scope.limit : TASK_LIST_DEFAULT_LIMIT;
  const page = scope.limit === null ? ranked.slice(offset) : ranked.slice(offset, offset + limit);
  return {
    tasks: page.map((item) => item.card),
    // The projection covers the whole ranking, not the page — the question it
    // answers is "why is this card where it is", and that needs the cards it beat.
    orderDebug: ranked.map(taskOrderDebugEntry),
  };
}

/** Attach the two relation counts the weight order reads, defaulting to none. */
function withRelationCounts(tasks, counts) {
  return tasks.map((task) => ({ ...task, ...(counts.get(task.id) ?? NO_OPEN_EDGES) }));
}

const NO_OPEN_EDGES = Object.freeze({ blockersOpen: 0, unblocksOpen: 0 });

/**
 * The claimable candidates for an assignee — the read a poll performs *before*
 * claiming, kept in lockstep with the openclaw-team `poll.mjs#scanCandidates`
 * criteria so a provider swap changes nothing on the framework side.
 *
 * A candidate is:
 *   * `ready` — `todo`, assigned to `assignee`, **auto-claimable** (not an
 *     `epic`, not a `deploy`), and every `blocks` edge pointing at it (its
 *     `depends_on`) is `done`;
 *   * `unassigned` — with `includeUnassigned: true`, a `todo`, auto-claimable,
 *     `depends_on`-done card with no assignee: the public pool any actor may
 *     claim (see `domain/claim.mjs#isAssignee`). This is the read a supervisor
 *     uses when its policy is "claim unassigned tasks too";
 *   * with `stale: true`, `in_progress` whose heartbeat is stale — the same
 *     holder after 30 minutes (`stale_same`) or anyone after 6 hours
 *     (`stale_any`) — the recovery pool.
 *
 * **Deployment cards are withheld** (T-20261013-232004): a `kind: deploy` card
 * runs against a live instance, so it is dispatched explicitly rather than
 * picked up by a poll. This read — the poll's read — never offers one, in any of
 * the three pools. The card stays claimable: the exclusion is
 * `domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS`, a *read* rule, and the claim
 * gate deliberately does not refuse `deploy` (unlike `epic`, which it does).
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
  return orderedCandidates(ctx, input).candidates;
}

/**
 * `listCandidates` plus the `order_debug` projection (contract §7.1).
 *
 * @param {object} ctx
 * @param {object} [input] as `listCandidates`, plus `order` / `orderDebug`
 * @returns {{candidates: object[], orderDebug: object[]|null}}
 */
export function listOrderedCandidates(ctx, input = {}) {
  const { candidates, orderDebug } = orderedCandidates(ctx, input);
  return { candidates, orderDebug };
}

/** The bucket order (S3): what a card is *claimable as*, a ruling, not a preference. */
const CANDIDATE_BUCKET_RANK = Object.freeze({ ready: 0, unassigned: 1, stale_same: 2, stale_any: 2 });

/**
 * The candidate read, in whatever order was asked for.
 *
 * **The scope is pushed into SQL** (R16). The previous form read
 * `list({status:"todo"})` — which the repository caps at 200 rows — and filtered
 * by assignee *in JS*, so an assignee whose claimable card sat past row 200 never
 * saw it. Here the status *and* the assignee set are predicates, the read is
 * unbounded, and the order is computed over the assignee's whole pool.
 *
 * @param {object} ctx
 * @param {{assignee?: string, stale?: boolean, includeUnassigned?: boolean, order?: string, orderDebug?: boolean}} [input]
 * @returns {{candidates: object[], orderDebug: object[]|null}}
 */
function orderedCandidates(ctx, input = {}) {
  const assignee = String(input.assignee ?? "").trim();
  const includeUnassigned = input.includeUnassigned === true;
  const ids = assigneeEntryIds(ctx, assignee);
  const order = resolveOrder(input.order, input.orderDebug === true);
  if (ids.length === 0 && !includeUnassigned) return { candidates: [], orderDebug: order === "weight" ? [] : null };

  const now = ctx.now();
  const isAssignee = (task) => isAutoClaimableKind(task.kind) && ids.includes(task.assigneeId);
  // Every read below is the *whole* scope: no `LIMIT` to truncate it first.
  const ready =
    ids.length === 0 ? [] : ctx.repos.tasks.list({ status: STATUS.TODO, assigneeId: ids, limit: null }).filter(isAssignee);
  const pool = includeUnassigned
    ? ctx.repos.tasks
        .list({ status: STATUS.TODO, unassignedOnly: true, limit: null })
        .filter((task) => isAutoClaimableKind(task.kind))
    : [];
  const stale =
    input.stale === true && ids.length > 0
      ? ctx.repos.tasks
          .list({ status: STATUS.IN_PROGRESS, assigneeId: ids, limit: null })
          .filter((task) => isAssignee(task) && staleReason(task, ids, now) !== null)
      : [];

  // One batched edge read for every pool, not one per card (R16).
  const scoped = [...ready, ...pool, ...stale];
  const counts = ctx.repos.relations.openEdgeCounts(scoped.map((task) => task.id));
  const blockersOpen = (task) => (counts.get(task.id) ?? NO_OPEN_EDGES).blockersOpen;

  const found = [];
  // `allBlockersDone` as a count: an open `blocks` predecessor is what holds a
  // card back, whether it says so through `status = blocked` or not (R14).
  for (const task of ready) {
    if (blockersOpen(task) === 0) found.push({ task, reason: "ready" });
  }
  for (const task of pool) {
    if (blockersOpen(task) === 0) found.push({ task, reason: "unassigned" });
  }
  for (const task of stale) {
    const reason = staleReason(task, ids, now);
    if (reason !== null && blockersOpen(task) === 0) found.push({ task, reason });
  }

  const byWeight =
    order === "weight"
      ? new Map(orderTasks(withRelationCounts(scoped, counts), { now }).map((item) => [item.card.id, item]))
      : null;

  // Ready, then the pool this agent may take, then recovery. The weight order
  // refines **within** a bucket and never reorders across one: the bucket says
  // whether the card can be claimed at all, which the contract (S3) keeps as the
  // first key because it is a ruling rather than a preference.
  found.sort((a, b) => {
    const byBucket = CANDIDATE_BUCKET_RANK[a.reason] - CANDIDATE_BUCKET_RANK[b.reason];
    if (byBucket !== 0) return byBucket;
    if (byWeight !== null) return byWeight.get(a.task.id).rank - byWeight.get(b.task.id).rank;
    return (
      (a.task.sortOrder ?? 0) - (b.task.sortOrder ?? 0) ||
      (a.task.createdAt ?? "").localeCompare(b.task.createdAt ?? "") ||
      (a.task.projectId ?? "").localeCompare(b.task.projectId ?? "") ||
      (a.task.identifier ?? "").localeCompare(b.task.identifier ?? "")
    );
  });

  return {
    candidates: found.map(({ task, reason }) => candidateOf(task, reason)),
    // In the order the caller receives them, so the two arrays reconcile
    // line for line; `reason` rides along because the bucket is the first key.
    orderDebug:
      byWeight === null ? null : found.map(({ task, reason }) => ({ ...taskOrderDebugEntry(byWeight.get(task.id)), reason })),
  };
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
 * `stale_same` means "the holder is the person who is asking", a comparison that
 * since `0020` is between actor **ids** (`claimed_by` holds one, and `assigneeIds`
 * are the ids the asked-for name resolves to — `assigneeEntryIds`). Comparing a
 * name to the stored value is exactly the bug the FK removed.
 *
 * @param {object} task
 * @param {string[]} assigneeIds the actor ids the requested assignee resolves to
 * @param {string} now
 * @returns {"stale_same"|"stale_any"|null}
 */
function staleReason(task, assigneeIds, now) {
  if (task.heartbeatAt === null || task.heartbeatAt === undefined || task.heartbeatAt === "") return null;
  const age = new Date(now).getTime() - new Date(task.heartbeatAt).getTime();
  if (!Number.isFinite(age) || age < 0) return null;
  if (age > CLAIM_STALE_ANY_MS) return "stale_any";
  if (assigneeIds.includes(task.claimedBy) && age > CLAIM_STALE_SAME_MS) return "stale_same";
  return null;
}

/**
 * The candidate projection: exactly the card's fields, plus `reason` so the
 * poll can rank ready against recovery without re-deriving it.
 *
 * There is no `target` here (O3): a project owns no directory, so the board has
 * no workspace to project onto a candidate. A dispatch consumer that needs a
 * location resolves one from `project` against its own mapping.
 * @param {object} task
 * @param {string} reason
 */
function candidateOf(task, reason) {
  const meta = task.meta ?? {};
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project: task.projectId,
    sort: task.sortOrder ?? 0,
    reason,
    // A review card names the card it audits (`meta.review_of`) and the round it
    // audits (`meta.review_round`), so the supervisor can pick the review
    // handoff at wake time without a second `issue get`. Both are `null` for a
    // normal card; the round is coerced because `--meta` values arrive as
    // strings while a JSON metadata write may carry a number.
    review_of: nonEmptyString(meta.review_of),
    review_round: integerOrNull(meta.review_round),
  };
}

/** A meta value as a non-empty string, or `null`. */
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A meta value as an integer, or `null` — numbers and digit strings both. */
function integerOrNull(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
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
    assertTransition(task.status, input.to, task.kind);
  } catch (err) {
    return { ok: false, reason: err.code, details: err.details };
  }
  return { ok: true };
}
