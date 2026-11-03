/**
 * The single acceptance vocabulary (post-0002).
 *
 * A card stores one word that names its closer:
 *
 *   * `off`   — no review; the deliverer (or the board, or a human) closes it.
 *               `in_progress → done` is allowed.
 *   * `auto`  — an independent agent review card must APPROVE first; the loop
 *               applies the verdict and closes the card. A human may also close.
 *               **This is the fallback**: a card nobody declared is reviewed.
 *   * `human` — an independent agent review card still runs and records its
 *               verdict; the review must finish, and only a human closes the
 *               card. A human may also close an `auto` card as a fallback.
 *
 * There is no project-level default: the creator resolves the card's word at
 * creation from the card's own context. A project may document its selection
 * rules in `docs/agents/acceptance-mode.md` for the card-creating skill; that document
 * is not board data and is never stored or inherited.
 *
 * `deploy` is deliberately **not** a card rule. Whether a card belongs to a
 * release line — and what confirming that means — is the loop's own decision;
 * the board only stores the acceptance mode the loop chose.
 *
 * Pure: no `node:` specifiers, no clock.
 */

import { HUMAN_KIND } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { reviewIdentityOf } from "../../foundation/review-identity.mjs";

/** The three values a card stores. */
export const CARD_ACCEPTANCE_MODES = Object.freeze(["off", "auto", "human"]);

/**
 * What an unresolved card falls back to. **Every card — task or epic — is
 * reviewed**: review is the default, `human` is an explicit request and `off`
 * an explicit opt-out.
 */
export const FALLBACK_CARD_ACCEPTANCE = "auto";

/**
 * The card column's own default (`auto`), used when a DTO predates the column or
 * a raw write omits it.
 */
export const DEFAULT_CARD_ACCEPTANCE = "auto";

/**
 * @param {unknown} value
 * @returns {"off"|"auto"|"human"|null}
 */
export function normalizeCardAcceptance(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return CARD_ACCEPTANCE_MODES.includes(text) ? /** @type {any} */ (text) : null;
}

/**
 * Validate a card-level value.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {"off"|"auto"|"human"}
 */
export function assertCardAcceptance(value, field = "acceptance_mode") {
  const mode = normalizeCardAcceptance(value);
  if (mode === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `acceptance mode must be one of ${CARD_ACCEPTANCE_MODES.join(" | ")} ` +
        `(got ${JSON.stringify(value)})`,
      details: { field, received: value, allowed: [...CARD_ACCEPTANCE_MODES] },
    });
  }
  return mode;
}

/**
 * Read the stored card mode, defaulting to the column default.
 * @param {unknown} value
 * @returns {"off"|"auto"|"human"}
 */
export function cardAcceptanceOf(value) {
  return normalizeCardAcceptance(value) ?? DEFAULT_CARD_ACCEPTANCE;
}

/**
 * Resolve a new card's acceptance snapshot.
 *
 * Order:
 *   1. a review card is always `off` (flow B is never reviewed again);
 *   2. an explicit card value wins;
 *   3. otherwise the unresolved card falls back to `auto`.
 *
 * There is no project input: the creator states the card's word, and a project
 * that wants selection guidance documents it outside the board.
 *
 * `kind` is accepted for callers that pass it; the fallback does not branch on
 * it. A container is reviewed like any other card.
 *
 * @param {{
 *   requested?: unknown,
 *   reviewCard?: boolean,
 *   kind?: string,
 * }} [input]
 * @returns {{mode: "off"|"auto"|"human", source: "review_card"|"requested"|"fallback"}}
 */
export function resolveCardAcceptance(input = {}) {
  const requestedGiven = input.requested !== undefined && input.requested !== null;
  const requested = normalizeCardAcceptance(input.requested);
  if (requestedGiven && requested === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `a card's acceptance mode must be one of ${CARD_ACCEPTANCE_MODES.join(" | ")} ` +
        `(got ${JSON.stringify(input.requested)})`,
      details: {
        field: "acceptance_mode",
        received: input.requested,
        allowed: [...CARD_ACCEPTANCE_MODES],
      },
    });
  }

  if (input.reviewCard === true) {
    if (requested !== null && requested !== "off") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "a review card is always acceptance off; it cannot require its own review",
        details: {
          field: "acceptance_mode",
          received: requested,
          reviewCard: true,
          allowed: ["off"],
        },
        hint: { fix: "create the review card without --acceptance-mode, or pass off" },
      });
    }
    return { mode: "off", source: "review_card" };
  }

  if (requested !== null) return { mode: requested, source: "requested" };
  return { mode: FALLBACK_CARD_ACCEPTANCE, source: "fallback" };
}

/**
 * May this actor close a card in `mode`?
 *
 * The question is answered by the **evidence**, not by who claims to be the
 * board: `auto` mode needs a current-round APPROVE (checked by the caller), and
 * the one actor it excludes is the agent that wrote that verdict. So "the loop
 * closes it" is no longer a privilege a caller can claim by declaring a kind —
 * any writer that did not review the card may apply the approval, and a human
 * may always close. The reviewer never closes its own finding.
 *
 * `human` mode still admits exactly one kind. `off` trusts the deliverer.
 *
 * @param {string|null|undefined} actorKind
 * @param {"off"|"auto"|"human"} mode
 * @param {{reviewCard?: boolean, actorId?: string|null, verdictAuthorId?: string|null}} [options]
 *   `actorId` and `verdictAuthorId` are **actor-row ids** (`actors.id`), not
 *   `--agent` names: the caller normalises before asking.
 * @returns {boolean}
 */
export function acceptanceAllows(actorKind, mode, options = {}) {
  const who = String(actorKind ?? "").trim();
  if (who === "") return false;
  const wroteTheVerdict = sameActorId(options.actorId, options.verdictAuthorId);
  if (options.reviewCard === true) {
    // The reviewer must not close the card it just wrote a verdict on.
    return who === HUMAN_KIND || !wroteTheVerdict;
  }
  switch (cardAcceptanceOf(mode)) {
    case "off":
      // Trust mode: the deliverer itself may close the card.
      return true;
    case "auto":
      // An independent APPROVE is the authority; the verdict's author is not.
      return who === HUMAN_KIND || !wroteTheVerdict;
    case "human":
      return who === HUMAN_KIND;
    default:
      return false;
  }
}

/** Two actor ids that name one writer. A missing id on either side is not a match. */
function sameActorId(actorId, verdictAuthorId) {
  return (
    typeof actorId === "string" &&
    actorId !== "" &&
    typeof verdictAuthorId === "string" &&
    verdictAuthorId !== "" &&
    actorId === verdictAuthorId
  );
}

/**
 * The acceptance authority **derived from one card**.
 *
 * The card's own mode and its review-card shape are two facts every caller
 * currently re-supplies (`{ reviewCard: task.reviewOfId !== null }`). One of
 * them — "is this a review card" — has a single reader now
 * (`foundation/review-identity.mjs`); this wrapper makes the other (the mode)
 * come from the same card so a caller cannot pair the wrong two.
 *
 * @param {object|null|undefined} task a Task DTO or a wire task
 * @returns {{
 *   isReview: boolean,
 *   mode: "off"|"auto"|"human",
 *   canAccept: (actorKind: string|null|undefined, options?: {actorId?: string|null, verdictAuthorId?: string|null}) => boolean,
 * }}
 */
export function acceptanceAuthorityFor(task) {
  const isReview = reviewIdentityOf(task).isReview;
  const mode = cardAcceptanceOf(task?.acceptanceMode ?? task?.acceptance_mode);
  return {
    isReview,
    mode,
    canAccept: (actorKind, options = {}) =>
      acceptanceAllows(actorKind, mode, { reviewCard: isReview, ...options }),
  };
}

/**
 * The error's `allowed` field: which kinds are **never** refused.
 *
 * `auto` and review-card closure are no longer a kind allow-list — anyone who
 * did not write the verdict may close — so a human is the only kind that is
 * always admitted. The refusal names `verdictAuthorId`, which is the identity
 * that actually mattered.
 *
 * @param {"off"|"auto"|"human"} mode
 * @param {boolean} reviewCard
 * @returns {string|string[]}
 */
function allowedFor(mode, reviewCard) {
  if (reviewCard) return [HUMAN_KIND];
  switch (cardAcceptanceOf(mode)) {
    case "off":
      return "any non-blank actor kind";
    case "auto":
      return [HUMAN_KIND];
    case "human":
      return [HUMAN_KIND];
    default:
      return [];
  }
}

/**
 * Assert that this writer may move a card into `done`.
 *
 * A service-layer invariant: the actor is not a `tasks` column, so no trigger
 * can see it. The check reads the actor's **declared** kind, exactly as before.
 *
 * @param {{kind?: string, id?: string}|null|undefined} actor
 * @param {{mode?: unknown, reviewCard?: boolean, actorId?: string|null, verdictAuthorId?: string|null}} [options]
 * @returns {true}
 * @throws {DomainError} ACCEPTANCE_FORBIDDEN
 */
export function assertAcceptanceAuthority(actor, options = {}) {
  const kind = String(actor?.kind ?? "").trim();
  const mode = cardAcceptanceOf(options.mode);
  const reviewCard = options.reviewCard === true;
  const actorId = typeof options.actorId === "string" ? options.actorId : null;
  const verdictAuthorId =
    typeof options.verdictAuthorId === "string" ? options.verdictAuthorId : null;
  if (acceptanceAllows(kind, mode, { reviewCard, actorId, verdictAuthorId })) return true;

  const allowed = allowedFor(mode, reviewCard);
  const wroteTheVerdict = sameActorId(actorId, verdictAuthorId);
  const message = reviewCard
    ? wroteTheVerdict
      ? "a review card is closed after its verdict, never by the actor who wrote the verdict"
      : "a review card needs an actor to close it"
    : mode === "human"
      ? "this card is human-accepted: only a human may move it to done"
      : mode === "auto"
        ? wroteTheVerdict
          ? "a card is never accepted by the agent that reviewed it"
          : "this card needs an independent review; it is closed after APPROVE"
        : "an actor kind is required to accept a card";
  throw new DomainError("ACCEPTANCE_FORBIDDEN", {
    message,
    details: {
      actorKind: kind === "" ? null : kind,
      actorId: actor?.id ?? null,
      mode,
      reviewCard,
      verdictAuthorId,
      allowed,
    },
    hint: {
      fix:
        mode === "human"
          ? "a human can run this with --as-human; an agent must leave the card in in_review"
          : reviewCard
            ? "let the reviewer deliver a verdict; another actor (or a human) closes the review card"
            : "another actor closes the card after APPROVE; the reviewer cannot accept its own finding",
    },
  });
}
