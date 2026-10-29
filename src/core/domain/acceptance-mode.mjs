/**
 * The single acceptance vocabulary (0038).
 *
 * Two layers, one word:
 *
 *   * `projects.acceptance` — `auto | off | agent | human`. `auto` means "the
 *     creator (in practice the loop) decides per card"; the other three are a
 *     concrete default. `human` here is a **top-level-only** default: a child
 *     that names no mode under it resolves to `agent`.
 *   * `tasks.acceptance_mode` — `off | agent | human`. The resolved snapshot,
 *     frozen at creation. **`auto` is never stored on a card**: an unresolved
 *     card must not sit in a state whose owner is unknown.
 *
 * The three card modes:
 *
 *   * `off`   — no review; the deliverer (or the board, or a human) closes it.
 *               `in_progress → done` is allowed.
 *   * `agent` — an independent agent review card must APPROVE first; the loop
 *               applies the verdict and closes the card. A human may also close.
 *               **This is the fallback**: a card nobody declared is reviewed.
 *   * `human` — an independent agent review card still runs and records its
 *               verdict; only a human closes the card, with that verdict in
 *               hand. Opt-in only, and only on a **top-level** card: a card with
 *               a parent never resolves here (a person's decision is an
 *               `awaiting` question, not a close of a subtask).
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

/** The three values a card stores. `auto` is a project word, not a card word. */
export const CARD_ACCEPTANCE_MODES = Object.freeze(["off", "agent", "human"]);

/** The four values a project may store. */
export const PROJECT_ACCEPTANCES = Object.freeze(["auto", "off", "agent", "human"]);

/** The project default: let the creator decide per card. */
export const DEFAULT_PROJECT_ACCEPTANCE = "auto";

/**
 * What an unresolved card falls back to. **Every card — task or epic — is
 * reviewed**: review is the default, `human` is an explicit request and `off`
 * an explicit opt-out. The fallback used to be `human` (and `off` for an epic),
 * which made the one card kind whose job is to aggregate the others the only
 * one nobody audited.
 */
export const FALLBACK_CARD_ACCEPTANCE = "agent";

/**
 * The card column's own default (`off`), used when a DTO predates the column or
 * a raw write omits it. This is a *storage* default; the create resolver never
 * produces it by omission (it uses {@link FALLBACK_CARD_ACCEPTANCE}).
 */
export const DEFAULT_CARD_ACCEPTANCE = "off";

/**
 * @param {unknown} value
 * @returns {"off"|"agent"|"human"|null}
 */
export function normalizeCardAcceptance(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return CARD_ACCEPTANCE_MODES.includes(text) ? /** @type {any} */ (text) : null;
}

/**
 * @param {unknown} value
 * @returns {"auto"|"off"|"agent"|"human"|null}
 */
export function normalizeProjectAcceptance(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return PROJECT_ACCEPTANCES.includes(text) ? /** @type {any} */ (text) : null;
}

/**
 * Validate a card-level value.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {"off"|"agent"|"human"}
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
 * Validate a project-level value.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {"auto"|"off"|"agent"|"human"}
 */
export function assertProjectAcceptance(value, field = "acceptance") {
  const mode = normalizeProjectAcceptance(value);
  if (mode === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `project acceptance must be one of ${PROJECT_ACCEPTANCES.join(" | ")} ` +
        `(got ${JSON.stringify(value)})`,
      details: { field, received: value, allowed: [...PROJECT_ACCEPTANCES] },
    });
  }
  return mode;
}

/**
 * Read the stored card mode, defaulting to the column default.
 * @param {unknown} value
 * @returns {"off"|"agent"|"human"}
 */
export function cardAcceptanceOf(value) {
  return normalizeCardAcceptance(value) ?? DEFAULT_CARD_ACCEPTANCE;
}

/**
 * Resolve a new card's acceptance snapshot.
 *
 * Order:
 *   1. a review card is always `off` (flow B is never reviewed again);
 *   2. an explicit card value wins — except `human` on a card that declares a
 *      parent, which is refused (the mode is a top-level closure gate);
 *   3. a concrete project value is the default — except `human`, which is a
 *      **top-level-only** default: a child naming no mode falls through;
 *   4. project `auto` (or no project) falls back to `agent`, for every kind.
 *
 * `kind` is accepted for callers that pass it; the fallback no longer branches
 * on it. A container is reviewed like any other card.
 *
 * @param {{
 *   projectAcceptance?: unknown,
 *   requested?: unknown,
 *   reviewCard?: boolean,
 *   kind?: string,
 *   hasParent?: boolean,
 * }} [input]
 * @returns {{mode: "off"|"agent"|"human", source: "review_card"|"requested"|"project"|"fallback"}}
 */
export function resolveCardAcceptance(input = {}) {
  const requestedGiven = input.requested !== undefined && input.requested !== null;
  const requested = normalizeCardAcceptance(input.requested);
  if (requestedGiven && requested === null) {
    // `auto` is a project word; a card must state a concrete answer.
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

  const hasParent = input.hasParent === true;
  if (requested === "human" && hasParent) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        "acceptance mode human is top-level only: a card with a parent is reviewed and closed " +
        "by its own mode, never handed to a person",
      details: {
        field: "acceptance_mode",
        received: requested,
        hasParent: true,
        allowed: ["off", "agent"],
      },
      hint: {
        fix: "create the child with --acceptance-mode off or agent, or with no mode at all",
      },
    });
  }
  if (requested !== null) return { mode: requested, source: "requested" };

  const projectGiven =
    input.projectAcceptance !== undefined && input.projectAcceptance !== null;
  const project = normalizeProjectAcceptance(input.projectAcceptance);
  if (projectGiven && project === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `project acceptance must be one of ${PROJECT_ACCEPTANCES.join(" | ")} ` +
        `(got ${JSON.stringify(input.projectAcceptance)})`,
      details: {
        field: "acceptance",
        received: input.projectAcceptance,
        allowed: [...PROJECT_ACCEPTANCES],
      },
    });
  }
  // A project-level `human` is a top-level default only: a card that declares a
  // parent (or already has one, at the update boundary) must state its own mode
  // rather than inherit a person's closure gate.
  if (project === "human" && !hasParent) return { mode: "human", source: "project" };
  if (project !== null && project !== "auto" && project !== "human") {
    return { mode: project, source: "project" };
  }
  return { mode: FALLBACK_CARD_ACCEPTANCE, source: "fallback" };
}

/**
 * May this actor close a card in `mode`?
 *
 * The question is answered by the **evidence**, not by who claims to be the
 * board: `agent` mode needs a current-round APPROVE (checked by the caller), and
 * the one actor it excludes is the agent that wrote that verdict. So "the loop
 * closes it" is no longer a privilege a caller can claim by declaring a kind —
 * any writer that did not review the card may apply the approval, and the
 * reviewer never closes its own finding.
 *
 * `human` mode still admits exactly one kind. `off` trusts the deliverer.
 *
 * @param {string|null|undefined} actorKind
 * @param {"off"|"agent"|"human"} mode
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
    case "agent":
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
 *   mode: "off"|"agent"|"human",
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
 * `agent` and review-card closure are no longer a kind allow-list — anyone who
 * did not write the verdict may close — so a human is the only kind that is
 * always admitted. The refusal names `verdictAuthorId`, which is the identity
 * that actually mattered.
 *
 * @param {"off"|"agent"|"human"} mode
 * @param {boolean} reviewCard
 * @returns {string|string[]}
 */
function allowedFor(mode, reviewCard) {
  if (reviewCard) return [HUMAN_KIND];
  switch (cardAcceptanceOf(mode)) {
    case "off":
      return "any non-blank actor kind";
    case "agent":
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
 * can see it. The check reads the actor's **declared** kind, exactly as the old
 * acceptance policy did.
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
      : mode === "agent"
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
