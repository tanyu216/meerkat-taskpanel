/**
 * The activity vocabulary has one writer contract (`activity-events.test.mjs`)
 * and several *readers*. This is the other half: every declared event must be
 * an explicit decision at each consumer, not something that silently falls
 * through a default.
 *
 * The three consumers are independent on purpose — the board is a Vue package,
 * the loop is a separate supervisor process, and the wire filter is the
 * server's. They cannot share a module, so the contract lives here: a new event
 * cannot be added to `ACTIVITY_EVENTS` without every consumer naming it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { ACTIVITY_EVENTS, HISTORICAL_ACTIVITY_EVENTS } from "../../src/core/domain/enums.mjs";
import { SSE_NOISE_EVENTS } from "../../src/foundation/constants.mjs";
import { classify, DISPATCH_EVENTS, IGNORED_EVENTS } from "../../src/orchestrator/subscribe.mjs";
import { ADMITTED_EVENTS, FEED_EXCLUDED_EVENTS } from "../../web/src/lib/activity-feed.js";
import { isKnownEvent } from "../../web/src/lib/events.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HISTORICAL = new Set(HISTORICAL_ACTIVITY_EVENTS);
const CURRENT = ACTIVITY_EVENTS.filter((event) => !HISTORICAL.has(event));

/** Event names the catalogue table in `docs/events.md` names, in order. */
function documentedEvents() {
  const text = readFileSync(join(ROOT, "docs/events.md"), "utf8");
  return [...text.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map((match) => match[1]);
}

describe("contract/activity-consumers — every reader names every event", () => {
  it("declares each event once", () => {
    assert.equal(new Set(ACTIVITY_EVENTS).size, ACTIVITY_EVENTS.length);
    for (const event of HISTORICAL_ACTIVITY_EVENTS) {
      assert.ok(ACTIVITY_EVENTS.includes(event), `${event} is historical but not declared`);
    }
  });

  it("the board knows every event it can receive", () => {
    const unknown = CURRENT.filter((event) => !isKnownEvent(event));
    assert.deepEqual(unknown, [], `the board treats these as unknown: ${unknown.join(", ")}`);
  });

  it("the human feed admits or explicitly excludes every event", () => {
    // `task_updated` is admitted conditionally by `TASK_UPDATED_KINDS`.
    const unclassified = ACTIVITY_EVENTS.filter(
      (event) =>
        event !== "task_updated" &&
        Boolean(ADMITTED_EVENTS[event]) === FEED_EXCLUDED_EVENTS.includes(event),
    );
    assert.deepEqual(unclassified, [], `neither admitted nor excluded: ${unclassified.join(", ")}`);
    const admittedAndExcluded = ACTIVITY_EVENTS.filter(
      (event) => Boolean(ADMITTED_EVENTS[event]) && FEED_EXCLUDED_EVENTS.includes(event),
    );
    assert.deepEqual(admittedAndExcluded, [], "an event cannot be both admitted and excluded");
  });

  it("the loop dispatches or explicitly ignores every event", () => {
    const classification = new Map();
    for (const event of DISPATCH_EVENTS) classification.set(event, "dispatch");
    for (const event of IGNORED_EVENTS) {
      assert.equal(classification.has(event), false, `${event} is in both loop lists`);
      classification.set(event, "ignore");
    }
    const unclassified = CURRENT.filter(
      (event) => event !== "task_updated" && !classification.has(event),
    );
    assert.deepEqual(unclassified, [], `the loop never decided about: ${unclassified.join(", ")}`);
    for (const [event, decision] of classification) {
      assert.ok(ACTIVITY_EVENTS.includes(event), `${event} is classified but not declared`);
      const expected = decision === "dispatch" ? "dispatch" : "ignore";
      assert.equal(
        classify({ event, actor_kind: "human", actor_id: "terry", changes: {} }, { agents: [] }),
        expected,
        event,
      );
    }
  });

  it("an unknown event never wakes the loop", () => {
    assert.equal(
      classify({ event: "from_a_newer_board", actor_kind: "human", actor_id: "terry", changes: {} }, { agents: [] }),
      "ignore",
    );
  });

  it("the wire filter only names declared events", () => {
    for (const event of SSE_NOISE_EVENTS) {
      assert.ok(ACTIVITY_EVENTS.includes(event), `${event} is filtered but not declared`);
    }
  });

  it("the catalogue documents every current event, and invents none", () => {
    const documented = documentedEvents();
    const missing = CURRENT.filter((event) => !documented.includes(event));
    assert.deepEqual(missing, [], `docs/events.md never names: ${missing.join(", ")}`);
    const undeclared = documented.filter((event) => !ACTIVITY_EVENTS.includes(event));
    assert.deepEqual(undeclared, [], `docs/events.md invents: ${undeclared.join(", ")}`);
  });
});
