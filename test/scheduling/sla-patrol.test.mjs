/**
 * The SLA patrol — the loop's half of the repository's own SLA contract
 * (`docs/sla.md`), which is the single source of truth for the thresholds,
 * the tier ladder, the working-hours basis and the de-duplication rules.
 *
 * What is asserted here, and why each one is a counter-proof rather than a
 * smoke test:
 *
 *   * the **working-hours basis** — a wait that spans the off-hours window must
 *     not age while the window is closed, and a host in another timezone must
 *     measure the same `T` (the window is a civil window in Asia/Shanghai, not
 *     the observer's local day);
 *   * the **tier ladder** — `warn = L − P`, `overdue = L`, `escalate = F`, with
 *     the `leader_stalled` row exempt from the lead;
 *   * **every row** fires on its own trigger and stays silent without it, so the
 *     expansion is coverage rather than a list of names;
 *   * **notify-only** — `target` is `"leader"` on every alert and no path here
 *     writes a card;
 *   * **zero-cost idle** — a quiet board emits nothing at all;
 *   * **fail-safe** — an unreadable origin alerts instead of going green, and a
 *     dropped candidate is always reported.
 *
 * The decision tests are pure: no clock of its own, no board, no filesystem.
 * The one exception is the contract-document test at the end, which reads
 * `docs/sla.md` so the prose and `SLA_ROWS` cannot drift apart.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BOARD_CARD_ID,
  MECHANISM,
  PEER_LIVENESS_K,
  PEER_PERIOD_MIN,
  SLA_ROWS,
  WORKING_WINDOW,
  addWorkingMinutes,
  alertIdFor,
  blockedReasonOf,
  dedupKeyFor,
  elapsedWorkingMinutes,
  emptySlaLedger,
  findConfirmRequest,
  leaderAttributionWarning,
  looksLikeConfirmRequest,
  partitionSlaAlerts,
  planSlaPatrol,
  pruneSlaLedger,
  recordSlaAlerts,
  slaRowRef,
  stillQualifies,
  tierFor,
  trailReadCandidates,
  warnLeadMinutes,
} from "../../src/foundation/sla-patrol.mjs";
import { runSlaPatrolTick } from "../../scripts/loop/runners.mjs";

/**
 * A fixed clock inside the Asia/Shanghai working window (18:00 local), placed
 * late enough that `ago()` looks back *within* the window for every offset the
 * short-row fixtures use — a lookback that crossed 09:00 local would be
 * measuring off-hours, which is a property under test elsewhere.
 */
const NOW = "2026-10-14T10:00:00.000Z";
/** Minutes before `NOW`, in wall-clock terms — exact while the offset stays inside the window. */
const ago = (minutes) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const PERIOD_SECONDS = 300; // the installed patrol unit's cadence (5 min)

/**
 * A card fixture.
 *
 * `created_at` defaults to `NOW`, so the board always shows a recent leader
 * action and `leader_stalled` (which needs *pending leader work* and a quiet
 * leader) stays out of the way of the row under test — the tests that want it
 * set an old `created_at` on purpose.
 *
 * `heartbeat_at` defaults fresh for the same reason: an `in_progress` card on a
 * real board has one (it was claimed and is being worked), and the heartbeat row
 * now emits a tuple of its own, so a fixture without one would be a card that is
 * running and not running at the same time. The heartbeat tests set it (or its
 * absence) on purpose.
 *
 * The `reporter` actor defaults to what the board records for a plain local
 * writer — which is what `actorFromRequest` answers for a `curl` or a `taskctl`
 * run with no agent identity. It matters because leader attribution is an
 * **author** test (§6.3-D): a card the leader created is a leader event, and the
 * creator IS the reporter (0019), so a fixture that omitted it would model a
 * board where nobody ever dispatches anything.
 */
function card(fields) {
  return {
    identifier: "T-1",
    status: "in_progress",
    created_at: NOW,
    status_changed_at: NOW,
    heartbeat_at: NOW,
    reporter: { id: "local", display_name: "local", kind: "human" },
    ...fields,
  };
}

function plan(cards, { trails = {}, now = NOW, periodSeconds = PERIOD_SECONDS, ...rest } = {}) {
  return planSlaPatrol({ cards, trails, now, periodSeconds, mechanismHost: "claude/linus", ...rest });
}

const rowsOf = (result) => result.alerts.map((alert) => alert.sla_row).sort();

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

describe("elapsedWorkingMinutes (the measurement basis, §6.4)", () => {
  it("counts wall-clock minutes inside the window", () => {
    // 12:00 → 13:00 Shanghai is entirely inside 09:00–23:00.
    assert.equal(elapsedWorkingMinutes("2026-10-14T04:00:00.000Z", "2026-10-14T05:00:00.000Z"), 60);
  });

  it("stops the clock across the off-hours window (rolls over, never resets)", () => {
    // 22:30 → 23:30 Shanghai: only the 30 minutes before 23:00 count.
    assert.equal(elapsedWorkingMinutes("2026-10-14T14:30:00.000Z", "2026-10-14T15:30:00.000Z"), 30);
    // …and the hour resumes counting the next working morning.
    assert.equal(elapsedWorkingMinutes("2026-10-14T14:30:00.000Z", "2026-10-15T02:00:00.000Z"), 30 + 60);
  });

  it("does not age a wait over a full day off the window", () => {
    // 23:30 Shanghai on the 14th → 08:30 on the 15th: both ends are closed.
    assert.equal(elapsedWorkingMinutes("2026-10-14T15:30:00.000Z", "2026-10-15T00:30:00.000Z"), 0);
  });

  it("is timezone-independent: the window is civil, in Asia/Shanghai", () => {
    // The same two instants, expressed for an observer in another zone, are the
    // same instants — the function reads UTC and shifts by the fixed +08:00.
    const a = elapsedWorkingMinutes("2026-10-14T04:00:00.000Z", "2026-10-14T06:00:00.000Z");
    const b = elapsedWorkingMinutes("2026-10-14T12:00:00.000+08:00", "2026-10-14T14:00:00.000+08:00");
    assert.equal(a, b);
    assert.equal(a, 120);
  });

  it("pins the window and counts every calendar day — there is no weekend calendar", () => {
    // The contract is deliberately daily: 09:00–23:00 in Asia/Shanghai, every
    // day of the week. 2026-10-17 is a Saturday; 10:00 → 12:00 local counts.
    assert.deepEqual(WORKING_WINDOW, {
      zone: "Asia/Shanghai",
      offsetMinutes: 480,
      startHour: 9,
      endHour: 23,
    });
    assert.equal(elapsedWorkingMinutes("2026-10-17T02:00:00.000Z", "2026-10-17T04:00:00.000Z"), 120);
  });

  it("returns null for an unreadable origin — the caller must not read that as fresh", () => {
    assert.equal(elapsedWorkingMinutes(null, NOW), null);
    assert.equal(elapsedWorkingMinutes("not-a-date", NOW), null);
    assert.equal(elapsedWorkingMinutes(NOW, "not-a-date"), null);
  });

  it("is zero for a future or equal instant (a clock skew never makes a card overdue)", () => {
    assert.equal(elapsedWorkingMinutes(NOW, NOW), 0);
    assert.equal(elapsedWorkingMinutes("2026-10-14T11:00:00.000Z", NOW), 0);
  });
});

describe("addWorkingMinutes (display-only due_at, §4 #13)", () => {
  it("projects forward inside the window", () => {
    assert.equal(addWorkingMinutes("2026-10-14T04:00:00.000Z", 120), "2026-10-14T06:00:00.000Z");
  });

  it("rolls a projection that would land after 23:00 to the next window", () => {
    // 22:00 Shanghai + 120 working minutes = 60 min left today, 60 tomorrow
    // (the next window opens at 09:00 local = 01:00Z).
    assert.equal(addWorkingMinutes("2026-10-14T14:00:00.000Z", 120), "2026-10-15T02:00:00.000Z");
  });

  it("refuses to project from an unreadable origin", () => {
    assert.equal(addWorkingMinutes(null, 60), null);
    assert.equal(addWorkingMinutes(NOW, null), null);
  });
});

// ---------------------------------------------------------------------------
// Thresholds — the runtime mapping table carries docs/sla.md, never a new number
// ---------------------------------------------------------------------------

describe("SLA_ROWS (the docs/sla.md runtime mapping table, hook H6)", () => {
  it("pins every published limit to its contract value, with the reference beside it", () => {
    // These are docs/sla.md §2's numbers, transcribed once, here, with the row
    // they come from. If the contract ever moves one, this test is where the
    // drift shows up.
    const published = {
      blocked_clarification: [120, 1440],
      confirmation_gate: [240, 1440],
      defect_card_creation: [1440, 2880],
      acceptance_card_creation: [1440, 2880],
      heartbeat_stale: [30, 360],
      leader_stalled: [60, 360],
    };
    for (const [row, [limit, further]] of Object.entries(published)) {
      assert.equal(SLA_ROWS[row].limitMin, limit, `${row} normal limit`);
      assert.equal(SLA_ROWS[row].furtherMin, further, `${row} further timeout`);
      assert.match(SLA_ROWS[row].ref, /^docs\/sla\.md §/);
      assert.match(SLA_ROWS[row].thresholdRef, /^docs\/sla\.md §/);
      assert.doesNotMatch(SLA_ROWS[row].ref, /:\d+/, "no line-number anchors (§4)");
    }
  });

  it("names no external document anywhere in the table", () => {
    assert.doesNotMatch(
      JSON.stringify(SLA_ROWS),
      /PROTOCOL|§⑮|sla-inspection-contract|team\/guides/,
    );
  });

  it("says which code path covers each row, including the rows it does not emit", () => {
    // Every row now names this module as a producer: `heartbeat_stale` because
    // the SLA channel must exist beside the legacy envelope (§10.4, "F4"), and
    // `inspector_liveness` because the row is emitted whenever the deployment
    // wires the peer's marker (§8.4, "F3"). Neither *replaces* what was there.
    assert.equal(SLA_ROWS.heartbeat_stale.coveredBy, "sla-patrol+legacy-stale-alert");
    assert.equal(SLA_ROWS.inspector_liveness.coveredBy, "sla-patrol");
    for (const row of Object.keys(SLA_ROWS)) {
      assert.match(SLA_ROWS[row].coveredBy, /sla-patrol/, `${row} must name a producer`);
    }
  });

  it("exposes the in-repo contract stamp for a row, and nothing for an unknown one", () => {
    assert.match(slaRowRef("blocked_clarification"), /^docs\/sla\.md §/);
    assert.equal(slaRowRef("nonsense"), null);
  });

  it("keeps docs/sla.md in step with the table", () => {
    // The document is the human contract; this is the machine check that it
    // still carries every row and every published number.
    const doc = readFileSync(new URL("../../docs/sla.md", import.meta.url), "utf8");
    for (const [row, spec] of Object.entries(SLA_ROWS)) {
      assert.ok(doc.includes(row), `docs/sla.md names ${row}`);
      if (spec.limitMin !== null) {
        assert.match(doc, new RegExp(`\\b${spec.limitMin}\\b`), `${row} normal limit ${spec.limitMin}`);
      }
      if (spec.furtherMin !== null) {
        assert.match(doc, new RegExp(`\\b${spec.furtherMin}\\b`), `${row} further bound ${spec.furtherMin}`);
      }
    }
  });

  it("documents the tuple's field count accurately", () => {
    const doc = readFileSync(new URL("../../docs/scheduling.md", import.meta.url), "utf8");
    const match = doc.match(/(\d+)-field object of the contract/);
    assert.ok(match, "docs/scheduling.md states the tuple's size");
    assert.equal(Number(match[1]), 26);
  });
});

describe("tierFor (the shared ladder, §5.2)", () => {
  it("warn is L − P, overdue is L, escalate is F", () => {
    assert.equal(tierFor("blocked_clarification", 114, PERIOD_SECONDS / 60), null);
    assert.equal(tierFor("blocked_clarification", 115, PERIOD_SECONDS / 60), "warn");
    assert.equal(tierFor("blocked_clarification", 120, PERIOD_SECONDS / 60), "overdue");
    assert.equal(tierFor("blocked_clarification", 1439, PERIOD_SECONDS / 60), "overdue");
    assert.equal(tierFor("blocked_clarification", 1440, PERIOD_SECONDS / 60), "escalate");
  });

  it("clamps the lead at 0 when the mechanism's period is longer than the limit", () => {
    assert.equal(tierFor("heartbeat_stale", 0, 60), "warn");
  });

  it("exempts leader_stalled from the −P lead and never reports overdue (§5.2 rule 5)", () => {
    assert.equal(tierFor("leader_stalled", 59, 5), null);
    assert.equal(tierFor("leader_stalled", 60, 5), "warn");
    assert.equal(tierFor("leader_stalled", 359, 5), "warn");
    assert.equal(tierFor("leader_stalled", 360, 5), "escalate");
  });

  it("has no tier at all for a row with no contract threshold", () => {
    assert.equal(tierFor("inspector_liveness", 9999, 5), null);
    assert.equal(tierFor("nonsense", 9999, 5), null);
  });
});

describe("warnLeadMinutes", () => {
  it("is L − P, and L itself for the exempt row", () => {
    assert.equal(warnLeadMinutes("blocked_clarification", 300), 115);
    assert.equal(warnLeadMinutes("leader_stalled", 300), 60);
    assert.equal(warnLeadMinutes("inspector_liveness", 300), null);
  });
});

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

describe("blocked_clarification", () => {
  it("alerts at the lead from blocked_at, as a shared tuple", () => {
    const result = plan([card({ status: "blocked", blocked_at: ago(116) })]);
    assert.equal(result.alerts.length, 1);
    const alert = result.alerts[0];
    assert.equal(alert.sla_row, "blocked_clarification");
    assert.equal(alert.severity, "warn");
    assert.equal(alert.alert_id, "T-1#blocked_clarification#warn");
    assert.equal(alert.dedup_key, `T-1#blocked_clarification#warn@${ago(116)}`);
    assert.equal(alert.measure_start_kind, "blocked_at");
    assert.equal(alert.measure_start_at, ago(116));
    assert.equal(alert.measure_start_source, "frontmatter");
    assert.equal(alert.threshold_min, 120);
    assert.equal(alert.due_at, addWorkingMinutes(ago(116), 120));
    assert.equal(alert.elapsed_basis, "working_hours");
    assert.equal(alert.confidence, "high");
  });

  it("stays silent inside the lead (zero-cost idle)", () => {
    assert.deepEqual(plan([card({ status: "blocked", blocked_at: ago(114) })]).alerts, []);
  });

  it("escalates past the further timeout, still addressed to the leader", () => {
    const result = plan([card({ status: "blocked", blocked_at: "2026-10-01T04:00:00.000Z", status_changed_at: "2026-10-01T04:00:00.000Z" })]);
    assert.equal(result.alerts[0].severity, "escalate");
    assert.equal(result.alerts[0].notify, "immediate");
    assert.equal(result.alerts[0].target, "leader");
  });

  it("falls back to status_changed_at with confidence low when blocked_at is unreadable", () => {
    const result = plan([card({ status: "blocked", blocked_at: null, status_changed_at: ago(130) })]);
    const alert = result.alerts[0];
    assert.equal(alert.measure_start_kind, "status_changed_at");
    assert.equal(alert.measure_start_source, "frontmatter");
    assert.equal(alert.confidence, "low");
  });

  it("alerts with no threshold when no origin can be read at all (§6.5, never false-green)", () => {
    const result = plan([card({ status: "blocked", blocked_at: null, status_changed_at: null })]);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].measure_start_kind, "unverifiable");
    assert.equal(result.alerts[0].threshold_min, null);
    assert.equal(result.alerts[0].severity, "warn");
    assert.equal(result.alerts[0].confidence, "low");
    assert.equal(result.alerts[0].target, "leader");
  });

  it("treats an absent blocked_reason exactly as `clarify` (§7.3)", () => {
    const result = plan([card({ status: "blocked", blocked_at: ago(116) })]);
    assert.equal(result.alerts[0].blocked_reason, null);
    assert.notEqual(result.alerts[0].threshold_min, null, "absence must not silence the row");
  });

  it("gives dependency / external / resource visibility without inventing a contract limit (gap G-3)", () => {
    for (const reason of ["dependency", "external", "resource"]) {
      const result = plan([card({ status: "blocked", blocked_at: ago(116), meta: { blocked_reason: reason } })]);
      assert.equal(result.alerts.length, 1, reason);
      assert.equal(result.alerts[0].threshold_min, null);
      assert.equal(result.alerts[0].severity, "warn");
      assert.equal(result.alerts[0].due_at, null);
      assert.equal(result.alerts[0].blocked_reason, reason);
      assert.match(result.alerts[0].action, /visibility only/);
    }
  });

  it("reads blocked_reason from the provider key or from the card's meta", () => {
    assert.equal(blockedReasonOf({ blocked_reason: "clarify" }), "clarify");
    assert.equal(blockedReasonOf({ meta: { blocked_reason: "defect" } }), "defect");
    assert.equal(blockedReasonOf({ meta: {} }), null);
    assert.equal(blockedReasonOf({}), null);
  });
});

describe("the releasability hint (§7.4) — a hint, never an action", () => {
  it("flags a blocked card whose trail has a leader's answer after the block", () => {
    const result = plan(
      [card({ status: "blocked", blocked_at: ago(130) })],
      { trails: { "T-1": [{ kind: "change", created_at: ago(20), body: "revised", author_kind: "human", author_id: "local" }] } },
    );
    const alert = result.alerts[0];
    assert.equal(alert.releasable, true);
    assert.equal(alert.releasable_basis, "clarification_trail_after_block");
    assert.match(alert.action, /releasable hint/);
    assert.match(alert.action, /never moves a card/);
  });

  it("does not treat a worker's change as the leader's answer", () => {
    const result = plan(
      [card({ status: "blocked", blocked_at: ago(130) })],
      { trails: { "T-1": [{ kind: "change", created_at: ago(20), body: "still blocked", author_kind: "agent", author_id: "linus" }] } },
    );
    assert.equal(result.alerts[0].releasable, false);
    assert.equal(result.alerts[0].releasable_basis, null);
  });

  it("narrows the answer to the configured leader id", () => {
    const blocked = card({ status: "blocked", blocked_at: ago(130) });
    const byOther = plan([blocked], {
      trails: { "T-1": [{ kind: "change", created_at: ago(20), author_kind: "agent", author_id: "linus" }] },
      leaderId: "elon",
    });
    assert.equal(byOther.alerts[0].releasable, false);
    const byElon = plan([blocked], {
      trails: { "T-1": [{ kind: "change", created_at: ago(20), author_kind: "agent", author_id: "elon" }] },
      leaderId: "elon",
    });
    assert.equal(byElon.alerts[0].releasable, true);
  });

  it("does not flag a blocked card whose only trail entry predates the block", () => {
    const result = plan(
      [card({ status: "blocked", blocked_at: ago(20) })],
      { trails: { "T-1": [{ kind: "change", created_at: ago(40), body: "before the block", author_kind: "human", author_id: "local" }] } },
    );
    assert.deepEqual(result.alerts, [], "inside the lead, and nothing to release");
  });

  it("flags a dependency block once every depends_on entry is terminal", () => {
    const result = plan(
      [
        card({ identifier: "T-1", status: "blocked", blocked_at: ago(116), meta: { blocked_reason: "dependency", depends_on: "T-2 T-3" } }),
        card({ identifier: "T-2", status: "done" }),
        card({ identifier: "T-3", status: "canceled" }),
      ],
    );
    const alert = result.alerts.find((entry) => entry.card_id === "T-1");
    assert.equal(alert.releasable, true);
    assert.equal(alert.releasable_basis, "deps_satisfied");
  });

  it("does not flag a dependency block while a predecessor is open", () => {
    const result = plan(
      [
        card({ identifier: "T-1", status: "blocked", blocked_at: ago(116), meta: { blocked_reason: "dependency", depends_on: "T-2" } }),
        card({ identifier: "T-2", status: "in_progress" }),
      ],
    );
    const alert = result.alerts.find((entry) => entry.card_id === "T-1");
    assert.equal(alert.releasable, false);
    assert.equal(alert.releasable_basis, null);
  });
});

describe("confirmation_gate", () => {
  it("fires on the stable [confirm-request] marker in the trail", () => {
    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(300) })],
      { trails: { "T-1": [{ kind: "note", created_at: ago(250), body: "plan.md ready [confirm-request] 2 open items" }] } },
    );
    assert.deepEqual(rowsOf(result), ["confirmation_gate"]);
    const alert = result.alerts[0];
    assert.equal(alert.measure_start_kind, "gate_at");
    assert.equal(alert.measure_start_at, ago(250));
    assert.equal(alert.measure_start_source, "comments");
    assert.equal(alert.confidence, "high");
    assert.equal(alert.severity, "overdue", "250 minutes of a 240-minute limit");
  });

  it("fires on a confirm_request comment, at high confidence", () => {
    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(300) })],
      { trails: { "T-1": [{ kind: "confirm_request", created_at: ago(250), author_kind: "agent", author_id: "linus" }] } },
    );
    const alert = result.alerts.find((entry) => entry.sla_row === "confirmation_gate");
    assert.ok(alert);
    assert.equal(alert.measure_start_at, ago(250));
    assert.equal(alert.measure_start_source, "comments");
    assert.equal(alert.confidence, "high");
  });

  it("prefers a confirm_request entry over a later legacy body marker", () => {
    // The formal kind is the current channel; the body marker is a fallback for
    // deployments that have not adopted it. Priority, not recency, decides.
    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(300) })],
      {
        trails: {
          "T-1": [
            { kind: "confirm_request", created_at: ago(250), author_kind: "agent", author_id: "linus" },
            { kind: "note", created_at: ago(200), body: "docs/plan.md [confirm-request]" },
          ],
        },
      },
    );
    assert.equal(
      result.alerts.find((entry) => entry.sla_row === "confirmation_gate").measure_start_at,
      ago(250),
      "the formal kind wins even though the marker is newer",
    );
  });

  it("takes the latest entry within one channel", () => {
    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(600) })],
      {
        trails: {
          "T-1": [
            { kind: "confirm_request", created_at: ago(500), author_kind: "agent", author_id: "linus" },
            { kind: "confirm_request", created_at: ago(300), author_kind: "agent", author_id: "linus" },
          ],
        },
      },
    );
    assert.equal(
      result.alerts.find((entry) => entry.sla_row === "confirmation_gate").measure_start_at,
      ago(300),
    );
  });

  it("stays silent when the card carries no confirmation request at all", () => {
    const result = plan([card({ status: "in_progress", status_changed_at: ago(600) })]);
    assert.deepEqual(result.alerts, []);
  });

  it("stays silent once a confirmation answers the request", () => {
    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(300) })],
      {
        trails: {
          "T-1": [
            { kind: "note", created_at: ago(250), body: "plan.md ready [confirm-request]" },
            { kind: "confirm", created_at: ago(10), body: "confirmed", author_kind: "human", author_id: "local" },
          ],
        },
      },
    );
    assert.deepEqual(result.alerts, []);
  });

  it("matches the §6.2 request shape only when all three parts are present, at confidence low", () => {
    assert.equal(looksLikeConfirmRequest("docs/plan.md — 请确认，open items: 2"), true);
    assert.equal(looksLikeConfirmRequest("docs/plan.md — looks good"), false, "no confirmation ask");
    assert.equal(looksLikeConfirmRequest("确认了，open items 2"), false, "no document path");

    const result = plan(
      [card({ status: "in_progress", status_changed_at: ago(300) })],
      { trails: { "T-1": [{ kind: "discuss", created_at: ago(250), body: "docs/plan.md 请确认，open items: 2" }] } },
    );
    assert.equal(result.alerts[0].confidence, "low");
  });

  it("prefers an explicit forward-compatible gate field over the trail", () => {
    const request = findConfirmRequest({ meta: { gate_at: ago(250) } }, []);
    assert.deepEqual(request, { at: ago(250), source: "frontmatter", confidence: "high" });
  });
});

describe("defect_card_creation", () => {
  const origin = { status: "blocked", blocked_at: "2026-10-01T04:00:00.000Z", status_changed_at: "2026-10-01T04:00:00.000Z" };

  it("fires on a recorded defect when no fix card exists", () => {
    const result = plan(
      [card({ ...origin, identifier: "T-1" })],
      { trails: { "T-1": [{ kind: "defect", created_at: "2026-10-02T04:00:00.000Z", body: "regression in export" }] } },
    );
    assert.deepEqual(rowsOf(result), ["blocked_clarification", "defect_card_creation"]);
    const alert = result.alerts.find((entry) => entry.sla_row === "defect_card_creation");
    assert.equal(alert.measure_start_kind, "trail_event");
    assert.equal(alert.severity, "escalate", "past the further timeout");
    assert.equal(alert.threshold_min, 1440);
  });

  it("stays silent once a bug-labelled fix card references the origin", () => {
    const result = plan(
      [
        card({ ...origin, identifier: "T-1" }),
        card({ identifier: "T-9", status: "todo", labels: ["category:bug"], meta: { fixes: "T-1" } }),
      ],
      { trails: { "T-1": [{ kind: "defect", created_at: "2026-10-02T04:00:00.000Z", body: "regression" }] } },
    );
    assert.equal(rowsOf(result).includes("defect_card_creation"), false);
  });

  it("does not close the wait on a bug label without a reference back", () => {
    const result = plan(
      [
        card({ ...origin, identifier: "T-1" }),
        card({ identifier: "T-9", status: "todo", labels: ["category:bug"] }),
      ],
      { trails: { "T-1": [{ kind: "defect", created_at: "2026-10-02T04:00:00.000Z", body: "regression" }] } },
    );
    assert.equal(rowsOf(result).includes("defect_card_creation"), true);
  });

  it("stays silent on a card with no recorded defect, however old", () => {
    const result = plan([card({ identifier: "T-1", status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" })]);
    assert.deepEqual(rowsOf(result), ["acceptance_card_creation"]);
  });

  it("reads an exact defect origin verbatim — high, not low (F6)", () => {
    const result = plan(
      [card({ ...origin, identifier: "T-1" })],
      { trails: { "T-1": [{ kind: "defect", created_at: "2026-10-02T04:00:00.000Z", body: "regression" }] } },
    );
    const alert = result.alerts.find((entry) => entry.sla_row === "defect_card_creation");
    assert.equal(alert.confidence, "high", "the origin is one exact trail timestamp");
    assert.equal(alert.evidence.open_predicate, "no_fix_card");
  });

  it("treats an incomplete board read as open but undecidable — low (F6, §6.3-B)", () => {
    // The open predicate is a *negative* over the whole board ("no fix card
    // exists"), so a snapshot cut off at the page cap cannot decide it. The row
    // still fires — an unknown must not become silence — and says why.
    const result = planSlaPatrol({
      cards: [card({ ...origin, identifier: "T-1" })],
      trails: { "T-1": [{ kind: "defect", created_at: "2026-10-02T04:00:00.000Z", body: "regression" }] },
      now: NOW,
      periodSeconds: PERIOD_SECONDS,
      boardTruncated: true,
    });
    const alert = result.alerts.find((entry) => entry.sla_row === "defect_card_creation");
    assert.equal(alert.confidence, "low");
    assert.equal(alert.evidence.open_predicate, "no_fix_card_undecidable");
    assert.match(alert.action, /could not be decided/);
  });
});

describe("heartbeat_stale (the SLA channel beside the legacy envelope, §10.4 / F4)", () => {
  const hbAlert = (result) => result.alerts.find((entry) => entry.sla_row === "heartbeat_stale");

  it("emits the §4 tuple for a stale heartbeat, which the legacy envelope cannot", () => {
    const result = plan([card({ status: "in_progress", heartbeat_at: ago(40) })]);
    const alert = hbAlert(result);
    assert.ok(alert, "the legacy alert is no longer the only channel for this row");
    assert.equal(alert.measure_start_kind, "heartbeat_at");
    assert.equal(alert.measure_start_source, "frontmatter");
    assert.equal(alert.threshold_min, 30);
    assert.equal(alert.confidence, "high", "heartbeat_at is exact frontmatter");
    assert.equal(alert.target, "leader");
    // The shared idempotency key the legacy envelope does not carry — which is
    // precisely why the legacy shape cannot take part in the shared ledger.
    assert.match(alert.dedup_key, /#heartbeat_stale#overdue@/);
  });

  it("fires one period early, at the lead — not only once it is already stale", () => {
    // The legacy alert fires past 30 minutes; the tuple's `warn` is `L − P`, so
    // the two envelopes do not even describe the same instant. That is the point
    // of having both: the row is now 到点提醒, and the legacy consumer is intact.
    assert.equal(hbAlert(plan([card({ heartbeat_at: ago(26) })])).severity, "warn");
    assert.equal(hbAlert(plan([card({ heartbeat_at: ago(24) })])) ?? null, null);
  });

  it("escalates at the further bound with an immediate notify", () => {
    const alert = hbAlert(plan([card({ heartbeat_at: ago(400) })]));
    assert.equal(alert.severity, "escalate");
    assert.equal(alert.notify, "immediate");
    assert.equal(alert.threshold_min, 30);
  });

  it("applies only to in_progress cards", () => {
    const result = plan([card({ status: "in_review", heartbeat_at: ago(600), status_changed_at: ago(600) })]);
    assert.equal(rowsOf(result).includes("heartbeat_stale"), false);
  });

  it("alerts with no threshold when the heartbeat cannot be read (§6.5)", () => {
    const result = plan([card({ heartbeat_at: "not-a-timestamp" })]);
    const alert = hbAlert(result);
    assert.equal(alert.measure_start_kind, "unverifiable");
    assert.equal(alert.threshold_min, null);
    assert.equal(alert.severity, "warn");
    assert.equal(alert.confidence, "low");
  });
});

describe("inspector_liveness (the mutual watchdog, §5.3 / §8.4 / F3)", () => {
  const live = (input) => planSlaPatrol({ cards: [], trails: {}, now: NOW, periodSeconds: PERIOD_SECONDS, ...input });
  const livenessAlert = (result) => result.alerts.find((entry) => entry.sla_row === "inspector_liveness");
  /** The derived bound this mechanism watches the peer against. */
  const BOUND_MIN = PEER_LIVENESS_K * PEER_PERIOD_MIN;

  it("raises when the peer has run and gone quiet past the derived bound", () => {
    const alert = livenessAlert(live({ peerLastOkAt: ago(BOUND_MIN + 1) }));
    assert.ok(alert, "a peer marker older than k × P_peer is a silent inspector");
    assert.equal(alert.severity, "warn");
    assert.equal(alert.threshold_min, null, "no contract row ⇒ no invented threshold");
    assert.equal(alert.confidence, "high", "the marker's own timestamp is exact");
    assert.equal(alert.target, "leader");
    assert.equal(alert.evidence.peer, "openclaw-cron");
    assert.equal(alert.evidence.peer_state, "present");
  });

  it("stays silent while the peer is inside its bound", () => {
    assert.equal(livenessAlert(live({ peerLastOkAt: ago(BOUND_MIN - 1) })) ?? null, null);
    assert.equal(livenessAlert(live({ peerLastOkAt: NOW })) ?? null, null);
  });

  it("registers a never-published peer marker as a dependency, not a per-period alarm", () => {
    // The peer's half has not landed. Alarming every pass on that is the "never
    // green" failure mode the contract exists to prevent, so the default is
    // silence; a deployment that *requires* the peer asks for the alarm instead.
    assert.equal(livenessAlert(live({ peerLastOkAt: null })) ?? null, null);
    const required = livenessAlert(live({ peerLastOkAt: null, peerRequired: true }));
    assert.ok(required, "with the peer required, an absent marker is a liveness failure");
    assert.equal(required.measure_start_kind, "unverifiable");
    assert.equal(required.threshold_min, null);
    assert.equal(required.severity, "warn");
    assert.equal(required.evidence.peer_state, "absent");
  });

  it("is not leader-owed work, so it can never make a quiet board look stalled", () => {
    const result = live({ peerLastOkAt: null, peerRequired: true });
    assert.deepEqual(rowsOf(result), ["inspector_liveness"]);
  });

  it("alarms when the observer's own clock cannot be read — an injected fault is never a clean envelope", () => {
    const alert = livenessAlert(live({ peerLastOkAt: "2026-10-14T09:00:00.000Z", now: "not-a-timestamp" }));
    assert.ok(alert, "H4: an unreadable clock must not decide the peer is fine");
    assert.equal(alert.measure_start_kind, "unverifiable");
    assert.equal(alert.threshold_min, null);
    assert.equal(alert.severity, "warn");
    assert.equal(alert.confidence, "low");
  });
});

describe("assignee_changed (the §7 substantive-change channel, F7)", () => {
  const outOfBounds = (over = {}) =>
    card({ status: "blocked", blocked_reason: "out_of_bounds", blocked_at: ago(200), status_changed_at: ago(200), ...over });
  const entry = (at, body, author = { kind: "human", id: "local" }) =>
    ({ kind: "change", created_at: at, body, author_kind: author.kind, author_id: author.id });
  const basisOf = (result) => result.alerts.find((a) => a.sla_row === "blocked_clarification")?.releasable_basis ?? null;

  it("reads the reassignment from the trail, not from a snapshot that has no history", () => {
    const result = plan([outOfBounds()], { trails: { "T-1": [entry(ago(100), "改派给 turing")] } });
    assert.equal(basisOf(result), "assignee_changed");
    assert.equal(result.alerts.find((a) => a.sla_row === "blocked_clarification").releasable, true);
  });

  it("requires the entry to be newer than the block — an old reassignment is history", () => {
    const result = plan([outOfBounds()], { trails: { "T-1": [entry(ago(300), "reassign: linus")] } });
    assert.equal(basisOf(result), null);
  });

  it("requires the entry to say it was a reassignment", () => {
    const result = plan([outOfBounds()], { trails: { "T-1": [entry(ago(100), "noted, will look after lunch")] } });
    assert.equal(basisOf(result), null);
  });

  it("applies only to a block raised back as out_of_bounds", () => {
    const result = plan([card({ status: "blocked", blocked_reason: "clarify", blocked_at: ago(200), status_changed_at: ago(200) })], {
      trails: { "T-1": [entry(ago(100), "reassign: turing")] },
    });
    assert.equal(basisOf(result), "clarification_trail_after_block", "the clarify basis, not the reassignment one");
  });
});

describe("acceptance_card_creation", () => {
  it("fires on a delivered card nobody has queued a review for", () => {
    const result = plan([card({ status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" })]);
    const alert = result.alerts.find((entry) => entry.sla_row === "acceptance_card_creation");
    assert.equal(alert.measure_start_kind, "status_changed_at");
    assert.equal(alert.measure_start_at, "2026-10-01T04:00:00.000Z");
    assert.equal(alert.severity, "escalate");
    assert.equal(alert.threshold_min, 1440);
    assert.equal(alert.target, "leader");
  });

  it("stays silent once a card records review_of = this card", () => {
    const result = plan([
      card({ identifier: "T-1", status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" }),
      card({ identifier: "T-9", status: "todo", meta: { review_of: "T-1" } }),
    ]);
    assert.deepEqual(rowsOf(result).filter((row) => row === "acceptance_card_creation"), []);
  });

  it("suppresses only the round the review card audits", () => {
    // Round 2 is a re-delivery after a rejection: the round-1 review card is
    // history and must not silence the new wait.
    const stale = card({
      identifier: "T-1",
      status: "in_review",
      status_changed_at: "2026-10-01T04:00:00.000Z",
      delivery_round: 2,
    });
    const oldReview = card({ identifier: "T-9", status: "done", meta: { review_of: "T-1", review_round: 1 } });
    assert.deepEqual(
      rowsOf(plan([stale, oldReview])).filter((row) => row === "acceptance_card_creation"),
      ["acceptance_card_creation"],
      "a last-round review card no longer covers this delivery",
    );

    const currentReview = card({ identifier: "T-10", status: "todo", meta: { review_of: "T-1", review_round: 2 } });
    assert.deepEqual(
      rowsOf(plan([stale, currentReview])).filter((row) => row === "acceptance_card_creation"),
      [],
      "a review card for this round suppresses it",
    );

    // A review card from before `review_round` existed records no round; the
    // conservative reading is that it still covers the delivery.
    const legacyReview = card({ identifier: "T-11", status: "todo", meta: { review_of: "T-1" } });
    assert.deepEqual(
      rowsOf(plan([stale, legacyReview])).filter((row) => row === "acceptance_card_creation"),
      [],
    );
  });

  it("does not apply to a flow B card", () => {
    const result = plan([card({ status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z", meta: { flow: "B" } })]);
    assert.deepEqual(result.alerts, []);
  });

  it("stays silent for a delivery still inside its 24h working limit", () => {
    const result = plan([card({ status: "in_review", status_changed_at: ago(600) })]);
    assert.deepEqual(result.alerts, []);
  });

  it("marks a capped board read as undecidable, but still reports the wait", () => {
    const delivered = card({ status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" });
    const exact = plan([delivered]).alerts.find((entry) => entry.sla_row === "acceptance_card_creation");
    assert.equal(exact.confidence, "high");
    assert.equal(exact.evidence.open_predicate, "no_review_card");

    const capped = plan([delivered], { boardTruncated: true }).alerts
      .find((entry) => entry.sla_row === "acceptance_card_creation");
    assert.ok(capped, "an incomplete read must not silence the wait");
    assert.equal(capped.confidence, "low");
    assert.equal(capped.evidence.open_predicate, "no_review_card_undecidable");
    assert.match(capped.action, /could not be decided/);

    // Positive evidence still suppresses: a review card we did see is enough.
    const covered = plan(
      [delivered, card({ identifier: "T-9", status: "todo", meta: { review_of: "T-1" } })],
      { boardTruncated: true },
    );
    assert.deepEqual(rowsOf(covered).filter((row) => row === "acceptance_card_creation"), []);
  });
});

describe("leader_stalled", () => {
  const hasStalled = (result) => result.alerts.some((entry) => entry.sla_row === "leader_stalled");
  /** A leader-owed card (blocked, wait open) on a board whose newest card is old. */
  const blocked = (identifier, created = ago(200)) =>
    card({ identifier, status: "blocked", created_at: created, blocked_at: ago(30), status_changed_at: ago(30) });
  /** A comment in the shared wire shape, written by whoever is named. */
  const comment = (kind, at, author, body = "") => ({
    kind,
    created_at: at,
    body,
    author_kind: author.kind,
    author_id: author.id,
  });
  const LEADER = { kind: "human", id: "local" };
  const WORKER = { kind: "agent", id: "linus" };

  it("fires when leader-owed work is pending and no leader action is observable", () => {
    const result = plan([blocked("T-1")], { now: NOW });
    const alert = result.alerts.find((entry) => entry.sla_row === "leader_stalled");
    assert.equal(alert.severity, "warn");
    assert.equal(alert.threshold_min, 60);
    assert.equal(alert.target, "leader");
    // The newest leader-attributed event is the card's own creation (the leader
    // is the only dispatcher, §⑩), read verbatim from the frontmatter — an exact
    // candidate inside the lookback, so §6.2's rule makes it `high`.
    assert.equal(alert.measure_start_kind, "created_at");
    assert.equal(alert.measure_start_source, "frontmatter");
    assert.equal(alert.confidence, "high");
  });

  it("stays silent on an idle board (no leader-owed work) — the conditioning rule", () => {
    const result = plan([card({ identifier: "T-1", status: "in_progress", status_changed_at: ago(600) })]);
    assert.deepEqual(result.alerts, []);
  });

  it("stays silent on a quiet board whose only alert would be a stale heartbeat", () => {
    // A stale heartbeat is not leader-owed work (§5.1): if it conditioned this
    // row, every quiet night would read as a stalled leader (§9.4).
    const result = plan([card({ identifier: "T-1", created_at: "2026-09-01T04:00:00.000Z", status_changed_at: ago(600), heartbeat_at: ago(600) })]);
    assert.equal(hasStalled(result), false);
    assert.deepEqual(rowsOf(result), ["heartbeat_stale"]);
  });

  it("stays silent while a leader action is observable on the board", () => {
    // The same leader-owed card, on a board whose newest card was created 30
    // minutes ago: a leader that acted within the bound is not stalled.
    const result = plan([card({ identifier: "T-1", status: "blocked", created_at: ago(30), blocked_at: ago(30), status_changed_at: ago(30) })]);
    assert.equal(hasStalled(result), false);
  });

  it("escalates past the §5.2 stall bound", () => {
    const result = plan([blocked("T-1", "2026-10-01T04:00:00.000Z")]);
    const alert = result.alerts.find((entry) => entry.sla_row === "leader_stalled");
    assert.equal(alert.severity, "escalate");
    assert.equal(alert.notify, "immediate");
  });

  it("counts a leader-authored confirm / decision / change entry as leader activity", () => {
    const fresh = { identifier: "T-2", status: "in_progress", created_at: "2026-09-01T04:00:00.000Z", status_changed_at: ago(5) };
    const staleBlocked = blocked("T-1", "2026-09-01T04:00:00.000Z");
    const silent = plan([staleBlocked, fresh]);
    for (const kind of ["confirm", "decision", "change"]) {
      const active = plan([staleBlocked, fresh], {
        trails: { "T-2": [comment(kind, ago(10), LEADER)] },
      });
      assert.equal(hasStalled(silent), true, `${kind}: the quiet board stalls`);
      assert.equal(hasStalled(active), false, `${kind}: a leader's ${kind} resets the clock`);
    }
  });

  it("does not count a worker's confirm_request as leader activity", () => {
    const stale = blocked("T-1", "2026-09-01T04:00:00.000Z");
    const result = plan([stale], { trails: { "T-1": [comment("confirm_request", ago(1), WORKER)] } });
    assert.equal(hasStalled(result), true, "a request is not a leader action");
  });

  it("does not count the loop's own automated acceptance as leader activity", () => {
    // The workflow pass writes `meta.accepted_by = "loop-review"` when it closes
    // a card after a verdict. Counting that `done` would let the loop's own
    // activity mask a stalled leader — so the marker is excluded, and the same
    // card *without* it still proves the control case.
    const stale = blocked("T-1", "2026-09-01T04:00:00.000Z");
    const accepted = (meta) =>
      card({ identifier: "T-2", status: "done", created_at: "2026-09-01T04:00:00.000Z", status_changed_at: ago(1), meta });

    assert.equal(hasStalled(plan([stale, accepted({ accepted_by: "loop-review" })])), true);
    assert.equal(hasStalled(plan([stale, accepted({})])), false, "a leader's own done still resets the clock");
  });

  it("does not count a worker's kind=change entry as leader activity (F2)", () => {
    // The whole point of the ruling: a chatty worker must not be able to mask a
    // real stall by narrating its own progress.
    const staleBlocked = blocked("T-1", "2026-09-01T04:00:00.000Z");
    const worker = plan([staleBlocked], { trails: { "T-1": [comment("change", ago(1), WORKER)] } });
    assert.equal(hasStalled(worker), true, "a worker's change must not reset the stall clock");
    const leader = plan([staleBlocked], { trails: { "T-1": [comment("change", ago(1), LEADER)] } });
    assert.equal(hasStalled(leader), false, "the leader's change must reset it");
  });

  it("narrows the attribution to an explicitly configured leader id", () => {
    // `--sla-leader` is how a deployment whose leader writes as an *agent* keeps
    // the same set the peer mechanism uses; with it set, kind alone is not enough
    // and the board's own human-authority default is overridden.
    const staleBlocked = blocked("T-1", "2026-09-01T04:00:00.000Z");
    const asCoordinator = planSlaPatrol({
      cards: [staleBlocked],
      trails: { "T-1": [comment("change", ago(1), { kind: "agent", id: "elon" })] },
      now: NOW,
      periodSeconds: PERIOD_SECONDS,
      leaderId: "elon",
    });
    assert.equal(hasStalled(asCoordinator), false, "a configured leader id counts");
    const asSomeoneElse = planSlaPatrol({
      cards: [staleBlocked],
      trails: { "T-1": [comment("change", ago(1), { kind: "agent", id: "linus" })] },
      now: NOW,
      periodSeconds: PERIOD_SECONDS,
      leaderId: "elon",
    });
    assert.equal(hasStalled(asSomeoneElse), true, "a configured leader id counts only the leader");
  });

  it("keeps the real pre-lookback origin, and says the board is quiet (low)", () => {
    // Dropping a >7-day origin would silently soften the deepest stall into a
    // fresh one; §6.3-D wants the real start emitted and the *confidence* to
    // carry the "no leader event in the lookback" fact.
    const result = plan([blocked("T-1", "2026-09-01T04:00:00.000Z")]);
    const alert = result.alerts.find((entry) => entry.sla_row === "leader_stalled");
    assert.equal(alert.measure_start_at, "2026-09-01T04:00:00.000Z");
    assert.equal(alert.confidence, "low");
    assert.equal(alert.severity, "escalate", "the real origin keeps the real tier");
  });

  it("reports a board that has never shown a leader event rather than staying quiet", () => {
    // §6.3-D's last sentence: an inspector that has never seen the leader act
    // must say so. No threshold (there is no origin to count from), `warn` only.
    const orphan = blocked("T-1", "2026-09-01T04:00:00.000Z");
    delete orphan.created_at;
    const result = plan([{ ...orphan, reporter: { id: "linus", display_name: "linus", kind: "agent" } }]);
    const alert = result.alerts.find((entry) => entry.sla_row === "leader_stalled");
    assert.equal(alert.measure_start_kind, "unverifiable");
    assert.equal(alert.threshold_min, null);
    assert.equal(alert.severity, "warn");
    assert.equal(alert.confidence, "low");
  });

  it("anchors the alert on a real leader-owed card", () => {
    const result = plan([blocked("T-1"), blocked("T-2")]);
    const alert = result.alerts.find((entry) => entry.sla_row === "leader_stalled");
    assert.ok(["T-1", "T-2"].includes(alert.card_id));
    assert.equal(alert.evidence.open_predicate, "leader_owed_work");
  });
});

describe("leaderAttributionWarning (a configuration hint, never an attribution)", () => {
  it("warns when the configured id only matches a display name", () => {
    const cards = [card({ reporter: { id: "terry", display_name: "Terry", kind: "human" } })];
    assert.match(leaderAttributionWarning("Terry", cards, {}), /display name/);
  });

  it("stays quiet when the id matches a reporter or a comment author", () => {
    const cards = [card({ reporter: { id: "terry", display_name: "Terry", kind: "human" } })];
    assert.equal(leaderAttributionWarning("terry", cards, {}), null);
    assert.equal(leaderAttributionWarning("terry", [], { "T-1": [{ author_id: "terry" }] }), null);
  });

  it("warns when the id matches no author at all", () => {
    assert.match(leaderAttributionWarning("nobody", [], {}), /no author/);
  });

  it("does nothing when no leader id is configured", () => {
    assert.equal(leaderAttributionWarning(null, [], {}), null);
    assert.equal(leaderAttributionWarning("", [], {}), null);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting properties
// ---------------------------------------------------------------------------

describe("the shared tuple (§4) and the safe-operation envelope (§9)", () => {
  const FULL = plan([card({ status: "blocked", blocked_at: ago(130) })], {
    trails: { "T-1": [{ kind: "change", created_at: ago(20), body: "answered" }] },
  }).alerts[0];

  it("carries every field of the shared tuple", () => {
    const expected = [
      "alert_id", "dedup_key", "card_id", "sla_row", "sla_ref", "severity",
      "measure_start_kind", "measure_start_at", "measure_start_source",
      "elapsed_working_min", "elapsed_basis", "threshold_min", "due_at", "action",
      "target", "notify", "releasable", "releasable_basis", "blocked_reason",
      "confidence", "mechanism", "mechanism_host", "first_seen", "last_seen",
      "observed_by", "evidence",
    ];
    for (const field of expected) assert.ok(field in FULL, `missing tuple field: ${field}`);
    assert.equal(FULL.mechanism, MECHANISM);
    assert.deepEqual(Object.keys(FULL.evidence).sort(), [
      "has_sessions", "has_workspace", "open_predicate", "status", "status_changed_at", "threshold_ref",
    ]);
  });

  it("addresses every alert to the leader and never to the operator (§9.1, hook H1)", () => {
    const result = plan([
      card({ status: "blocked", blocked_at: ago(130) }),
      card({ identifier: "T-2", status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" }),
    ]);
    assert.ok(result.alerts.length >= 2);
    for (const alert of result.alerts) assert.equal(alert.target, "leader");
    assert.equal(JSON.stringify(result.alerts).includes("operator"), false);
  });

  it("names the contract row it derives from, never a line anchor", () => {
    for (const alert of plan([card({ status: "blocked", blocked_at: ago(130) })]).alerts) {
      assert.match(alert.sla_ref, /^docs\/sla\.md §/);
      assert.doesNotMatch(alert.sla_ref, /:\d/);
    }
  });

  it("alerts nothing on an empty board", () => {
    assert.deepEqual(plan([]), { alerts: [] });
  });

  it("does not alert for a card that is not in a covered state", () => {
    assert.deepEqual(plan([card({ status: "todo" }), card({ status: "done" })]).alerts, []);
  });
});

// ---------------------------------------------------------------------------
// Pre-emit re-check (§9.6)
// ---------------------------------------------------------------------------

describe("stillQualifies (one shared decision rule for scan and re-check)", () => {
  const alert = plan([card({ status: "blocked", blocked_at: ago(130) })]).alerts[0];

  it("keeps a card that is still blocked", () => {
    assert.deepEqual(stillQualifies(alert, { status: "blocked" }), { ok: true });
  });

  it("drops a card that moved on, with a reason", () => {
    assert.deepEqual(stillQualifies(alert, { status: "done" }), { ok: false, reason: "live_status:done" });
    assert.deepEqual(stillQualifies(alert, null), { ok: false, reason: "live_status:gone" });
  });

  it("drops an acceptance wait whose card left in_review", () => {
    const acceptance = plan([card({ status: "in_review", status_changed_at: "2026-10-01T04:00:00.000Z" })]).alerts
      .find((entry) => entry.sla_row === "acceptance_card_creation");
    assert.equal(stillQualifies(acceptance, { status: "done" }).ok, false);
    assert.equal(stillQualifies(acceptance, { status: "in_review" }).ok, true);
  });

  it("drops a gate the leader has since answered, from the live trail read", () => {
    const gate = plan([card({ status: "in_progress", status_changed_at: ago(300), meta: { gate_at: ago(300) } })])
      .alerts.find((entry) => entry.sla_row === "confirmation_gate");
    assert.ok(gate);
    const open = [{ kind: "confirm_request", created_at: ago(300) }];
    assert.equal(stillQualifies(gate, { status: "in_progress" }, { trail: open }).ok, true);

    const answered = [
      ...open,
      { kind: "confirm", created_at: ago(10), author_kind: "human", author_id: "local" },
    ];
    assert.deepEqual(
      stillQualifies(gate, { status: "in_progress" }, { trail: answered, leaderId: null }),
      { ok: false, reason: "gate_answered" },
    );

    // A worker's confirmation does not close the leader's gate.
    const worker = [
      ...open,
      { kind: "confirm", created_at: ago(10), author_kind: "agent", author_id: "linus" },
    ];
    assert.equal(stillQualifies(gate, { status: "in_progress" }, { trail: worker }).ok, true);
  });
});

// ---------------------------------------------------------------------------
// De-duplication (§8.3)
// ---------------------------------------------------------------------------

describe("the ledger", () => {
  const alerts = plan([card({ status: "blocked", blocked_at: ago(130) })]).alerts;

  it("notifies a key once and suppresses the repeat", () => {
    const first = partitionSlaAlerts(alerts, emptySlaLedger());
    assert.equal(first.notify.length, 1);
    assert.equal(first.suppressed.length, 0);

    const ledger = recordSlaAlerts(emptySlaLedger(), first.notify, NOW);
    const second = partitionSlaAlerts(alerts, ledger);
    assert.equal(second.notify.length, 0);
    assert.equal(second.suppressed.length, 1);
  });

  it("treats a tier promotion as a new key — an escalation is never de-duplicated away", () => {
    // Same wait, same origin, one tier higher: the key is addressed *by tier*,
    // so the promotion is a new key and goes out again.
    const warned = plan([card({ status: "blocked", blocked_at: ago(116) })]).alerts[0];
    assert.equal(warned.severity, "warn");
    const ledger = recordSlaAlerts(emptySlaLedger(), [warned], NOW);

    const promoted = {
      ...warned,
      severity: "overdue",
      alert_id: alertIdFor("T-1", "blocked_clarification", "overdue"),
    };
    promoted.dedup_key = dedupKeyFor(promoted.alert_id, promoted.measure_start_at);
    assert.equal(partitionSlaAlerts([promoted], ledger).notify.length, 1);
    assert.equal(promoted.measure_start_at, warned.measure_start_at, "only the tier moved");
  });

  it("re-notifies on a new wait on the same card and row (a new origin is a new key)", () => {
    const ledger = recordSlaAlerts(emptySlaLedger(), alerts, NOW);
    const reblocked = plan([card({ status: "blocked", blocked_at: ago(200) })]);
    assert.equal(partitionSlaAlerts(reblocked.alerts, ledger).notify.length, 1);
  });

  it("records a suppressed duplicate's observer without notifying it", () => {
    const ledger = recordSlaAlerts(emptySlaLedger(), alerts, NOW);
    const suppressed = partitionSlaAlerts(alerts, ledger).suppressed;
    const next = recordSlaAlerts(ledger, [], ago(1), suppressed);
    const key = alerts[0].dedup_key;
    assert.equal(next.seen[key].observed_by.length, 1, "the same mechanism observing twice is not two observers");
    assert.equal(next.seen[key].last_seen, ago(1));
    assert.equal(next.seen[key].first_seen, NOW, "first_seen is when this mechanism first saw the wait");
  });

  it("notifies rather than suppressing when the ledger is unreadable", () => {
    assert.equal(partitionSlaAlerts(alerts, null).notify.length, 1);
    assert.equal(partitionSlaAlerts(alerts, { version: 1 }).notify.length, 1);
  });

  it("prunes by age and by size", () => {
    const ledger = { version: 1, seen: { old: { first_seen: NOW, last_seen: "2026-08-01T04:00:00.000Z", observed_by: [] }, new: { last_seen: NOW, observed_by: [] } } };
    assert.deepEqual(Object.keys(pruneSlaLedger(ledger, { now: NOW }).seen), ["new"]);
    assert.deepEqual(Object.keys(pruneSlaLedger(ledger, { now: NOW, maxEntries: 1 }).seen), ["new"]);
  });
});

// ---------------------------------------------------------------------------
// Which trails the pass has to read
// ---------------------------------------------------------------------------

describe("trailReadCandidates (one provider read per trail, so it must not over-read)", () => {
  it("skips a card whose trail-derived rows cannot have reached their lead", () => {
    assert.deepEqual(trailReadCandidates([card({ status: "in_progress", status_changed_at: ago(10) })], { now: NOW, periodSeconds: 300 }), []);
  });

  it("reads a blocked card once its releasability hint could matter", () => {
    assert.deepEqual(
      trailReadCandidates([card({ status: "blocked", blocked_at: ago(116), status_changed_at: ago(116) })], { now: NOW, periodSeconds: 300 }),
      ["T-1"],
    );
  });

  it("reads an old card for the gate and defect rows", () => {
    assert.deepEqual(
      trailReadCandidates([card({ status: "in_progress", status_changed_at: ago(300) })], { now: NOW, periodSeconds: 300 }),
      ["T-1"],
    );
  });

  it("never reads a finished card's trail", () => {
    assert.deepEqual(trailReadCandidates([card({ status: "done", status_changed_at: ago(10_000) })], { now: NOW, periodSeconds: 300 }), []);
  });

  it("reads a card whose status_changed_at is unreadable — an unreadable origin must not suppress a row", () => {
    assert.deepEqual(trailReadCandidates([card({ status: "in_progress", status_changed_at: null })], { now: NOW, periodSeconds: 300 }), ["T-1"]);
  });
});

// ---------------------------------------------------------------------------
// The runner (injected I/O)
// ---------------------------------------------------------------------------

function spy(impl = () => undefined) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  fn.count = () => calls.length;
  return fn;
}

const runnerDeps = (overrides = {}) => ({
  cards: [],
  trails: {},
  ledger: emptySlaLedger(),
  periodSeconds: PERIOD_SECONDS,
  mechanismHost: "claude/linus",
  recheck: async () => ({ checked: true, card: null }),
  notify: () => {},
  now: () => NOW,
  log: () => {},
  ...overrides,
});

describe("runSlaPatrolTick (injected deps)", () => {
  it("notifies nothing on an idle board — and re-checks nothing either", async () => {
    const notify = spy();
    const recheck = spy(async () => ({ checked: true, card: null }));
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "in_progress", status_changed_at: ago(5) })],
      notify,
      recheck,
    }));
    assert.equal(result.alerts.length, 0);
    assert.equal(notify.count(), 0, "zero-cost idle");
    assert.equal(recheck.count(), 0, "no candidate ⇒ no extra read");
  });

  it("forwards the peer's declared period to the planner", async () => {
    const deps = (peerPeriodMinutes) => runnerDeps({
      peerLastOkAt: ago(80),
      peerPeriodMinutes,
      recheck: async () => ({ checked: true, card: null }),
    });
    const fallback = await runSlaPatrolTick(deps(15));
    assert.equal(fallback.alerts.length, 1);
    assert.equal(fallback.alerts[0].sla_row, "inspector_liveness");

    const declared = await runSlaPatrolTick(deps(30));
    assert.deepEqual(declared.alerts, [], "80 minutes is inside a declared 30-minute peer's 3× bound");
  });

  it("re-reads the trail for a fresh gate alert and drops it when answered", async () => {
    const notify = spy();
    const recheckTrail = spy(async () => ({
      checked: true,
      trail: [
        { kind: "confirm_request", created_at: ago(300) },
        { kind: "confirm", created_at: ago(10), author_kind: "human", author_id: "local" },
      ],
    }));
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "in_progress", status_changed_at: ago(300), meta: { gate_at: ago(300) } })],
      notify,
      recheck: async () => ({ checked: true, card: { status: "in_progress" } }),
      recheckTrail,
    }));
    assert.equal(recheckTrail.count(), 1);
    assert.equal(result.alerts.length, 0);
    assert.ok(result.dropped.some((drop) => drop.reason === "gate_answered"));
    assert.equal(notify.count(), 0);
  });

  it("keeps a gate alert when the live trail read fails", async () => {
    const notify = spy();
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "in_progress", status_changed_at: ago(300), meta: { gate_at: ago(300) } })],
      notify,
      recheck: async () => ({ checked: true, card: { status: "in_progress" } }),
      recheckTrail: async () => ({ checked: false }),
    }));
    assert.equal(result.alerts.length, 1);
    assert.equal(notify.count(), 1);
  });

  it("does not read a trail for a non-gate row", async () => {
    const recheckTrail = spy(async () => ({ checked: true, trail: [] }));
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      recheck: async () => ({ checked: true, card: { status: "blocked" } }),
      recheckTrail,
    }));
    assert.equal(result.alerts.length, 1);
    assert.equal(recheckTrail.count(), 0);
  });

  it("re-checks before it notifies, and keeps the alert when the card is unchanged", async () => {
    const notify = spy();
    const recheck = spy(async () => ({ checked: true, card: { status: "blocked" } }));
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      notify,
      recheck,
    }));
    assert.equal(result.alerts.length, 1);
    assert.equal(recheck.count(), 1);
    assert.equal(notify.count(), 1);
  });

  it("drops a candidate whose card moved on, and says why", async () => {
    const notify = spy();
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      notify,
      recheck: async () => ({ checked: true, card: { status: "in_progress" } }),
    }));
    assert.equal(result.alerts.length, 0);
    assert.equal(notify.count(), 0);
    assert.deepEqual(result.dropped.filter((drop) => drop.reason.startsWith("live_status")), [
      { card_id: "T-1", sla_row: "blocked_clarification", reason: "live_status:in_progress" },
    ]);
  });

  it("notifies anyway when the re-check cannot run (a failed read must not silence an alert)", async () => {
    const notify = spy();
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      notify,
      recheck: async () => ({ checked: false }),
    }));
    assert.equal(result.alerts.length, 1);
    assert.equal(notify.count(), 1);
  });

  it("suppresses a repeat without reading the card again, and records it in the ledger", async () => {
    const recheck = spy(async () => ({ checked: true, card: { status: "blocked" } }));
    const first = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      recheck,
    }));
    const second = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      ledger: first.ledger,
      recheck,
    }));
    assert.equal(first.alerts.length, 1);
    assert.equal(second.alerts.length, 0);
    assert.equal(second.suppressed.length, 1);
    assert.equal(recheck.count(), 1, "a suppressed alert costs no provider read");
  });

  it("does not re-read a card for a board-level row — there is no card to read", async () => {
    // `leader_stalled` and `inspector_liveness` name the board, not a card. Asking
    // the provider for the sentinel would be a read that cannot succeed and a log
    // line that reports a failure that is not one; the row goes straight out,
    // which is also what §9.3 requires of a re-check that cannot be performed.
    const asked = [];
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130), created_at: ago(200) })],
      peerLastOkAt: ago(1_000),
      peerRequired: true,
      recheck: async (cardId) => {
        asked.push(cardId);
        return { checked: true, card: { status: "blocked" } };
      },
    }));
    const liveness = result.alerts.find((a) => a.sla_row === "inspector_liveness");
    assert.equal(liveness.card_id, BOARD_CARD_ID);
    // The card rows are re-read (the leader_stalled row is anchored on a real
    // card); the sentinel never is.
    assert.deepEqual(asked, ["T-1", "T-1"]);
    assert.equal(asked.includes(BOARD_CARD_ID), false, "the provider is never asked for a card that does not exist");
  });

  it("starts no LLM turn and moves no card", async () => {
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      recheck: async () => ({ checked: true, card: { status: "blocked" } }),
    }));
    assert.equal(result.spawns, 0);
    assert.equal(result.mechanism, MECHANISM);
    for (const alert of result.alerts) assert.equal(alert.target, "leader");
  });

  it("carries the ledger's first_seen / last_seen / observed_by into the emitted tuple", async () => {
    const result = await runSlaPatrolTick(runnerDeps({
      cards: [card({ status: "blocked", blocked_at: ago(130) })],
      recheck: async () => ({ checked: true, card: { status: "blocked" } }),
    }));
    const alert = result.alerts[0];
    assert.equal(alert.last_seen, NOW);
    assert.deepEqual(alert.observed_by, [MECHANISM]);
  });
});
