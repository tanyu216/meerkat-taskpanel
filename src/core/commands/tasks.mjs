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

import { DomainError, isDomainError } from "../../foundation/errors.mjs";
import {
  CLAIM_STALE_ANY_MS,
  CLAIM_STALE_SAME_MS,
  HEARTBEAT_FRESH_MS,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_ORDER_DEFAULT,
  TASK_ORDER_MODES,
} from "../../foundation/constants.mjs";
import { orderTasks, taskOrderDebugEntry } from "../../foundation/task-order.mjs";
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
import { assertTransition, isReopen, isTerminalStatus } from "../domain/status.mjs";
import { acceptanceKey, normalizeAcceptanceList } from "../domain/acceptance.mjs";
import { resolveReviewRequired, reviewRequiredOf } from "../domain/review-policy.mjs";
import {
  assertAwaitingReason,
  isAnsweredAfter,
  latestQuestion,
} from "../domain/awaiting.mjs";
import { normalizeBlockedReason } from "../domain/blocked-reason.mjs";
import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { hasIdemDiscriminator, idemKey, idemSource, normalizeIdem } from "../domain/idem.mjs";
import { isArchivable, normalizeTaskCreate, normalizeTaskUpdate } from "../domain/task.mjs";
import { assertEpicDowngradeAllowed } from "../domain/relation.mjs";
import { normalizeLabelName } from "../domain/labels.mjs";
import { normalizeName } from "../domain/dictionary.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import {
  assertAcceptance,
  assertAcceptanceCoverage,
  assertChildrenTerminal,
  assertReviewReady,
  currentRoundReviews,
} from "./acceptance.mjs";
import { actorOf } from "./context.mjs";
import { addComment } from "./comments.mjs";
import { resolveActorId, resolveAssignment } from "./dictionary.mjs";
import { resolveLabels } from "./labels.mjs";
import { advanceContainerForChild, hasChildStarted, startContainerForChild } from "./rollup.mjs";

/**
 * @param {object} ctx
 * @param {{projectId: string, title: string, actor: object, assignee?: string, assigneeKind?: string, reporter?: string, reporterKind?: string, forceCreate?: boolean, idem?: string, allowDup?: boolean, reviewOf?: string, reviewRound?: number, parent?: string, [key: string]: unknown}} input
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

      // The gate's INSERT-shaped half. `createTask` is the single door the HTTP
      // and CLI faces share; refusing here — before any row is written — makes
      // `in_review`/`done` unreachable at creation the same way a reportless
      // `task_move` is refused. It is a JS guard, not a trigger, because the
      // gate belongs to this use-case rather than to every INSERT.
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

      // 0025 — the structural review marker. `meta.review_of` holds an
      // identifier (`PROJ-0007`), which is what the loop and the SLA patrol
      // match on; the column holds the internal id, and that is what the
      // acceptance policy reads. Resolve once, here, so a dangling reference is
      // refused instead of silently producing a card that is not exempt.
      //
      // Both spellings are stamped from the same resolution. Before this, a
      // card created through the declared top-level `review_of` field carried
      // only the column, so `workflow.reviewOf`/the SLA patrol/candidate
      // projection (all meta readers) could not find its original.
      const marker = resolveReviewMarker(ctx, input.projectId, input, candidate.kind);
      candidate.reviewOfId = marker.reviewOfId;
      candidate.reviewRound = marker.reviewRound;
      if (marker.reviewOfId !== null) candidate.meta = mirrorReviewMeta(candidate.meta, marker);

      // 0031 — the per-card review decision. The project row is the default; a
      // review card is forced to 0; a deploy card is forced to 1. The result is
      // the snapshot every later dispatch/acceptance decision reads.
      candidate.reviewRequired = resolveReviewRequired({
        policy: project.reviewPolicy,
        requested: input.reviewRequired,
        reviewCard: marker.reviewOfId !== null,
        kind: candidate.kind,
        requireDecision: input.requireReviewDecision === true,
      });

      // 0032 — freeze the acceptance baseline at creation. `meta.acceptance` is
      // the modern spelling; `acceptance_legacy` is the imported fallback. The
      // review card's list is the original's baseline plus the generic checks,
      // so it gets the 64-item ceiling; a normal card is capped at 60.
      candidate.acceptance = normalizeAcceptanceList(
        candidate.meta?.acceptance ?? candidate.meta?.acceptance_legacy ?? [],
        { maxItems: marker.reviewOfId !== null ? 64 : 60 },
      );
      candidate.acceptanceRevision = candidate.acceptance.length > 0 ? 1 : 0;

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
          review_required: task.reviewRequired,
          review_policy: project.reviewPolicy ?? "optional",
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
 * Resolve a create's review reference into the structural marker (0025).
 *
 * `input.reviewOf` (the command/wire field) and `input.meta.review_of` (the
 * loop's metadata convention) are both **identifiers or ids**; the column wants
 * the internal id, resolved in the card's own project. A reference that resolves
 * to nothing, or to another project, is refused: the marker grants the card the
 * review-card acceptance exemption, and that must never be inferred from a name
 * the board cannot confirm.
 *
 * `review_round` is optional and must be a positive integer when present. A
 * round without a reference is refused for the same reason: it would describe an
 * audit that does not exist.
 *
 * @param {object} ctx
 * @param {string} projectId
 * @param {{reviewOf?: unknown, reviewRound?: unknown, meta?: object}} input
 * @param {string} [kind] the new card's kind (already normalized)
 * @returns {{reviewOfId: string|null, reviewRound: number|null, reviewOfIdentifier: string|null}}
 */
function resolveReviewMarker(ctx, projectId, input, kind = TASK_KIND.TASK) {
  const rawRef = input.reviewOf ?? input.meta?.review_of;
  const ref = rawRef === undefined || rawRef === null ? "" : String(rawRef).trim();
  const rawRound = input.reviewRound ?? input.meta?.review_round;
  const roundText = rawRound === undefined || rawRound === null ? "" : String(rawRound).trim();

  if (ref === "") {
    if (roundText !== "") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "review_round requires review_of — a round without a reviewed card describes nothing",
        details: { field: "review_round", received: rawRound },
        hint: { fix: "pass review_of together with review_round, or drop the round" },
      });
    }
    return { reviewOfId: null, reviewRound: null, reviewOfIdentifier: null };
  }

  // A review is a work card the reviewer can claim. An epic cannot be claimed,
  // so an epic review card would never be woken — it would only age. `deploy`
  // is claimable but not a review; everything but `task` is refused.
  if (kind !== TASK_KIND.TASK) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `a review card must be kind=task (got ${JSON.stringify(kind)})`,
      details: { field: "kind", received: kind, allowed: [TASK_KIND.TASK] },
      hint: { fix: "create the review card as a task; an epic cannot be claimed or reviewed" },
    });
  }

  const original = ctx.repos.tasks.resolve(projectId, ref);
  if (original === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `review_of ${JSON.stringify(ref)} does not name a card in this project`,
      details: { field: "review_of", received: rawRef, projectId },
      hint: { fix: "pass the reviewed card's identifier (e.g. PROJ-0007) or its id" },
    });
  }
  if (original.projectId !== projectId) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `review_of ${JSON.stringify(ref)} names a card in another project`,
      details: { field: "review_of", received: rawRef, projectId, originalProjectId: original.projectId },
    });
  }

  // A review cannot itself be reviewed. The structural column is the predicate;
  // the meta key is the compatibility fallback for a row written before 0025.
  const originalIsReview =
    (original.reviewOfId !== null && original.reviewOfId !== undefined) ||
    (typeof original.meta?.review_of === "string" && original.meta.review_of.trim() !== "");
  if (originalIsReview) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `review_of ${JSON.stringify(ref)} names a review card; a review cannot itself be reviewed`,
      details: { field: "review_of", received: rawRef, projectId, reviewed: original.identifier },
      hint: { fix: "reopen or re-deliver the original card; the loop will issue a new review for the new round" },
    });
  }

  // A review is evidence about a delivery. Creating one for a card that has not
  // been delivered (or has already left review) lets the reviewer audit a state
  // that does not exist, and `review_round` would describe a delivery that never
  // happened. The loop only dispatches for `in_review` originals; this closes
  // the race between its snapshot and the create.
  if (original.status !== STATUS.IN_REVIEW) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `review_of ${JSON.stringify(ref)} names ${original.identifier}, which is ${original.status}; ` +
        "a review requires the original in in_review",
      details: {
        field: "review_of",
        received: rawRef,
        projectId,
        original: original.identifier,
        status: original.status,
        expected: STATUS.IN_REVIEW,
        deliveryRound: original.deliveryRound,
      },
      hint: { fix: "deliver the original first: taskctl issue deliver <ref> --report-file -" },
    });
  }

  let round = null;
  if (roundText !== "") {
    round = Number(roundText);
    if (!Number.isInteger(round) || round <= 0) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `review_round must be a positive integer (got ${JSON.stringify(rawRound)})`,
        details: { field: "review_round", received: rawRound },
      });
    }
    // The audited round is the original's current round. A future or stale
    // round can never produce a satisfying outcome; catch it at creation
    // instead of later as `round_mismatch` / `review_stale_round`.
    if (round !== original.deliveryRound) {
      throw new DomainError("VALIDATION_FAILED", {
        message:
          `review_round ${round} does not match ${original.identifier}'s current delivery round ` +
          `${original.deliveryRound}`,
        details: { field: "review_round", received: rawRound, expected: original.deliveryRound },
        hint: {
          fix:
            "use the original's current delivery_round, or omit review_round for a " +
            "round-agnostic review",
        },
      });
    }
  }
  return { reviewOfId: original.id, reviewRound: round, reviewOfIdentifier: original.identifier };
}

/**
 * Write the readable mirror of the review marker into `meta`.
 *
 * The meta keys are what the loop's snapshot readers match on
 * (`workflow.reviewOf`, the SLA patrol's `reviewOfRefs`, the candidate
 * projection), while the columns are what the acceptance gate reads. A card
 * that carried only the columns looked like a review card to `isReviewCard`
 * but had no resolvable original, so its verdict was never applied.
 *
 * Returns a new object and never mutates `meta`: `normalizeTaskCreate` keeps
 * the caller's object by reference. The value is normalized rather than
 * trusted — the original's identifier, an integer round — and `review_round` is
 * omitted, not written as null, for a card that audits every round (the
 * readers' "absent means any round" reading).
 *
 * @param {object|null|undefined} meta
 * @param {{reviewOfIdentifier: string|null, reviewRound: number|null}} marker
 * @returns {object}
 */
function mirrorReviewMeta(meta, marker) {
  const next = { ...(meta ?? {}), review_of: marker.reviewOfIdentifier };
  if (marker.reviewRound === null || marker.reviewRound === undefined) delete next.review_round;
  else next.review_round = marker.reviewRound;
  return next;
}

/**
 * Canonicalize a meta patch against the immutable review columns.
 *
 * The columns are the authority; `meta` is the readable mirror. A review card's
 * patch therefore gets the original's identifier and the audited round back,
 * whatever it carried; a card without a marker loses both keys, which also
 * closes the reverse drift (a `meta.review_of` on an ordinary card would make
 * `isReviewCard`'s compatibility fallback disagree with the acceptance gate).
 * Every other key is preserved — including the loop's `rework_round`, which
 * lives on the original, not on a review card.
 *
 * @param {{tasks: {get: (id: string) => object|null}}} repos
 * @param {object} current the task being patched
 * @param {object} meta the caller's patch value
 * @returns {object}
 */
function canonicalReviewMeta(repos, current, meta) {
  if (current.reviewOfId === null || current.reviewOfId === undefined) {
    const next = { ...(meta ?? {}) };
    delete next.review_of;
    delete next.review_round;
    return next;
  }
  // `foreign_keys=ON` (driver.mjs) plus 0025's immutable marker mean a set
  // `reviewOfId` always names a card that still exists.
  const original = repos.tasks.get(current.reviewOfId);
  return mirrorReviewMeta(meta, {
    reviewOfIdentifier: original.identifier,
    reviewRound: current.reviewRound ?? null,
  });
}

/**
 * A review waiver is an audited exception, like a report waiver or a takeover:
 * the reason is what a reader needs to understand why a required check was
 * skipped.
 *
 * @param {unknown} reason
 * @returns {string}
 */
function assertReviewOverrideReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < WAIVER_MIN_REASON_CHARS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `waiving a required review needs --reason with at least ${WAIVER_MIN_REASON_CHARS} characters`,
      details: {
        field: "reason",
        received: typeof reason === "string" ? reason : null,
        minLength: WAIVER_MIN_REASON_CHARS,
      },
      hint: { fix: 'e.g. --reason "documentation-only change; no independent reviewer is needed"' },
    });
  }
  return text;
}

/**
 * Apply the controlled `review_required` change.
 *
 * Asymmetric on purpose:
 *
 *   * `false → true` — any writer may escalate; it only adds a review.
 *   * `true → false` — a human only, with a reason, and only when no current
 *     round review card is still open. An agent must not be able to waive the
 *     check on its own work.
 *
 * Review cards and terminal cards are refused. The generic `updateCas` path
 * cannot reach this column (`reviewRequired` is not in `PATCHABLE`), so an
 * override always leaves this one activity row.
 *
 * @param {object} ctx
 * @param {{task: object, value: boolean, reason?: string, actor: object, now: string, ifVersion?: number}} input
 * @returns {object} the current task when the value did not change
 */
function applyReviewOverride(ctx, input) {
  const { task, value, reason, actor, now, ifVersion } = input;
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a review card's review_required marker cannot be changed",
      details: { field: "review_required", taskId: task.id, reviewOfId: task.reviewOfId },
    });
  }
  if (isTerminalStatus(task.status)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `cannot change review_required on a ${task.status} card`,
      details: { field: "review_required", status: task.status },
    });
  }

  const currentValue = reviewRequiredOf(task.reviewRequired);
  if (value === currentValue) return task;

  let waiverReason = null;
  if (value === true) {
    const project = ctx.repos.projects.get(task.projectId);
    if (project?.reviewPolicy === "off") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "this project has review off; a card cannot opt in",
        details: {
          field: "review_required",
          projectId: task.projectId,
          policy: project.reviewPolicy,
        },
      });
    }
  } else {
    if (actor.kind !== "human") {
      throw new DomainError("ACCEPTANCE_FORBIDDEN", {
        message: "only a human may waive a card's required review",
        details: { field: "review_required", actorKind: actor.kind, actorId: actor.id },
        hint: { fix: "a human can run this with --as-human, or let the review finish" },
      });
    }
    waiverReason = assertReviewOverrideReason(reason);
    const open = currentRoundReviews(ctx, task).filter((review) => !isTerminalStatus(review.status));
    if (open.length > 0) {
      throw new DomainError("REVIEW_PENDING", {
        message:
          `${task.identifier} still has an open review for its current delivery round; ` +
          "close or cancel it first",
        details: {
          taskId: task.id,
          identifier: task.identifier,
          round: task.deliveryRound,
          pending: open.map((review) => ({ identifier: review.identifier, status: review.status })),
        },
      });
    }
  }

  const updated = ctx.repos.tasks.setReviewRequired({
    id: task.id,
    value,
    ifVersion,
    now,
  });
  ctx.repos.activities.append({
    taskId: updated.id,
    actorKind: actor.kind,
    actorId: actor.id,
    event: "review_override",
    changes: {
      from: currentValue,
      to: value,
      ...(waiverReason === null ? {} : { reason: waiverReason }),
    },
    createdAt: now,
  });
  return updated;
}

/**
 * @param {object} ctx
 * @param {{id: string, ifVersion?: number, patch?: object, actor: object, assignee?: string, reporter?: string, forceCreate?: boolean, reviewRequired?: boolean, reason?: string}} input
 */
export function updateTask(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();
  if (input.reviewRequired !== undefined && typeof input.reviewRequired !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `review_required must be a boolean (got ${JSON.stringify(input.reviewRequired)})`,
      details: { field: "review_required", received: input.reviewRequired },
    });
  }
  const reviewTarget = input.reviewRequired;
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

      // The structural columns are the authority for the review marker; `meta`
      // is the readable mirror. Canonicalize a meta patch against them so the
      // loop's readers and the acceptance gate can never disagree about which
      // card a review audits.
      if (patch.meta !== undefined) {
        patch.meta = canonicalReviewMeta(ctx.repos, current, patch.meta);
      }

      // 0032 — `meta` is a writable bag; the acceptance baseline is not. The
      // CLI's `issue meta` re-sends the *whole* merged meta object, so an
      // unchanged `acceptance` must pass (otherwise every `issue meta` on a card
      // with a baseline would fail). Only a changed value is refused.
      if (patch.meta !== undefined) {
        for (const key of ["acceptance", "acceptance_legacy"]) {
          if (!Object.hasOwn(patch.meta, key)) continue;
          if (JSON.stringify(patch.meta[key]) === JSON.stringify(current.meta?.[key])) continue;
          throw new DomainError("VALIDATION_FAILED", {
            message: `${key} is frozen; use --acceptance / --drop-acceptance`,
            details: { field: `meta.${key}` },
            hint: {
              fix:
                "append with taskctl issue update --acceptance <text>; " +
                "a human may prune with --drop-acceptance --reason",
            },
          });
        }
      }

      let task = current;
      let acceptanceApplied = false;
      const wantsAcceptance =
        input.acceptance !== undefined ||
        input.acceptanceDrop !== undefined ||
        input.acceptanceRevision !== undefined;
      if (wantsAcceptance) {
        if (input.acceptance !== undefined && input.acceptanceDrop !== undefined) {
          throw new DomainError("VALIDATION_FAILED", {
            message: "use --acceptance or --drop-acceptance, not both",
            details: { fields: ["acceptance", "acceptance_drop"] },
          });
        }
        if (input.acceptanceRevision !== undefined && input.acceptanceDrop === undefined) {
          throw new DomainError("VALIDATION_FAILED", {
            message: "--acceptance-revision is only used with --drop-acceptance",
            details: { field: "acceptance_revision" },
          });
        }
        if (current.status === STATUS.IN_REVIEW || isTerminalStatus(current.status)) {
          throw new DomainError("ACCEPTANCE_LOCKED", {
            message: `the acceptance baseline is frozen while ${current.identifier} is ${current.status}`,
            details: { taskId: current.id, status: current.status },
            hint: { fix: "rework the card first; the new delivery round re-opens the baseline" },
          });
        }
        if (input.acceptanceDrop !== undefined) {
          if (actor.kind !== "human") {
            throw new DomainError("ACCEPTANCE_PRUNE_FORBIDDEN", {
              message: "only a human may remove an acceptance criterion",
              details: { actorKind: actor.kind, actorId: actor.id },
              hint: { fix: "ask a human, or append a new criterion instead" },
            });
          }
          const reason = typeof input.reason === "string" ? input.reason.trim() : "";
          if (reason.length < WAIVER_MIN_REASON_CHARS) {
            throw new DomainError("VALIDATION_FAILED", {
              message: `pruning the acceptance baseline needs --reason with at least ${WAIVER_MIN_REASON_CHARS} characters`,
              details: {
                field: "reason",
                received: typeof input.reason === "string" ? input.reason : null,
                minLength: WAIVER_MIN_REASON_CHARS,
              },
            });
          }
          const expected = input.acceptanceRevision ?? current.acceptanceRevision;
          if (expected !== current.acceptanceRevision) {
            throw new DomainError("ACCEPTANCE_STALE_REVISION", {
              message: `acceptance revision changed for ${current.identifier}; re-read the card and retry`,
              details: {
                taskId: current.id,
                expectedRevision: expected,
                currentRevision: current.acceptanceRevision,
              },
            });
          }
          const dropKeys = new Set(
            normalizeAcceptanceList(input.acceptanceDrop, { maxItems: 64 }).map(acceptanceKey),
          );
          const next = current.acceptance.filter((text) => !dropKeys.has(acceptanceKey(text)));
          if (next.length !== current.acceptance.length) {
            // The trigger reads this activity, so it must be written first.
            ctx.repos.activities.append({
              taskId: current.id,
              actorKind: actor.kind,
              actorId: actor.id,
              event: "acceptance_pruned",
              changes: {
                reason,
                removed: current.acceptance.filter((text) => dropKeys.has(acceptanceKey(text))),
              },
              createdAt: now,
            });
            task = ctx.repos.tasks.setAcceptance({
              id: current.id,
              acceptance: next,
              expectedRevision: current.acceptanceRevision,
              now,
            });
            acceptanceApplied = true;
          }
        } else if (input.acceptance !== undefined) {
          const appended = normalizeAcceptanceList(input.acceptance, { maxItems: 60 });
          const keys = new Set(current.acceptance.map(acceptanceKey));
          const added = appended.filter((text) => !keys.has(acceptanceKey(text)));
          if (added.length > 0) {
            const next = normalizeAcceptanceList([...current.acceptance, ...added], { maxItems: 64 });
            task = ctx.repos.tasks.setAcceptance({
              id: current.id,
              acceptance: next,
              expectedRevision: current.acceptanceRevision,
              now,
            });
            ctx.repos.activities.append({
              taskId: current.id,
              actorKind: actor.kind,
              actorId: actor.id,
              event: "acceptance_changed",
              changes: { added, revision: task.acceptanceRevision },
              createdAt: now,
            });
            acceptanceApplied = true;
          }
        }
      }

      if (Object.keys(patch).length === 0 && reviewTarget === undefined && !acceptanceApplied) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "nothing to update: pass a patch, an assignee/reporter, --review, or an acceptance change",
          details: {
            allowed: [
              "title",
              "description",
              "priority",
              "kind",
              "labels",
              "assignee",
              "reporter",
              "review_required",
              "acceptance",
              "acceptance_drop",
            ],
          },
        });
      }

      // Downgrading an epic that still has children would orphan a `task → task`
      // parent edge. The DB trigger (0011) is the machine guarantee; this read is
      // the friendly refusal that names the repair before the write is attempted.
      if (patch.kind !== undefined) {
        assertEpicDowngradeAllowed(current, patch.kind, ctx.repos.relations.listChildren(input.id));
      }

      // The controlled review decision is a separate write with its own audit
      // row. Doing it first means the generic patch's CAS runs against the
      // returned version, so the two writes cannot be split by another writer.
      let overrideApplied = false;
      if (reviewTarget !== undefined) {
        task = applyReviewOverride(ctx, {
          task,
          value: reviewTarget,
          reason: input.reason,
          actor,
          now,
          ifVersion: acceptanceApplied ? task.version : input.ifVersion,
        });
        overrideApplied = task !== current;
      }
      if (Object.keys(patch).length === 0) return task;

      const updated = ctx.repos.tasks.updateCas({
        id: input.id,
        // An acceptance write or a review override bumps the row; a no-op must
        // not weaken the caller's CAS, so use the returned version only when
        // something actually wrote.
        ifVersion: overrideApplied || acceptanceApplied ? task.version : input.ifVersion,
        patch,
        now,
      });
      ctx.repos.activities.append({
        taskId: updated.id,
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
      return updated;
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
 * Reopening a finished card is an audited act — the same rule (and the same
 * minimum length) as a takeover or a report waiver. The board records it as
 * `task_reopened`, but the reason is what a reader needs to understand why
 * accepted work became active again.
 * @param {unknown} reason
 * @returns {string} the trimmed reason
 */
function assertReopenReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < WAIVER_MIN_REASON_CHARS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `reopening a terminal card needs --reason with at least ${WAIVER_MIN_REASON_CHARS} characters`,
      details: {
        field: "reason",
        received: typeof reason === "string" ? reason : null,
        minLength: WAIVER_MIN_REASON_CHARS,
      },
      hint: { fix: 'e.g. --reason "customer found a regression in the accepted delivery"' },
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
  const { current, actor, now, allowSteal, reason, ifVersion, checkBlockers } = input;
  // 0032 — a worker may have written its derived baseline just before claiming.
  // Seed it once, then re-read: the seed bumps `version`, so the claim CAS must
  // use the new row rather than the caller's pre-seed `ifVersion`.
  let task = current;
  let claimVersion = ifVersion;
  if ((current.acceptance ?? []).length === 0) {
    const seeded = normalizeAcceptanceList(
      current.meta?.acceptance ?? current.meta?.acceptance_legacy ?? [],
      { maxItems: 60 },
    );
    if (seeded.length > 0) {
      task = ctx.repos.tasks.seedAcceptance({ id: current.id, acceptance: seeded, now });
      claimVersion = task.version;
    }
  }
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
  const verdict = assertClaimable(task, {
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
    return { task, reused: true, stole: false };
  }

  // `--check-blockers` (opt-in): the board re-derives the dependency read the
  // caller would otherwise do itself. It runs only when a claim is actually
  // being taken — a `reuse` above is the same holder asking again, and a card
  // already in flight is not refused for a predecessor that opened afterwards.
  if (checkBlockers === true) {
    const blockers = ctx.repos.relations.listOpenBlockers(task.id);
    if (blockers.length > 0) {
      throw new DomainError("BLOCKED_BY_PREDECESSOR", {
        message: `${task.identifier} is blocked by ${blockers.map((blocker) => blocker.identifier).join(", ")}`,
        details: {
          taskId: task.id,
          identifier: task.identifier,
          blockers,
        },
        hint: { fix: "wait for the predecessors to reach done, or remove their `blocks` edges" },
      });
    }
  }

  // `--allow-steal` must say why. A >6h reclaim is audited too but needs no
  // reason: the staleness *is* the reason.
  const auditedTakeover = verdict.steal === true && verdict.reclaim !== true;
  const stealReason = auditedTakeover ? assertStealReason(reason) : null;

  const fromStatus = task.status;
  if (verdict.reclaim === true) {
    // Re-claiming an in_progress card: the CAS must match status='in_progress'
    // *and* the heartbeat the verdict judged stale — the repository enforces the
    // bound rather than trusting this call site (R3).
    task = ctx.repos.tasks.stealStaleClaim({
      id: task.id,
      ifVersion: claimVersion,
      actor: claimantId,
      // The claim is a record, so it records the kind it was made under — the
      // acting platform, beside the holder (0023).
      claimedKind: actor.kind,
      now,
      staleBefore: staleBound(now, verdict.steal === true),
    });
  } else {
    const result = ctx.repos.tasks.claimCas({
      id: task.id,
      ifVersion: claimVersion,
      actor: claimantId,
      claimedKind: actor.kind,
      now,
    });
    if (!result.claimed) {
      throw explainLostClaim({
        before: task,
        after: result.task,
        actor: claimantId,
        now,
        ifVersion: claimVersion,
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
      from: fromStatus,
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
        checkBlockers: input.checkBlockers === true,
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
 * A move out of `done`/`canceled` is a **reopen**: the only legal destination is
 * `todo`, and it must carry a reason. `requireTerminalSource` is the internal
 * flag `reopenStatus` sets so the dedicated command cannot be used as a generic
 * `move … todo` for an already-open card.
 *
 * @param {object} ctx
 * @param {{id: string, to: string, actor: object, ifVersion?: number, noReport?: boolean, reason?: string, allowSteal?: boolean, awaitingReason?: string|null, blockedReason?: string|null, question?: string|null, requireTerminalSource?: boolean}} input
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

      // The dedicated command is terminal-only. Checked before the whitelist so
      // an already-open card gets the reopen-specific refusal rather than the
      // generic `todo → todo` one; a terminal card falls through to
      // `assertTransition`, which is what keeps `done → in_progress` a
      // `TERMINAL_STATE` on the plain move route too.
      if (input.requireTerminalSource === true && !isTerminalStatus(current.status)) {
        throw new DomainError("INVALID_TRANSITION", {
          message: "only a done/canceled card can be reopened",
          details: { from: current.status, to: input.to },
          hint: { fix: "the card is already open; use a normal move" },
        });
      }

      assertTransition(current.status, input.to, current.kind);

      // 0034 — an agent entering `awaiting` must say what it is waiting for.
      // The question is stored as a `question` comment in this same transaction,
      // so a later gate refusal rolls it back with the move. A human may park a
      // card silently; an agent that already has an unanswered question on the
      // card need not repeat it.
      let questionCommentId = null;
      if (input.to === STATUS.AWAITING) {
        const questionText = typeof input.question === "string" ? input.question.trim() : "";
        if (questionText !== "") {
          questionCommentId = addComment(ctx, {
            taskId: current.id,
            kind: "question",
            body: questionText,
            actor,
          }).id;
        } else if (actor.kind !== "human") {
          const comments = ctx.repos.comments.list({ taskId: current.id, limit: 10_000 });
          const openQuestion = latestQuestion(comments);
          if (openQuestion === null || isAnsweredAfter(comments, openQuestion)) {
            throw new DomainError("QUESTION_REQUIRED", {
              message:
                `${current.identifier}: an agent entering awaiting must ask a question ` +
                "(or point at an earlier unanswered one)",
              details: { taskId: current.id, identifier: current.identifier, field: "question" },
              hint: {
                fix: `taskctl issue move ${current.identifier} awaiting --awaiting-reason E2 --question "<what you need>"`,
              },
            });
          }
          questionCommentId = openQuestion.id ?? null;
        }
      }

      // Reopening is the `done|canceled → todo` edge. It is audited, and it is
      // closed to review cards: a review is a loop artifact, and reopening the
      // original is what produces the next round's review.
      const reopen = isReopen(current.status, input.to);
      const reopenReason = reopen ? assertReopenReason(input.reason) : null;
      if (reopen && current.reviewOfId !== null && current.reviewOfId !== undefined) {
        throw new DomainError("INVALID_TRANSITION", {
          message: "a review card cannot be reopened; reopen the original card instead",
          details: { from: current.status, to: input.to, reviewOf: current.reviewOfId },
          hint: { fix: "reopen the reviewed card; the loop will issue a review for the new round" },
        });
      }
      // `done` is acceptance, not delivery. Who may perform it is the board's
      // policy (`human-only` | `both` | `agent-only`) and the card's scope
      // (child / review card / top-level original) — see
      // `commands/acceptance.mjs` and `domain/status.mjs`.
      if (input.to === STATUS.DONE) assertAcceptance(ctx, current, actor);
      // A card is not delivered or accepted while a child is still in flight.
      // The same rule the automatic rollup applies; the DB trigger is 0026.
      assertChildrenTerminal(ctx, current, input.to);
      // 0032 — acceptance is coverage, not just authority. The current-round
      // delivery report must answer every frozen criterion. A waiver is not
      // evidence; it only excuses the delivery gate.
      if (input.to === STATUS.DONE) assertAcceptanceCoverage(ctx, current);

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

      // Last, after the delivery gate: a human accepting a top-level original
      // needs the review cards of the current round resolved. The loop's own
      // write order is original-first, review-last, so system/agent acceptances
      // are deliberately exempt (the function checks the actor).
      if (input.to === STATUS.DONE) assertReviewReady(ctx, current, actor);

      const task = ctx.repos.tasks.moveCas({
        id: input.id,
        ifVersion: input.ifVersion,
        to: input.to,
        now,
        waiver,
        awaitingReason,
        blockedReason,
        // The repository clears the finished card's `idem`/`archived_at` in the
        // same UPDATE — one revision, and no idempotency-index collision.
        reopen,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        // Kept on one line: the activity-vocabulary test reads the literals
        // from the audit row's event-name line itself. Do not put that
        // colon-suffixed key in a comment above it — the scanner finds the
        // first matching line and would read the comment instead.
        event: reopenReason !== null ? "task_reopened" : waiver === null ? "task_moved" : "report_waived",
        changes:
          reopenReason !== null
            ? {
                from: current.status,
                to: task.status,
                reason: reopenReason,
                deliveryRound: task.deliveryRound,
              }
            : waiver === null
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
                  // 0034 — the question the worker stopped on.
                  ...(questionCommentId === null ? {} : { questionCommentId }),
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
      // `in_progress` (commands/rollup.mjs). The test is `hasChildStarted`, not
      // `status === in_progress`: a nested epic delivered straight out of `todo`
      // (`todo → in_review`, 0024) has entered the work as surely as a claimed
      // task, and its parent container must start.
      if (hasChildStarted(task.status)) startContainerForChild(ctx, task.id, now);
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
 * Reopen a `done`/`canceled` card to `todo`.
 *
 * The edge, the reason, the round bump and the bookkeeping (released `idem`,
 * cleared `archived_at`) are all `moveStatus`'s; this exists so the command has
 * its own name and so `requireTerminalSource` makes the dedicated route refuse
 * an already-open card. Review cards are refused there.
 *
 * @param {object} ctx
 * @param {{id: string, actor: object, ifVersion?: number, reason: string}} input
 */
export function reopenStatus(ctx, input) {
  return moveStatus(ctx, { ...input, to: STATUS.TODO, requireTerminalSource: true });
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
        changes: {
          from: current.status,
          archivedAt: task.archivedAt,
          ...(released > 0 ? { labelsReleased: released } : {}),
        },
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
 *   * `weight` — the assignee weight order (`foundation/task-order.mjs`), requested
 *     with `?order=weight`.
 *
 * The default is deliberately untouched: the existing order is a frozen
 * commitment (md export reuses the same `ORDER BY`) and the weight order is
 * clock-dependent, so switching the default would change behaviour where nothing
 * tests it.
 *
 * @param {object} ctx
 * @param {{projectId?: string, status?: string|string[], assigneeId?: string|string[], reviewOfId?: string, includeArchived?: boolean, limit?: number, offset?: number, order?: string, orderDebug?: boolean}} [filter]
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
  // An unknown assignee still has a recovery pool: the 6-hour takeover does not
  // depend on the asker owning the card.
  if (ids.length === 0 && !includeUnassigned && input.stale !== true) {
    return { candidates: [], orderDebug: order === "weight" ? [] : null };
  }

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
  // The recovery pool is **not** scoped to the asker's own cards: past the
  // six-hour bound any agent may take a stale claim over, so an agent that has
  // never seen the card must be able to discover it. `staleReason` keeps the
  // 30-minute window holder-only (`stale_same`) — an agent cannot take a card
  // from a live holder early.
  const stale =
    input.stale === true
      ? ctx.repos.tasks
          .list({ status: STATUS.IN_PROGRESS, limit: null })
          .filter((task) => isAutoClaimableKind(task.kind))
          .filter((task) => staleReason(task, ids, now) !== null)
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
 * The actor ids a free-text assignee names — the public half of
 * `assigneeEntryIds`, for the board read's `--assignee` filter. An unknown name
 * resolves to `[]`, which the repository reads as the empty scope (`1 = 0`)
 * rather than as "no filter".
 *
 * @param {object} ctx
 * @param {string} assignee
 * @returns {string[]}
 */
export function assigneeIdsFor(ctx, assignee) {
  return assigneeEntryIds(ctx, assignee);
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
 * The candidate projection: the card's fields a poll needs, plus `reason` so it
 * can rank ready against recovery without re-deriving it.
 *
 * `target` is the card's own opaque value (`meta.target`), not a project
 * directory: the board still holds no workspace for a project (O3). `meta` is
 * projected whole as the generic escape hatch for a consumer's own keys (a
 * routing field, for example), so a poll does not need an `issue get` per
 * candidate to read one.
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
    created_at: task.createdAt,
    target: nonEmptyString(meta.target),
    meta,
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
    // The structural half of the new gates is actor-independent, so the
    // pre-flight answer can carry it. The acceptance policy and the review-ready
    // check need the writer's declared kind, which `canMove` is not given — the
    // write itself still refuses those.
    assertChildrenTerminal(ctx, task, input.to);
    if (input.to === STATUS.DONE) assertAcceptanceCoverage(ctx, task);
  } catch (err) {
    return { ok: false, reason: err.code, details: err.details };
  }
  return { ok: true };
}
