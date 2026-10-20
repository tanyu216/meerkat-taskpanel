/**
 * Step 2: the state machine, exhaustively.
 *
 * The expected whitelist below is written out independently of
 * `domain/status.mjs` (literal pairs, not a re-export) so a typo in the module
 * is a red test rather than a self-fulfilling assertion. Every ordered pair is
 * walked — `statuses²`, derived, so a future status cannot sneak in without
 * extending the table *and* cannot be added by editing a hard-coded count.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { STATUS, STATUSES, TASK_KIND } from "../../../src/core/domain/enums.mjs";
import {
  ALLOWED_TRANSITIONS,
  CLAIMABLE_STATUS,
  EPIC_ONLY_TRANSITIONS,
  ROUND_BUMPING_EXITS,
  TERMINAL_STATUSES,
  allowedTargets,
  assertTransition,
  bumpsDeliveryRound,
  canTransition,
  isClaimable,
  isKnownStatus,
  isTerminalStatus,
  requiresReport,
  transitionReasonCode,
} from "../../../src/core/domain/status.mjs";
import { DomainError } from "../../../src/foundation/errors.mjs";

/** F1 ruling, option A — transcribed from the card, not from the module. */
const EXPECTED_ALLOWED = {
  backlog: ["todo", "canceled"],
  todo: ["backlog", "in_progress", "blocked", "canceled"],
  // M1 — `awaiting` joins as the fifth exit from `in_progress`, and is its own
  // row below. The card's conversion rules: entry only from `in_progress`;
  // `→ canceled` allowed; `→ blocked` / `→ in_review` / `→ done` forbidden.
  in_progress: ["in_review", "blocked", "todo", "canceled", "awaiting"],
  awaiting: ["in_progress", "canceled"],
  in_review: ["done", "in_progress", "blocked"],
  blocked: ["todo", "in_progress", "in_review", "canceled"],
  done: [],
  canceled: [],
};

/** Every ordered pair, derived: `statuses²`. */
const ALL_PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to]));
/** The whitelisted pairs, counted from the independent table above. */
const WHITELISTED = Object.values(EXPECTED_ALLOWED).reduce((sum, list) => sum + list.length, 0);

describe("domain/status — the whitelist table", () => {
  it("covers every status exactly once, and walks every ordered pair", () => {
    assert.deepEqual(
      [...STATUSES].sort(),
      Object.keys(EXPECTED_ALLOWED).sort(),
      "the table below must name every status — no more, no fewer",
    );
    assert.equal(ALL_PAIRS.length, STATUSES.length ** 2);
  });

  it("walks every pair against the F1 ruling", () => {
    for (const [from, to] of ALL_PAIRS) {
      const expected = EXPECTED_ALLOWED[from].includes(to);
      assert.equal(
        canTransition(from, to),
        expected,
        `${from} → ${to} should be ${expected ? "allowed" : "rejected"}`,
      );
    }
  });

  it("never allows a self-transition and never allows a no-op out of a status", () => {
    for (const status of STATUSES) {
      assert.equal(canTransition(status, status), false, `${status} → ${status}`);
    }
  });

  it("makes done reachable ONLY from in_review", () => {
    const into = STATUSES.filter((from) => canTransition(from, STATUS.DONE));
    assert.deepEqual(into, [STATUS.IN_REVIEW]);
  });

  it("keeps both in_review exits that start a new delivery round (F3)", () => {
    assert.deepEqual([...ROUND_BUMPING_EXITS].sort(), ["blocked", "in_progress"]);
    assert.deepEqual(allowedTargets(STATUS.IN_REVIEW), ["done", "in_progress", "blocked"]);
    for (const [from, to] of ALL_PAIRS) {
      const expected = from === STATUS.IN_REVIEW && ROUND_BUMPING_EXITS.includes(to);
      assert.equal(bumpsDeliveryRound(from, to), expected, `bump ${from} → ${to}`);
    }
  });

  it("exposes the same table through ALLOWED_TRANSITIONS", () => {
    for (const status of STATUSES) {
      assert.deepEqual([...ALLOWED_TRANSITIONS[status]], EXPECTED_ALLOWED[status]);
      assert.deepEqual([...allowedTargets(status)], EXPECTED_ALLOWED[status]);
    }
    assert.deepEqual([...allowedTargets("nonsense")], []);
  });
});

describe("domain/status — terminals, claimability, gate", () => {
  it("marks done/canceled terminal and nothing else", () => {
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ["canceled", "done"]);
    for (const status of STATUSES) {
      assert.equal(isTerminalStatus(status), TERMINAL_STATUSES.includes(status), status);
    }
    assert.deepEqual(STATUSES.filter((s) => allowedTargets(s).length === 0), ["done", "canceled"]);
  });

  it("only todo is claimable, and only in_review demands a report", () => {
    assert.equal(CLAIMABLE_STATUS, "todo");
    assert.deepEqual(STATUSES.filter(isClaimable), ["todo"]);
    assert.deepEqual(STATUSES.filter(requiresReport), ["in_review"]);
  });

  it("recognises known statuses case-sensitively", () => {
    for (const status of STATUSES) assert.equal(isKnownStatus(status), true, status);
    for (const bad of ["", "READY", "Todo", "ready", "failed", null, 42]) {
      assert.equal(isKnownStatus(bad), false, String(bad));
    }
  });
});

describe("domain/status — rejection codes", () => {
  it("maps every rejected pair to the trigger's reason code", () => {
    let rejected = 0;
    for (const [from, to] of ALL_PAIRS) {
      const reason = transitionReasonCode(from, to);
      if (canTransition(from, to)) {
        assert.equal(reason, null, `${from} → ${to}`);
        continue;
      }
      rejected += 1;
      assert.equal(reason, isTerminalStatus(from) ? "TERMINAL_STATE" : "INVALID_TRANSITION");
    }
    assert.equal(rejected, STATUSES.length ** 2 - WHITELISTED, "every pair minus the whitelisted ones");
  });

  it("keeps `awaiting` a real exit with exactly two doors, and no gate bypass (M1)", () => {
    // The card's three conversion rules, asserted against the independent table
    // rather than against the module's own answer.
    assert.deepEqual(allowedTargets("awaiting"), ["in_progress", "canceled"]);
    assert.deepEqual(
      STATUSES.filter((from) => canTransition(from, "awaiting")),
      ["in_progress"],
      "in_progress → awaiting is the only entry",
    );
    for (const forbidden of ["blocked", "in_review", "done"]) {
      assert.equal(canTransition("awaiting", forbidden), false, `awaiting → ${forbidden} must stay forbidden`);
    }
    assert.equal(isTerminalStatus("awaiting"), false);
    assert.equal(allowedTargets("awaiting").length > 0, true, "a non-terminal status must have an exit");
    assert.deepEqual(TERMINAL_STATUSES.slice().sort(), ["canceled", "done"]);
  });

  it("does not start a delivery round on awaiting → in_progress (M1)", () => {
    // The round is a property of *leaving `in_review`* (F3). `awaiting` is
    // entered from `in_progress` and resumed back into it, so the card never
    // left; the same round's report must therefore still count.
    assert.equal(bumpsDeliveryRound("awaiting", "in_progress"), false);
    assert.equal(ROUND_BUMPING_EXITS.includes("awaiting"), false);
    assert.equal(ROUND_BUMPING_EXITS.includes("in_progress"), true, "only as an exit *from in_review*");
    assert.equal(bumpsDeliveryRound("in_review", "in_progress"), true);
    // and it is never an entry into the delivery-gated status either
    assert.equal(requiresReport("awaiting"), false);
  });

  it("assertTransition returns the target or throws a DomainError with that code", () => {
    assert.equal(assertTransition("todo", "in_progress"), "in_progress");

    assert.throws(
      () => assertTransition("done", "todo"),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "TERMINAL_STATE");
        assert.equal(err.http, 409);
        assert.deepEqual(err.details.allowed, []);
        return true;
      },
    );

    assert.throws(
      () => assertTransition("backlog", "done"),
      (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.deepEqual(err.details.allowed, ["todo", "canceled"]);
        return true;
      },
    );

    assert.throws(
      () => assertTransition("nope", "todo"),
      (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.http, 400);
        return true;
      },
    );
  });
});

/**
 * The epic overlay (0024).
 *
 * An `epic` is the one kind that can never be `in_progress` — it is a container,
 * never claimed — so the whitelist has exactly one gap for it: the route from
 * `todo` (the status `issue create --kind epic` births in) into `in_review`. The
 * expected overlay below is written out literally, independently of the module,
 * the same way `EXPECTED_ALLOWED` is.
 */
describe("domain/status — the epic overlay (0024)", () => {
  /** The only pair an epic may take that a `task` may not. */
  const EPIC_EXTRA = [["todo", "in_review"]];

  const isExtra = (from, to) => EPIC_EXTRA.some(([f, t]) => f === from && t === to);

  it("adds exactly that one pair, and adds it for no other kind", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const base = EXPECTED_ALLOWED[from].includes(to);
        assert.equal(canTransition(from, to, TASK_KIND.EPIC), base || isExtra(from, to), `epic ${from} → ${to}`);
        for (const kind of [undefined, TASK_KIND.TASK, TASK_KIND.DEPLOY, null]) {
          assert.equal(canTransition(from, to, kind), base, `${kind ?? "unstated"} ${from} → ${to}`);
        }
      }
    }
    assert.deepEqual([...EPIC_ONLY_TRANSITIONS[STATUS.TODO]], ["in_review"]);
    assert.deepEqual(Object.keys(EPIC_ONLY_TRANSITIONS), [STATUS.TODO], "one row, not a table");
  });

  it("overlays the row instead of rewriting it", () => {
    assert.deepEqual(
      [...allowedTargets(STATUS.TODO, TASK_KIND.EPIC)],
      [...EXPECTED_ALLOWED.todo, "in_review"],
      "the epic row is the task row plus the one pair",
    );
    assert.deepEqual([...allowedTargets(STATUS.TODO)], EXPECTED_ALLOWED.todo);
    for (const status of STATUSES) {
      assert.deepEqual([...ALLOWED_TRANSITIONS[status]], EXPECTED_ALLOWED[status], "the base table never moves");
      if (status !== STATUS.TODO) {
        assert.deepEqual([...allowedTargets(status, TASK_KIND.EPIC)], EXPECTED_ALLOWED[status], status);
      }
    }
  });

  it("is about *delivery*, never about *claiming*", () => {
    // `todo → in_progress` stays on the epic's row — the table has no opinion on
    // who may claim; it is `decideClaim` that refuses an epic. Widening this
    // would be the one thing the card forbids, so it is asserted, not assumed.
    assert.equal(canTransition(STATUS.TODO, STATUS.IN_PROGRESS, TASK_KIND.EPIC), true);
    assert.equal(isClaimable(STATUS.TODO), true);
  });

  it("refuses with the epic's own allowed set in the details", () => {
    assert.equal(assertTransition(STATUS.TODO, STATUS.IN_REVIEW, TASK_KIND.EPIC), "in_review");
    assert.throws(
      () => assertTransition(STATUS.TODO, STATUS.IN_REVIEW),
      (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.deepEqual(err.details.allowed, EXPECTED_ALLOWED.todo);
        return true;
      },
    );
    assert.throws(
      () => assertTransition(STATUS.TODO, STATUS.DONE, TASK_KIND.EPIC),
      (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.deepEqual(err.details.allowed, [...EXPECTED_ALLOWED.todo, "in_review"]);
        return true;
      },
    );
  });

  it("moves the reason code, and nothing else, with the pair", () => {
    assert.equal(transitionReasonCode(STATUS.TODO, STATUS.IN_REVIEW, TASK_KIND.EPIC), null);
    assert.equal(transitionReasonCode(STATUS.TODO, STATUS.IN_REVIEW), "INVALID_TRANSITION");
    assert.equal(transitionReasonCode(STATUS.BACKLOG, STATUS.IN_REVIEW, TASK_KIND.EPIC), "INVALID_TRANSITION");
    for (const terminal of TERMINAL_STATUSES) {
      assert.equal(canTransition(terminal, STATUS.IN_REVIEW, TASK_KIND.EPIC), false);
      assert.equal(transitionReasonCode(terminal, STATUS.IN_REVIEW, TASK_KIND.EPIC), "TERMINAL_STATE");
    }
    assert.equal(canTransition("nonsense", STATUS.IN_REVIEW, TASK_KIND.EPIC), false);
  });

  it("still reaches done only through in_review — for an epic too", () => {
    assert.deepEqual(STATUSES.filter((from) => canTransition(from, STATUS.DONE, TASK_KIND.EPIC)), [STATUS.IN_REVIEW]);
    for (const start of STATUSES) {
      if (start === STATUS.IN_REVIEW) continue;
      const seen = new Set();
      const queue = [...allowedTargets(start, TASK_KIND.EPIC)];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === STATUS.IN_REVIEW || seen.has(next)) continue;
        seen.add(next);
        queue.push(...allowedTargets(next, TASK_KIND.EPIC));
      }
      assert.equal(seen.has(STATUS.DONE), false, `epic ${start} reaches done without passing in_review`);
    }
  });

  it("does not move the round or the gate with the pair", () => {
    assert.equal(bumpsDeliveryRound(STATUS.TODO, STATUS.IN_REVIEW), false, "todo is not a round-bumping source");
    assert.equal(requiresReport(STATUS.IN_REVIEW), true, "and the gate still asks for a report");
  });
});
