/**
 * The task lifecycle state machine (F1 ruling: whitelist table, option A).
 *
 * The whitelist is the *only* fact source: `domain/status.mjs` decides the
 * service-layer path and the migrations re-encode the exact same table as
 * triggers (`0024_epic_deliver_from_todo.sql` for the whitelist, and
 * `0027_reopen_terminal.sql` for the terminal and round-bump rules), so the DB
 * is the machine guarantee behind the same rules
 * (`test/contract/state-machine.test.mjs` walks every ordered pair, for a
 * `task` *and* for an `epic`, down both paths).
 *
 * Since 0024 the whitelist has **two rows per status for one pair**: the base
 * table below is the `task` row and {@link EPIC_ONLY_TRANSITIONS} is the one
 * pair an `epic` adds to it. The second axis is confined to `kind` — it is not a
 * general-purpose rule hook — and every predicate takes it as an optional last
 * argument, so a caller with no kind in hand reads the base table.
 *
 * Key properties:
 *   - `done` is reachable **only** from `in_review` ⇒ "no delivery without review".
 *   - `done`/`canceled` are terminal (I3), with one audited exit: **reopen to
 *     `todo`**. They are still "finished work" everywhere terminality is a
 *     bookkeeping fact (archive, idempotency, rollup) — only the state machine
 *     gained the exit. Reopening starts a new delivery round, so the previous
 *     round's report cannot satisfy the gate for the next delivery.
 *   - Leaving `in_review` (to `in_progress` or `blocked`) starts a new delivery
 *     round (F3), so the previous round's report can no longer satisfy the gate.
 *
 * M1 adds one first-class status, `awaiting` (the card is running but has asked
 * a human — design §2/§6). Three properties of it are load-bearing and are
 * asserted in `test/contract/state-machine.test.mjs`:
 *
 *   - **`in_progress → awaiting` is the only entry.** No other status may reach
 *     it, so the badge's reason stays single-valued.
 *   - **`awaiting → in_progress` is the only way back into the work** (a human
 *     replied); `awaiting → canceled` is allowed (the human cancels);
 *     `awaiting → blocked` and `awaiting → in_review | done` are **forbidden**.
 *     The last one is a delivery-gate bypass: reaching `in_review` from
 *     `awaiting` would skip the report for the current round, which the DB
 *     trigger and this table both refuse.
 *   - **`awaiting` is not terminal, and it does not start a delivery round.**
 *     `awaiting → in_progress` is a *resume of the same attempt*, not a rework:
 *     `ROUND_BUMPING_EXITS` only speaks about leaving `in_review` (F3), so the
 *     round counter is untouched and the round's report, once written, still
 *     counts. The card never left `in_progress` in the board's eyes.
 *
 * Pure: no `node:` specifiers.
 */

import {
  ACCEPTANCE_POLICIES,
  DEFAULT_ACCEPTANCE_POLICY,
  HUMAN_KIND,
  TASKD_KIND,
} from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { STATUS, STATUSES, TASK_KIND } from "./enums.mjs";

/**
 * `from` → allowed `to` values. Every pair *not* listed here is rejected with
 * `INVALID_TRANSITION` (or `TERMINAL_STATE` when `from` is terminal).
 *
 * This is the **task** row. An `epic` adds {@link EPIC_ONLY_TRANSITIONS} on top
 * of it (0024); `kind` is the second argument of every predicate below, and a
 * caller that does not pass one gets exactly this table.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.BACKLOG]: Object.freeze([STATUS.TODO, STATUS.CANCELED]),
  [STATUS.TODO]: Object.freeze([STATUS.BACKLOG, STATUS.IN_PROGRESS, STATUS.BLOCKED, STATUS.CANCELED]),
  [STATUS.IN_PROGRESS]: Object.freeze([
    STATUS.IN_REVIEW,
    STATUS.BLOCKED,
    STATUS.TODO,
    STATUS.CANCELED,
    // M1 — the single entry into `awaiting` (design §2.1/§6).
    STATUS.AWAITING,
  ]),
  // M1 — the overlay state. Its exits are back into the work (the worker was
  // live when the reply arrived), back to the **queue** (0034 — the worker had
  // stopped, so the card must be claimed again by a fresh one), or out
  // (canceled). `blocked`, `in_review` and `done` are absent on purpose: an
  // `awaiting` card must not be able to reach `in_review` without the report the
  // delivery gate demands. `awaiting → todo` is not a reopen: the round does not
  // move and the claim is released.
  [STATUS.AWAITING]: Object.freeze([STATUS.IN_PROGRESS, STATUS.TODO, STATUS.CANCELED]),
  [STATUS.IN_REVIEW]: Object.freeze([STATUS.DONE, STATUS.IN_PROGRESS, STATUS.BLOCKED]),
  [STATUS.BLOCKED]: Object.freeze([STATUS.TODO, STATUS.IN_PROGRESS, STATUS.IN_REVIEW, STATUS.CANCELED]),
  // The reopen edge. `todo` is the only target on purpose: `in_progress` is a
  // *claimed* state, and a reopened card has no claim holder — landing there
  // would create an `in_progress` row with `claimed_by IS NULL`, the corruption
  // I2 exists to prevent. The card goes back to the queue and is claimed
  // normally. The audited reason is a service-layer rule (`commands/tasks.mjs`);
  // the whitelist is the database guarantee.
  [STATUS.DONE]: Object.freeze([STATUS.TODO]),
  [STATUS.CANCELED]: Object.freeze([STATUS.TODO]),
});

/**
 * The **epic overlay** (0024): the pairs that are legal for an `epic` and for no
 * other kind.
 *
 * An `epic` is a container — never claimed, never `in_progress` (that refusal is
 * `domain/claim.mjs#decideClaim`, and it is product semantics: `GLOSSARY.md`
 * "Epic"). So the one assumption every other row of the table can make —
 * *`in_review` is entered from the work cycle* — does not hold for it: `todo` is
 * where `issue create --kind epic` puts a container, and without an exit there
 * the card can never be delivered, and so never reach `done`. The pair is
 * **added** to the row rather than replacing it; the whitelist stays a whitelist.
 *
 * One pair, and only `todo → in_review`:
 *
 *   - `todo` is the epic's ready state, and the only one that means "released for
 *     work" — so it is the only state that may be delivered from. `backlog` is
 *     deliberately absent: an unreleased container is not deliverable, exactly as
 *     an unreleased task is not claimable.
 *   - `todo → in_progress` is *not* removed. It is the claim gate, not the table,
 *     that refuses an epic, and moving that refusal into the table would take
 *     `in_progress → todo`'s counterexample apart for `deploy` cards too.
 *
 * What the overlay does **not** relax is the delivery gate: `requiresReport`
 * keys on `to` alone, so an epic landing in `in_review` still owes a report for
 * the current round — the rollup, which is what a reviewer reads. The database
 * mirrors both halves (`0024_epic_deliver_from_todo.sql`).
 */
export const EPIC_ONLY_TRANSITIONS = Object.freeze({
  [STATUS.TODO]: Object.freeze([STATUS.IN_REVIEW]),
});


/**
 * Finished statuses (I3). They hold the "finished work" bookkeeping (archive
 * eligibility, idempotency release, rollup completion), but they are no longer
 * unreachable-from: the one exit is {@link REOPEN_TARGET}.
 */
export const TERMINAL_STATUSES = Object.freeze([STATUS.DONE, STATUS.CANCELED]);

/** The only status a terminal card may be reopened to. */
export const REOPEN_TARGET = STATUS.TODO;

/**
 * Is this pair the reopen edge?
 * @param {string} from @param {string} to
 * @returns {boolean}
 */
export function isReopen(from, to) {
  return isTerminalStatus(from) && to === REOPEN_TARGET;
}

/**
 * Exits from `in_review` that start a new delivery round (F3). Both of these
 * are "the delivery came back" — a rework and a blocker discovered at review
 * time. `in_review → done` is the delivery succeeding and does *not* bump.
 *
 * Membership is keyed on the **source** status: this list names the exits from
 * `in_review`. So M1's `awaiting → in_progress` is not in this list and cannot
 * be: `awaiting` is entered from `in_progress`, the round never ended, and
 * resuming therefore keeps the same delivery round — and the report already
 * written for it. Written down because "in_progress" appearing in the list
 * makes the pair look like it might belong here; the `from` is what decides
 * (asserted in `test/contract/state-machine.test.mjs`).
 *
 * A terminal reopen is the second round-bumping family, handled separately in
 * {@link bumpsDeliveryRound}: it is keyed on a different source pair and does
 * not belong in this `in_review`-only list.
 */
export const ROUND_BUMPING_EXITS = Object.freeze([STATUS.IN_PROGRESS, STATUS.BLOCKED]);

/** The single status a task may be claimed from. */
export const CLAIMABLE_STATUS = STATUS.TODO;

/**
 * The **work cycle** — the statuses in which a card keeps its execution claim
 * (`claimed_by` / `claimed_at` / `heartbeat_at`).
 *
 * The claim is a lock on *this* attempt, so it lives exactly as long as the card
 * is being worked: `in_progress` holds it, `awaiting` is the same attempt
 * paused on a human (M1), `in_review` is the same attempt handed over for
 * review, and `blocked` is the same attempt stopped on something external. Every
 * status **outside** the cycle is an exit — `todo`, `backlog` and the terminal
 * pair — and leaving the cycle releases the lock (see
 * `storage/repositories/tasks.mjs#moveCas`).
 *
 * Why the release matters (T-20261014-152924): the schema refuses a claim on a
 * `backlog` card (`CHECK (claimed_by IS NULL OR status <> 'backlog')`), while
 * `in_progress → todo` and `todo → backlog` are both legal transitions. Before
 * the release, the first leg left `claimed_by` behind and the second leg tripped
 * the CHECK — surfacing as a raw `CHECK constraint failed: …` in the UI.
 *
 * Why `in_review` and `blocked` are **inside** the cycle rather than released on
 * entry: both can be exited back into `in_progress` (`rework`, `unblock`), and
 * the card that comes back must still be the *same executor's* card. Releasing
 * on entry would hand the lock to whoever performed the bounce — `rework` does
 * not re-check the routing lock (`commands/tasks.mjs#moveStatus`), so the new
 * holder would be taken silently and the original executor's next heartbeat
 * would be refused with `EXECUTION_ACTIVE` for up to six hours.
 */
export const CLAIM_HOLDING_STATUSES = Object.freeze([
  STATUS.IN_PROGRESS,
  STATUS.AWAITING,
  STATUS.IN_REVIEW,
  STATUS.BLOCKED,
]);

/**
 * Does a card in this status keep its execution claim?
 * @param {unknown} status
 * @returns {boolean}
 */
export function holdsClaim(status) {
  return CLAIM_HOLDING_STATUSES.includes(/** @type {string} */ (status));
}

/** @param {unknown} value */
export function isKnownStatus(value) {
  return STATUSES.includes(/** @type {string} */ (value));
}

/** @param {unknown} value */
export function isTerminalStatus(value) {
  return TERMINAL_STATUSES.includes(/** @type {string} */ (value));
}

/**
 * The allowed targets of `from` **for this kind of card**.
 *
 * `kind` is the card's own `kind` (`TASK_KIND`). An `epic` gets
 * {@link EPIC_ONLY_TRANSITIONS} laid over the base row; every other kind — and a
 * caller that states none — reads the base table unchanged, which is the
 * fail-closed direction: an unstated kind is never *more* permissive.
 *
 * @param {string} from
 * @param {string|null} [kind] the card's kind, or `null`/omitted for the base table
 * @returns {readonly string[]} allowed targets (empty for terminal statuses and
 *   for unknown inputs).
 */
export function allowedTargets(from, kind = null) {
  const base = ALLOWED_TRANSITIONS[from];
  if (base === undefined) return Object.freeze([]);
  if (kind !== TASK_KIND.EPIC) return base;
  const extra = EPIC_ONLY_TRANSITIONS[from];
  return extra === undefined ? base : Object.freeze([...base, ...extra]);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {boolean} whether the pair is on the whitelist for this kind
 */
export function canTransition(from, to, kind = null) {
  return allowedTargets(from, kind).includes(to);
}

/**
 * Machine-readable reason for a rejection, or `null` when the pair is allowed.
 * Kept separate from `assertTransition` so the contract test can assert codes
 * without catching exceptions.
 *
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {"TERMINAL_STATE"|"INVALID_TRANSITION"|null}
 */
export function transitionReasonCode(from, to, kind = null) {
  if (canTransition(from, to, kind)) return null;
  if (isTerminalStatus(from)) return "TERMINAL_STATE";
  return "INVALID_TRANSITION";
}

/**
 * Assert a transition, throwing the same reason code the DB trigger raises.
 *
 * The refusal carries the target's own `allowed` list, so the repair a caller
 * prints is the move that caller can actually make — an epic in `todo` is told
 * `in_review` is available, a task in `todo` is not.
 *
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {string} `to`, for chaining
 */
export function assertTransition(from, to, kind = null) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown status value(s): from=${JSON.stringify(from)} to=${JSON.stringify(to)}`,
      details: { from, to, allowed: STATUSES },
    });
  }
  const reason = transitionReasonCode(from, to, kind);
  if (reason !== null) {
    throw new DomainError(reason, {
      details: {
        from,
        to,
        allowed: [...allowedTargets(from, kind)],
      },
      message:
        reason === "TERMINAL_STATE"
          ? `task is ${from} (terminal); it may only be reopened to ${REOPEN_TARGET}`
          : `transition ${from} → ${to} is not allowed`,
    });
  }
  return to;
}

/** @param {unknown} value */
export function isClaimable(value) {
  return value === CLAIMABLE_STATUS;
}

/**
 * The acceptance policies a board may run under (T-20261019 acceptance).
 *
 *   * `human-only` — only a human closes a top-level card (children and review
 *     cards are still closed by agents/the loop);
 *   * `both` (the default, and the historical rule) — a human or the board;
 *   * `agent-only` — any non-human writer (the board, or any agent platform).
 *
 * `agent-only` deliberately does **not** name *which* agent closes a card: that
 * is the deployment's business (the loop's skill, a reviewer, an operator's own
 * script). The board's only claim is the one bit it can see — "this writer is
 * not the human".
 */
export { ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY };

/**
 * The historical allowed-kinds pair, kept as an export for the `both` policy and
 * for callers that still describe the old rule. New code should ask
 * {@link acceptanceAllows} instead.
 */
export const ACCEPTANCE_ACTOR_KINDS = Object.freeze([HUMAN_KIND, TASKD_KIND]);

/** Normalise a configured policy string, or `null` when it is not one of ours. */
export function normalizeAcceptancePolicy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ACCEPTANCE_POLICIES.includes(text) ? text : null;
}

/**
 * Which acceptance rule applies to this card.
 *
 * Precedence is deliberate: **a card with a parent is a child, whatever else it
 * is**. A human never closes a child card (the children are the agents' work to
 * finish), and that rule is stronger than the review-card exemption — a review
 * card that somehow acquired a parent is treated as a child, which is the
 * conservative reading of both rules.
 *
 * @param {{reviewCard?: boolean, hasParent?: boolean}} [input]
 * @returns {"child"|"review"|"top_level"}
 */
export function acceptanceScopeOf(input = {}) {
  if (input.hasParent === true) return "child";
  if (input.reviewCard === true) return "review";
  return "top_level";
}

/**
 * May `kind` accept a card in `scope` under `policy`?
 *
 * "Any non-human" is the whole test for `agent-only` and for child cards: the
 * board does not model agent roles, so it cannot and must not distinguish
 * `taskd` from `claude` there.
 *
 * @param {string|null|undefined} kind the writer's declared actor kind
 * @param {string} policy one of {@link ACCEPTANCE_POLICIES}
 * @param {"child"|"review"|"top_level"} scope
 * @returns {boolean}
 */
export function acceptanceAllows(kind, policy, scope) {
  const who = String(kind ?? "").trim();
  if (who === "") return false;
  if (scope === "child") return who !== HUMAN_KIND;
  if (scope === "review") {
    return policy === "agent-only" ? who !== HUMAN_KIND : ACCEPTANCE_ACTOR_KINDS.includes(who);
  }
  switch (policy) {
    case "human-only":
      return who === HUMAN_KIND;
    case "agent-only":
      return who !== HUMAN_KIND;
    case "both":
    default:
      return ACCEPTANCE_ACTOR_KINDS.includes(who);
  }
}

/** The kinds a refusal should name: `any non-human`, or a concrete pair. */
function allowedKindsFor(policy, scope) {
  if (scope === "child") return "any non-human";
  if (scope === "review") {
    return policy === "agent-only" ? "any non-human" : [...ACCEPTANCE_ACTOR_KINDS];
  }
  if (policy === "human-only") return [HUMAN_KIND];
  if (policy === "agent-only") return "any non-human";
  return [...ACCEPTANCE_ACTOR_KINDS];
}

/**
 * Assert that this writer may move a card into `done`.
 *
 * `done` is the board's *acceptance* act, and acceptance is the one transition a
 * worker must never perform on its own work by default. What "the acceptor" means
 * is a board policy (see {@link ACCEPTANCE_POLICIES}); the actor's declared kind
 * is the only input, because the board does not model agent roles.
 *
 * This is a service-layer invariant, and deliberately so: the actor of a write
 * is not a column of the `tasks` row, so — unlike the delivery gate, which a
 * trigger can decide from the report table — no `tasks` trigger can see it.
 * `SQL_CONSTRAINT_CODES`/`DB_RAISE_CODES` in `foundation/errors.mjs` name the codes
 * a trigger *can* raise; this one is `JS_ONLY_CODES` for exactly that reason.
 *
 * The check reads the actor's **declared** kind. The board trusts a caller's
 * attribution (a loopback caller is trusted, and `--actor-kind human` is
 * refused), so this raises the bar to "you must claim to be the allowed kind",
 * not to a cryptographic guarantee.
 *
 * @param {{kind?: string, id?: string}|null|undefined} actor
 * @param {{policy?: string, reviewCard?: boolean, hasParent?: boolean}} [options]
 * @returns {true}
 * @throws {DomainError} ACCEPTANCE_FORBIDDEN
 */
export function assertAcceptanceAuthority(actor, options = {}) {
  const kind = String(actor?.kind ?? "").trim();
  const policy = normalizeAcceptancePolicy(options.policy) ?? DEFAULT_ACCEPTANCE_POLICY;
  const scope = acceptanceScopeOf(options);
  if (acceptanceAllows(kind, policy, scope)) return true;

  const allowed = allowedKindsFor(policy, scope);
  throw new DomainError("ACCEPTANCE_FORBIDDEN", {
    message:
      scope === "child"
        ? "Only a non-human writer may accept a child card; a human closes the top-level card."
        : policy === "human-only"
          ? "This board is human-only: only a human may accept a delivered card."
          : "This writer may not accept a delivery to done under the board's acceptance policy.",
    details: {
      actorKind: kind === "" ? null : kind,
      actorId: actor?.id ?? null,
      policy,
      scope,
      allowed,
    },
    hint: {
      fix:
        scope === "child"
          ? "let the agent/loop close the child; a human accepts the top-level card"
          : "a worker stops at in_review; an independent reviewer reports a verdict and the loop " +
            "(or a human) applies it",
    },
  });
}

/**
 * Does moving `from → to` start a new delivery round?
 *
 * Two families: leaving `in_review` for a rework/blocker (F3), and reopening a
 * terminal card. The second must bump, or the old round's report would satisfy
 * the delivery gate on the first delivery after a reopen.
 *
 * @param {string} from
 * @param {string} to
 */
export function bumpsDeliveryRound(from, to) {
  if (isTerminalStatus(from)) return to === REOPEN_TARGET;
  return from === STATUS.IN_REVIEW && ROUND_BUMPING_EXITS.includes(/** @type {string} */ (to));
}

/**
 * Does entering `to` require a report for the current round?
 * @param {string} to
 */
export function requiresReport(to) {
  return to === STATUS.IN_REVIEW;
}
