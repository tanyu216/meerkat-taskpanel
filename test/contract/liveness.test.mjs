/**
 * Liveness: the new terminality gates can never wedge a card.
 *
 * M6 adds three refusals that did not exist before — the acceptance policy
 * (`ACCEPTANCE_FORBIDDEN`), the children-terminal gate (`CHILDREN_OPEN`) and the
 * review-ready gate (`REVIEW_PENDING`). A refusal is only safe if every state it
 * can leave the card in still has a path to a terminal state; a gate without an
 * exit turns "the board refuses this" into "the board is stuck".
 *
 * The core lemma, asserted here over the **transition table** rather than by
 * example:
 *
 *   > From every non-terminal status there is a path to `canceled`, and
 *   > cancellation is not gated by the acceptance policy.
 *
 * The three gates then each have an escape:
 *
 *   * `REVIEW_PENDING` — the open review card can be canceled (or completed);
 *     `canceled` counts as resolved;
 *   * `CHILDREN_OPEN` — every child can be finished or canceled;
 *   * `ACCEPTANCE_FORBIDDEN` — a refusal about *who*, not about *state*: change
 *     the writer (or the board's policy) and the same transition succeeds.
 *
 * Pure: `domain/status.mjs` only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  allowedTargets,
  isTerminalStatus,
} from "../../src/core/domain/status.mjs";
import { ACCEPTANCE_POLICIES, acceptanceAllows } from "../../src/core/domain/status.mjs";

const NON_TERMINAL = ["backlog", "todo", "in_progress", "in_review", "blocked", "awaiting"];

/** Every status reachable from `start` in at most `max` moves (breadth first). */
function reachable(start, kind, max = 4) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 0; depth < max; depth += 1) {
    const next = [];
    for (const status of frontier) {
      for (const to of allowedTargets(status, kind)) {
        if (!seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

describe("contract/liveness — every non-terminal status can reach canceled", () => {
  for (const kind of [null, "epic"]) {
    for (const status of NON_TERMINAL) {
      it(`${kind ?? "task"}: ${status} → canceled`, () => {
        assert.equal(isTerminalStatus(status), false, "precondition: a non-terminal start");
        assert.ok(
          reachable(status, kind).has("canceled"),
          `${status} must have a path to canceled; without one the M6 gates could wedge it`,
        );
      });
    }
  }

  it("a reopened terminal card can reach canceled again", () => {
    for (const terminal of ["done", "canceled"]) {
      assert.ok(allowedTargets(terminal).includes("todo"), `${terminal} → todo is the reopen edge`);
      assert.ok(reachable(terminal, null).has("canceled"), `${terminal} → todo → canceled`);
    }
  });

  it("in_review reaches canceled in two moves (there is no direct edge)", () => {
    assert.equal(allowedTargets("in_review").includes("canceled"), false, "deliberate: no direct edge");
    for (const via of ["in_progress", "blocked"]) {
      assert.ok(allowedTargets("in_review").includes(via), `in_review → ${via}`);
      assert.ok(allowedTargets(via).includes("canceled"), `${via} → canceled`);
    }
  });

  it("cancellation is reachable from every status a review or a child can sit in", () => {
    // The two gates look at *other* cards. Every status those other cards can
    // hold must be cancelable, or a gate could wait on something that cannot
    // finish.
    for (const status of NON_TERMINAL) {
      assert.ok(reachable(status, null).has("canceled"), `a child in ${status} can be canceled`);
    }
  });

  it("the transition table stays a whitelist: unknown words are unreachable", () => {
    assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS).sort(), [
      "awaiting",
      "backlog",
      "blocked",
      "canceled",
      "done",
      "in_progress",
      "in_review",
      "todo",
    ]);
    for (const status of NON_TERMINAL) {
      for (const to of allowedTargets(status)) {
        assert.notEqual(to, "nonsense");
      }
    }
  });

  it("a review-required card can leave in_review without passing the review gate", () => {
    // 0031's `REVIEW_REQUIRED` gate blocks exactly one edge: `in_review → done`.
    // Reaching `done` needs a current-round review (or a human waiver), but no
    // reviewer being configured must still be recoverable: rework and cancel
    // are the same exits they were before the gate existed.
    const exits = allowedTargets("in_review");
    assert.ok(exits.includes("in_progress"), "rework needs no reviewer");
    assert.ok(exits.includes("blocked"), "a blocker found at review time needs none either");
    assert.ok(reachable("in_review", null).has("canceled"), "cancellation is not gated");
  });

  it("the acceptance policy decides writers, never reachability", () => {
    // The policy changes *who* may take the `done` edge, not whether the state
    // machine has it: `in_review → done` is present under all three policies.
    assert.ok(allowedTargets("in_review").includes("done"));
    for (const policy of ACCEPTANCE_POLICIES) {
      assert.ok(
        ["human", "taskd", "agent"].some((kind) => acceptanceAllows(kind, policy, "top_level")),
        `${policy} has at least one acceptor — a policy no actor satisfies is a guaranteed stall`,
      );
    }
  });
});
