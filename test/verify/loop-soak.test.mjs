/**
 * Tests for `scripts/verify/lib/soak-verdict.mjs` — the loop soak's final
 * status judgement (TP-0151).
 *
 * The defect: the soak required the final verdict to be exactly `running`, so a
 * `busy` pool with a live pid — a card turn in flight, the healthy norm on a
 * soak — was reported as a failure (TP-0034's 40 s and 60 s runs).
 *
 * The status objects are built from the real `poolVerdict` with only the clock
 * and `isAlive` injected, so the cases stay tied to the production verdict
 * vocabulary instead of hand-typed strings. Nothing is mocked.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { poolVerdict } from "../../src/foundation/loop-state.mjs";
import { healthyStatusVerdict } from "../../scripts/verify/lib/soak-verdict.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const AGO_MS = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The shape `probeSupervisor` reports and the soak judges. */
function statusOf(verdict, poolPid = 4242) {
  return {
    verdict: verdict.verdict,
    pool: {
      live: verdict.live,
      verdict: verdict.verdict,
      reason: verdict.reason,
      poolPid: verdict.verdict === "gone" ? null : poolPid,
    },
  };
}

function verdictWith(fields, alive = true) {
  return poolVerdict({
    poolPid: 4242,
    poolPidStart: null,
    now: () => NOW,
    isAlive: () => alive,
    ...fields,
  });
}

describe("healthyStatusVerdict", () => {
  it("accepts running with a live pid", () => {
    const status = statusOf(
      verdictWith({ phase: "running", heartbeatAt: AGO_MS(MINUTE) }),
    );
    assert.equal(status.verdict, "running");
    assert.equal(healthyStatusVerdict(status).ok, true);
  });

  it("accepts busy with a live pid — a card turn in flight is healthy", () => {
    const status = statusOf(
      verdictWith({
        phase: "running",
        heartbeatAt: AGO_MS(MINUTE),
        tickStartedAt: AGO_MS(MINUTE),
      }),
    );
    assert.equal(status.verdict, "busy");
    assert.equal(status.pool.live, true);
    const judgement = healthyStatusVerdict(status);
    assert.equal(judgement.ok, true);
    assert.match(judgement.detail, /busy/);
    assert.match(judgement.detail, /4242/);
  });

  it("rejects wedged even though the pid is alive", () => {
    const status = statusOf(
      verdictWith({
        phase: "running",
        heartbeatAt: AGO_MS(MINUTE),
        tickStartedAt: AGO_MS(2 * HOUR),
      }),
    );
    assert.equal(status.verdict, "wedged");
    assert.equal(status.pool.live, true);
    const judgement = healthyStatusVerdict(status);
    assert.equal(judgement.ok, false);
    assert.match(judgement.detail, /wedged/);
  });

  it("rejects a dead pid (gone)", () => {
    const status = statusOf(verdictWith({ phase: "running" }, false));
    assert.equal(status.verdict, "gone");
    assert.equal(status.pool.live, false);
    const judgement = healthyStatusVerdict(status);
    assert.equal(judgement.ok, false);
    assert.match(judgement.detail, /gone/);
  });

  it("rejects a missing pool pid", () => {
    const status = statusOf(
      poolVerdict({ poolPid: null, now: () => NOW, isAlive: () => true }),
    );
    assert.equal(healthyStatusVerdict(status).ok, false);
  });

  it("rejects unresponsive (stale heartbeat) and starting", () => {
    const stale = statusOf(
      verdictWith({ phase: "running", heartbeatAt: AGO_MS(5 * MINUTE) }),
    );
    assert.equal(stale.verdict, "unresponsive");
    assert.equal(healthyStatusVerdict(stale).ok, false);

    const starting = statusOf(
      verdictWith({ phase: "starting", startStartedAt: AGO_MS(MINUTE) }),
    );
    assert.equal(starting.verdict, "starting");
    assert.equal(healthyStatusVerdict(starting).ok, false);
  });

  it("rejects busy when its pid is not live (malformed input)", () => {
    const status = {
      verdict: "busy",
      pool: { live: false, poolPid: 4242, reason: null },
    };
    assert.equal(healthyStatusVerdict(status).ok, false);
  });

  it("rejects an absent report", () => {
    assert.equal(healthyStatusVerdict(null).ok, false);
    assert.equal(healthyStatusVerdict(undefined).ok, false);
    assert.equal(healthyStatusVerdict({}).ok, false);
  });
});

describe("loop-soak wiring", () => {
  const source = readFileSync(join(ROOT, "scripts", "verify", "loop-soak.mjs"), "utf8");

  it("judges the final status, the CLI status and the after-EPIPE status through the shared predicate", () => {
    const uses = source.match(/healthyStatusVerdict\(/g) ?? [];
    assert.ok(uses.length >= 3, `expected every status check to use the helper, found ${uses.length}`);
    assert.doesNotMatch(source, /after EPIPE the verdict was/);
  });

  it("no longer gates a status verdict on an exact `running`", () => {
    assert.doesNotMatch(source, /finalStatus\.verdict === "running"/);
    assert.doesNotMatch(source, /status\.verdict !== "running"/);
  });
});
