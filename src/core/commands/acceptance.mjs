/**
 * The acceptance guards shared by `moveStatus` and `deliver`.
 *
 * Two questions, in a fixed order, because a caller must be told the *first*
 * reason a write is refused:
 *
 *   1. **May this writer accept?** `assertAcceptanceAuthority` reads the card's
 *      acceptance mode; a review card is the one structural override. See
 *      `domain/acceptance-mode.mjs`.
 *   2. **Is the card ready to be accepted?** A human closing an `agent` card
 *      needs the review cards for the **current** delivery round to be resolved
 *      (`done` or `canceled`). The loop is deliberately not held to
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
import { acceptanceAuthorityFor, assertAcceptanceAuthority, cardAcceptanceOf } from "../domain/acceptance-mode.mjs";
import { parseReviewVerdict } from "../domain/workflow.mjs";
import { coverageOf, unsupportedClaimsOf } from "../domain/acceptance.mjs";
import { normalizeName } from "../domain/dictionary.mjs";
import { COMMIT_SHA_PATTERN, evidenceFromJson, evidenceHasCommand } from "../domain/report.mjs";
import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { assertEpicRollupReady, assertRollupCoverage } from "./rollup.mjs";

/**
 * Refuse a writer that may not accept this card under the card's own mode.
 *
 * 0038 — scope is gone: the card's `acceptance_mode` names who closes it. The
 * one structural override is the review card itself (its reviewer reports a
 * verdict; the acceptor closes it).
 *
 * **The authority is the evidence, not the kind.** An `agent` card is closed by
 * anyone who did not write the current-round APPROVE; a review card the same.
 * Declaring a kind therefore buys no right to accept — which is what makes the
 * board's own `system` kind harmless to keep.
 *
 * @param {object} ctx
 * @param {object} task
 * @param {{kind?: string, id?: string}} actor
 */
export function assertAcceptance(ctx, task, actor) {
  const authority = acceptanceAuthorityFor(task);
  return assertAcceptanceAuthority(actor, {
    mode: authority.mode,
    reviewCard: authority.isReview,
    actorId: actorRowId(ctx, actor),
    verdictAuthorId: verdictAuthorIdFor(ctx, task),
  });
}

/**
 * The actor row id behind an `--agent` name, or `null`.
 *
 * Two identity spellings meet here: the command layer carries the raw name
 * (`--agent Reviewer`), while `task_reports.author_id` is a row id. Comparing
 * the two as strings is how a review would be "closed by its own reviewer" and
 * pass. The lookup is **exact after normalisation** — no fuzzy match, because
 * verification must not equate two different people — and it never writes: an
 * actor that has not written before cannot be the author of a stored verdict.
 *
 * @param {object} ctx
 * @param {{kind?: string, id?: string}|null|undefined} actor
 * @returns {string|null}
 */
function actorRowId(ctx, actor) {
  const name = typeof actor?.id === "string" ? normalizeName(actor.id) : "";
  if (name === "") return null;
  const row = ctx.repos.dictionary
    .list()
    .find((entry) => normalizeName(entry.displayName) === name);
  return row?.id ?? null;
}

/**
 * The actor whose verdict decides who may close this card.
 *
 * - a review card: its own report for the current round — the verdict the
 *   reviewer wrote;
 * - an original card: the author of the review card's APPROVE (see
 *   `approvedReview`), or nothing when no verdict exists yet.
 *
 * A `null` answer means "no verdict to exclude", which is the honest reading of
 * a card no review has reached.
 */
function verdictAuthorIdFor(ctx, task) {
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) {
    // A review card's verdict is its own report for the current round. The
    // stored row is the authority: it was resolved when the verdict was written,
    // so the comparison needs no second spelling of the same name.
    return ctx.repos.reports.latestForRound(task.id, task.deliveryRound)?.authorId ?? null;
  }
  return approvedReview(ctx, task)?.verdict.report?.authorId ?? null;
}

/**
 * A delivery that cites a path must also cite the commit it was made in.
 *
 * A path anchor is a claim about the working tree. An uncommitted tree can be
 * stashed, reset or overwritten before the reviewer reads it, so the board
 * refuses the report unless the same evidence names the commit that contains
 * the work. This is the *shape* half: core cannot shell out to git
 * (`test/core/domain/purity.test.mjs`), so the reviewer verifies that the sha
 * resolves and that every path exists at it (`review-workflow.md`).
 *
 * Review cards are exempt: their path anchors name places the reviewer read,
 * not work they produced. An epic is exempt too — a container has no working
 * tree of its own, and its rollup evidence is the union of its children's,
 * each of which passed this gate.
 *
 * @param {object} task
 * @param {object|null|undefined} report the prepared or stored report
 * @returns {true}
 * @throws {DomainError} DELIVERY_NEEDS_COMMIT
 */
export function assertDeliveryCommitAnchor(task, report) {
  if (task?.reviewOfId !== null && task?.reviewOfId !== undefined) return true;
  if (task?.kind === TASK_KIND.EPIC) return true;

  const items = evidenceFromJson(report?.evidence).items;
  const pathAnchors = items
    .filter((anchor) => anchor?.kind === "path" && typeof anchor.path === "string" && anchor.path.trim() !== "")
    .map((anchor) => anchor.path);
  if (pathAnchors.length === 0) return true;

  const hasCommit = items.some(
    (anchor) =>
      anchor?.kind === "commit" &&
      typeof anchor.sha === "string" &&
      COMMIT_SHA_PATTERN.test(anchor.sha),
  );
  if (hasCommit) return true;

  throw new DomainError("DELIVERY_NEEDS_COMMIT", {
    message:
      `${task?.identifier ?? "the card"}: a delivery that cites a path must also cite the ` +
      "commit it was made in — an uncommitted tree can disappear before the review reads it",
    details: {
      taskId: task?.id ?? null,
      identifier: task?.identifier ?? null,
      round: report?.round ?? task?.deliveryRound ?? null,
      pathAnchors,
    },
    hint: {
      fix:
        'commit the work, then add {"kind":"commit","sha":"<sha>"} to the report evidence ' +
        "(taskctl report template <ref> --commit <sha>); put the commit anchor before any " +
        "path anchor so bounding cannot drop it",
    },
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
    evidence: evidenceFromJson(report.evidence).items,
    // An `agent` card is the one whose report is checked by a second pair of
    // eyes; `off`/`human` cards keep their lighter contract.
    requireEvidence: cardAcceptanceOf(task.acceptanceMode) === "agent",
  });
  return true;
}

/** The current-round report, or `null` when there is none (0035: any row counts). */
function deliveryReportFor(ctx, task) {
  return ctx.repos.reports.latestForRound(task.id, task.deliveryRound) ?? null;
}

/** The coverage arithmetic + the refusal. Shared by the delivery and review gates. */
function assertCoverageOrThrow({
  task,
  baseline,
  reportItems,
  source,
  review = null,
  evidence = [],
  requireEvidence = false,
}) {
  const coverage = coverageOf({ baseline, reportItems, includeExtras: true });
  // A `met` that names no anchor is a recollection, not evidence. Structural:
  // it forces the pointer, not the truth of the pointer.
  const unsupported = requireEvidence
    ? unsupportedClaimsOf({ reportItems, evidence })
    : [];
  if (coverage.ok && unsupported.length === 0) return;
  const reviewRef =
    review === null ? null : { identifier: review.identifier, status: review.status };
  const parts = [];
  if (coverage.missing.length > 0) parts.push(`${coverage.missing.length} missing`);
  if (coverage.blocking.length > 0) parts.push(`${coverage.blocking.length} blocking`);
  if (unsupported.length > 0) parts.push(`${unsupported.length} without evidence`);
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
      unsupported,
      extra: coverage.extra,
    },
    hint: {
      fix:
        source === "review"
          ? "the review report must answer every baseline criterion and point each met item at its evidence; REJECT instead of approving an incomplete report"
          : "answer every baseline criterion with met/not_applicable (not_applicable needs a note); a met item needs a note naming its anchor, e.g. evidence[1]",
    },
  });
}

/**
 * The current-round review whose verdict is an `APPROVE`, with that verdict.
 *
 * One definition of "the verdict" for both questions this module answers: the
 * evidence gate (`assertReviewEvidence`) and the authority gate (who may close —
 * never the agent that wrote the verdict). Two readers of one fact, so they
 * cannot disagree about which review made the card closable.
 *
 * A review card has no review of its own: it is flow B, and its own report is
 * the verdict. The caller answers that case directly.
 *
 * @param {object} ctx
 * @param {object} task the original card
 * @returns {{review: object, verdict: object}|null}
 */
export function approvedReview(ctx, task) {
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) return null;
  for (const review of currentRoundReviews(ctx, task)) {
    if (review.status !== "in_review" && review.status !== "done") continue;
    const verdict = parseReviewVerdict(
      ctx.repos.reports.listByTask(review.id),
      review.deliveryRound ?? null,
    );
    if (verdict.ok === true && verdict.verdict === "APPROVE") return { review, verdict };
  }
  return null;
}

/**
 * Does an `agent` card have the evidence its mode promised?
 *
 * The evidence is a **current-round** review card with an `APPROVE` verdict.
 * An open review that already carries the verdict passes here: the loop's
 * protocol is to move the original first and close the review card last. The
 * human pending check that follows still makes a human wait for the card to be
 * closed, because a human should not accept over an open review.
 *
 * A review card itself is never held to this rule (it is flow B and is forced to
 * `acceptance_mode = off`), but the guard is repeated here so a raw row cannot
 * produce a chain.
 *
 * @param {object} ctx
 * @param {object} task
 */
export function assertReviewEvidence(ctx, task) {
  if (task.reviewOfId !== null && task.reviewOfId !== undefined) return true;

  const reviews = currentRoundReviews(ctx, task);
  const approved = approvedReview(ctx, task);
  if (approved !== null) {
    const approvedReview = approved.review;
    const approvedVerdict = approved.verdict;
    // 0032 — an APPROVE is only evidence when its report answers every criterion
    // of the original (and of the review card's own copied baseline). A reviewer
    // that writes `VERDICT: APPROVE` over a report that never mentions half the
    // baseline has not accepted the work.
    const verdictEvidence = evidenceFromJson(approvedVerdict.report?.evidence).items;
    assertCoverageOrThrow({
      task,
      baseline: task.acceptance,
      reportItems: approvedVerdict.report?.acceptance,
      source: "review",
      review: approvedReview,
      evidence: verdictEvidence,
      requireEvidence: true,
    });
    if (approvedReview !== null) {
      assertCoverageOrThrow({
        task: approvedReview,
        baseline: approvedReview.acceptance,
        reportItems: approvedVerdict.report?.acceptance,
        source: "review",
        review: approvedReview,
        evidence: verdictEvidence,
        requireEvidence: true,
      });
    }
    // The reviewer's own run: an APPROVE with no command anchor is a reading of
    // the delivery report, not an independent verification of it.
    if (!evidenceHasCommand(verdictEvidence)) {
      throw new DomainError("ACCEPTANCE_INCOMPLETE", {
        message:
          `${task.identifier}: the APPROVE on ${approvedReview?.identifier ?? "the review card"} ` +
          "carries no command evidence for the reviewer's own run",
        details: {
          taskId: task.id,
          identifier: task.identifier,
          source: "review",
          round: task.deliveryRound,
          ...(approvedReview === null
            ? {}
            : { review: { identifier: approvedReview.identifier, status: approvedReview.status } }),
          reason: "no_command_evidence",
        },
        hint: {
          fix:
            "run the project's gate (or any command) and record it as a {kind:\"command\", cmd, exit_code} anchor; " +
            "REJECT instead if it cannot be run",
        },
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
      acceptanceMode: "agent",
    },
    hint: {
      fix:
        "let the loop dispatch a review, or a human may waive it: " +
        'taskctl issue update <ref> --acceptance-mode off --reason "<why>"',
    },
  });
}

/**
 * Refuse a human closing an `agent` card whose current-round review cards are
 * still open.
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
