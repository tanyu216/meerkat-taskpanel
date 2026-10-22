/**
 * The loop's durable queues: continue turns coalesce, card handoffs do not.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  claimCards,
  claimContinue,
  completeCards,
  completeContinue,
  enqueueCard,
  enqueueContinue,
  readCards,
  readContinue,
  recoverStaleCards,
  requeueCards,
  pruneCards,
  requeueContinue,
} from "../../scripts/loop/queue.mjs";

function dirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("continue queue", () => {
  it("coalesces a second request into the one pending turn", (t) => {
    const dir = dirFor(t);
    assert.deepEqual(enqueueContinue(dir, { reason: "timer", requestedAt: "2026-01-01T00:00:00.000Z" }), {
      ok: true,
      coalesced: false,
      error: null,
    });
    assert.equal(enqueueContinue(dir, { reason: "event" }).coalesced, true);
    const state = readContinue(dir);
    assert.equal(state.pending.reason, "event");
    assert.equal(state.processing, null);
  });

  it("claims the pending turn once and completes it", (t) => {
    const dir = dirFor(t);
    enqueueContinue(dir, { reason: "timer" });
    const first = claimContinue(dir);
    assert.equal(first.request.reason, "timer");
    assert.equal(claimContinue(dir).request, null, "a second claim sees the in-flight turn");
    assert.deepEqual(completeContinue(dir), { ok: true, error: null });
    assert.equal(readContinue(dir).processing, null);
  });

  it("requeues a claimed turn, and a newer pending request wins", (t) => {
    const dir = dirFor(t);
    enqueueContinue(dir, { reason: "timer", requestedAt: "2026-01-01T00:00:00.000Z" });
    claimContinue(dir);
    const requeued = requeueContinue(dir);
    assert.equal(requeued.requeued, true);
    assert.equal(readContinue(dir).pending.attempts, 1);

    claimContinue(dir);
    enqueueContinue(dir, { reason: "event" });
    const superseded = requeueContinue(dir);
    assert.equal(superseded.superseded, true);
    assert.equal(readContinue(dir).pending.reason, "event");
  });

  it("treats a corrupt continue file as empty and reports why", (t) => {
    const dir = dirFor(t);
    writeFileSync(join(dir, "continue.pending.json"), "{not json", "utf8");
    const state = readContinue(dir);
    assert.equal(state.pending, null);
    assert.equal(state.errors.length, 1);
  });
});

describe("card queue retention", () => {
  it("drops a terminal row past its retention and keeps live ones", (t) => {
    const dir = dirFor(t);
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    enqueueCard(dir, { card: "T-1", role: "worker", enqueuedAt: "2026-01-01T00:00:00.000Z" });
    enqueueCard(dir, { card: "T-2", role: "worker", enqueuedAt: "2026-01-01T00:00:00.000Z" });
    enqueueCard(dir, { card: "T-3", role: "worker", enqueuedAt: "2026-01-01T00:00:00.000Z" });
    completeCards(dir, ["T-1-worker"], { now: "2026-01-01T00:30:00.000Z" });
    requeueCards(dir, ["T-2-worker"], { error: "boom" });
    const pruned = pruneCards(dir, { now, ttlMs: 60_000 });
    assert.equal(pruned.dropped, 1);
    const cards = readCards(dir).value.cards;
    assert.deepEqual(cards.map((card) => card.card).sort(), ["T-2", "T-3"]);
    assert.equal(cards.find((card) => card.card === "T-2").status, "pending", "a requeued card is not terminal");
  });

  it("keeps a just-completed row", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { card: "T-1", enqueuedAt: "2026-01-01T00:00:00.000Z" });
    completeCards(dir, ["T-1-worker"], { now: "2026-01-01T23:59:00.000Z" });
    const pruned = pruneCards(dir, { now: Date.parse("2026-01-02T00:00:00.000Z"), ttlMs: 60_000 });
    assert.equal(pruned.dropped, 0);
    assert.equal(readCards(dir).value.cards.length, 1);
  });
});

describe("card queue", () => {
  const card = (ref, role = "worker") => ({
    card: ref,
    role,
    agent: "alice",
    project: "TaskPanel",
    target_dir: "/work/app",
    handoff: `handoff ${ref}`,
  });

  it("keeps distinct cards and dedupes the same (card, role)", (t) => {
    const dir = dirFor(t);
    assert.equal(enqueueCard(dir, card("T-1")).coalesced, false);
    assert.equal(enqueueCard(dir, card("T-2")).coalesced, false);
    assert.equal(enqueueCard(dir, card("T-1")).coalesced, true);
    assert.equal(enqueueCard(dir, card("T-1", "reviewer")).coalesced, false);
    assert.equal(readCards(dir).value.cards.length, 3);
  });

  it("records the event UUID and review fields, normalizing absent ones to null", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { ...card("T-1"), task_id: "uuid-1", review_of: "T-0", review_round: 2 });
    enqueueCard(dir, card("T-2"));
    const [a, b] = readCards(dir).value.cards;
    assert.equal(a.task_id, "uuid-1");
    assert.equal(a.review_of, "T-0");
    assert.equal(a.review_round, 2);
    assert.equal(b.task_id, null);
    assert.equal(b.review_of, null);
    assert.equal(b.review_round, null);
  });

  it("records the selected role agent, normalizing absent to null", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { ...card("T-1"), agent_role: "Jobs" });
    enqueueCard(dir, card("T-2"));
    const [a, b] = readCards(dir).value.cards;
    assert.equal(a.agent_role, "Jobs");
    assert.equal(b.agent_role, null);
  });

  it("claims a bounded batch and completes it", (t) => {
    const dir = dirFor(t);
    for (const ref of ["T-1", "T-2", "T-3"]) enqueueCard(dir, card(ref));
    const claimed = claimCards(dir, { claimedBy: "/work/app", limit: 2, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(claimed.cards.length, 2);
    assert.ok(claimed.cards.every((entry) => entry.status === "processing"));
    assert.equal(claimCards(dir, { claimedBy: "/work/app", limit: 2 }).cards.length, 1);
    completeCards(dir, claimed.cards.map((entry) => entry.id));
    assert.equal(readCards(dir).value.cards.filter((entry) => entry.status === "done").length, 2);
  });

  it("requeues below the attempt cap and fails at it", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    const [first] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    const one = requeueCards(dir, [first.id], { maxAttempts: 2 });
    assert.deepEqual({ requeued: one.requeued, failed: one.failed }, { requeued: 1, failed: 0 });
    const [second] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    const two = requeueCards(dir, [second.id], { maxAttempts: 2 });
    assert.deepEqual({ requeued: two.requeued, failed: two.failed }, { requeued: 0, failed: 1 });
    assert.equal(readCards(dir).value.cards[0].status, "failed");
  });

  it("recovers a processing card whose owner pid is gone", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    claimCards(dir, { claimedBy: "/work/app", limit: 1 });
    const file = join(dir, "cards.queue.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.cards[0].claimedByPid = 999999;
    writeFileSync(file, JSON.stringify(value), "utf8");
    const recovered = recoverStaleCards(dir, { isAlive: () => false, maxAttempts: 3 });
    assert.deepEqual({ recovered: recovered.recovered, failed: recovered.failed }, { recovered: 1, failed: 0 });
    assert.equal(readCards(dir).value.cards[0].status, "pending");
  });
});
