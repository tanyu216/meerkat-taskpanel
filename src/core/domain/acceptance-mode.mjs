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

import { HUMAN_KIND, TASKD_KIND } from "../../foundation/constants.mjs";
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
 * May `actorKind` close a card in `mode`?
 *
 * Scope is deliberately gone: a child is closed by whoever its own mode names,
 * not by a matrix. The one structural override is the review card itself — its
 * reviewer reports a verdict, and the acceptor (the board or a human) closes it.
 *
 * @param {string|null|undefined} actorKind
 * @param {"off"|"agent"|"human"} mode
 * @param {{reviewCard?: boolean}} [options]
 * @returns {boolean}
 */
export function acceptanceAllows(actorKind, mode, options = {}) {
  const who = String(actorKind ?? "").trim();
  if (who === "") return false;
  if (options.reviewCard === true) {
    // The reviewer must not close the card it just wrote a verdict on.
    return who === HUMAN_KIND || who === TASKD_KIND;
  }
  switch (cardAcceptanceOf(mode)) {
    case "off":
      // Trust mode: the deliverer itself may close the card.
      return true;
    case "agent":
      // The loop applies the APPROVE; a human may always close.
      return who === HUMAN_KIND || who === TASKD_KIND;
    case "human":
      return who === HUMAN_KIND;
    default:
      return false;
  }
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
 *   canAccept: (actorKind: string|null|undefined) => boolean,
 * }}
 */
export function acceptanceAuthorityFor(task) {
  const isReview = reviewIdentityOf(task).isReview;
  const mode = cardAcceptanceOf(task?.acceptanceMode ?? task?.acceptance_mode);
  return {
    isReview,
    mode,
    canAccept: (actorKind) => acceptanceAllows(actorKind, mode, { reviewCard: isReview }),
  };
}

/**
 * @param {"off"|"agent"|"human"} mode
 * @param {boolean} reviewCard
 * @returns {string|string[]}
 */
function allowedFor(mode, reviewCard) {
  if (reviewCard) return [HUMAN_KIND, TASKD_KIND];
  switch (cardAcceptanceOf(mode)) {
    case "off":
      return "any non-blank actor kind";
    case "agent":
      return [HUMAN_KIND, TASKD_KIND];
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
 * @param {{mode?: unknown, reviewCard?: boolean}} [options]
 * @returns {true}
 * @throws {DomainError} ACCEPTANCE_FORBIDDEN
 */
export function assertAcceptanceAuthority(actor, options = {}) {
  const kind = String(actor?.kind ?? "").trim();
  const mode = cardAcceptanceOf(options.mode);
  const reviewCard = options.reviewCard === true;
  if (acceptanceAllows(kind, mode, { reviewCard })) return true;

  const allowed = allowedFor(mode, reviewCard);
  const message = reviewCard
    ? "a review card is closed by the acceptor, never by the reviewer"
    : mode === "human"
      ? "this card is human-accepted: only a human may move it to done"
      : mode === "agent"
        ? "this card needs an independent review; the loop (or a human) closes it after APPROVE"
        : "an actor kind is required to accept a card";
  throw new DomainError("ACCEPTANCE_FORBIDDEN", {
    message,
    details: {
      actorKind: kind === "" ? null : kind,
      actorId: actor?.id ?? null,
      mode,
      reviewCard,
      allowed,
    },
    hint: {
      fix:
        mode === "human"
          ? "a human can run this with --as-human; an agent must leave the card in in_review"
          : reviewCard
            ? "let the reviewer deliver a verdict; the loop or a human closes the review card"
            : "pass --actor-kind <platform>; a card is never accepted anonymously",
    },
  });
}
