/**
 * The **assignee task weight order** (C-WEIGHT-1), as a pure function.
 *
 * `design/contracts/assignee-weight-order.md` is the frozen contract; this file
 * is its single implementation and the only place the ordering is computed.
 * Three layers, each consulted only when the one before it cannot separate two
 * cards:
 *
 *   1. **tier** — `T0 可动 → T1 停滞 → T2 在别人手上`: a *semantic* constraint
 *      ("can this assignee move this card right now?"). It is hard on purpose.
 *      Turning "cannot be moved" into merely "scores less" would let a card
 *      nobody can start float to the top *because it is old enough* — the worst
 *      outcome, since the top of the list is then occupied by dead work.
 *   2. **score** — a linear weighted sum of six factors, each normalised into
 *      `[0,1]` beforehand by `min(value / cap, 1)` (a **ratio cap**). This is a
 *      deliberate break from `shared/project-order.mjs`'s *rank* normalisation:
 *      there, a project's score depends on the other projects in the set. Here
 *      every card's score is a function of that card alone, which is what makes
 *      the order paginable and what keeps "someone added a card yesterday" from
 *      being the explanation for somebody else's rank.
 *   3. **tie-break** — a seven-key chain whose last two keys (`project_id`,
 *      `identifier`) are unique, so the order is a **total** order and does not
 *      depend on `Array#sort` being stable.
 *
 * Pure: no `node:` specifiers, no I/O, **no clock** — the caller passes `now`
 * (the same convention `rankProjects` uses, so the same `(data, now)` always
 * yields the same order and the arithmetic is testable). Every missing field
 * falls back to **zero pressure**, never to a maximum: an absent value must not
 * be able to queue-jump. Nothing here can produce `NaN`, which would poison the
 * whole comparator and corrupt the sort silently.
 */

import {
  TASK_ORDER_CAPS,
  TASK_ORDER_SEVERITY_ENABLED,
  TASK_ORDER_SLA_HOURS,
  TASK_ORDER_WEIGHTS,
} from "./constants.mjs";

/**
 * Board column order — the first seven of `core/domain/enums.mjs#STATUSES`, in
 * the order the board draws them.
 *
 * Restated rather than imported because `shared` imports nothing from `src/`;
 * `test/shared/task-order.test.mjs` asserts the two lists still agree, so a
 * status added to the enum turns into a red test rather than a silent drift.
 *
 * `awaiting` is the M1 **overlay** state, not an eighth column: a waiting card
 * still sits on its stage (`in_progress`), so it sorts as one.
 */
export const TASK_ORDER_STATUS_RANK = Object.freeze({
  backlog: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  blocked: 4,
  done: 5,
  canceled: 6,
  awaiting: 2,
});

/**
 * The **explicit five-value** priority rank (contract §8 R2).
 *
 * `core/domain/priority.mjs#priorityRank` is deliberately **not** reused. Its
 * `?? medium` fallback ranks *any* unknown value as `medium`, and the frontend
 * vocabulary has a fifth value (`none`) that core never produces — so reusing it
 * would rank "nobody set a priority" **above** "explicitly the lowest one". Here
 * `none` and `low` share rank 0, which is also what the contract's factor table
 * (`none=.000 low=.000`) says.
 */
export const TASK_ORDER_PRIORITY_RANK = Object.freeze({
  none: 0,
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
});

/** Unknown priority ⇒ the card's documented default (`medium`), not a rank-0 bump. */
const UNKNOWN_PRIORITY_RANK = TASK_ORDER_PRIORITY_RANK.medium;

/** `sev:` label ranks (contract §4.2 `L`). Absent label ⇒ 0. Whole factor off by default. */
const TASK_ORDER_SEVERITY_RANK = Object.freeze({
  "sev:minor": 0,
  "sev:major": 1,
  "sev:critical": 2,
  "sev:blocker": 3,
});

/**
 * The hard layers (contract §4.1), plus the closure they need.
 *
 * `T0`/`T1`/`T2` are the contract's three layers. `UNLAYERED` is **not** a
 * fourth layer in the contract — it is what a total function must do with a card
 * that belongs to none of them (`backlog`, `done`, `canceled`, an unknown
 * status): sink it below every layered card, so it can never displace one. The
 * weight order is never asked for terminal cards (§3 constraint 2, and the
 * default scope already filters them), but a comparator that had no answer for
 * them would be partial, and a partial comparator is how sorts go wrong.
 */
export const TIER = Object.freeze({
  MOVABLE: 0,
  STALLED: 1,
  WITH_OTHERS: 2,
  UNLAYERED: 3,
});

/** Human-readable tier names for the `order_debug` projection. */
export const TIER_NAMES = Object.freeze(["T0", "T1", "T2", "T3"]);

/** The six factors, in the order the contract's formula writes them. */
export const FACTOR_IDS = Object.freeze(["P", "W", "S", "A", "B", "L"]);

/**
 * `min(value / cap, 1)` — the contract's ratio clamp (§6.2).
 *
 * A non-finite or non-positive input is `0`, never `NaN`: "we cannot tell how
 * long this has been waiting" is not evidence of pressure.
 */
function ratio(value, cap) {
  if (!Number.isFinite(value) || !Number.isFinite(cap) || cap <= 0 || value <= 0) return 0;
  return Math.min(value / cap, 1);
}

/**
 * Whole hours between two ISO-8601 UTC stamps, clamped at 0 (contract R8).
 *
 * A missing, unparseable, or *future* stamp yields `0`: clocks get corrected and
 * timestamps get backdated, and a negative elapsed time must not become a
 * negative score.
 */
function hoursBetween(from, to) {
  if (typeof from !== "string" || from === "") return 0;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const hours = (end - start) / 3_600_000;
  return hours > 0 ? hours : 0;
}

/** @param {unknown} value */
export function priorityRankOf(value) {
  if (typeof value !== "string") return UNKNOWN_PRIORITY_RANK;
  const rank = TASK_ORDER_PRIORITY_RANK[value.trim().toLowerCase()];
  return rank === undefined ? UNKNOWN_PRIORITY_RANK : rank;
}

/** @param {unknown} labels */
function severityUnit(labels) {
  if (!Array.isArray(labels)) return 0;
  let best = 0;
  for (const label of labels) {
    const rank = TASK_ORDER_SEVERITY_RANK[String(label).trim().toLowerCase()];
    if (rank !== undefined && rank > best) best = rank;
  }
  return best / 3;
}

/** Board order position, or the end of the board for a status the board has no column for. */
function statusRankOf(status) {
  const rank = TASK_ORDER_STATUS_RANK[status];
  return rank === undefined ? Object.keys(TASK_ORDER_STATUS_RANK).length : rank;
}

/**
 * Which hard layer a card is in (contract §4.1).
 *
 * The two `todo` cases are why this reads relations rather than only the status
 * column: a `todo` card whose `blocks` predecessors are all `done` is work the
 * assignee can start *now* (T0), while a `todo` card still waiting on an open
 * predecessor is stalled (T1) — and the same word `blocked` names both the
 * status and that relation-level situation, which R14 says must not be conflated.
 *
 * @param {object} card a card carrying the task's fields plus `blockersOpen`
 * @returns {number} `TIER.*`
 */
export function tierOf(card) {
  const status = card.status;
  const blockersOpen = Number(card.blockersOpen ?? 0);
  if (status === "in_progress") return TIER.MOVABLE;
  if (status === "todo") return blockersOpen > 0 ? TIER.STALLED : TIER.MOVABLE;
  if (status === "blocked") return TIER.STALLED;
  if (status === "in_review" || status === "awaiting") return TIER.WITH_OTHERS;
  return TIER.UNLAYERED;
}

/**
 * The SLA ratio for a card (contract factor `S`).
 *
 * The clock starts at `blocked_at` **only while the card is `blocked`** (R15):
 * `moveCas` writes that column when a card enters `blocked` and never clears it
 * on the way out, so a card unblocked months ago still carries a stale stamp.
 * Without the gate it would read as permanently, maximally overdue — silently.
 *
 * **One place the frozen contract disagrees with itself, resolved here.** §5.2's
 * threshold table gives `awaiting` a **24h** threshold ("no direct PROTOCOL §⑮
 * row; take the wide reading"), but §9.1/§9.2 score the sample's `awaiting` card
 * (A6) as `S = 0` — "无（记 0）". §5.2 is the normative parameter table and the
 * acceptance criterion points at it ("SLA 阈值口径 = 墙钟 v1 (§5.2/R3)"), so the
 * table wins and `awaiting` is measured against 24h. The consequence is confined
 * to A6's printed score (0.407778 here vs the 0.341111 §9.2 prints): every
 * *ordering* claim in §9 — the T0 chain, and A6 overtaking A5 at `wP = 0.40` —
 * reproduces identically either way, because A6 carries no other `S`-bearing
 * field. Both columns are reported in the card's Report.
 *
 * @param {object} card @param {object} slaHours @param {string} now
 */
function slaOf(card, slaHours, now) {
  const threshold = slaHours?.[card.status];
  if (!Number.isFinite(threshold) || threshold <= 0) return { hours: 0, threshold: null, value: 0 };
  const startedAt = card.status === "blocked" ? card.blockedAt : card.statusChangedAt || card.createdAt;
  const hours = hoursBetween(startedAt, now);
  return { hours, threshold, value: ratio(hours, threshold) };
}

/**
 * Every factor of one card: its raw value, its normalised `[0,1]` value, and its
 * weighted contribution.
 *
 * @param {object} card a task's fields plus `blockersOpen` and `unblocksOpen`
 * @param {{now: string, weights?: object, caps?: object, slaHours?: object, severityEnabled?: boolean}} options
 */
export function factorsOf(card, options) {
  const now = options.now;
  const weights = options.weights ?? TASK_ORDER_WEIGHTS;
  const caps = options.caps ?? TASK_ORDER_CAPS;
  const slaHours = options.slaHours ?? TASK_ORDER_SLA_HOURS;
  const severityEnabled = options.severityEnabled ?? TASK_ORDER_SEVERITY_ENABLED;

  const dwellHours = hoursBetween(card.statusChangedAt || card.createdAt, now);
  const ageHours = hoursBetween(card.createdAt, now);
  const unblocksOpen = Math.max(0, Number(card.unblocksOpen ?? 0) || 0);
  const sla = slaOf(card, slaHours, now);

  // `raw` is the number that came out of the database (a rank, some hours, a
  // count); `normalised` is what the weight multiplies. `S` is the one factor
  // whose raw value is already a ratio — for it the raw column carries the
  // elapsed hours, so a reader can check the division by hand.
  const raw = {
    P: priorityRankOf(card.priority),
    W: dwellHours,
    A: ageHours,
    S: sla.hours,
    B: unblocksOpen,
    L: severityEnabled ? severityUnit(card.labels) : 0,
  };
  const normalised = {
    P: raw.P / 3,
    W: ratio(dwellHours, caps.dwellHours),
    A: ratio(ageHours, caps.ageHours),
    S: sla.value,
    B: ratio(unblocksOpen, caps.unblocks),
    L: raw.L,
  };
  const effective = { ...weights, ...(severityEnabled ? {} : { L: 0 }) };
  const weighted = {};
  let score = 0;
  for (const id of FACTOR_IDS) {
    weighted[id] = effective[id] * normalised[id];
    score += weighted[id];
  }

  return {
    tier: tierOf(card),
    raw,
    normalised,
    weighted,
    weights: effective,
    score,
  };
}

/** String compare that treats a missing value as the empty string. */
function compareStrings(a, b) {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The seven-key tie-break chain (contract §6.3), applied to already-scored entries.
 *
 * Level 2 compares the score **rounded to 3 decimals** — the same convention
 * §20 uses — which makes a tie a real, visible event (`order_debug` shows the
 * same number twice) instead of a floating-point curiosity. Levels 3–7 then
 * decide it without re-deriving anything.
 *
 * @param {object} left @param {object} right entries from `orderTasks`
 */
function compareRanked(left, right) {
  if (left.tier !== right.tier) return left.tier - right.tier;
  if (left.display !== right.display) return right.display - left.display;
  const byPriority = right.priority - left.priority;
  if (byPriority !== 0) return byPriority;
  // Raw hours, not the capped ratio: "who has waited longer" is a finer question
  // than "who has saturated", and past 72h the ratio has stopped answering it.
  const byDwell = right.dwellHours - left.dwellHours;
  if (byDwell !== 0) return byDwell;
  const byCreated = compareStrings(left.card.createdAt, right.card.createdAt);
  if (byCreated !== 0) return byCreated;
  const byStatus = left.statusRank - right.statusRank;
  if (byStatus !== 0) return byStatus;
  const byProject = compareStrings(left.card.projectId, right.card.projectId);
  if (byProject !== 0) return byProject;
  return compareStrings(left.card.identifier, right.card.identifier);
}

/**
 * Order cards by the contract.
 *
 * @param {object[]} cards each a task's fields plus `blockersOpen` / `unblocksOpen`
 * @param {{now: string, weights?: object, caps?: object, slaHours?: object, severityEnabled?: boolean}} options
 * @returns {Array<{card: object, tier: number, priority: number, dwellHours: number, statusRank: number, display: number, score: number, factors: object, rank: number}>}
 *   a new array; `rank` is 1-based and the same `(cards, now)` always yields the
 *   same one
 */
export function orderTasks(cards, options) {
  const ranked = cards.map((card) => {
    const factors = factorsOf(card, options);
    return {
      card,
      tier: factors.tier,
      priority: priorityRankOf(card.priority),
      dwellHours: factors.raw.W,
      statusRank: statusRankOf(card.status),
      display: round3(factors.score),
      score: factors.score,
      factors,
    };
  });
  ranked.sort(compareRanked);
  for (let index = 0; index < ranked.length; index += 1) ranked[index].rank = index + 1;
  return ranked;
}

/**
 * The `order_debug` projection (contract §7.1 / R11): everything needed to
 * reconcile a rank by hand — the tier, each factor's raw value, its normalised
 * value, its weighted contribution, and the final score.
 *
 * The shape follows `/projects?order_debug=1`'s `{raw, …, score}` spirit; the
 * `score` here is the **rounded** value the comparator actually compares, so
 * "these two show the same score" is exactly "the tie-break chain decided this".
 *
 * @param {object} item one entry from `orderTasks`
 */
export function taskOrderDebugEntry(item) {
  const factors = {};
  for (const id of FACTOR_IDS) {
    factors[id] = {
      raw: round5(item.factors.raw[id]),
      normalised: round5(item.factors.normalised[id]),
      weighted: round5(item.factors.weighted[id]),
    };
  }
  return {
    id: item.card.id,
    identifier: item.card.identifier,
    order: item.rank,
    tier: item.tier,
    tier_name: TIER_NAMES[item.tier] ?? null,
    score: item.display,
    factors,
  };
}

/** §6.3's rounding — the value the comparator compares. */
export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** Debug-view precision for the factors (five decimals, like §20's projection). */
function round5(value) {
  return Math.round(value * 100000) / 100000;
}
