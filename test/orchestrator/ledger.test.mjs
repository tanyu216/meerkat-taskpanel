/**
 * The card-session ledger: one terminal row per finished card turn, kept for
 * audit and reconcile; no row is live because the queue row holds the slot.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  liveSubagents,
  prune,
  readLedger,
  upsertSubagent,
  writeLedger,
} from "../../src/orchestrator/ledger.mjs";

function dirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("ledger", () => {
  it("round-trips through its state file and tolerates an empty dir", (t) => {
    const dir = dirFor(t);
    assert.deepEqual(readLedger(dir).value, { version: 1, subagents: [] });
    const ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "worker:T-1:r1",
      actorKind: "claude",
      subagentId: "sid-1",
      card: "T-1",
      role: "worker",
      type: "card-session",
      status: "completed",
    });
    assert.equal(writeLedger(dir, ledger).ok, true);
    assert.equal(readLedger(dir).value.subagents[0].subagentId, "sid-1");
  });

  it("fills the session id into a row created before it existed", () => {
    const pending = upsertSubagent({ subagents: [] }, {
      sessionKey: "worker:T-1:r1",
      actorKind: "claude",
      card: "T-1",
      role: "worker",
      status: "spawned",
    });
    const filled = upsertSubagent(pending, {
      sessionKey: "worker:T-1:r1",
      actorKind: "claude",
      subagentId: "sid-1",
      card: "T-1",
      role: "worker",
      status: "completed",
    });
    assert.equal(filled.subagents.length, 1);
    assert.equal(filled.subagents[0].subagentId, "sid-1");
    assert.equal(filled.subagents[0].status, "completed");
  });

  it("a completed card turn is not live — the queue row held the slot", () => {
    const ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "worker:T-1:r1",
      actorKind: "claude",
      subagentId: "sid-1",
      card: "T-1",
      role: "worker",
      type: "card-session",
      status: "completed",
    });
    assert.equal(liveSubagents(ledger).length, 0);
  });

  it("prunes finished rows but never a legacy live one", () => {
    let ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      subagentId: "done",
      card: "T-1",
      status: "completed",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    // A row written before this release: live statuses are only pruned once
    // they are terminal, so a legacy row is never dropped while it claims a slot.
    ledger = upsertSubagent(ledger, {
      sessionKey: "/work/app",
      subagentId: "live",
      card: "T-2",
      status: "running",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    const pruned = prune(ledger, { now: Date.parse("2026-02-01T00:00:00.000Z") });
    assert.deepEqual(pruned.subagents.map((entry) => entry.subagentId), ["live"]);
  });
});
