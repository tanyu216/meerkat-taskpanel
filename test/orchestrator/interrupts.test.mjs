/**
 * The cross-process interrupt channel (TP-0125 · ADR 0017).
 *
 * A request is a small durable file, not an IPC call: the writer may be the
 * subscriber, the workflow pass or a heartbeat refusal, and the reader is the
 * pool process. These tests pin the two halves that make that safe — an atomic,
 * idempotent write/read, and the **timestamp guard** that keeps a tombstone
 * from killing a handoff enqueued after the move.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CLAIM_HOLDING,
  INTERRUPT_PRUNE_MS,
  INTERRUPT_TOMBSTONE_MS,
  interruptRequestForRow,
  interruptsDir,
  isInterruptActivity,
  leavesClaimCycle,
  pruneInterruptRequests,
  readInterruptRequestIndex,
  removeInterruptRequest,
  requestInterrupt,
} from "../../src/orchestrator/interrupts.mjs";
import { STATE_FILES } from "../../src/foundation/loop-state.mjs";

function dirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-interrupts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AT = "2026-11-05T09:00:00.000Z";
const row = (overrides = {}) => ({
  id: "T-1-worker",
  card: "T-1",
  task_id: "uuid-1",
  enqueuedAt: "2026-11-05T08:59:00.000Z",
  ...overrides,
});

describe("orchestrator/interrupts — the request file", () => {
  it("writes one atomic file per target and overwrites it idempotently", (t) => {
    const dir = dirFor(t);
    const first = requestInterrupt(dir, {
      taskId: "uuid-1",
      from: "in_progress",
      to: "canceled",
      requestedBy: "subscribe",
      requestedAt: AT,
    });
    assert.equal(first.ok, true);
    assert.equal(existsSync(first.file), true);
    assert.equal(readdirSync(interruptsDir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);

    requestInterrupt(dir, {
      taskId: "uuid-1",
      from: "in_progress",
      to: "backlog",
      requestedBy: "subscribe",
      requestedAt: AT,
    });
    const files = readdirSync(interruptsDir(dir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, "same target, same file");
    const onDisk = JSON.parse(readFileSync(join(interruptsDir(dir), files[0]), "utf8"));
    assert.equal(onDisk.to, "backlog", "the later write wins");
    assert.equal(onDisk.requested_at, AT);
    assert.equal(onDisk.version, 1);
  });

  it("uses the identifier when there is no task UUID", (t) => {
    const dir = dirFor(t);
    const written = requestInterrupt(dir, { card: "REV-0007", from: "in_review", to: "canceled", requestedAt: AT });
    assert.equal(written.ok, true);
    assert.match(written.file, /card:REV-0007\.json$/);
    const index = readInterruptRequestIndex(dir);
    assert.equal(index.byCard.get("REV-0007")?.length, 1);
    assert.equal(index.byTask.size, 0);
  });

  it("refuses a request that names no card, or no parsable time", (t) => {
    const dir = dirFor(t);
    assert.equal(requestInterrupt(dir, { from: "in_progress", to: "todo" }).ok, false);
    assert.equal(requestInterrupt(dir, { card: "T-1", requestedAt: "not a time" }).ok, false);
    assert.equal(existsSync(interruptsDir(dir)), false, "a refused request writes nothing");
  });

  it("drops a corrupt file on read and reports it", (t) => {
    const dir = dirFor(t);
    requestInterrupt(dir, { taskId: "uuid-1", from: "in_progress", to: "todo", requestedAt: AT });
    writeFileSync(join(interruptsDir(dir), "broken.json"), "{not json", "utf8");
    const index = readInterruptRequestIndex(dir);
    assert.equal(index.corrupt.length, 1);
    assert.equal(existsSync(join(interruptsDir(dir), "broken.json")), false);
    assert.equal(index.byTask.get("uuid-1")?.length, 1, "the good request still reads");
  });

  it("reads snake_case on disk and removes a request idempotently", (t) => {
    const dir = dirFor(t);
    const written = requestInterrupt(dir, { taskId: "uuid-1", from: "in_progress", to: "todo", requestedAt: AT });
    const index = readInterruptRequestIndex(dir);
    const request = index.byTask.get("uuid-1")[0];
    assert.equal(request.task_id, "uuid-1");
    assert.equal(removeInterruptRequest(request), true);
    assert.equal(removeInterruptRequest(request), true, "a second remove is a no-op, not an error");
    assert.equal(existsSync(written.file), false);
  });

  it("registers the directory once in the state vocabulary", () => {
    assert.equal(STATE_FILES.interrupts, "interrupts");
  });
});

describe("orchestrator/interrupts — matching a queue row", () => {
  const indexWith = (request) => {
    const dir = mkdtempSync(join(tmpdir(), "tp-interrupts-index-"));
    try {
      requestInterrupt(dir, request);
      return readInterruptRequestIndex(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("matches a row enqueued at or before the move", () => {
    const index = indexWith({ taskId: "uuid-1", from: "in_progress", to: "todo", requestedAt: AT });
    assert.notEqual(interruptRequestForRow(index, row()), null);
    assert.notEqual(
      interruptRequestForRow(index, row({ enqueuedAt: AT })),
      null,
      "the boundary is inclusive",
    );
  });

  it("never matches a handoff enqueued after the move (the timestamp guard)", () => {
    const index = indexWith({ taskId: "uuid-1", from: "in_progress", to: "todo", requestedAt: AT });
    assert.equal(
      interruptRequestForRow(index, row({ enqueuedAt: "2026-11-05T09:00:01.000Z" })),
      null,
      "a reopened card's next handoff is a new attempt",
    );
  });

  it("matches by task id first, and by card when the row has no task id", () => {
    const byTask = indexWith({ taskId: "uuid-1", from: "in_progress", to: "todo", requestedAt: AT });
    assert.notEqual(interruptRequestForRow(byTask, row()), null);
    assert.equal(interruptRequestForRow(byTask, row({ task_id: null, card: "OTHER" })), null);

    const byCard = indexWith({ card: "T-1", from: "in_review", to: "canceled", requestedAt: AT });
    assert.notEqual(interruptRequestForRow(byCard, row({ task_id: null })), null);
  });

  it("returns the earliest applicable request when two writers requested the same move", (t) => {
    const dir = dirFor(t);
    requestInterrupt(dir, {
      taskId: "uuid-1",
      from: "in_progress",
      to: "todo",
      requestedBy: "subscribe",
      requestedAt: "2026-11-05T09:00:00.000Z",
    });
    requestInterrupt(dir, {
      card: "T-1",
      from: "in_progress",
      to: "todo",
      requestedBy: "pulse",
      requestedAt: "2026-11-05T09:05:00.000Z",
    });
    const index = readInterruptRequestIndex(dir);
    const match = interruptRequestForRow(index, row());
    assert.equal(match.requested_by, "subscribe");
  });

  it("prunes past the absolute lifetime and keeps a fresh tombstone", (t) => {
    const dir = dirFor(t);
    requestInterrupt(dir, { taskId: "old", from: "in_progress", to: "todo", requestedAt: AT });
    requestInterrupt(dir, {
      taskId: "fresh",
      from: "in_progress",
      to: "todo",
      requestedAt: new Date(Date.parse(AT) + INTERRUPT_PRUNE_MS).toISOString(),
    });
    const pruned = pruneInterruptRequests(dir, {
      now: Date.parse(AT) + INTERRUPT_PRUNE_MS + 1,
    });
    assert.equal(pruned.removed, 1);
    const index = readInterruptRequestIndex(dir);
    assert.equal(index.byTask.has("fresh"), true);
    assert.equal(index.byTask.has("old"), false);
    assert.equal(INTERRUPT_TOMBSTONE_MS < INTERRUPT_PRUNE_MS, true, "a tombstone is short, the prune absolute");
  });
});

describe("orchestrator/interrupts — the activity predicate", () => {
  const activity = (event, from, to) => ({ event, changes: { from, to } });

  it("fires on every claim-cycle exit and on nothing else", () => {
    for (const [from, to] of [
      ["in_progress", "todo"],
      ["in_progress", "backlog"],
      ["in_progress", "canceled"],
      ["in_progress", "done"],
      ["awaiting", "todo"],
      ["in_review", "canceled"],
      ["blocked", "todo"],
    ]) {
      assert.equal(isInterruptActivity(activity("task_moved", from, to)), true, `${from} → ${to}`);
    }
    assert.equal(isInterruptActivity(activity("task_resumed", "awaiting", "todo")), true);
    for (const [from, to] of [
      ["in_review", "in_progress"],
      ["todo", "backlog"],
      ["in_progress", "awaiting"],
      ["blocked", "in_progress"],
    ]) {
      assert.equal(isInterruptActivity(activity("task_moved", from, to)), false, `${from} → ${to}`);
    }
    assert.equal(isInterruptActivity(activity("task_created", "todo", "todo")), false);
    assert.equal(isInterruptActivity({ event: "task_moved" }), false, "no changes = no claim");
  });

  it("uses the same vocabulary as the domain", () => {
    assert.deepEqual(CLAIM_HOLDING.slice().sort(), ["awaiting", "blocked", "in_progress", "in_review"]);
    assert.equal(leavesClaimCycle("in_progress", "backlog"), true);
    assert.equal(leavesClaimCycle("in_review", "in_progress"), false);
  });
});
