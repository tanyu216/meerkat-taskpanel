/**
 * `lib/waiting-queue.js` — B27's projection (R12x).
 *
 * The queue is a derivation like B26's feed, and the whole of it is one pure
 * module, so its three rules can be asserted here without a browser: the order
 * (oldest first), the instant a row carries, and the two-value reason attribute.
 * The render — the six fields, the stamp stated twice, the opener — is measured
 * live in `web/scripts/dom-smoke.mjs`.
 *
 * Authority: `design/BLOCKS.md` B27, `design/DESIGN.md` §30.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AWAITING_CATEGORIES,
  WAITING_REASON_KINDS,
  reasonKeyOf,
  reasonKindOf,
  sinceOf,
  waitingRow,
  waitingRows,
} from "../../web/src/lib/waiting-queue.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fixed "now" so the ladder is asserted, not the clock. */
const NOW = Date.parse("2026-10-13T09:51:00Z");
const at = (minutes) => new Date(NOW - minutes * MINUTE).toISOString();

/** One awaiting card, with the fields the wire carries. */
function card(id, identifier, overrides = {}) {
  return {
    id,
    identifier,
    title: `Task ${identifier}`,
    status: "awaiting",
    awaiting_reason: "E1",
    assignee: { id: "a1", display_name: "linus", kind: "agent" },
    updated_at: at(60),
    ...overrides,
  };
}

describe("B27 · the reason is a two-value attribute", () => {
  it("maps every awaiting category the core writes onto `question`", () => {
    for (const category of AWAITING_CATEGORIES) {
      assert.equal(reasonKindOf(card("1", "TD-1", { awaiting_reason: category })), "question", category);
      assert.equal(reasonKeyOf("question"), "waiting.reason.question");
    }
  });

  it("reads a card that says `blocked` as blocked, and anything else as a question", () => {
    assert.equal(reasonKindOf(card("1", "TD-1", { awaiting_reason: "blocked" })), "blocked");
    assert.equal(reasonKeyOf("blocked"), "waiting.reason.blocked");
    assert.equal(reasonKindOf(card("1", "TD-1", { awaiting_reason: null })), "question");
    assert.equal(reasonKindOf(card("1", "TD-1", { awaiting_reason: "nonsense" })), "question");
    assert.equal(reasonKindOf(undefined), "question");
    assert.equal(reasonKeyOf("nonsense"), "waiting.reason.question");
    // M6 adds `acceptance`: the third thing that can be on a human's side.
    assert.deepEqual([...WAITING_REASON_KINDS], ["question", "blocked", "acceptance"]);
    assert.equal(reasonKeyOf("acceptance"), "waiting.reason.acceptance");
  });
});

describe("B27 · the instant a row carries", () => {
  it("prefers the triggering comment's own stamp and falls back to the card's", () => {
    const task = card("1", "TD-1", { updated_at: at(600) });
    assert.equal(sinceOf(task, { created_at: at(30) }), at(30));
    assert.equal(sinceOf(task, null), at(600));
    assert.equal(sinceOf({}, null), "");
  });

  it("prints that instant on B26's ladder, never reading as zero", () => {
    const rows = waitingRows([card("1", "TD-1")], { 1: { created_at: at(9) } }, NOW);
    assert.equal(rows[0].stamp.key, "time.minutesAgo");
    assert.equal(rows[0].stamp.arg, 9);
    const hourly = waitingRows([card("2", "TD-2")], { 2: { created_at: at(3 * 60) } }, NOW);
    assert.equal(hourly[0].stamp.key, "time.hoursAgo");
    const daily = waitingRows([card("3", "TD-3")], { 3: { created_at: at(72 * 60) } }, NOW);
    assert.equal(daily[0].stamp.key, "time.daysAgo");
    const fresh = waitingRows([card("4", "TD-4")], { 4: { created_at: at(0) } }, NOW);
    assert.equal(fresh[0].stamp.arg, 1, "a just-now stamp is one minute, not zero");
    assert.match(fresh[0].stamp.absolute, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("B27 · the queue", () => {
  it("runs oldest first, so the top row has waited longest", () => {
    const rows = waitingRows(
      [card("a", "TD-1", { updated_at: at(10) }), card("b", "TD-2", { updated_at: at(5 * 24 * 60) }), card("c", "TD-3", { updated_at: at(60 * 24) })],
      {},
      NOW,
    );
    assert.deepEqual(rows.map((row) => row.id), ["b", "c", "a"]);
    assert.deepEqual(
      rows.map((row) => row.since),
      [at(5 * 24 * 60), at(60 * 24), at(10)],
    );
  });

  it("orders by the triggering comment when there is one, not by the card's own change", () => {
    const tasks = [card("a", "TD-1", { updated_at: at(10) }), card("b", "TD-2", { updated_at: at(20) })];
    // TD-1's card changed most recently, but its question was asked longest ago.
    const rows = waitingRows(tasks, { a: { created_at: at(600) }, b: { created_at: at(30) } }, NOW);
    assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  });

  it("projects the six fields a row owes, with the identifier capped at ten characters", () => {
    const [row] = waitingRows([card("1", "INVENTORY-0042", { title: "Long id" })], {}, NOW);
    assert.equal(row.identifier, "INVENTORY-0042", "the row keeps the whole value for its `title`");
    assert.equal(row.display, "INVENTORY-…", "the cell is the capped value");
    assert.equal(row.title, "Long id");
    assert.equal(row.actor, "linus");
    assert.equal(row.actorKind, "agent");
    assert.equal(row.reasonKind, "question");
    assert.equal(row.reasonKey, "waiting.reason.question");
  });

  it("keeps a short identifier verbatim and survives an empty queue", () => {
    const [row] = waitingRows([card("1", "TD-1")], {}, NOW);
    assert.equal(row.display, "TD-1");
    // Nine characters is *inside* the ten-character cap (it was above the old
    // eight): the row shows the id whole, with no ellipsis.
    const [nine] = waitingRows([card("2", "PROJ-0007")], {}, NOW);
    assert.equal(nine.display, "PROJ-0007");
    assert.deepEqual(waitingRows([], {}, NOW), []);
    assert.deepEqual(waitingRows(undefined, {}, NOW), []);
  });

  it("states the actor as the agent the card is parked on", () => {
    const [row] = waitingRows([card("1", "TD-1", { assignee: { display_name: "jobs", kind: "agent" } })], {}, NOW);
    assert.equal(row.actor, "jobs");
    assert.equal(waitingRow(card("2", "TD-2", { assignee: null })).actor, "");
  });
});

describe("M6 · acceptance waiting (who still owes an acceptance)", () => {
  /** A top-level delivered card, with the wire fields the derivation reads. */
  function delivered(id, overrides = {}) {
    return {
      id,
      identifier: `TD-${id}`,
      title: `Delivered ${id}`,
      status: "in_review",
      delivery_round: 1,
      parent_id: null,
      review_of_id: null,
      review_round: null,
      status_changed_at: at(30),
      updated_at: at(30),
      assignee: { id: "a1", display_name: "linus", kind: "agent" },
      ...overrides,
    };
  }

  /** A review card for `original`, on `round`. */
  function review(id, original, status, round = 1) {
    return delivered(id, { review_of_id: original.id, review_round: round, status, identifier: `TD-R${id}` });
  }

  const waitIds = (tasks, policy) => {
    // Imported lazily through the same module the view uses.
    return acceptanceWaitingTasksFor(tasks, policy).map((task) => task.id);
  };

  it("lists a top-level delivered card under human-only and both, never agent-only", () => {
    const tasks = [delivered("1")];
    assert.deepEqual(waitIds(tasks, "human-only"), ["1"]);
    assert.deepEqual(waitIds(tasks, "both"), ["1"]);
    assert.deepEqual(waitIds(tasks, "agent-only"), []);
  });

  it("still queues a no-review card for a human under human-only", () => {
    // 0031: the review decision does not remove the human's acceptance work on
    // a human-only board. A no-review card has no review rows, so the
    // `every` over an empty set releases it to the human.
    assert.deepEqual(waitIds([delivered("1", { review_required: false })], "human-only"), ["1"]);
    assert.deepEqual(waitIds([delivered("1", { review_required: false })], "agent-only"), []);
  });

  it("hides a card whose current-round review is still open, and shows it once resolved", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked", "awaiting"]) {
      const original = delivered("1");
      const tasks = [original, review("2", original, status)];
      assert.deepEqual(waitIds(tasks, "both"), [], `a ${status} review holds it back`);
    }
    for (const status of ["done", "canceled"]) {
      const original = delivered("1");
      const tasks = [original, review("2", original, status)];
      assert.deepEqual(waitIds(tasks, "both"), ["1"], `a ${status} review releases it`);
    }
  });

  it("ignores an old round, and treats a NULL round as covering every round", () => {
    const original = delivered("1");
    assert.deepEqual(waitIds([original, review("2", original, "todo", 2)], "both"), ["1"], "round 2 is history on round 1");
    const unrounded = delivered("2", { review_of_id: original.id, review_round: null, status: "todo", identifier: "TD-2" });
    assert.deepEqual(waitIds([original, unrounded], "both"), [], "a NULL round is conservative");
  });

  it("hides review cards and child cards, and waits for every child", () => {
    const original = delivered("1");
    const child = delivered("2", { parent_id: "1", status: "todo", identifier: "TD-2" });
    assert.deepEqual(waitIds([original, child], "both"), [], "an open child holds the container");
    child.status = "canceled";
    assert.deepEqual(waitIds([original, child], "both"), ["1"], "a canceled child counts as finished");

    // A child (even one in review) is never the human's to accept.
    assert.deepEqual(waitIds([delivered("3", { parent_id: "1" })], "both"), []);
    // A review card is never an acceptance item.
    assert.deepEqual(waitIds([original, review("4", original, "in_review")], "both"), []);
  });

  it("does not list anything that is not in_review", () => {
    for (const status of ["todo", "blocked", "awaiting", "in_progress", "done", "canceled"]) {
      assert.deepEqual(waitIds([delivered("1", { status })], "both"), [], status);
    }
  });

  it("turns an already-narrowed acceptance set into rows without re-deriving it", () => {
    // The view narrows the *result* of `acceptanceWaitingTasks` by assignee.
    // Re-running the predicate on that narrowed list would judge the card
    // against a subset (its child assigned elsewhere would vanish and the
    // parent would be released), so the mapper must take the derived set as-is.
    const derived = acceptanceWaitingTasksFor([delivered("1", { status_changed_at: at(10) })], "both");
    const rows = acceptanceRowsFrom(derived, NOW);
    assert.deepEqual(rows.map((row) => row.identifier), ["TD-1"]);
    assert.equal(rows[0].reasonKind, "acceptance");
    assert.equal(rows[0].stamp.key, "time.minutesAgo");
    assert.deepEqual(acceptanceRowsFrom([], NOW), []);
  });

  it("orders acceptance rows with awaiting rows, oldest first", () => {
    const awaiting = waitingRows(
      [
        {
          id: "a",
          identifier: "TD-A",
          title: "A question",
          status: "awaiting",
          awaiting_reason: "E1",
          assignee: { id: "a1", display_name: "linus", kind: "agent" },
          updated_at: at(120),
        },
      ],
      {},
      NOW,
    );
    const acceptance = acceptanceRows([delivered("1", { status_changed_at: at(10) })], "both", NOW);
    const merged = mergeWaitingRows(awaiting, acceptance);
    assert.deepEqual(merged.map((row) => row.identifier), ["TD-A", "TD-1"]);
    assert.equal(merged[0].kind, "question");
    assert.equal(merged[1].kind, "acceptance");
    assert.equal(merged[1].reasonKind, "acceptance");
    assert.equal(merged[1].stamp.key, "time.minutesAgo");
  });
});

// The import is at the bottom so the file's shape stays "helpers, then rules".
import {
  acceptanceRows,
  acceptanceRowsFrom,
  acceptanceWaitingTasks as acceptanceWaitingTasksFor,
  mergeWaitingRows,
} from "../../web/src/lib/waiting-queue.js";
