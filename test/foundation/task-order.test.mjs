/**
 * C-WEIGHT-1 — the assignee task weight order, as pure arithmetic.
 *
 * `design/contracts/assignee-weight-order.md` §10.2 lists ten machine-checkable
 * assertions for the implementation. Six of them are questions about a pure
 * function and live here (1 determinism, 2 tier-over-score, 3 the
 * anti-starvation break-even, 4 no `NaN` from a missing field, 5 monotonicity,
 * 6 the total order); the four that need a board — the unchanged default order,
 * the untouched export, the `blocked_at` gate and scope-before-sort — live in
 * `test/server/task-order.test.mjs`.
 *
 * Every number in the §9 cases below is from the contract's own worked example,
 * reproduced to six decimals rather than paraphrased.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { STATUSES } from "../../src/core/domain/enums.mjs";
import { TASK_ORDER_SEVERITY_ENABLED, TASK_ORDER_WEIGHTS } from "../../src/foundation/constants.mjs";
import {
  FACTOR_IDS,
  TASK_ORDER_STATUS_RANK,
  TIER,
  factorsOf,
  orderTasks,
  priorityRankOf,
  round3,
  taskOrderDebugEntry,
  tierOf,
} from "../../src/foundation/task-order.mjs";

const NOW = "2026-10-14T12:00:00.000Z";

/** An ISO stamp `hours` before `NOW` (negative = in the future). */
const ago = (hours) => new Date(new Date(NOW).getTime() - hours * 3_600_000).toISOString();

/** A card in the shape the order reads: a task's fields plus the two edge counts. */
function card(id, options = {}) {
  return {
    id,
    identifier: options.identifier ?? id,
    projectId: options.projectId ?? "proj",
    status: options.status ?? "in_progress",
    priority: options.priority ?? "medium",
    kind: options.kind ?? "task",
    labels: options.labels ?? [],
    createdAt: options.createdAt ?? ago(options.age ?? 1),
    statusChangedAt: options.statusChangedAt ?? ago(options.dwell ?? 1),
    blockedAt: options.blockedAt ?? null,
    blockersOpen: options.blockersOpen ?? 0,
    unblocksOpen: options.unblocksOpen ?? 0,
  };
}

const idsOf = (ranked) => ranked.map((item) => item.card.id);

/**
 * The contract's §9.1 sample: six cards covering all three tiers and every
 * factor. A6 (`awaiting`) is the one cell the contract scores inconsistently —
 * §5.2 gives `awaiting` a 24h threshold, §9.1 writes "无（记 0）". See
 * `src/foundation/task-order.mjs#slaOf` for why §5.2 wins; the tier and ordering
 * behaviour is identical either way.
 */
const SAMPLE = [
  card("A1", { priority: "urgent", status: "in_progress", dwell: 2, age: 3 }),
  card("A2", { priority: "medium", status: "todo", dwell: 30, age: 30, unblocksOpen: 1 }),
  card("A3", { priority: "low", status: "todo", dwell: 96, age: 400 }),
  card("A4", { priority: "high", status: "blocked", dwell: 3, age: 50, blockedAt: ago(3) }),
  card("A5", { priority: "medium", status: "in_review", dwell: 30, age: 200 }),
  card("A6", { priority: "urgent", status: "awaiting", dwell: 8, age: 96 }),
];

/**
 * §9.4's sensitivity sweep: `wP` is set and the other five are renormalised so
 * the vector still sums to 1.00. The five non-`P` weights total 0.70, which is
 * the divisor — `(=1 − wP) / 0.70`, the `k` column §9.4 prints.
 */
const scaled = (p) => {
  const k = (1 - p) / 0.7;
  return { P: p, W: 0.25 * k, S: 0.2 * k, A: 0.1 * k, B: 0.1 * k, L: 0.05 * k };
};

describe("task-order — the vocabulary it derives from", () => {
  it("keeps the board order in step with the core status list", () => {
    // The rank table is restated here (foundation imports nothing from src), so this
    // is the assertion that turns a status added to the enum into a red test
    // instead of a silently mis-tiered column.
    const boardOrder = STATUSES.filter((status) => status !== "awaiting");
    assert.deepEqual([...boardOrder], Object.keys(TASK_ORDER_STATUS_RANK).filter((s) => s !== "awaiting"));
    // `awaiting` is the M1 overlay, not an eighth column: it sorts on its stage.
    assert.equal(TASK_ORDER_STATUS_RANK.awaiting, TASK_ORDER_STATUS_RANK.in_progress);
  });

  it("ranks `none` below `low` rather than reusing priorityRank's `?? medium`", () => {
    // §8 R2: `core/domain/priority.mjs#priorityRank` falls back to `medium` for
    // anything unknown, which would put "nobody set a priority" above "explicitly
    // the lowest one". The five-value table exists to stop exactly that.
    assert.equal(priorityRankOf("none"), 0);
    assert.equal(priorityRankOf("low"), 0);
    assert.ok(priorityRankOf("none") < priorityRankOf("medium"));
    assert.equal(factorsOf(card("x", { priority: "none" }), { now: NOW }).normalised.P, 0);
    assert.equal(factorsOf(card("x", { priority: "low" }), { now: NOW }).normalised.P, 0);
  });

  it("ships the signed vector, with the optional severity factor off", () => {
    assert.deepEqual({ ...TASK_ORDER_WEIGHTS }, { P: 0.3, W: 0.25, S: 0.2, A: 0.1, B: 0.1, L: 0.05 });
    assert.equal(TASK_ORDER_SEVERITY_ENABLED, false);
    const sev = card("s", { labels: ["sev:blocker"] });
    assert.equal(factorsOf(sev, { now: NOW }).weighted.L, 0, "L contributes nothing while it is off");
    // …and the factor is inert, not merely discounted: it cannot reorder anything.
    const without = card("s", { labels: [] });
    assert.equal(factorsOf(sev, { now: NOW }).score, factorsOf(without, { now: NOW }).score);
  });

  it("honours the severity factor when a caller turns it on", () => {
    // §5.4 question 3 is Terry's: the switch exists so the answer is a one-line
    // change rather than a rewrite. This is the proof that the line works.
    const unit = (labels) => factorsOf(card("s", { labels }), { now: NOW, severityEnabled: true }).normalised.L;
    assert.equal(unit(["sev:blocker"]), 1);
    assert.equal(unit(["sev:critical"]), 2 / 3);
    assert.equal(unit(["sev:minor"]), 0);
    assert.equal(unit([]), 0);
    assert.equal(unit(undefined), 0, "a card with no labels at all");
    assert.equal(unit(["sev:nonsense"]), 0, "an unknown `sev:` word is not a severity");

    // The heaviest of several severity labels wins, whatever the array order.
    assert.equal(unit(["sev:minor", "sev:blocker", "ui"]), 1);

    // Switching it on changes the order — and spends exactly the signed weight.
    const plain = card("plain", { priority: "urgent" });
    const severe = card("severe", { priority: "urgent", labels: ["sev:critical"] });
    const ranked = orderTasks([plain, severe], { now: NOW, severityEnabled: true });
    assert.deepEqual(idsOf(ranked), ["severe", "plain"]);
    assert.ok(Math.abs(ranked[0].factors.weighted.L - 0.05 * (2 / 3)) < 1e-12);
    assert.equal(ranked[0].factors.weights.L, 0.05);
  });
});

describe("task-order — the contract's §9 worked example", () => {
  it("reproduces §9.2's factor values and §9.3's order", () => {
    const ranked = orderTasks(SAMPLE, { now: NOW });
    assert.deepEqual(idsOf(ranked), ["A1", "A3", "A2", "A4", "A5", "A6"]);
    assert.deepEqual(ranked.map((item) => item.tier), [0, 0, 0, 1, 2, 2]);

    const byId = new Map(ranked.map((item) => [item.card.id, item]));
    // §9.4's raw-output block, to six decimals.
    assert.equal(byId.get("A1").score.toFixed(6), "0.307361");
    assert.equal(byId.get("A3").score.toFixed(6), "0.305556");
    assert.equal(byId.get("A2").score.toFixed(6), "0.241667");
    assert.equal(byId.get("A4").score.toFixed(6), "0.417361");
    assert.equal(byId.get("A5").score.toFixed(6), "0.431944");
    // §9.2 prints A6 as 0.341111 because it scores the `awaiting` card's SLA as
    // "无（记 0）", contradicting §5.2's 24h row for `awaiting`. §5.2 is normative
    // (the acceptance criterion cites it), so A6 carries S = 8/24. Both numbers
    // are in the card's Report; the ordering below is unaffected.
    assert.equal(byId.get("A6").score.toFixed(6), "0.407778");
    assert.equal(byId.get("A6").factors.normalised.S.toFixed(3), "0.333");
  });

  it("assertion 1 — the same (cards, now) twice is the same array, byte for byte", () => {
    const first = orderTasks(SAMPLE, { now: NOW });
    const second = orderTasks(SAMPLE, { now: NOW });
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first), "not merely equal — identical bytes");
    // The order is a function of the cards, not of the array they arrived in:
    // the tie-break chain ends on a unique key, so no `Array#sort` stability is
    // being relied on to keep the result reproducible.
    assert.deepEqual(idsOf(orderTasks([...SAMPLE].reverse(), { now: NOW })), idsOf(first));
  });

  it("assertion 2 — a tier beats a score: the best-scoring T2 card still comes last", () => {
    // §9.3's first point, made unmissable: A5 has the highest raw score in the
    // sample (0.431944) and still ranks behind every T0 card, because "already
    // delivered, waiting on a reviewer" is not work its assignee can start.
    const ranked = orderTasks(SAMPLE, { now: NOW });
    const a5 = ranked.find((item) => item.card.id === "A5");
    const t0 = ranked.filter((item) => item.tier === TIER.MOVABLE);
    assert.ok(t0.length === 3);
    for (const item of t0) assert.ok(a5.score > item.score, `${a5.card.id} outscores ${item.card.id}`);
    assert.ok(a5.rank > Math.max(...t0.map((item) => item.rank)));

    // The same claim without the fixture: construct a T2 card and make every T0
    // card score strictly less, then pin the order.
    const lowT0 = card("t0", { priority: "low", dwell: 0, age: 0 });
    const richT2 = card("t2", { priority: "urgent", status: "in_review", dwell: 30, age: 720 });
    const sorted = orderTasks([richT2, lowT0], { now: NOW });
    assert.ok(sorted[1].score > sorted[0].score, "the T2 card really does score higher");
    assert.deepEqual(idsOf(sorted), ["t0", "t2"]);
  });

  it("assertion 3 — the anti-starvation break-even, asserted as product behaviour", () => {
    // §9.4: `wP` is the总闸 on "can a long-waiting card cut the queue". At 0.30 a
    // brand-new urgent card wins by 0.18%; at 0.20 the long-waiting low card
    // takes the lead. The assertion is about the *behaviour*, not the constant.
    const atDefault = orderTasks(SAMPLE, { now: NOW });
    const atLow = orderTasks(SAMPLE, { now: NOW, weights: scaled(0.2) });

    assert.ok(
      atDefault.findIndex((item) => item.card.id === "A1") <
        atDefault.findIndex((item) => item.card.id === "A3"),
      "wP = 0.30: the new urgent card leads",
    );
    assert.ok(
      atLow.findIndex((item) => item.card.id === "A3") <
        atLow.findIndex((item) => item.card.id === "A1"),
      "wP = 0.20: the 96h low card overtakes it",
    );
    // The margin at the signed value is genuinely tiny — 0.0018 — which is the
    // whole reason this is an operator decision rather than a rounding choice.
    const a1 = atDefault.find((item) => item.card.id === "A1");
    const a3 = atDefault.find((item) => item.card.id === "A3");
    assert.ok(Math.abs(a1.score - a3.score - 0.001806) < 1e-6, `${a1.score - a3.score}`);

    // §9.4's third row: at 0.40 the T2 layer itself flips (A6 over A5).
    const atHigh = orderTasks(SAMPLE, { now: NOW, weights: scaled(0.4) });
    assert.deepEqual(idsOf(atHigh), ["A1", "A3", "A2", "A4", "A6", "A5"]);
  });

  it("assertion 4 — a missing field never becomes NaN, and never queues-jumps", () => {
    // §8 R4: `status_changed_at` empty, `blocked_at` null, `labels` empty,
    // `priority` the frontend's fifth value. A NaN here would poison the whole
    // comparator and corrupt the sort silently, so this is asserted, not assumed.
    const degenerate = [
      card("empty-status-at", { statusChangedAt: "", createdAt: "" }),
      card("null-blocked-at", { status: "blocked", blockedAt: null, statusChangedAt: "" }),
      card("no-labels", { labels: [] }),
      card("priority-none", { priority: "none" }),
      card("everything-missing", {
        statusChangedAt: null,
        createdAt: null,
        blockedAt: undefined,
        labels: undefined,
        priority: undefined,
      }),
    ];

    const ranked = orderTasks(degenerate, { now: NOW });
    for (const item of ranked) {
      assert.ok(Number.isFinite(item.score), `${item.card.id} score is ${item.score}`);
      for (const id of FACTOR_IDS) {
        assert.ok(Number.isFinite(item.factors.normalised[id]), `${item.card.id}.${id}`);
        assert.ok(Number.isFinite(item.factors.weighted[id]), `${item.card.id}.${id} weighted`);
      }
    }
    // Reproducible: the same (cards, now) twice is the same array. (Assertion 1.)
    assert.deepEqual(idsOf(orderTasks(degenerate, { now: NOW })), idsOf(ranked));
    assert.deepEqual(orderTasks(degenerate, { now: NOW }), ranked);
  });

  it("assertion 5 — moving the clock forward never lowers a score", () => {
    // §8 R6: every factor is monotone non-decreasing in time, so a card cannot be
    // pushed backwards by its own history — the mathematical premise of
    // anti-starvation. Checked on the whole sample across a fortnight.
    for (const offset of [0, 1, 24, 72, 200, 336]) {
      const later = new Date(new Date(NOW).getTime() + offset * 3_600_000).toISOString();
      const before = new Map(orderTasks(SAMPLE, { now: NOW }).map((i) => [i.card.id, i.score]));
      for (const item of orderTasks(SAMPLE, { now: later })) {
        assert.ok(
          item.score >= before.get(item.card.id) - 1e-12,
          `${item.card.id} dropped after ${offset}h (${before.get(item.card.id)} → ${item.score})`,
        );
      }
    }
    // …and a clock that went backwards is clamped to zero, never negative.
    const skewed = factorsOf(card("future", { createdAt: ago(-50), dwell: -50 }), { now: NOW });
    assert.equal(skewed.normalised.W, 0);
    assert.equal(skewed.normalised.A, 0);
  });

  it("assertion 6 — the seven-key chain is a total order", () => {
    // Two cards that tie at every earlier key must still come out in a fixed
    // order, decided by the next one. Each pair below differs only in the key
    // under test (`score` is equalised by construction: same tier, same factors).
    const equal = { status: "todo", priority: "medium", dwell: 10, age: 10, blockersOpen: 0 };
    const same = (id, over) => card(id, { ...equal, ...over });

    // 3 · priority (the score is rounded to 3dp, so priority decides the tie the
    // contract's "priority → created_at 先后" names).
    assert.deepEqual(idsOf(orderTasks([same("low", { priority: "low" }), same("high", { priority: "high" })], { now: NOW })), [
      "high",
      "low",
    ]);
    // 4 · dwell hours, then 5 · created_at: the longer wait wins, and among cards
    // that have waited exactly as long, the older one does.
    assert.deepEqual(
      idsOf(orderTasks([same("shorter", { dwell: 5 }), same("longer", { dwell: 40 })], { now: NOW })),
      ["longer", "shorter"],
    );
    assert.deepEqual(
      idsOf(
        orderTasks(
          [
            same("newer", { createdAt: ago(20), statusChangedAt: ago(10) }),
            same("older", { createdAt: ago(60), statusChangedAt: ago(10) }),
          ],
          { now: NOW },
        ),
      ),
      ["older", "newer"],
    );
    // 6 · the board's column order, reusing the enum's own sequence. Both cards
    // are in the same tier (a status pair that also differed in tier would be
    // decided one key earlier — which is the point of the tier).
    assert.deepEqual(
      idsOf(orderTasks([same("running", { status: "in_progress" }), same("queued", { status: "todo" })], { now: NOW })),
      ["queued", "running"],
      "`todo` is column 2, `in_progress` is column 3",
    );
    // 7 · project_id, then identifier: the repository's own `ORDER BY` tail, so
    // the weight order and the board order cannot disagree on the final key.
    const keys = [same("b", { projectId: "aaa", identifier: "B" }), same("a", { projectId: "zzz", identifier: "A" })];
    assert.deepEqual(idsOf(orderTasks(keys, { now: NOW })), ["b", "a"]);
    assert.deepEqual(idsOf(orderTasks([...keys].reverse(), { now: NOW })), ["b", "a"], "input order cannot matter");

    // …and within one project the identifier breaks it.
    assert.deepEqual(
      idsOf(
        orderTasks(
          [same("z", { projectId: "p", identifier: "P-0002" }), same("y", { projectId: "p", identifier: "P-0001" })],
          { now: NOW },
        ),
      ),
      ["y", "z"],
    );
  });
});

describe("task-order — the tier function", () => {
  it("separates 'cannot be moved' from 'scores less'", () => {
    assert.equal(tierOf({ status: "in_progress" }), TIER.MOVABLE);
    assert.equal(tierOf({ status: "todo", blockersOpen: 0 }), TIER.MOVABLE);
    assert.equal(tierOf({ status: "todo", blockersOpen: 2 }), TIER.STALLED);
    assert.equal(tierOf({ status: "blocked" }), TIER.STALLED);
    assert.equal(tierOf({ status: "in_review" }), TIER.WITH_OTHERS);
    assert.equal(tierOf({ status: "awaiting" }), TIER.WITH_OTHERS);
    // Not one of the three hard layers: sink it, never let it displace one.
    for (const status of ["backlog", "done", "canceled", "something-else"]) {
      assert.equal(tierOf({ status }), TIER.UNLAYERED, status);
    }
  });

  it("reads both senses of `blocked` (R14), from different fields", () => {
    // `status = blocked` is one sense; "a `todo` card with an open predecessor"
    // is the other, and the second is what `blockersOpen` carries.
    assert.equal(tierOf({ status: "blocked", blockersOpen: 0 }), TIER.STALLED);
    assert.equal(tierOf({ status: "todo", blockersOpen: 1 }), TIER.STALLED);
    assert.equal(tierOf({ status: "todo", blockersOpen: 0 }), TIER.MOVABLE);
  });
});

describe("task-order — the SLA gate (R15) and the threshold table (§5.2)", () => {
  it("does not read `blocked_at` on a card that is not blocked", () => {
    // `moveCas` writes `blocked_at` on entry to `blocked` and never clears it, so
    // a card unblocked months ago still carries the stamp. Without the gate it
    // would read as maximally overdue — silently, with no error anywhere.
    const stalwart = card("stale", {
      status: "in_progress",
      blockedAt: ago(24 * 90),
      statusChangedAt: ago(1),
      createdAt: ago(24 * 90),
    });
    const fresh = card("fresh", { status: "in_progress", blockedAt: ago(24 * 90), statusChangedAt: ago(1) });
    assert.equal(factorsOf(stalwart, { now: NOW }).normalised.S, 0, "in_progress has no SLA threshold at all");
    assert.equal(factorsOf(fresh, { now: NOW }).normalised.S, 0);

    // On a genuinely blocked card the same stamp is the clock, and it caps at 1.
    const blocked = card("blocked", { status: "blocked", blockedAt: ago(3), statusChangedAt: ago(50) });
    assert.equal(factorsOf(blocked, { now: NOW }).normalised.S, 1, "3h against a 2h threshold, capped");
    assert.equal(factorsOf(blocked, { now: NOW }).raw.S, 3, "the raw column keeps the elapsed hours");
  });

  it("applies §5.2's table and scores `S = 0` where there is no threshold", () => {
    const ratio = (options) => factorsOf(card("t", options), { now: NOW }).normalised.S;
    assert.equal(ratio({ status: "blocked", blockedAt: ago(1) }), 0.5, "1h of a 2h threshold");
    assert.equal(ratio({ status: "in_review", statusChangedAt: ago(12) }), 0.5, "12h of a 24h threshold");
    assert.equal(ratio({ status: "awaiting", statusChangedAt: ago(12) }), 0.5, "§5.2 gives `awaiting` 24h");
    assert.equal(ratio({ status: "todo", statusChangedAt: ago(999) }), 0, "no threshold ⇒ 0, not a skip");
    assert.equal(ratio({ status: "in_progress", statusChangedAt: ago(999) }), 0);
    // A missing clock is 0 pressure, never "infinitely overdue".
    assert.equal(ratio({ status: "in_review", statusChangedAt: "", createdAt: "" }), 0);
  });
});

describe("task-order — the order_debug projection", () => {
  it("shows the numbers the comparator actually compared", () => {
    const ranked = orderTasks(SAMPLE, { now: NOW });
    const entry = taskOrderDebugEntry(ranked[0]);
    assert.equal(entry.id, "A1");
    assert.equal(entry.identifier, "A1");
    assert.equal(entry.order, 1);
    assert.equal(entry.tier, TIER.MOVABLE);
    assert.equal(entry.tier_name, "T0");
    assert.equal(entry.score, round3(ranked[0].score), "the displayed score is the ordering key");
    assert.deepEqual(Object.keys(entry.factors).sort(), [...FACTOR_IDS].sort());
    for (const id of FACTOR_IDS) {
      assert.deepEqual(Object.keys(entry.factors[id]).sort(), ["normalised", "raw", "weighted"]);
    }
    assert.equal(entry.factors.P.raw, 3, "A1 is urgent");
    assert.equal(entry.factors.P.normalised, 1);
    assert.equal(entry.factors.P.weighted, 0.3);
  });
});
