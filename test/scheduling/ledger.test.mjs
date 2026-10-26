/**
 * The subagent ledger: capture an agent handle, reattach it after a restart, and
 * release its slot without trusting an agent transcript.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  extractAgentIds,
  liveSubagents,
  markSubagent,
  prune,
  readLedger,
  reap,
  reattachCandidates,
  upsertSubagent,
  writeLedger,
} from "../../scripts/loop/ledger.mjs";

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
      sessionKey: "/work/app",
      actorKind: "claude",
      subagentId: "a-1",
      card: "T-1",
      role: "worker",
      status: "running",
    });
    assert.equal(writeLedger(dir, ledger).ok, true);
    assert.equal(readLedger(dir).value.subagents[0].subagentId, "a-1");
  });

  it("fills the agent handle into a row created before the id existed", () => {
    const pending = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      actorKind: "claude",
      card: "T-1",
      role: "worker",
      status: "spawned",
    });
    const filled = upsertSubagent(pending, {
      sessionKey: "/work/app",
      actorKind: "claude",
      subagentId: "a-1",
      card: "T-1",
      role: "worker",
      status: "running",
    });
    assert.equal(filled.subagents.length, 1);
    assert.equal(filled.subagents[0].subagentId, "a-1");
    assert.equal(filled.subagents[0].status, "running");
  });

  it("releases a slot when the agent reports a stop", () => {
    const running = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      actorKind: "claude",
      subagentId: "a-1",
      card: "T-1",
      role: "worker",
      status: "running",
    });
    assert.equal(liveSubagents(running).length, 1);
    const stopped = markSubagent(running, "a-1", { status: "completed", lastResult: "done" });
    assert.equal(liveSubagents(stopped).length, 0);
    assert.equal(stopped.subagents[0].lastResult, "done");
  });

  it("extracts Claude agent ids from Agent results and hook payloads", () => {
    assert.deepEqual(extractAgentIds("done\nagentId: a-123"), ["a-123"]);
    assert.deepEqual(extractAgentIds('{"agent_id":"a-9"}'), ["a-9"]);
    assert.deepEqual(extractAgentIds("agentId: a-1 and agentId: a-1"), ["a-1"]);
  });

  it("offers only live rows with a handle for reattach", () => {
    let ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      subagentId: "a-1",
      card: "T-1",
      role: "worker",
      status: "running",
    });
    ledger = upsertSubagent(ledger, {
      sessionKey: "/work/app",
      subagentId: "a-2",
      card: "T-2",
      role: "worker",
      status: "completed",
    });
    ledger = upsertSubagent(ledger, {
      sessionKey: "/work/app",
      card: "T-3",
      role: "worker",
      status: "running",
    });
    assert.deepEqual(reattachCandidates(ledger).map((entry) => entry.subagentId), ["a-1"]);
    assert.deepEqual(reattachCandidates(ledger, { sessionKey: "/work/other" }), []);
  });

  it("reaps a live row once it outlives the bound, and leaves a fresh one", () => {
    const ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      subagentId: "a-1",
      card: "T-1",
      role: "worker",
      status: "running",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    const fresh = reap(ledger, {
      now: Date.parse("2026-01-01T00:01:00.000Z"),
      staleAfterMs: 2 * 60 * 60 * 1000,
    });
    assert.equal(fresh.reaped.length, 0, "a fresh row is not reaped");
    assert.equal(fresh.ledger.subagents[0].status, "running");
    const old = reap(ledger, {
      now: Date.parse("2026-01-02T00:00:00.000Z"),
      staleAfterMs: 2 * 60 * 60 * 1000,
    });
    assert.deepEqual(old.reaped, ["a-1"]);
    assert.equal(old.ledger.subagents[0].status, "stale");
    assert.equal(liveSubagents(old.ledger).length, 0, "the slot is released");
  });

  it("never reaps a row that is already terminal", () => {
    const ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      subagentId: "a-1",
      card: "T-1",
      status: "completed",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    const result = reap(ledger, {
      now: Date.parse("2026-01-02T00:00:00.000Z"),
      staleAfterMs: 2 * 60 * 60 * 1000,
    });
    assert.deepEqual(result.reaped, []);
    assert.equal(result.ledger.subagents[0].status, "completed");
  });

  it("prunes finished rows but never a live one", () => {
    let ledger = upsertSubagent({ subagents: [] }, {
      sessionKey: "/work/app",
      subagentId: "done",
      card: "T-1",
      status: "completed",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
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
