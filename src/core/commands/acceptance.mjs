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
import { acceptanceScopeOf, assertAcceptanceAuthority, isTerminalStatus } from "../domain/status.mjs";
import { STATUS } from "../domain/enums.mjs";

/**
 * The scope a card's acceptance falls in: a card with a parent is a child; a
 * card carrying the structural review marker is a review card; everything else
 * is a top-level original.
 *
 * @param {object} ctx
 * @param {object} task
 * @returns {"child"|"review"|"top_level"}
 */
export function acceptanceScopeFor(ctx, task) {
  return acceptanceScopeOf({
    hasParent: ctx.repos.relations.getParent(task.id) !== null,
    // 0025 — the structural column, never `meta.review_of`: the meta key is
    // writable and must not be able to mint the exemption.
    reviewCard: task.reviewOfId !== null && task.reviewOfId !== undefined,
  });
}

/**
 * Refuse a writer that may not accept this card under the board's policy.
 *
 * @param {object} ctx
 * @param {object} task
 * @param {{kind?: string, id?: string}} actor
 */
export function assertAcceptance(ctx, task, actor) {
  return assertAcceptanceAuthority(actor, {
    policy: readPolicy(ctx),
    ...scopeInputs(ctx, task),
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
  if (String(actor?.kind ?? "") !== "human") return true;
  if (acceptanceScopeFor(ctx, task) !== "top_level") return true;

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

/** The policy in force, without importing the context module (keeps this testable). */
function readPolicy(ctx) {
  return typeof ctx.acceptancePolicy === "function" ? ctx.acceptancePolicy() : undefined;
}

/** The scope flags `assertAcceptanceAuthority` takes. */
function scopeInputs(ctx, task) {
  const scope = acceptanceScopeFor(ctx, task);
  return { hasParent: scope === "child", reviewCard: scope === "review" };
}
