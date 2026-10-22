/**
 * The board's workflow decisions — the *decision* half of a workflow pass.
 *
 * Everything after a delivery — accepting it, rejecting it, rolling a container
 * up, splitting one — used to be the loop's private policy. It is the board's
 * decision now: this module reads a snapshot and decides three things, with
 * **no I/O of its own**:
 *
 *   * **reconcile** — which container verdicts deserve a notification;
 *   * **outcomes** — what a review card's verdict means for the card it audits;
 *   * **dispatch** — which `in_review` cards still need an independent reviewer.
 *
 * Three rules shape every decision here:
 *
 *   * **The board is the only source of truth.** Container start/close stays in
 *     `src/core/commands/rollup.mjs`; this module never re-derives a close
 *     predicate, it only classifies what `issue reconcile` reported.
 *   * **The reviewer reports; the loop moves.** A review card is a normal card
 *     (`kind=task`, `meta.review_of`, `meta.flow=B`) whose only job is to carry
 *     a `VERDICT:` report. Its owner never moves the original and never closes
 *     the review card — `autoAcceptReviews` is what lets the loop close it.
 *   * **Fail-safe, never half-applied.** An unreadable verdict, a stale round or
 *     an original that cannot be seen produce an **alert and no action** — a
 *     review card left in `in_review` is recoverable on the next tick; a card
 *     closed on a guess is not.
 *
 * Pure: no `node:` imports, no clock (`now` is always an input), no board. The
 * board's use-case (`commands/workflow.mjs`) assembles the snapshot from SQLite
 * and exposes the plan through `issue reconcile --workflow`; the loop performs
 * the review writes the plan describes.
 */

import {
  ACCEPTANCE_POLICIES,
  DEFAULT_ACCEPTANCE_POLICY,
  DEFAULT_REVIEW_AGING_MS,
  DEFAULT_WORKFLOW_MAX_ACTIONS,
  LOOP_ACCEPTOR,
  LOOP_AUTO_ACCEPTOR,
  TASKD_KIND,
} from "../../foundation/constants.mjs";
import { reviewRequiredOf } from "./review-policy.mjs";
import { coverageOf } from "./acceptance.mjs";
import { acceptanceAllows, acceptanceScopeOf } from "./status.mjs";

// The two workflow defaults are shared with the loop's config resolver, so they
// live in `foundation/constants.mjs` — one number, both sides. Re-exported here
// because this module's public surface has always named them.
export { DEFAULT_REVIEW_AGING_MS, DEFAULT_WORKFLOW_MAX_ACTIONS };

/** The policy the loop believes the board runs, from its own config. */
function acceptancePolicyOf(config) {
  const value = String(config?.acceptancePolicy ?? "").trim().toLowerCase();
  return ACCEPTANCE_POLICIES.includes(value) ? value : DEFAULT_ACCEPTANCE_POLICY;
}

/**
 * Is this original a **top-level** card?
 *
 * The board sends `parent_id` on every task since 0025. A snapshot that does
 * not carry it reads as top-level, which is the conservative direction for a
 * human-only board: the loop holds instead of closing on the human's behalf.
 */
function isTopLevel(task) {
  return task?.parent_id === null || task?.parent_id === undefined;
}

/**
 * Does this card's own snapshot say it needs an independent review?
 *
 * This is the **only** input to dispatch/auto-accept. It never re-reads the
 * project policy: the card's decision was taken at creation and is stable.
 *
 * @param {object} task a wire task
 * @returns {boolean}
 */
export function reviewRequired(task) {
  return reviewRequiredOf(task?.review_required);
}

/** The acceptance scope of a wire task (child > review > top-level). */
function scopeOf(task) {
  return acceptanceScopeOf({
    hasParent: task?.parent_id !== null && task?.parent_id !== undefined,
    reviewCard: isReviewCard(task),
  });
}

/**
 * The reviewer for this card: the project's override when it has one, else the
 * deployment-level reviewer passed in the reconcile request.
 *
 * @param {object} task a wire task
 * @param {{reviewer?: string|null, projectReviewers?: object|Map<string,string>|null}} [config]
 * @returns {string|null}
 */
function effectiveReviewerFor(task, config) {
  const projectReviewers = config?.projectReviewers;
  const projectId = task?.project_id;
  let override = null;
  if (projectReviewers && projectId !== undefined && projectId !== null) {
    override =
      typeof projectReviewers.get === "function"
        ? nonEmpty(projectReviewers.get(projectId))
        : nonEmpty(projectReviewers[projectId]);
  }
  return override ?? nonEmpty(config?.reviewer);
}

/** How long a childless epic may exist before `empty_epic` is worth a notice. */
export const EMPTY_EPIC_GRACE_MS = 30 * 60_000;

/** The `meta.flow` a worker card runs (and the only flow reviewed here). */
export const WORK_FLOW = "A";

/** The `meta.accepted_by` markers an automated acceptance writes. */
export { LOOP_ACCEPTOR, LOOP_AUTO_ACCEPTOR };

/** The most evidence a verdict's findings may carry into a comment. */
export const FINDINGS_MAX_CHARS = 4_000;

/** Statuses a card never leaves. */
const TERMINAL_STATUSES = new Set(["done", "canceled"]);

/** Reconcile reasons that are normal, in-flight states rather than findings. */
const QUIET_RECONCILE_REASONS = new Set([
  "children_unfinished",
  "no_child_started",
  "awaiting_acceptance",
]);

// ---------------------------------------------------------------------------
// Small readers — one definition each, because the wire and `meta` disagree
// ---------------------------------------------------------------------------

function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function intOrNull(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function instant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The flow a card runs. An absent `meta.flow` is `A` — the fail-safe direction,
 * because treating an unknown card as flow B would exempt it from review.
 *
 * @param {object} task a wire task
 * @returns {string}
 */
export function flowOf(task) {
  const flow = nonEmpty(task?.meta?.flow);
  return flow === null ? WORK_FLOW : flow.toUpperCase();
}

/**
 * Is this a review card?
 *
 * Detection reads the **structural marker** first (`review_of_id`, 0025), and
 * falls back to `meta.review_of` for a board that has not migrated yet or a
 * snapshot assembled without the column. A label is a discovery aid, never the
 * predicate (a human may label anything).
 *
 * @param {object} task a wire task
 * @returns {boolean}
 */
export function isReviewCard(task) {
  if (nonEmpty(task?.review_of_id) !== null) return true;
  return nonEmpty(task?.meta?.review_of) !== null;
}

/** The card a review card audits, or `null`. */
export function reviewOf(task) {
  return nonEmpty(task?.meta?.review_of);
}

/**
 * The delivery round a card is on. Absent/unreadable is `0`, which is what a
 * card that has never been delivered reports — deterministic, never `NaN`.
 *
 * @param {object} task a wire task
 * @returns {number}
 */
export function roundOf(task) {
  return intOrNull(task?.delivery_round) ?? 0;
}

/**
 * The round a review card audits, or `null` for a card written before the field
 * existed. `null` suppresses every round (the conservative reading) — see
 * `planReviewDispatch` and `sla-patrol.mjs#acceptanceDetection`.
 *
 * @param {object} task a wire task
 * @returns {number|null}
 */
export function reviewRoundOf(task) {
  // 0025 — the structural column wins; the meta value is the compatibility
  // fallback for a snapshot/board written before it existed.
  return intOrNull(task?.review_round) ?? intOrNull(task?.meta?.review_round);
}

/** The idempotency key for one review card: one per original per round. */
export function reviewIdemKey(ref, round) {
  return `loop-review|${ref}|r${round}`;
}

/** The idempotency key for one rework card: one per original per round. */
export function reworkIdemKey(ref, round) {
  return `loop-rework|${ref}|r${round}`;
}

/**
 * Whether `reviewer` is one of the people/agents who produced the card — the
 * self-review guard. The board has no per-agent ACL, so this is the one place
 * the separation can be checked at all.
 *
 * @param {object} original the card under review
 * @param {string} reviewer
 * @returns {boolean}
 */
export function isSelfReview(original, reviewer) {
  const who = String(reviewer ?? "").trim().toLowerCase();
  if (who === "") return false;
  const candidates = [
    original?.assignee_id,
    original?.assignee?.id,
    original?.assignee?.display_name,
    original?.claimed_by,
    original?.claimed_by_actor?.id,
    original?.claimed_by_actor?.display_name,
  ];
  return candidates.some((value) => typeof value === "string" && value.trim().toLowerCase() === who);
}

// ---------------------------------------------------------------------------
// The verdict protocol
// ---------------------------------------------------------------------------

/** The first line of the report that states the verdict. */
const VERDICT_LINE = /^VERDICT\s*:\s*(APPROVE|REJECT)\b/i;

/**
 * Read a review card's verdict from its reports.
 *
 * The review card delivers a normal report; its `conclusion`'s **first line**
 * must be `VERDICT: APPROVE` or `VERDICT: REJECT`. Everything after that line,
 * plus the report's `leftovers`, is carried into the rework comment — the
 * reviewer writes its findings once, where the worker will read them.
 *
 * @param {object[]} reports reports for the review card, round-ascending
 * @param {number|null} round the round the review card's report is stamped with
 *   (its own `delivery_round`), not the round it audits; `null` reads the latest
 * @returns {{ok: true, verdict: "APPROVE"|"REJECT", findings: string, report: object}
 *   | {ok: false, reason: "no_report"|"no_verdict"}}
 */
export function parseReviewVerdict(reports, round) {
  const list = (Array.isArray(reports) ? reports : []).filter(
    (report) => report !== null && typeof report === "object",
  );
  const matching = round === null
    ? list
    : list.filter((report) => intOrNull(report.round) === round);
  if (matching.length === 0) return { ok: false, reason: "no_report" };

  // The last report wins: a reviewer that delivered twice has said something new.
  const report = matching[matching.length - 1];
  const conclusion = String(report.conclusion ?? "");
  const lines = conclusion.split("\n");
  const first = lines[0].trim();
  const match = VERDICT_LINE.exec(first);
  if (match === null) return { ok: false, reason: "no_verdict" };

  const findings = boundedFindings(
    [lines.slice(1).join("\n").trim(), String(report.leftovers ?? "").trim()]
      .filter((part) => part !== "")
      .join("\n\n"),
  );
  return {
    ok: true,
    verdict: match[1].toUpperCase(),
    findings,
    report,
  };
}

/** The readable name/id of a report's author, or `null`. */
function reportAuthor(report) {
  return nonEmpty(report?.author?.display_name) ?? nonEmpty(report?.author_id) ?? nonEmpty(report?.author?.id);
}

/**
 * Did this reviewer write the report? Compared on the id and the display name
 * the wire carries, case-insensitively — the dictionary may have normalised a
 * spelling, and a reviewer configured as `jobs` must match the recorded
 * `Jobs`. A report with no readable author cannot be attributed and therefore
 * does not match (fail-safe: an unattributable verdict is not applied).
 */
function reportAuthorMatches(report, expected) {
  const who = String(expected ?? "").trim().toLowerCase();
  if (who === "") return true;
  const candidates = [
    report?.author?.id,
    report?.author?.display_name,
    report?.author_id,
  ];
  return candidates.some(
    (value) => typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() === who,
  );
}

function boundedFindings(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= FINDINGS_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, FINDINGS_MAX_CHARS - 1)}…`;
}

/**
 * A stable de-duplication key for a workflow alert: the state that produced it,
 * never the clock. The loop's ledger suppresses a repeated key, so changing the
 * status, round or reason is what makes the same finding worth a new notice.
 */
function alertKey(...parts) {
  return parts.map((part) => (part === null || part === undefined ? "" : String(part))).join("|");
}

// ---------------------------------------------------------------------------
// Reconcile classification
// ---------------------------------------------------------------------------

/**
 * Turn `issue reconcile`'s action list into the handful that deserve a notice.
 *
 * Most verdicts are *normal*: `children_unfinished` is work in flight, and
 * `no_child_started` is a container resting in `todo` — the SLA pass already
 * watches stuck children. The ones that stay silent would otherwise make every
 * pass notify about the board's ordinary state, which is how an inspector gets
 * ignored.
 *
 * @param {{epic: string, status?: string, action: string, reason: string, child?: string, blocking?: object[]}[]} actions
 * @param {{byRef?: Map<string, object>, now?: string|number, graceMs?: number}} [input]
 * @returns {{alerts: object[], changes: object[]}}
 */
export function classifyReconcileActions(actions, input = {}) {
  const alerts = [];
  const changes = [];
  const now = instant(input.now);
  const graceMs = Number.isFinite(input.graceMs) && input.graceMs >= 0 ? input.graceMs : EMPTY_EPIC_GRACE_MS;
  const byRef = input.byRef ?? new Map();

  for (const action of Array.isArray(actions) ? actions : []) {
    const epic = String(action?.epic ?? "");
    if (epic === "") continue;
    const reason = String(action?.reason ?? "");
    if (action?.action === "start" || action?.action === "close") {
      changes.push({ epic, action: action.action, reason, ...(action.child === undefined ? {} : { child: action.child }) });
      continue;
    }
    if (QUIET_RECONCILE_REASONS.has(reason)) continue;

    if (reason === "empty_epic") {
      // A freshly created epic has no children for a moment; only a container
      // that stays empty is a finding. An unreadable creation time is not a
      // reason to suppress it — the conservative direction is to alert.
      const created = instant(byRef.get(epic)?.created_at ?? byRef.get(epic)?.createdAt);
      if (now !== null && created !== null && now - created <= graceMs) continue;
      alerts.push({
        type: "reconcile",
        reason,
        epic,
        status: action.status ?? null,
        dedupKey: alertKey("reconcile", reason, epic, ""),
      });
      continue;
    }

    const blocking = Array.isArray(action.blocking) ? action.blocking : [];
    const blockingIds = blocking
      .map((item) => String(item?.identifier ?? item ?? ""))
      .sort()
      .join(",");
    alerts.push({
      type: "reconcile",
      reason,
      epic,
      status: action.status ?? null,
      ...(blocking.length > 0 ? { blocking } : {}),
      dedupKey: alertKey("reconcile", reason, epic, blockingIds),
    });
  }
  return { alerts, changes };
}

// ---------------------------------------------------------------------------
// Dispatch: which delivered cards still need a reviewer
// ---------------------------------------------------------------------------

/**
 * Decide which `in_review` cards need a review card created.
 *
 * The guards, in the order they save the most work:
 *
 *   * a truncated board read dispatches **nothing** — "already reviewed" cannot
 *     be proven over an incomplete snapshot;
 *   * a review card of its own is never reviewed again (`flow=B`);
 *   * an active review card for the same **round** covers the card; a `done`
 *     review card whose original is still `in_review` is a finding, not a
 *     reason to create a second one; a `canceled` one releases the key (the
 *     board's idempotency key is released by a terminal card, so recreation is
 *     the consistent move);
 *   * the reviewer must not be the card's own assignee/claimer.
 *
 * @param {{tasks?: object[], config?: object, boardTruncated?: boolean, skipRefs?: Set<string>|string[]}} input
 * @returns {{alerts: object[], actions: object[]}}
 */
export function planReviewDispatch(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const config = input.config ?? {};
  const maxActions = Number.isFinite(config.maxActions) && config.maxActions >= 0
    ? config.maxActions
    : DEFAULT_WORKFLOW_MAX_ACTIONS;
  const skip = input.skipRefs instanceof Set ? input.skipRefs : new Set(input.skipRefs ?? []);

  if (input.boardTruncated === true) {
    return {
      alerts: [{ type: "dispatch_skipped", reason: "board_truncated" }],
      actions: [],
    };
  }

  const reviewsByOriginal = new Map();
  for (const task of tasks) {
    if (!isReviewCard(task)) continue;
    const ref = reviewOf(task);
    const list = reviewsByOriginal.get(ref) ?? [];
    list.push(task);
    reviewsByOriginal.set(ref, list);
  }

  const candidates = [];
  const alerts = [];
  /** project id → required cards waiting for a reviewer (no global early return:
   *  some projects may carry their own override). */
  const unconfigured = new Map();

  for (const task of tasks) {
    if (task?.status !== "in_review") continue;
    if (isReviewCard(task)) continue;
    if (flowOf(task) !== WORK_FLOW) continue;
    // The card's own decision is the gate. A project's `off` policy is not
    // consulted here: a card created before the policy changed keeps its
    // snapshot, and a manual review card on a `0` card is handled by its own
    // review card's outcome, not by dispatch.
    if (!reviewRequired(task)) continue;
    const ref = String(task.identifier ?? "");
    if (ref === "" || skip.has(ref)) continue;

    const reviewer = effectiveReviewerFor(task, config);
    if (reviewer === null) {
      const project = String(task.project_id ?? "");
      unconfigured.set(project, (unconfigured.get(project) ?? 0) + 1);
      continue;
    }

    if (isSelfReview(task, reviewer)) {
      alerts.push({
        type: "self_review_not_independent",
        original: ref,
        reviewer,
        dedupKey: alertKey("self_review", ref, reviewer),
      });
      continue;
    }

    const round = roundOf(task);
    const reviews = reviewsByOriginal.get(ref) ?? [];
    const covering = reviews.filter((review) => {
      const audited = reviewRoundOf(review);
      return audited === null || audited === round;
    });
    if (covering.some((review) => !TERMINAL_STATUSES.has(review?.status))) continue;
    const done = covering.find((review) => review?.status === "done");
    if (done !== undefined) {
      alerts.push({
        type: "review_done_but_original_open",
        original: ref,
        review: String(done.identifier ?? ""),
        round,
        dedupKey: alertKey("review_done_open", ref, done.identifier ?? "", round),
      });
      continue;
    }
    // Every covering review is terminal (`canceled`); the card should be reviewed
    // again, and the terminal row no longer holds the idempotency key.
    candidates.push({ task, ref, round, reviewer });
  }

  if (unconfigured.size > 0) {
    let waiting = 0;
    const projects = [];
    for (const [project, count] of unconfigured) {
      waiting += count;
      projects.push({ project: project === "" ? null : project, waiting: count });
    }
    // Not configured is not an error: the deployment runs reconcile/outcomes
    // only. It is said once, with the projects that are waiting, so a board with
    // a `required` project and no reviewer is not a silent surprise.
    alerts.push({ type: "dispatch_skipped", reason: "reviewer_not_configured", waiting, projects });
  }

  candidates.sort(
    (a, b) =>
      String(a.task.status_changed_at ?? "").localeCompare(String(b.task.status_changed_at ?? "")) ||
      a.ref.localeCompare(b.ref),
  );

  const actions = [];
  for (const { task, ref, round, reviewer } of candidates.slice(0, maxActions)) {
    actions.push(reviewAction(task, ref, round, reviewer));
  }
  if (candidates.length > actions.length) {
    alerts.push({ type: "dispatch_capped", remaining: candidates.length - actions.length, cap: maxActions });
  }
  return { alerts, actions };
}

/** The `issue create` plan for one review card. */
function reviewAction(task, ref, round, reviewer) {
  const title = String(task.title ?? "").slice(0, 120);
  return {
    type: "create_review",
    originalRef: ref,
    projectId: task.project_id ?? null,
    reviewer,
    round,
    idem: reviewIdemKey(ref, round),
    target: `review:${ref}:r${round}`,
    title: `Review ${ref}: ${title}`,
    description: [
      `Independent acceptance review of ${ref}, delivery round ${round}.`,
      `Original card: ${ref} — ${title}`,
      "",
      "Read the original card, its description and every acceptance item, the delivery",
      `report(s) for round ${round}, the full comment trail, and — for an epic — the`,
      "child cards and the rollup report.",
      "If the original's meta.acceptance_derived is \"yes\", its acceptance list was",
      "derived by the worker at claim: check it covers every requirement in the",
      "description and comments. A narrowed list is grounds for REJECT.",
      "",
      "Then deliver a report on THIS review card whose FIRST LINE is exactly:",
      "  VERDICT: APPROVE",
      "or",
      "  VERDICT: REJECT",
      "Put the findings (what you checked, and what is missing) after that line and in",
      "`leftovers`. On APPROVE every acceptance item must be addressed with evidence;",
      "on REJECT say exactly what must change.",
      "",
      "Do not move the original card, and do not move this review card either. The",
      "loop applies the verdict and closes this card after reading your report.",
    ].join("\n"),
    // 0032 — the review card's own baseline is the original's frozen baseline plus
    // the generic review checklist, so the reviewer answers each criterion by name
    // and the review report can be checked against both. The original is capped at
    // 60 items and the checklist adds at most 3, inside the review card's 64 cap.
    acceptance: [
      ...(Array.isArray(task.acceptance) ? task.acceptance.slice(0, 60) : []),
      ...reviewChecklist(task, ref),
    ],
  };
}

/** The generic items a review report must also answer. */
function reviewChecklist(task, ref) {
  if (task.kind === "epic") {
    return [
      `Every child of ${ref} has an explicit conclusion in the rollup report`,
      "The rollup report is consistent with its evidence anchors",
      "The comment trail has no unresolved decision/defect entry",
    ];
  }
  return [
    "The delivery report is consistent with its evidence anchors",
    "The comment trail has no unresolved decision/defect entry",
  ];
}

// ---------------------------------------------------------------------------
// Outcomes: what a verdict does to the original and to the review card
// ---------------------------------------------------------------------------

/**
 * Apply one verdict, as a plan. `verdicts` is keyed by the **review card's**
 * `identifier` (the runner reads each in-review review card's reports before
 * calling this).
 *
 * `autoAcceptReviews` gates exactly one thing: whether the loop closes the
 * review card itself. The verdict on the **original** is applied whenever the
 * workflow channel is on — otherwise a rejected card would wait for a human to
 * close the review card before it could be reworked, and the automation would
 * have no point.
 *
 * @param {{
 *   tasks?: object[],
 *   verdicts?: Record<string, {ok: boolean, verdict?: string, findings?: string, reason?: string, report?: object}>,
 *   config?: object,
 *   boardTruncated?: boolean,
 *   now?: string|number,
 * }} input
 * @returns {{alerts: object[], actions: object[]}}
 */
export function planReviewOutcomes(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const verdicts = input.verdicts ?? {};
  const autoAccept = input.config?.autoAcceptReviews !== false;
  // `human-only` means the board expects the **human** to close a top-level
  // original. The loop still applies the verdict (a comment and an idempotent
  // marker) and still closes the review card — what it declines to do is move
  // the original. Children are not held: a child is always the agents' to close.
  const policy = acceptancePolicyOf(input.config);
  const now = instant(input.now);
  const agingMs =
    Number.isFinite(input.config?.reviewAgingMs) && input.config.reviewAgingMs > 0
      ? input.config.reviewAgingMs
      : DEFAULT_REVIEW_AGING_MS;

  const byRef = new Map();
  for (const task of tasks) {
    if (typeof task?.identifier === "string" && task.identifier !== "") byRef.set(task.identifier, task);
    if (typeof task?.id === "string" && task.id !== "") byRef.set(task.id, task);
  }

  const alerts = [];
  const actions = [];

  for (const review of tasks) {
    if (!isReviewCard(review)) continue;
    const reviewRef = String(review.identifier ?? "");
    if (reviewRef === "") continue;
    if (TERMINAL_STATUSES.has(review.status)) continue;

    const originalRef = reviewOf(review);
    const original = byRef.get(originalRef);
    if (original === undefined) {
      // On a truncated snapshot, "not in the snapshot" is not the same as
      // "gone": the original may sit below the read cap. Keep the finding (an
      // unknown must not become silence) but say it is undecidable, and use a
      // distinct key so the exact state keeps its existing ledger entry.
      const undecidable = input.boardTruncated === true;
      alerts.push({
        type: "original_unseen",
        review: reviewRef,
        original: originalRef,
        ...(undecidable ? { reason: "board_truncated", undecidable: true } : {}),
        dedupKey: undecidable
          ? alertKey("original_unseen", reviewRef, originalRef, "board_truncated")
          : alertKey("original_unseen", reviewRef, originalRef),
      });
      continue;
    }

    // The original is gone (canceled): the review has nothing to accept. Cleanup
    // is not gated by `autoAcceptReviews` — there is no human decision left to
    // make, and a terminal-by-cancellation original must not leave a live card.
    if (original.status === "canceled") {
      actions.push({ type: "cancel_review", reviewStatus: review.status, reviewRef, originalRef, reason: "original_canceled" });
      continue;
    }

    const round = reviewRoundOf(review);
    const originalRound = roundOf(original);
    // The marker is written with the round the card is on **after** the move out
    // of `in_review` (`round + 1`), so equality here means "the rework this
    // review ordered is the one the card is currently on".
    const reworkApplied = intOrNull(original.meta?.rework_round) === originalRound;

    if (round !== null && round !== originalRound) {
      // The original has moved past the round this review audited. Two readings:
      //
      //   * **the review caused the move** — rejecting bumps the round, and the
      //     loop died mid-rework. Finish the half-applied rework rather than
      //     calling the card stale;
      //   * **a newer delivery happened** — the verdict is history. Applying it
      //     would accept work it never saw, so close the card (or leave it for a
      //     human) without touching the original.
      if (reworkApplied && (original.status === "in_progress" || original.status === "todo")) {
        if (original.status === "in_progress" && original.kind !== "epic") {
          actions.push({
            type: "reject_task_finish",
            reviewStatus: review.status,
            reviewRef,
            originalRef,
            round: originalRound,
            closeReview: autoAccept,
          });
        } else {
          actions.push({
            type: "close_review",
            reviewStatus: review.status,
            reviewRef,
            originalRef,
            round,
            reason: "rework_applied",
            closeReview: autoAccept,
          });
          if (!autoAccept) {
            alerts.push({ type: "review_awaiting_human_acceptance", review: reviewRef, original: originalRef });
          }
        }
        continue;
      }
      if (autoAccept) {
        actions.push({ type: "close_review", reviewStatus: review.status, reviewRef, originalRef, round, reason: "round_mismatch", closeReview: true });
      } else {
        alerts.push({
          type: "review_stale_round",
          review: reviewRef,
          original: originalRef,
          round,
          originalRound,
          dedupKey: alertKey("review_stale", reviewRef, round, originalRound),
        });
      }
      continue;
    }

    const verdict = verdicts[reviewRef];
    if (verdict === undefined || verdict?.ok !== true) {
      // A review card that has not reported yet is simply in flight. One that
      // *has* a report the loop cannot read is a fail-safe alarm: move nothing,
      // retry (or let a human read it) next pass. And one that never reports at
      // all is now the loop's own wait — the SLA pass stopped watching the
      // original when this card was created, so the aging check is what keeps
      // a silent reviewer from disappearing.
      if (review.status === "in_review") {
        alerts.push({
          type: "verdict_unreadable",
          review: reviewRef,
          original: originalRef,
          reason: verdict?.reason ?? "not_read",
          dedupKey: alertKey("verdict_unreadable", reviewRef, verdict?.reason ?? "not_read"),
        });
      } else if (now !== null) {
        const age = now - (instant(review.status_changed_at) ?? instant(review.created_at) ?? now);
        if (age >= agingMs) {
          alerts.push({
            type: "review_aging",
            review: reviewRef,
            original: originalRef,
            status: review.status ?? null,
            ageMs: age,
            thresholdMs: agingMs,
            dedupKey: alertKey("review_aging", reviewRef, review.status ?? null, round),
          });
        }
      }
      continue;
    }

    // The verdict must come from the card's own reviewer. The board has no
    // per-agent ACL, so this is the loop's half of the separation: a report
    // written by anybody else is not a verdict, whatever it says.
    // The review card's assignee is the effective reviewer (the dispatch action
    // set it from `project.reviewer ?? global`). The global value is only a
    // fallback for a card created before per-project overrides existed.
    const expectedReviewer =
      nonEmpty(review.assignee?.display_name)
      ?? nonEmpty(review.assignee_id)
      ?? nonEmpty(input.config?.reviewer);
    if (expectedReviewer !== null && !reportAuthorMatches(verdict.report, expectedReviewer)) {
      alerts.push({
        type: "review_report_not_by_reviewer",
        review: reviewRef,
        original: originalRef,
        expected: expectedReviewer,
        author: reportAuthor(verdict.report),
        dedupKey: alertKey("not_reviewer", reviewRef, reportAuthor(verdict.report) ?? "unknown"),
      });
      continue;
    }

    const findings = String(verdict.findings ?? "");
    const closeReview = autoAccept;
    if (!autoAccept) {
      alerts.push({ type: "review_awaiting_human_acceptance", review: reviewRef, original: originalRef });
    }

    if (original.status === "in_review") {
      if (verdict.verdict === "APPROVE") {
        // 0032 — an APPROVE over a report that does not answer every baseline
        // criterion is not an approval. The write gate would refuse it; deciding
        // it here keeps the refusal out of the failed-action noise.
        const baseline = Array.isArray(original.acceptance) ? original.acceptance : [];
        if (baseline.length > 0) {
          const coverage = coverageOf({
            baseline,
            reportItems: verdict.report?.acceptance ?? [],
            includeExtras: true,
          });
          if (!coverage.ok) {
            const key = [
              ...coverage.missing.map((item) => item.key),
              ...coverage.blocking.map((item) => `${item.key}:${item.status}`),
            ]
              .sort()
              .join("|");
            alerts.push({
              type: "verdict_incomplete",
              review: reviewRef,
              original: originalRef,
              missing: coverage.missing.map((item) => item.text),
              blocking: coverage.blocking.map((item) => item.text),
              dedupKey: alertKey("verdict_incomplete", reviewRef, key),
            });
            continue;
          }
        }
        // `human-only` + a top-level original: the loop records the verdict and
        // stops. The human decides; the review card is still closed here so the
        // human's own acceptance is not blocked by a review they already read.
        // The hold is exactly "taskd may not complete this card under the board's
        // acceptance policy". Reusing `acceptanceAllows` keeps the review outcome
        // plan and the acceptance guard on one matrix: `human-only` + top-level
        // holds; a child (and `both`/`agent-only`) does not.
        const hold = !acceptanceAllows(TASKD_KIND, policy, scopeOf(original));
        // The marker is written with the round the original is on now; a crash
        // after the marker but before the review card's close is recovered on
        // the next pass. The board decides that here so the loop's executor
        // never needs the task snapshot.
        const held =
          String(original.meta?.review_verdict ?? "") === "approve" &&
          String(original.meta?.review_verdict_round ?? "") === String(originalRound);
        actions.push({
          type: hold ? "approve_hold" : "approve",
          reviewStatus: review.status,
          reviewRef,
          originalRef,
          round: originalRound,
          closeReview,
          acceptedBy: LOOP_ACCEPTOR,
          ...(hold ? { held } : {}),
        });
        continue;
      }
      // Leaving `in_review` bumps the delivery round by exactly one
      // (`domain/status.mjs#bumpsDeliveryRound`). The marker is written with
      // that **new** round, so crash recovery compares it against the card's
      // current `delivery_round` rather than the round the review audited.
      const reworkRound = originalRound + 1;
      if (original.kind === "epic") {
        actions.push({
          type: "reject_epic",
          reviewStatus: review.status,
          reviewRef,
          originalRef,
          round: originalRound,
          reworkRound,
          projectId: original.project_id ?? null,
          assigneeId: original.assignee_id ?? null,
          originalTitle: String(original.title ?? ""),
          // The rework child inherits the container's review decision; the loop
          // passes it as `--review yes|no` (a non-human creator must state it).
          reviewRequired: reviewRequired(original),
          findings,
          closeReview,
        });
      } else {
        actions.push({
          type: "reject_task",
          reviewStatus: review.status,
          reviewRef,
          originalRef,
          round: originalRound,
          reworkRound,
          findings,
          closeReview,
        });
      }
      continue;
    }

    // Crash recovery: the verdict was applied, the loop died before closing the
    // review card. The state left on the original says which half landed.
    if (original.status === "done") {
      if (verdict.verdict === "APPROVE") {
        actions.push({ type: "close_review", reviewStatus: review.status, reviewRef, originalRef, round: originalRound, reason: "already_approved", closeReview });
      } else {
        alerts.push({
          type: "verdict_conflict",
          review: reviewRef,
          original: originalRef,
          reason: "original_done_but_rejected",
          dedupKey: alertKey("verdict_conflict", reviewRef, "original_done_but_rejected"),
        });
      }
      continue;
    }

    if (reworkApplied) {
      if (original.status === "in_progress" && original.kind !== "epic") {
        actions.push({
          type: "reject_task_finish",
          reviewStatus: review.status,
          reviewRef,
          originalRef,
          round: originalRound,
          closeReview,
        });
        continue;
      }
      // `todo` for a task, `in_progress` for an epic (its fix child exists and
      // keeps the container from re-closing): the rejection has been applied.
      actions.push({ type: "close_review", reviewStatus: review.status, reviewRef, originalRef, round: originalRound, reason: "rework_applied", closeReview });
      continue;
    }

    alerts.push({
      type: "original_unexpected_status",
      review: reviewRef,
      original: originalRef,
      status: original.status ?? null,
      dedupKey: alertKey("unexpected", reviewRef, original.status ?? null),
    });
  }

  return { alerts, actions };
}

// ---------------------------------------------------------------------------
// Auto-accept: cards that do not require a review
// ---------------------------------------------------------------------------

/**
 * Decide which `in_review` cards can be closed directly because they do not
 * require an independent review.
 *
 * This is the "no review needed" half of the 0031 model. It is deliberately
 * separate from `autoAcceptReviews`: that flag only controls whether the loop
 * closes a **review card**; whether a no-review original may be completed is
 * decided by the board's acceptance policy, exactly as it is for any other
 * `done` write. The loop executes the plan as `taskd`.
 *
 * Guards:
 *
 *   * a truncated board read accepts nothing — "there is no open review card"
 *     cannot be proven over an incomplete snapshot;
 *   * only flow-A, non-review, `review_required = 0` cards;
 *   * a current-round review card that is **not canceled** blocks — a human or
 *     the loop put the card into review on purpose, so the review outcome owns
 *     it. A canceled review released the key and does not block;
 *   * `taskd` must be allowed to accept this scope under the board policy
 *     (`acceptanceAllows`); `human-only` + top-level waits for a human;
 *   * `held` recovers a crash after the marker was written but before the move.
 *
 * @param {{
 *   tasks?: object[],
 *   config?: object,
 *   boardTruncated?: boolean,
 *   skipRefs?: Set<string>|string[],
 * }} input
 * @returns {{alerts: object[], actions: object[]}}
 */
export function planAutoAccept(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const config = input.config ?? {};
  const maxActions =
    Number.isFinite(config.maxActions) && config.maxActions >= 0
      ? config.maxActions
      : DEFAULT_WORKFLOW_MAX_ACTIONS;
  const skip = input.skipRefs instanceof Set ? input.skipRefs : new Set(input.skipRefs ?? []);

  if (input.boardTruncated === true) {
    return {
      alerts: [{ type: "auto_accept_skipped", reason: "board_truncated" }],
      actions: [],
    };
  }

  const policy = acceptancePolicyOf(config);
  const reviewsByOriginal = new Map();
  for (const task of tasks) {
    if (!isReviewCard(task)) continue;
    const ref = reviewOf(task);
    const list = reviewsByOriginal.get(ref) ?? [];
    list.push(task);
    reviewsByOriginal.set(ref, list);
  }

  const candidates = [];
  const alerts = [];
  for (const task of tasks) {
    if (task?.status !== "in_review") continue;
    if (isReviewCard(task)) continue;
    if (flowOf(task) !== WORK_FLOW) continue;
    if (reviewRequired(task)) continue;

    const ref = String(task.identifier ?? "");
    if (ref === "" || skip.has(ref)) continue;

    const round = roundOf(task);
    const reviews = (reviewsByOriginal.get(ref) ?? []).filter((review) => {
      const audited = reviewRoundOf(review);
      return audited === null || audited === round;
    });
    // A review card that is not canceled is a deliberate review of this round.
    // Let its outcome (or a human) finish the card; auto-accepting over it would
    // defeat the review someone asked for.
    if (reviews.some((review) => review?.status !== "canceled")) continue;

    if (!acceptanceAllows(TASKD_KIND, policy, scopeOf(task))) {
      alerts.push({
        type: "auto_accept_skipped",
        reason: "human_only",
        original: ref,
        dedupKey: alertKey("auto_accept_skipped", ref, "human_only"),
      });
      continue;
    }

    // 0032 — an empty baseline is vacuous (no report needed); a non-empty one
    // is covered only by a current-round delivery report. This is the planner's
    // copy of the write gate, so a broken delivery produces one standing alert
    // rather than a failed action every tick.
    const baseline = Array.isArray(task.acceptance) ? task.acceptance : [];
    if (baseline.length > 0) {
      const report = input.reportsByRef?.[ref] ?? null;
      if (report === null) {
        alerts.push({
          type: "auto_accept_skipped",
          reason: "acceptance_unverified",
          original: ref,
          dedupKey: alertKey("auto_accept_skipped", ref, "acceptance_unverified"),
        });
        continue;
      }
      const coverage = coverageOf({
        baseline,
        reportItems: report.acceptance ?? [],
        includeExtras: true,
      });
      if (!coverage.ok) {
        const key = [
          ...coverage.missing.map((item) => item.key),
          ...coverage.blocking.map((item) => `${item.key}:${item.status}`),
        ]
          .sort()
          .join("|");
        alerts.push({
          type: "auto_accept_skipped",
          reason: "acceptance_incomplete",
          original: ref,
          missing: coverage.missing.map((item) => item.text),
          blocking: coverage.blocking.map((item) => item.text),
          dedupKey: alertKey("auto_accept_skipped", ref, "acceptance_incomplete", key),
        });
        continue;
      }
    }

    const held =
      nonEmpty(task?.meta?.accepted_by) !== null &&
      String(task?.meta?.accepted_round ?? "") === String(round);
    candidates.push({ task, ref, round, held });
  }

  candidates.sort(
    (a, b) =>
      String(a.task.status_changed_at ?? "").localeCompare(String(b.task.status_changed_at ?? "")) ||
      a.ref.localeCompare(b.ref),
  );

  const actions = candidates.slice(0, maxActions).map(({ ref, round, held }) => ({
    type: "auto_accept",
    originalRef: ref,
    round,
    acceptedBy: LOOP_AUTO_ACCEPTOR,
    held,
  }));
  if (candidates.length > actions.length) {
    alerts.push({
      type: "auto_accept_capped",
      remaining: candidates.length - actions.length,
      cap: maxActions,
    });
  }
  return { alerts, actions };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * The whole workflow decision for one tick: reconcile notices, then outcomes,
 * then auto-accept, then dispatch — and dispatch is told what outcomes and
 * auto-accept already handled, so a card approved in this same pass is not
 * immediately re-dispatched.
 *
 * @param {{
 *   tasks?: object[],
 *   verdicts?: Record<string, object>,
 *   reconcileActions?: object[],
 *   config?: object,
 *   boardTruncated?: boolean,
 *   now?: string|number,
 * }} input
 * @returns {{alerts: object[], actions: object[], changes: object[], summary: object}}
 */
export function planWorkflowTick(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const config = input.config ?? {};

  const byRef = new Map();
  for (const task of tasks) {
    if (typeof task?.identifier === "string" && task.identifier !== "") byRef.set(task.identifier, task);
    if (typeof task?.id === "string" && task.id !== "") byRef.set(task.id, task);
  }

  const reconcile = classifyReconcileActions(input.reconcileActions ?? [], {
    byRef,
    now: input.now ?? null,
  });
  const outcomes = planReviewOutcomes({
    tasks,
    verdicts: input.verdicts ?? {},
    reportsByRef: input.reportsByRef ?? {},
    config,
    boardTruncated: input.boardTruncated === true,
    now: input.now ?? null,
  });

  const autoAcceptPlan = planAutoAccept({
    tasks,
    reportsByRef: input.reportsByRef ?? {},
    config,
    boardTruncated: input.boardTruncated === true,
    skipRefs: new Set(outcomes.actions.map((action) => action.originalRef)),
  });

  const handled = new Set(
    [...outcomes.actions, ...autoAcceptPlan.actions].map((action) => action.originalRef),
  );
  const dispatch = planReviewDispatch({
    tasks,
    config,
    boardTruncated: input.boardTruncated === true,
    skipRefs: handled,
  });

  const cap = Number.isFinite(config.maxActions) && config.maxActions >= 0
    ? config.maxActions
    : DEFAULT_WORKFLOW_MAX_ACTIONS;
  const planned = [...outcomes.actions, ...autoAcceptPlan.actions, ...dispatch.actions];
  const actions = planned.slice(0, cap);
  const dropped = planned.length - actions.length;

  const alerts = [
    ...reconcile.alerts,
    ...outcomes.alerts,
    ...autoAcceptPlan.alerts,
    ...dispatch.alerts,
  ];
  if (dropped > 0) {
    // The combined slice is the one place work can disappear without a word.
    // Keep `dispatch_capped` (log-only) for the dispatch-only overflow; this
    // alert is the notified signal, keyed by the cap so a backlog change does
    // not re-notify.
    alerts.push({
      type: "actions_capped",
      cap,
      dropped,
      outcomes: outcomes.actions.length,
      autoAccept: autoAcceptPlan.actions.length,
      dispatch: dispatch.actions.length,
      dedupKey: alertKey("actions_capped", cap),
    });
  }

  // Under `agent-only` a review card needs a non-human writer to reach `done`;
  // with auto-accept off the loop never closes one either, so they accumulate
  // until somebody notices. State the conflict while a card is actually stuck.
  const policy = acceptancePolicyOf(config);
  const autoAcceptReviews = config.autoAcceptReviews !== false;
  const openReviews = tasks.filter(
    (task) => isReviewCard(task) && task?.status === "in_review",
  ).length;
  if (policy === "agent-only" && !autoAcceptReviews && openReviews > 0) {
    alerts.push({
      type: "review_cards_unclosable",
      reason: "agent_only_without_auto_accept",
      policy,
      autoAcceptReviews: false,
      reviews: openReviews,
      dedupKey: alertKey("review_cards_unclosable", policy, "auto_accept_off"),
    });
  }

  const count = (type) => actions.filter((action) => action.type === type).length;
  return {
    alerts,
    actions,
    changes: reconcile.changes,
    summary: {
      reconciled: reconcile.changes.length,
      approved: count("approve") + count("approve_hold"),
      held: count("approve_hold"),
      rejected: count("reject_task") + count("reject_task_finish") + count("reject_epic"),
      dispatched: count("create_review"),
      autoAccepted: count("auto_accept"),
      closed: count("close_review") + count("cancel_review"),
      actions: actions.length,
      alerts: alerts.length,
    },
  };
}
