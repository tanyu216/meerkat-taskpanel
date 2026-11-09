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
 *     The terminal exits (`→ done`, `→ canceled`) do not: the card is finished
 *     and a reopen is what starts a round.
 *   - TP-0125 adds two direct exits — `in_progress → backlog` and
 *     `in_review → canceled` — so leaving the work does not have to pass through
 *     another claimed state. Exiting the claim cycle is one fact,
 *     {@link leavesClaimCycle}, and the orchestrator's interrupt machinery keys
 *     on it.
 *   - TP-0127 adds `blocked → backlog`: a card parked on an external stop may
 *     re-enter the queue as unreleased work. It is the same shape as the two
 *     above — one exit with no reason and no round bump — and the browser
 *     exposes exactly `todo`, `backlog`, `canceled` of the four.
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

import { DomainError } from "../../foundation/errors.mjs";
import { reviewIdentityOf } from "../../foundation/review-identity.mjs";
import { normalizeCardAcceptance } from "./acceptance-mode.mjs";
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
    // TP-0125 — a direct exit to the queue. The `todo` hop re-enters the
    // dispatch cycle; a card released for later must not be re-claimed on the
    // way out.
    STATUS.BACKLOG,
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
  // TP-0125 — a terminal exit in one move. The old path (`→ in_progress →
  // canceled`) briefly re-entered the work cycle and re-armed dispatch; the
  // terminal move is not a rework, so it does not bump the round.
  [STATUS.IN_REVIEW]: Object.freeze([STATUS.DONE, STATUS.IN_PROGRESS, STATUS.BLOCKED, STATUS.CANCELED]),
  // TP-0127 — `backlog` is the exit that does not re-enter the dispatch cycle:
  // a blocked card can go back to the queue as unreleased work again. The other
  // three stay: `in_progress` is the unblock (the same executor resumes),
  // `in_review` is the repair edge for a blocker found at review time, and
  // `canceled` abandons it. All four exits clear `blocked_reason`, release the
  // claim (none of them holds it) and leave the delivery round alone.
  [STATUS.BLOCKED]: Object.freeze([
    STATUS.TODO,
    STATUS.BACKLOG,
    STATUS.IN_PROGRESS,
    STATUS.IN_REVIEW,
    STATUS.CANCELED,
  ]),
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
 *     that refuses an epic; the table only says which status may be delivered
 *     from.
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
 * The **acceptance-mode overlay** (0038): the one pair a card in `off` mode
 * gains on top of the base table.
 *
 * `off` means "no review" — the deliverer may close the card directly, so
 * `in_progress → done` is the honest edge. `auto` and `human` still reach done
 * only through `in_review`; the overlay is keyed on an explicitly supplied
 * mode, never on a missing one, so a caller that has not read the card keeps the
 * base table (the fail-closed direction).
 */
export const AUTO_ONLY_TRANSITIONS = Object.freeze({
  [STATUS.IN_PROGRESS]: Object.freeze([STATUS.DONE]),
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

/**
 * Does moving `from → to` take the card out of its claim cycle?
 *
 * This is the **one predicate** the interrupt writers share (TP-0125): a card
 * that stops holding its claim has no executor — the turn still running in the
 * old attempt is an orphan and must be interrupted, and the next claim must
 * start a fresh session. It is deliberately derived from {@link holdsClaim}
 * rather than an edge list, so a status added to the cycle is classified
 * without a second table.
 *
 * A terminal move from `in_review` (`→ done`, `→ canceled`) also matches. That
 * is benign: the card is finished, so the writer finds no live turn and only
 * forgets the finished session (ADR 0017 records it).
 *
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function leavesClaimCycle(from, to) {
  return holdsClaim(from) && !holdsClaim(to);
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
 * @param {"off"|"auto"|"human"|null} [acceptanceMode] the card's acceptance
 *   mode; only an explicit `off` adds the direct-done edge
 * @returns {readonly string[]} allowed targets (empty for terminal statuses and
 *   for unknown inputs).
 */
export function allowedTargets(from, kind = null, acceptanceMode = null, reviewCard = false) {
  const base = ALLOWED_TRANSITIONS[from];
  if (base === undefined) return Object.freeze([]);
  // ADR 0014 — `kind='review'` is the same fact as the marker. A caller that
  // holds only the kind must not lose the review rules, so the kind is folded
  // into the flag here rather than left to every caller.
  const isReview = reviewCard || kind === TASK_KIND.REVIEW;
  // A review card has no reopen edge. Reopening the *original* is what starts
  // the next round; a review card is an artefact of the round it audited, and
  // The terminal trigger (`tr_tasks_review_no_reopen`) enforces the same rule.
  if (isReview && isTerminalStatus(from)) return Object.freeze([]);
  const extra = [];
  if (kind === TASK_KIND.EPIC) extra.push(...(EPIC_ONLY_TRANSITIONS[from] ?? []));
  // 0038 — only an explicit `off` gains the direct edge. A missing mode keeps
  // the base table rather than the column default, so a caller that has not
  // read the card cannot widen the transitions it may offer. A review card is flow B: it must
  // deliver its verdict through `in_review`, so the direct edge is withheld.
  if (!isReview && normalizeCardAcceptance(acceptanceMode) === "off") {
    extra.push(...(AUTO_ONLY_TRANSITIONS[from] ?? []));
  }
  return extra.length === 0 ? base : Object.freeze([...new Set([...base, ...extra])]);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @param {"off"|"auto"|"human"|null} [acceptanceMode] the card's acceptance mode
 * @param {boolean} [reviewCard] whether the card is a flow-B review card
 * @returns {boolean} whether the pair is on the whitelist for this kind/mode
 */
export function canTransition(from, to, kind = null, acceptanceMode = null, reviewCard = false) {
  return allowedTargets(from, kind, acceptanceMode, reviewCard).includes(to);
}

/**
 * Machine-readable reason for a rejection, or `null` when the pair is allowed.
 * Kept separate from `assertTransition` so the contract test can assert codes
 * without catching exceptions.
 *
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @param {"off"|"auto"|"human"|null} [acceptanceMode] the card's acceptance mode
 * @param {boolean} [reviewCard] whether the card is a flow-B review card
 * @returns {"TERMINAL_STATE"|"INVALID_TRANSITION"|null}
 */
export function transitionReasonCode(from, to, kind = null, acceptanceMode = null, reviewCard = false) {
  if (canTransition(from, to, kind, acceptanceMode, reviewCard)) return null;
  // The terminal trigger refuses a review card's reopen with
  // `INVALID_TRANSITION`, not `TERMINAL_STATE`: the card is terminal, but the
  // reason it cannot come back is that it is a review artefact.
  if (reviewCard && isTerminalStatus(from) && to === REOPEN_TARGET) return "INVALID_TRANSITION";
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
 * @param {"off"|"auto"|"human"|null} [acceptanceMode] the card's acceptance mode
 * @param {boolean} [reviewCard] whether the card is a flow-B review card
 * @returns {string} `to`, for chaining
 */
export function assertTransition(from, to, kind = null, acceptanceMode = null, reviewCard = false) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown status value(s): from=${JSON.stringify(from)} to=${JSON.stringify(to)}`,
      details: { from, to, allowed: STATUSES },
    });
  }
  const reason = transitionReasonCode(from, to, kind, acceptanceMode, reviewCard);
  if (reason !== null) {
    throw new DomainError(reason, {
      details: {
        from,
        to,
        allowed: [...allowedTargets(from, kind, acceptanceMode, reviewCard)],
      },
      message:
        reason === "TERMINAL_STATE"
          ? `task is ${from} (terminal); it may only be reopened to ${REOPEN_TARGET}`
          : `transition ${from} → ${to} is not allowed`,
    });
  }
  return to;
}

/**
 * The transition policy **derived from one card**.
 *
 * The primitives above take the four facts a caller must know — `from`, `kind`,
 * `acceptanceMode`, and whether the card is a review card — as positional
 * arguments. That is the interface a caller can get wrong: forget the review
 * flag and an `off` review card silently gains the direct-done edge. This
 * wrapper reads all four from the card once and returns the questions a caller
 * actually asks.
 *
 * `reviewIdentityOf` is the same reader the workflow and the SLA patrol use, so
 * "is this a review card" has one answer everywhere. `acceptanceMode` is read in
 * both spellings: the repository DTO is camelCase, a wire snapshot snake_case.
 *
 * @param {object|null|undefined} task a Task DTO or a wire task
 * @returns {{
 *   from: string,
 *   allowed: readonly string[],
 *   can: (to: string) => boolean,
 *   reason: (to: string) => "TERMINAL_STATE"|"INVALID_TRANSITION"|null,
 *   assert: (to: string) => string,
 *   bumpsRound: (to: string) => boolean,
 *   requiresReport: (to: string) => boolean,
 * }}
 */
export function transitionPolicyFor(task) {
  const from = task?.status;
  const kind = task?.kind ?? null;
  const mode = task?.acceptanceMode ?? task?.acceptance_mode ?? null;
  // ADR 0014 — the marker is authority, and the kind is the same fact. Either
  // one saying "review" is enough; a legacy meta-only row has the marker path.
  const reviewCard = reviewIdentityOf(task).isReview || kind === TASK_KIND.REVIEW;
  return {
    from,
    allowed: allowedTargets(from, kind, mode, reviewCard),
    can: (to) => canTransition(from, to, kind, mode, reviewCard),
    reason: (to) => transitionReasonCode(from, to, kind, mode, reviewCard),
    assert: (to) => assertTransition(from, to, kind, mode, reviewCard),
    bumpsRound: (to) => bumpsDeliveryRound(from, to),
    requiresReport: (to) => requiresReport(to),
  };
}

/** @param {unknown} value */
export function isClaimable(value) {
  return value === CLAIMABLE_STATUS;
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
