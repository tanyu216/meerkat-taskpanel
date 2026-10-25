/**
 * The acceptance guards shared by `moveStatus` and `deliver`.
 *
 * Two questions, in a fixed order, because a caller must be told the *first*
 * reason a write is refused:
 *
 *   1. **May this writer accept?** `assertAcceptanceAuthority` reads the board's
 *      policy and the card's scope (child / review / top-level). See
 *      `domain/status.mjs`.
 *   2. **Is the card ready to be accepted?** A human closing a top-level
 *      original needs the review cards for the **current** delivery round to be
 *      resolved (`done` or `canceled`). The loop is deliberately not held to
 *      this: its protocol is "move the original first, close the review card
 *      last", and a reverse gate would deadlock it.
 *
 * The children-terminal gate is the third, and applies to `in_review` as well as
 * `done` — it is not part of "acceptance" (a delivery to review is not an
 * acceptance), so it is a separate function the two commands call before the
 * delivery gate.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { isTerminalStatus } from "../domain/status.mjs";
import { assertAcceptanceAuthority, cardAcceptanceOf } from "../domain/acceptance-mode.mjs";
import { parseReviewVerdict } from "../domain/workflow.mjs";
import { coverageOf } from "../domain/acceptance.mjs";
import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { assertEpicRollupReady, assertRollupCoverage } from "./rollup.mjs";

/**
 * Refuse a writer that may not accept this card under the card's own mode.
 *
 * 0038 — scope is gone: the card's `acceptance_mode` names who closes it. The
 * one structural override is the review card itself (its reviewer reports a
 * verdict; the acceptor closes it).
 *
 * @param {object} ctx
 * @param {object} task
 * @param {{kind?: string, id?: string}} actor
 */
export function assertAcceptance(ctx, task, actor) {
  return assertAcceptanceAuthority(actor, {
    mode: cardAcceptanceOf(task.acceptanceMode),
    reviewCard: task.reviewOfId !== null && task.reviewOfId !== undefined,
  });
}

/**
 * Does the current-round delivery report cover the card's frozen baseline?
 *
 * This is the 0032 acceptance gate. A review card is exempt here — its evidence
 * is the APPROVE report checked by {@link assertReviewEvidence}. A card with an
 * empty baseline is vacuously covered (the migration grandfather and the
 * "creator wrote no criteria" case); the guarantee is that a non-empty baseline
 * can never be shortened, not that every card must have one.
 *
 * `deliver(to: done)` passes the report it is about to insert, because that row
 * does not exist in the repository yet; every other caller reads the current
 * round from the repository.
 *
 * @param {object} ctx
 * @param {object} task
 * @param {{report?: object}} [options]
 */
export function assertAcceptanceCoverage(ctx, task, options = {}) {
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) return true;
  // 0033 — an epic's acceptance facts are its children's, not its own
  // `acceptance_json` (which stays informational). The container owes a
  // current-round rollup that covers every child.
  if (task.kind === TASK_KIND.EPIC) {
    // A `deliver` call passes the report it is about to insert; any other caller
    // reads the current round from the repository.
    if (options.report !== undefined && options.report !== null) {
      assertRollupCoverage(ctx, task, options.report.acceptance);
      return true;
    }
    return assertEpicRollupReady(ctx, task);
  }
  // An empty baseline is vacuously covered — the migration grandfather and the
  // "the creator wrote no criteria" case. It needs no report: the guarantee is
  // that a non-empty baseline cannot be shortened, not that every card has one.
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) return true;

  const supplied = options.report !== undefined && options.report !== null;
  const report = supplied ? options.report : deliveryReportFor(ctx, task);
  if (report === null) {
    throw new DomainError("ACCEPTANCE_UNVERIFIED", {
      message:
        `${task.identifier} has an acceptance baseline but no delivery report for round ` +
        `${task.deliveryRound}`,
      details: {
        taskId: task.id,
        identifier: task.identifier,
        round: task.deliveryRound,
        waived:
          task.reportWaiverRound !== null &&
          task.reportWaiverRound !== undefined &&
          Number(task.reportWaiverRound) === Number(task.deliveryRound),
      },
      hint: {
        fix:
          "write the current round's report (taskctl issue deliver <ref> --report-file -); " +
          "a --no-report waiver is not acceptance evidence",
      },
    });
  }

  assertCoverageOrThrow({
    task,
    baseline: task.acceptance,
    reportItems: report.acceptance,
    source: "delivery",
  });
  return true;
}

/** The current-round report, or `null` when there is none (0035: any row counts). */
function deliveryReportFor(ctx, task) {
  return ctx.repos.reports.latestForRound(task.id, task.deliveryRound) ?? null;
}

/** The coverage arithmetic + the refusal. Shared by the delivery and review gates. */
function assertCoverageOrThrow({ task, baseline, reportItems, source, review = null }) {
  const coverage = coverageOf({ baseline, reportItems, includeExtras: true });
  if (coverage.ok) return;
  const reviewRef =
    review === null ? null : { identifier: review.identifier, status: review.status };
  const parts = [];
  if (coverage.missing.length > 0) parts.push(`${coverage.missing.length} missing`);
  if (coverage.blocking.length > 0) parts.push(`${coverage.blocking.length} blocking`);
  throw new DomainError("ACCEPTANCE_INCOMPLETE", {
    message:
      `${task.identifier}: ${parts.join(", ")} acceptance item(s) for delivery round ` +
      `${task.deliveryRound}`,
    details: {
      taskId: task.id,
      identifier: task.identifier,
      source,
      round: task.deliveryRound,
      ...(reviewRef === null ? {} : { review: reviewRef }),
      missing: coverage.missing,
      blocking: coverage.blocking,
      extra: coverage.extra,
    },
    hint: {
      fix:
        source === "review"
          ? "the review report must answer every baseline criterion; REJECT instead of approving an incomplete report"
          : "answer every baseline criterion with met/not_applicable (not_applicable needs a note)",
    },
  });
}

/**
 * Does a card that says `review_required` have the evidence it promised?
 *
 * The evidence is a **current-round** review card with an `APPROVE` verdict.
 * An open review that already carries the verdict passes here: the loop's
 * protocol is to move the original first and close the review card last. The
 * human/top-level pending check that follows still makes a human wait for the
 * card to be closed, because a human should not accept over an open review.
 *
 * A review card itself is never held to this rule (it is flow B and is forced to
 * `review_required = 0`), but the guard is repeated here so a raw row cannot
 * produce a chain.
 *
 * @param {object} ctx
 * @param {object} task
 */
export function assertReviewEvidence(ctx, task) {
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) return true;

  const reviews = currentRoundReviews(ctx, task);
  let approvedReview = null;
  let approvedVerdict = null;
  for (const review of reviews) {
    if (review.status !== "in_review" && review.status !== "done") continue;
    const verdict = parseReviewVerdict(
      ctx.repos.reports.listByTask(review.id),
      review.deliveryRound ?? null,
    );
    if (verdict.ok === true && verdict.verdict === "APPROVE") {
      approvedReview = review;
      approvedVerdict = verdict;
      break;
    }
  }
  if (approvedVerdict !== null) {
    // 0032 — an APPROVE is only evidence when its report answers every criterion
    // of the original (and of the review card's own copied baseline). A reviewer
    // that writes `VERDICT: APPROVE` over a report that never mentions half the
    // baseline has not accepted the work.
    assertCoverageOrThrow({
      task,
      baseline: task.acceptance,
      reportItems: approvedVerdict.report?.acceptance,
      source: "review",
      review: approvedReview,
    });
    if (approvedReview !== null) {
      assertCoverageOrThrow({
        task: approvedReview,
        baseline: approvedReview.acceptance,
        reportItems: approvedVerdict.report?.acceptance,
        source: "review",
        review: approvedReview,
      });
    }
    return true;
  }

  const open = reviews.filter((review) => !isTerminalStatus(review.status));
  if (open.length > 0) {
    throw new DomainError("REVIEW_PENDING", {
      message:
        `${task.identifier} still has ${open.length} open review card(s) for delivery round ` +
        `${task.deliveryRound}: ${open.map((review) => review.identifier).join(", ")}`,
      details: {
        taskId: task.id,
        identifier: task.identifier,
        round: task.deliveryRound,
        pending: open.map((review) => ({ identifier: review.identifier, status: review.status })),
      },
      hint: {
        fix: "let the review finish, or cancel an abandoned review card",
      },
    });
  }

  throw new DomainError("REVIEW_REQUIRED", {
    message:
      `${task.identifier} requires an approved review for delivery round ${task.deliveryRound}`,
    details: {
      taskId: task.id,
      identifier: task.identifier,
      round: task.deliveryRound,
      reviewRequired: true,
    },
    hint: {
      fix:
        "let the loop dispatch a review, or a human may waive it: " +
        'taskctl issue update <ref> --acceptance-mode off --reason "<why>"',
    },
  });
}

/**
 * Refuse a human closing a top-level original whose current-round review cards
 * are still open.
 *
 * Only a human is checked. A `system`/agent acceptance means the loop (or an
 * operator's own automation), whose write order is original-then-review; gating
 * it here would refuse the very sequence it is designed to perform.
 *
 * @param {object} ctx
 * @param {object} task
 * @param {{kind?: string, id?: string}} actor
 */
export function assertReviewReady(ctx, task, actor) {
  // 0038 — the card's own mode. `agent` owes a current-round APPROVE; `off` and
  // `human` owe no review evidence. The human pending check below is a second,
  // independent rule about an open review a human is about to close.
  if (cardAcceptanceOf(task.acceptanceMode) !== "agent") return true;
  assertReviewEvidence(ctx, task);

  if (String(actor?.kind ?? "") !== "human") return true;

  const reviews = currentRoundReviews(ctx, task);
  const pending = reviews.filter((review) => !isTerminalStatus(review.status));
  if (pending.length === 0) return true;

  throw new DomainError("REVIEW_PENDING", {
    message:
      `${task.identifier} still has ${pending.length} open review card(s) for delivery round ` +
      `${task.deliveryRound}: ${pending.map((review) => review.identifier).join(", ")}`,
    details: {
      taskId: task.id,
      identifier: task.identifier,
      round: task.deliveryRound,
      pending: pending.map((review) => ({ identifier: review.identifier, status: review.status })),
    },
    hint: {
      fix:
        "let the review finish, or cancel the review card if it is abandoned " +
        "(`taskctl issue move <review> canceled` after moving it out of in_review)",
    },
  });
}

/**
 * Refuse `→ in_review` / `→ done` while a child is still in flight.
 *
 * The same predicate the automatic rollup uses (`rollup.mjs#allChildrenTerminal`),
 * applied here so the manual path cannot hand a half-finished container to
 * acceptance. The database trigger (`0026`) is the machine guarantee.
 *
 * @param {object} ctx
 * @param {object} task
 * @param {string} to
 */
export function assertChildrenTerminal(ctx, task, to) {
  if (to !== STATUS.IN_REVIEW && to !== STATUS.DONE) return true;
  const children = ctx.repos.relations
    .listChildren(task.id)
    .map((edge) => ctx.repos.tasks.get(edge.target))
    .filter((child) => child !== null && child !== undefined);
  if (children.length === 0) return true;

  const open = children.filter((child) => !isTerminalStatus(child.status));
  if (open.length === 0) return true;

  throw new DomainError("CHILDREN_OPEN", {
    message:
      `${task.identifier} still has ${open.length} non-terminal child card(s): ` +
      open.map((child) => `${child.identifier} (${child.status})`).join(", "),
    details: {
      taskId: task.id,
      identifier: task.identifier,
      to,
      blocking: open.map((child) => ({ identifier: child.identifier, status: child.status })),
    },
    hint: { fix: "finish (done) or cancel each child before closing the container" },
  });
}

/**
 * The review cards that belong to this card's **current** delivery round.
 *
 * A `review_round` of NULL suppresses every round — the conservative reading
 * for a card written before the field existed, and the same one the loop's
 * dispatch and the SLA patrol take. An old-round review is history and must not
 * hold the original open.
 *
 * @param {object} ctx
 * @param {object} task
 */
export function currentRoundReviews(ctx, task) {
  return ctx.repos.tasks
    .listReviewsOf(task.id)
    .filter((review) => review.reviewRound === null || Number(review.reviewRound) === Number(task.deliveryRound));
}
