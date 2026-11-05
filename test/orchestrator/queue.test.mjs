/**
 * The loop's durable card queue: handoffs coalesce per (card, role), work does not.
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
  completeCards,
  enqueueCard,
  readCards,
  recoverStaleCards,
  reownCards,
  requeueCards,
  pruneCards,
  questionDispatches,
  rowDispatches,
  retireLegacyDispatched,
  timeoutCards,
  TIMEOUT_BACKOFF_MS,
  TIMEOUT_MAX_ATTEMPTS,
} from "../../src/orchestrator/queue.mjs";

function dirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("card queue interprocess lock", () => {
  it("refuses a mutation while another live process holds the queue lock", (t) => {
    const dir = dirFor(t);
    const lockPath = join(dir, "cards.queue.json.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: process.pid, token: "other-process" }),
    );

    const enqueued = enqueueCard(dir, { card: "T-1", role: "worker" });
    assert.equal(enqueued.ok, false);
    assert.match(enqueued.error, /locked by another loop process/);

    const claimed = claimCards(dir, { claimedBy: "/work/app", limit: 1 });
    assert.equal(claimed.ok, false);
    assert.deepEqual(claimed.cards, []);

    // The refused caller wrote nothing: the queue is still the empty work list.
    assert.deepEqual(readCards(dir).value.cards, []);
  });

  it("takes the lock over once its holder is gone", (t) => {
    const dir = dirFor(t);
    const lockPath = join(dir, "cards.queue.json.lock");
    writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 999_999, token: "dead" }));

    const enqueued = enqueueCard(dir, { card: "T-1", role: "worker" });
    assert.equal(enqueued.ok, true, "a dead holder is reclaimed, not waited out");
    assert.equal(readCards(dir).value.cards.length, 1);
  });
});

describe("card queue dispatch keys", () => {
  it("counts a route row by dispatch_key and a legacy row by question_id", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, {
      id: "route:T-1",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      dispatch_key: "route:T-1",
    });
    enqueueCard(dir, {
      id: "question:T-2:q-1",
      queue_kind: "question",
      role: "question",
      card: "T-2",
      question_id: "q-1",
    });
    assert.equal(rowDispatches(dir, "route:T-1"), 1);
    assert.equal(rowDispatches(dir, "q-1"), 1, "a row written before dispatch_key still counts");
    assert.equal(rowDispatches(dir, "route:T-1"), questionDispatches(dir, "route:T-1"));

    requeueCards(dir, ["route:T-1"], { maxAttempts: 5 });
    requeueCards(dir, ["route:T-1"], { maxAttempts: 5 });
    assert.equal(rowDispatches(dir, "route:T-1"), 2, "each requeue is another turn");
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

  it("claims only the listed ids", (t) => {
    const dir = dirFor(t);
    for (const ref of ["A-1", "B-1", "A-2"]) enqueueCard(dir, card(ref));
    const ids = readCards(dir)
      .value.cards.filter((entry) => String(entry.card).startsWith("A-"))
      .map((entry) => entry.id);
    const claimed = claimCards(dir, { claimedBy: "/work/app", ids, limit: 5 });
    assert.deepEqual(claimed.cards.map((entry) => entry.card).sort(), ["A-1", "A-2"]);
    const left = readCards(dir).value.cards.filter((entry) => entry.status === "pending").map((entry) => entry.card);
    assert.deepEqual(left, ["B-1"]);
  });

  it("filters by queue_kind, treating an absent one as handoff", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    enqueueCard(dir, { ...card("Q-1"), queue_kind: "question", role: "question" });
    const questions = claimCards(dir, { claimedBy: "/work/app", queueKind: "question", limit: 5 });
    assert.deepEqual(questions.cards.map((entry) => entry.card), ["Q-1"]);
    const handoffs = claimCards(dir, { claimedBy: "/work/app", queueKind: "handoff", limit: 5 });
    assert.deepEqual(handoffs.cards.map((entry) => entry.card), ["T-1"]);
  });

  it("never copies the board card kind onto a queue row", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { ...card("T-1"), kind: "task" });
    const [row] = readCards(dir).value.cards;
    assert.equal("kind" in row, false, "the board kind is not a queue field");
    assert.equal(row.queue_kind, "handoff");
  });

  it("keys a question row by the question, not by the card", (t) => {
    const dir = dirFor(t);
    const row = (questionId) => ({
      card: "T-1",
      queue_kind: "question",
      role: "question",
      question_id: questionId,
    });
    const fresh = { ok: true, coalesced: false, replaced: false, superseded: false, error: null };
    const coalesced = { ok: true, coalesced: true, replaced: false, superseded: false, error: null };
    assert.deepEqual(enqueueCard(dir, row("q-1")), fresh);
    assert.deepEqual(enqueueCard(dir, row("q-1")), coalesced);
    assert.deepEqual(enqueueCard(dir, row("q-2")), fresh);
    assert.equal(readCards(dir).value.cards.length, 2, "two questions on one card are two rows");

    assert.equal(questionDispatches(dir, "q-1"), 1);
    const [claimed] = claimCards(dir, { claimedBy: "/work/app", queueKind: "question", limit: 5 }).cards;
    completeCards(dir, [claimed.id]);
    assert.equal(questionDispatches(dir, "q-1"), 1, "a completed dispatch still counts against the bound");
  });

  it("counts a requeued question row by its attempts and records the retry time", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, {
      id: "question:T-1:q-1",
      card: "T-1",
      queue_kind: "question",
      role: "question",
      question_id: "q-1",
    });
    const claim = () =>
      claimCards(dir, { claimedBy: "/work/app", queueKind: "question", limit: 1 }).cards[0];
    requeueCards(dir, [claim().id], {
      maxAttempts: 2,
      error: "no release",
      retryAt: "2026-01-01T00:00:30.000Z",
    });
    const [pending] = readCards(dir).value.cards;
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempts, 1);
    assert.equal(pending.retry_at, "2026-01-01T00:00:30.000Z");
    assert.equal(questionDispatches(dir, "q-1"), 1, "one turn used");

    requeueCards(dir, [claim().id], { maxAttempts: 2, error: "still no release" });
    const [failed] = readCards(dir).value.cards;
    assert.equal(failed.status, "failed");
    assert.equal(questionDispatches(dir, "q-1"), 2, "two turns used");
  });

  it("keeps a worker key and supersedes a pending row on a round change", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { ...card("T-1"), round: 1, target_dir: "/w/a", worker_key: "worker:T-1:r1" });
    const [first] = readCards(dir).value.cards;
    assert.equal(first.worker_key, "worker:T-1:r1");
    assert.equal(first.round, 1);

    const again = enqueueCard(dir, {
      ...card("T-1"),
      round: 1,
      target_dir: "/w/a",
      worker_key: "worker:T-1:r1",
    });
    assert.equal(again.coalesced, true);

    const replaced = enqueueCard(dir, {
      ...card("T-1"),
      round: 2,
      target_dir: "/w/a-r2",
      worker_key: "worker:T-1:r2",
    });
    assert.equal(replaced.replaced, true);
    const rows = readCards(dir).value.cards;
    assert.equal(rows.length, 1, "one row per (card, role)");
    assert.equal(rows[0].round, 2);
    assert.equal(rows[0].worker_key, "worker:T-1:r2");
    assert.match(rows[0].lastError, /superseded by round 2/);
  });

  it("leaves a processing row alone when a new round arrives", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { ...card("T-1"), round: 1, target_dir: "/w/a", worker_key: "worker:T-1:r1" });
    claimCards(dir, { claimedBy: "/w/a", limit: 1 });
    const result = enqueueCard(dir, {
      ...card("T-1"),
      round: 2,
      target_dir: "/w/a-r2",
      worker_key: "worker:T-1:r2",
    });
    assert.equal(result.superseded, true);
    const [row] = readCards(dir).value.cards;
    assert.equal(row.status, "processing");
    assert.equal(row.round, 1);
  });

  it("re-owns a processing row after a restart", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    const [row] = claimCards(dir, { claimedBy: "/old", pid: 111, limit: 1 }).cards;
    const reowned = reownCards(dir, [row.id], { claimedBy: "/new", claimedByPid: 222 });
    assert.equal(reowned.ok, true);
    assert.equal(reowned.cards.length, 1);
    const [after] = readCards(dir).value.cards;
    assert.equal(after.claimedBy, "/new");
    assert.equal(after.claimedByPid, 222);
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
    assert.equal(one.attempts[first.id], 1, "the caller can read the attempt it just spent");
    assert.equal(two.attempts[second.id], 2);
    assert.deepEqual(two.failedIds, [second.id]);
    assert.equal(readCards(dir).value.cards[0].status, "failed");
  });

  // A terminal row is kept for 24h, and a new handoff for the same card gets the
  // same deterministic id once the old row is terminal (`enqueueCard`). A
  // requeue must move the one live row — not resurrect and inflate the history.
  it("does not inflate or resurrect a terminal row that shares a live row's id", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    const [first] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    requeueCards(dir, [first.id], { maxAttempts: 1 });
    assert.equal(readCards(dir).value.cards[0].status, "failed");

    enqueueCard(dir, card("T-1"));
    assert.equal(readCards(dir).value.cards.length, 2, "a terminal row does not coalesce");

    const [second] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    const result = requeueCards(dir, [second.id], { maxAttempts: 3 });
    assert.deepEqual({ requeued: result.requeued, failed: result.failed }, { requeued: 1, failed: 0 });

    const rows = readCards(dir).value.cards;
    const terminal = rows.filter((entry) => entry.status === "failed");
    const live = rows.filter((entry) => entry.status === "pending");
    assert.equal(terminal.length, 1, "the failed history row stays failed");
    assert.equal(terminal[0].attempts, 1, "and is not counted again");
    assert.equal(live.length, 1);
    assert.equal(live[0].attempts, 1, "only the live row was requeued");
  });

  it("does not rewrite a terminal row when a later handoff completes", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    const [first] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    completeCards(dir, [first.id], { now: "2026-01-01T00:00:00.000Z" });

    enqueueCard(dir, card("T-1"));
    const [second] = claimCards(dir, { claimedBy: "/work/app", limit: 1 }).cards;
    completeCards(dir, [second.id], { now: "2026-01-02T00:00:00.000Z" });

    const [oldRow, newRow] = readCards(dir).value.cards;
    assert.equal(oldRow.completedAt, "2026-01-01T00:00:00.000Z", "the first completion is history");
    assert.equal(newRow.completedAt, "2026-01-02T00:00:00.000Z");
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

  // TP-0031: a SIGKILLed pool leaves a processing row whose agent child still
  // runs. The ledger proves the subagent is working and the session record still
  // names its process; requeueing would put a second worker on the card. The
  // claim moves to the new pool instead — no queue field is added for it.
  it("repoints a row owned by a live ledger subagent and session pid", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    claimCards(dir, { claimedBy: "/work/app", pid: 999999, limit: 1 });
    writeFileSync(
      join(dir, "sessions.state.json"),
      JSON.stringify({
        version: 3,
        projects: {
          "/work/app": { pid: process.pid, cwd: "/work/app", sessionId: "sid-live" },
        },
      }),
    );
    writeFileSync(
      join(dir, "subagents.state.json"),
      JSON.stringify({
        version: 1,
        subagents: [
          {
            sessionKey: "/work/app",
            card: "T-1",
            role: "worker",
            queueId: "T-1-worker",
            status: "running",
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const result = recoverStaleCards(dir, {
      isAlive: (pid) => pid === process.pid,
      maxAttempts: 3,
      poolPid: 4242,
    });
    assert.equal(result.recovered, 0, "a live orphan keeps its claim");
    assert.equal(result.reowned, 1, "the claim is re-pointed at the new pool");
    const [row] = readCards(dir).value.cards;
    assert.equal(row.status, "processing");
    assert.equal(row.claimedByPid, 4242);
  });

  it("recovers the row once the session pid is gone, even if the ledger row is live", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    claimCards(dir, { claimedBy: "/work/app", pid: 999999, limit: 1 });
    writeFileSync(
      join(dir, "sessions.state.json"),
      JSON.stringify({
        version: 3,
        projects: { "/work/app": { pid: 999998, cwd: "/work/app", sessionId: "sid-dead" } },
      }),
    );
    writeFileSync(
      join(dir, "subagents.state.json"),
      JSON.stringify({
        version: 1,
        subagents: [
          {
            sessionKey: "/work/app",
            card: "T-1",
            role: "worker",
            queueId: "T-1-worker",
            status: "running",
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const result = recoverStaleCards(dir, {
      isAlive: (pid) => pid === process.pid,
      maxAttempts: 3,
      poolPid: 4242,
    });
    assert.deepEqual({ recovered: result.recovered, reowned: result.reowned }, { recovered: 1, reowned: 0 });
    assert.equal(readCards(dir).value.cards[0].status, "pending");
  });

  it("repoints to the current process by default", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    claimCards(dir, { claimedBy: "/work/app", pid: 999999, limit: 1 });
    writeFileSync(
      join(dir, "sessions.state.json"),
      JSON.stringify({ version: 3, projects: { "/work/app": { pid: process.pid, cwd: "/work/app" } } }),
    );
    writeFileSync(
      join(dir, "subagents.state.json"),
      JSON.stringify({
        version: 1,
        subagents: [{ card: "T-1", role: "worker", status: "running" }],
      }),
    );
    recoverStaleCards(dir, { isAlive: (pid) => pid === process.pid });
    assert.equal(readCards(dir).value.cards[0].claimedByPid, process.pid);
  });

  it("retires a legacy dispatched row to done", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    const file = join(dir, "cards.queue.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.cards[0].status = "dispatched";
    writeFileSync(file, JSON.stringify(value), "utf8");

    const retired = retireLegacyDispatched(dir);
    assert.equal(retired.retired, 1);
    const [row] = readCards(dir).value.cards;
    assert.equal(row.status, "done");
    assert.equal(row.lastError, "background dispatch retired");
    assert.ok(Number.isFinite(Date.parse(row.completedAt)), "a completed row carries its timestamp");

    const pruned = pruneCards(dir, { ttlMs: 0, now: Date.parse(row.completedAt) + 1 });
    assert.equal(pruned.dropped, 1, "the converted row is terminal and can be pruned");
  });

  it("leaves pending and processing rows alone when retiring", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, card("T-1"));
    enqueueCard(dir, card("T-2"));
    claimCards(dir, { claimedBy: "/work/app", limit: 1 });
    const retired = retireLegacyDispatched(dir);
    assert.equal(retired.retired, 0);
    const statuses = readCards(dir).value.cards.map((row) => row.status).sort();
    assert.deepEqual(statuses, ["pending", "processing"]);
  });
});

describe("card queue timeouts", () => {
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");
  const MINUTE = 60_000;

  function claimedCard(dir, ref = "T-1") {
    enqueueCard(dir, { card: ref, role: "worker", agent: "alice", target_dir: "/work/app" });
    const [row] = claimCards(dir, { claimedBy: "/work/app", pid: process.pid, limit: 1 }).cards;
    return row;
  }

  it("counts a timeout separately from attempts and backs off 2/4/8 minutes", (t) => {
    const dir = dirFor(t);
    const row = claimedCard(dir);
    assert.equal(row.attempts, 0);
    assert.equal(row.timeouts, 0);

    const first = timeoutCards(dir, [row.id], { now: NOW, error: "turn timed out after 60000ms" });
    assert.equal(first.ok, true);
    assert.equal(first.requeued, 1);
    assert.equal(first.exhausted, 0);
    assert.equal(first.timeouts[row.id], 1);
    let [live] = readCards(dir).value.cards;
    assert.equal(live.status, "pending");
    assert.equal(live.timeouts, 1);
    assert.equal(live.attempts, 0, "a timeout is not a delivery attempt");
    assert.equal(live.claimedAt, null);
    assert.equal(live.claimedBy, null);
    assert.equal(live.retry_at, new Date(NOW + 2 * MINUTE).toISOString());
    assert.equal(TIMEOUT_BACKOFF_MS[0], 2 * MINUTE);

    claimCards(dir, { claimedBy: "/work/app", pid: process.pid, limit: 1, now: new Date(NOW).toISOString() });
    const second = timeoutCards(dir, [row.id], { now: NOW + 2 * MINUTE });
    [live] = readCards(dir).value.cards;
    assert.equal(second.timeouts[row.id], 2);
    assert.equal(live.timeouts, 2);
    assert.equal(live.attempts, 0);
    assert.equal(live.retry_at, new Date(NOW + 2 * MINUTE + 4 * MINUTE).toISOString());
    assert.equal(TIMEOUT_BACKOFF_MS[1], 4 * MINUTE);
  });

  it("returns exhausted on the third timeout without touching attempts", (t) => {
    const dir = dirFor(t);
    const row = claimedCard(dir);
    const file = join(dir, "cards.queue.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.cards[0].timeouts = 2;
    writeFileSync(file, JSON.stringify(value), "utf8");

    const result = timeoutCards(dir, [row.id], { now: NOW, error: "turn timed out after 60000ms" });
    assert.equal(result.exhausted, 1);
    assert.deepEqual(result.exhaustedIds, [row.id]);
    assert.equal(result.timeouts[row.id], TIMEOUT_MAX_ATTEMPTS);
    const [live] = readCards(dir).value.cards;
    assert.equal(live.timeouts, 3);
    assert.equal(live.attempts, 0);
    assert.equal(live.retry_at, null, "the caller decides the release; the row stays pending");
    assert.equal(live.status, "pending");
  });

  it("leaves pending and terminal rows alone", (t) => {
    const dir = dirFor(t);
    enqueueCard(dir, { card: "T-1", role: "worker", target_dir: "/work/app" });
    const [pending] = readCards(dir).value.cards;
    const result = timeoutCards(dir, [pending.id], { now: NOW });
    assert.equal(result.requeued, 0);
    assert.equal(result.exhausted, 0);
    assert.equal(Number(readCards(dir).value.cards[0].timeouts), 0);

    const claimed = claimedCard(dir, "T-2");
    completeCards(dir, [claimed.id], { status: "done" });
    const done = timeoutCards(dir, [claimed.id], { now: NOW });
    assert.equal(done.requeued, 0);
    assert.equal(done.exhausted, 0);
    assert.equal(Number(readCards(dir).value.cards.find((row) => row.id === claimed.id).timeouts), 0);
  });

  it("refuses under the queue lock", (t) => {
    const dir = dirFor(t);
    const row = claimedCard(dir);
    writeFileSync(
      join(dir, "cards.queue.json.lock"),
      JSON.stringify({ version: 1, pid: process.pid, token: "other-process" }),
    );
    const result = timeoutCards(dir, [row.id], { now: NOW });
    assert.equal(result.ok, false);
    assert.match(result.error, /locked by another loop process/);
  });
});
