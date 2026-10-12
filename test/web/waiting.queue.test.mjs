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
    assert.deepEqual([...WAITING_REASON_KINDS], ["question", "blocked"]);
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

  it("projects the six fields a row owes, with the identifier capped at eight characters", () => {
    const [row] = waitingRows([card("1", "PROJ-0007", { title: "Long id" })], {}, NOW);
    assert.equal(row.identifier, "PROJ-0007", "the row keeps the whole value for its `title`");
    assert.equal(row.display, "PROJ-000…", "the cell is the capped value");
    assert.equal(row.title, "Long id");
    assert.equal(row.actor, "linus");
    assert.equal(row.actorKind, "agent");
    assert.equal(row.reasonKind, "question");
    assert.equal(row.reasonKey, "waiting.reason.question");
  });

  it("keeps a short identifier verbatim and survives an empty queue", () => {
    const [row] = waitingRows([card("1", "TD-1")], {}, NOW);
    assert.equal(row.display, "TD-1");
    assert.deepEqual(waitingRows([], {}, NOW), []);
    assert.deepEqual(waitingRows(undefined, {}, NOW), []);
  });

  it("states the actor as the agent the card is parked on", () => {
    const [row] = waitingRows([card("1", "TD-1", { assignee: { display_name: "jobs", kind: "agent" } })], {}, NOW);
    assert.equal(row.actor, "jobs");
    assert.equal(waitingRow(card("2", "TD-2", { assignee: null })).actor, "");
  });
});
