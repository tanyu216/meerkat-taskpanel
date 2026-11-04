/**
 * The worker session's identity, open plan, prompts and bounded transcript.
 *
 * These are the pieces the pool uses to resume a card's own conversation:
 * `worker:<card>:r<round>` is the deterministic key, `planWorkerOpen` decides
 * fresh/resume/replay/blocked, and the transcript is the replay source when the
 * native session is gone.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  WORKER_TRANSCRIPT_MAX_CHARS,
  WORKER_TRANSCRIPT_MAX_TURNS,
  appendWorkerTurn,
  buildWorkerDispatchPrompt,
  buildWorkerReplayPrompt,
  buildWorkerResumePrompt,
  buildWorkerReworkPrompt,
  copyWorkerTranscript,
  dropOlderWorkerRecords,
  isReworkDispatch,
  isWorkerHandoff,
  isWorkerKey,
  moveWorkerTranscript,
  planWorkerCarry,
  planWorkerOpen,
  readWorkerTranscript,
  renderReplay,
  retireWorkerGenerations,
  reworkRoundOf,
  roundOf,
  sessionResetRequested,
  transcriptFile,
  workerKey,
  workerRecordIsRunning,
} from "../../src/orchestrator/worker-session.mjs";

const row = {
  card: "TP-1",
  round: 2,
  worker_key: workerKey("TP-1", 2),
  target_dir: "/work/tp-1-r2",
  project: "PROJ",
};
const handoff =
  "You are the worker for the PROJ project — one card: TP-1. This is the card's own worker session; the loop holds its claim. Heartbeat it to keep the claim.";

describe("worker session identity", () => {
  it("keys a card+round deterministically and encodes the card", () => {
    assert.equal(workerKey("TP-1", 2), workerKey("TP-1", 2));
    assert.notEqual(workerKey("TP-1", 2), workerKey("TP-1", 3));
    assert.equal(isWorkerKey(workerKey("TP-1", 2)), true);
    assert.equal(isWorkerKey("/work/tp-1"), false);
    assert.equal(workerKey("A/B", 1), "worker:A%2FB:r1");
  });

  it("reads the round and identifies a worker handoff", () => {
    assert.equal(roundOf({ round: 2 }), 2);
    assert.equal(roundOf({ delivery_round: 3 }), 3);
    assert.equal(roundOf({}), 1);
    assert.equal(roundOf({ round: 0 }), 1);
    assert.equal(isWorkerHandoff({ role: "worker" }), true);
    assert.equal(isWorkerHandoff({}), true);
    assert.equal(isWorkerHandoff({ role: "reviewer" }), false);
    assert.equal(isWorkerHandoff({ queue_kind: "question" }), false);
    assert.equal(isWorkerHandoff({ queue_kind: "handoff", role: "worker" }), true);
  });
});

describe("planWorkerOpen", () => {
  const base = {
    worktree: "/work/tp-1-r2",
    sessionId: "sid-1",
    generation: 1,
    startedAt: new Date().toISOString(),
  };

  it("starts fresh with no record", () => {
    const plan = planWorkerOpen(null, { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 1_000 });
    assert.equal(plan.mode, "fresh");
    assert.equal(plan.generation, 1);
    assert.equal(plan.transcriptReset, true);
  });

  it("resumes the same round and worktree", () => {
    const plan = planWorkerOpen(base, {
      targetDir: "/work/tp-1-r2",
      now: Date.now(),
      maxAgeMs: 86_400_000,
    });
    assert.equal(plan.mode, "resume");
    assert.equal(plan.sessionId, "sid-1");
    assert.equal(plan.generation, 1);
  });

  it("starts fresh when the worktree changed", () => {
    const plan = planWorkerOpen(base, {
      targetDir: "/work/tp-1-r2-new",
      now: Date.now(),
      maxAgeMs: 86_400_000,
    });
    assert.equal(plan.mode, "fresh");
    assert.equal(plan.generation, 2);
    assert.equal(plan.worktreeChanged, true);
    assert.equal(plan.transcriptReset, true);
  });

  it("starts fresh when the worktree was recreated", () => {
    const stored = { ...base, workspace_created_at: "2026-01-01T00:00:00.000Z" };
    const plan = planWorkerOpen(stored, {
      targetDir: "/work/tp-1-r2",
      workspaceCreatedAt: "2026-01-02T00:00:00.000Z",
      now: Date.now(),
      maxAgeMs: 86_400_000,
    });
    assert.equal(plan.mode, "fresh");
    assert.equal(plan.worktreeChanged, true);
    assert.equal(plan.transcriptReset, true);
  });

  it("starts fresh when the worktree is gone", () => {
    const plan = planWorkerOpen(
      { ...base, worktree_gone: true },
      { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 86_400_000 },
    );
    assert.equal(plan.mode, "fresh");
    assert.equal(plan.transcriptReset, true);
  });

  it("replays when the native session is gone, flagged, or expired", () => {
    const noId = planWorkerOpen(
      { ...base, sessionId: null },
      { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 86_400_000 },
    );
    assert.equal(noId.mode, "replay");

    const needs = planWorkerOpen(
      { ...base, needsReplay: true },
      { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 86_400_000 },
    );
    assert.equal(needs.mode, "replay");

    const expired = planWorkerOpen(
      { ...base, startedAt: new Date(0).toISOString() },
      { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 1_000 },
    );
    assert.equal(expired.mode, "replay");
    assert.equal(expired.expired, true);
  });

  it("blocks a blocked record instead of spawning", () => {
    const plan = planWorkerOpen(
      { ...base, blocked: true, lastError: "replay failed" },
      { targetDir: "/work/tp-1-r2", now: Date.now(), maxAgeMs: 86_400_000 },
    );
    assert.equal(plan.mode, "blocked");
    assert.match(plan.reason, /replay failed/);
  });
});

describe("worker prompts", () => {
  it("dispatches the standalone handoff", () => {
    const prompt = buildWorkerDispatchPrompt({ row, handoff });
    assert.match(prompt, /You are the worker for the PROJ project/);
    assert.doesNotMatch(prompt, /subagent of the project session/);
    assert.match(prompt, /TP-1/);
  });

  it("resumes with the answer and forbids starting over", () => {
    const prompt = buildWorkerResumePrompt({
      row,
      handoff,
      reason: "same-round re-dispatch",
      answer: "[human] keep the API stable",
      sessionId: "sid-1",
    });
    assert.match(prompt, /same-round/);
    assert.match(prompt, /keep the API stable/);
    assert.match(prompt, /re-read/i);
    assert.match(prompt, /do not start over/i);
    assert.match(prompt, /heartbeat/i);
  });

  it("replays a bounded transcript in a new session", () => {
    const prompt = buildWorkerReplayPrompt({
      row,
      handoff,
      reason: "native resume failed",
      answer: "[human] continue",
      transcript: "user: did A\nassistant: did B",
      nativeError: "session not found",
    });
    assert.match(prompt, /could not be resumed/i);
    assert.match(prompt, /session not found/);
    assert.match(prompt, /did A/);
    assert.match(prompt, /do not repeat/i);
    assert.ok(prompt.length < 20_000);
  });
});

describe("worker transcript", () => {
  it("bounds turns and characters and survives corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-session-"));
    try {
      const key = workerKey("TP-1", 1);
      for (let index = 0; index < 40; index += 1) {
        appendWorkerTurn(dir, key, { kind: "note", text: `turn ${index} ${"x".repeat(500)}` });
      }
      const read = readWorkerTranscript(dir, key);
      assert.ok(read.turns.length <= WORKER_TRANSCRIPT_MAX_TURNS);
      const total = read.turns.reduce((sum, turn) => sum + String(turn.text).length, 0);
      assert.ok(total <= WORKER_TRANSCRIPT_MAX_CHARS);
      assert.match(renderReplay(read), /turn 39/);

      writeFileSync(transcriptFile(dir, key), "{not json", "utf8");
      const corrupt = readWorkerTranscript(dir, key);
      assert.deepEqual(corrupt.turns, []);
      assert.ok(corrupt.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retires older rounds and keeps lanes", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-session-"));
    try {
      const old = workerKey("TP-1", 1);
      const keep = workerKey("TP-1", 2);
      appendWorkerTurn(dir, old, { kind: "note", text: "old" });
      appendWorkerTurn(dir, keep, { kind: "note", text: "keep" });
      writeFileSync(
        join(dir, "sessions.state.json"),
        JSON.stringify({
          version: 3,
          projects: {
            [old]: { sessionId: "a" },
            [keep]: { sessionId: "b" },
            "/work/x": { sessionId: "c" },
          },
        }),
      );
      const result = retireWorkerGenerations(dir, "TP-1", 2);
      assert.deepEqual(result.removed, [old]);
      const state = JSON.parse(readFileSync(join(dir, "sessions.state.json"), "utf8"));
      assert.equal(state.projects[old], undefined);
      assert.equal(state.projects[keep].sessionId, "b");
      assert.equal(state.projects["/work/x"].sessionId, "c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rework continuity", () => {
  it("recognises the rework round a reject wrote and nothing else", () => {
    assert.equal(reworkRoundOf({ meta: { rework_round: "2" } }), 2);
    assert.equal(reworkRoundOf({ meta: {} }), null);
    assert.equal(reworkRoundOf({ meta: { rework_round: "nope" } }), null);
    assert.equal(
      isReworkDispatch({ delivery_round: 2, meta: { rework_round: "2" } }),
      true,
    );
    assert.equal(
      isReworkDispatch({ delivery_round: 1, meta: { rework_round: "1" } }),
      false,
      "round 1 is never a rework",
    );
    assert.equal(
      isReworkDispatch({ delivery_round: 2, meta: { rework_round: "1" } }),
      false,
      "a marker for another round is not this pass",
    );
    assert.equal(isReworkDispatch({ delivery_round: 2 }), false, "no marker, no carry");
  });

  it("reads the one-shot session reset as an explicit yes only", () => {
    assert.equal(sessionResetRequested({ meta: { session_reset: "yes" } }), true);
    assert.equal(sessionResetRequested({ meta: { session_reset: "YES" } }), true);
    assert.equal(sessionResetRequested({ meta: { session_reset: "no" } }), false);
    assert.equal(sessionResetRequested({ meta: {} }), false);
  });

  it("carries only the same card, agent, kind and worktree", () => {
    const previous = {
      card: "TP-1",
      agent: "Linus",
      actorKind: "claude",
      worktree: "/work/tp-1",
      workspace_created_at: "2026-01-01T00:00:00.000Z",
    };
    const good = {
      card: "TP-1",
      agent: "linus",
      actorKind: "claude",
      worktree: "/work/tp-1",
      workspaceCreatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(planWorkerCarry(previous, good).ok, true);
    assert.equal(planWorkerCarry(previous, { ...good, card: "TP-2" }).ok, false);
    assert.equal(planWorkerCarry(previous, { ...good, agent: "Turing" }).ok, false);
    assert.equal(planWorkerCarry(previous, { ...good, actorKind: "codex" }).ok, false);
    assert.equal(planWorkerCarry(previous, { ...good, worktree: "/work/other" }).ok, false);
    assert.equal(
      planWorkerCarry(previous, { ...good, workspaceCreatedAt: "2026-02-01T00:00:00.000Z" }).ok,
      false,
      "a recreated workspace is a new conversation",
    );
    assert.equal(planWorkerCarry({ ...previous, blocked: true }, good).ok, false);
    assert.equal(planWorkerCarry({ ...previous, worktree_gone: true }, good).ok, false);
    assert.equal(planWorkerCarry(null, good).ok, false);
  });

  it("writes a delta rework prompt that names the rejected round", () => {
    const prompt = buildWorkerReworkPrompt({
      row: { card: "TP-1", round: 3 },
      carryFromRound: 2,
      handoff,
    });
    assert.match(prompt, /rework round 3/i);
    assert.match(prompt, /round 2 was rejected/i);
    assert.match(prompt, /do not start over/i);
    assert.match(prompt, /must-fix/i);
    assert.match(prompt, /new report/i);
    assert.match(prompt, /You are the worker for the PROJ project/);
  });

  it("adds the rework note to a replay prompt", () => {
    const plain = buildWorkerReplayPrompt({ row, transcript: "x", rework: false });
    const rework = buildWorkerReplayPrompt({ row, transcript: "x", rework: true });
    assert.doesNotMatch(plain, /rework round/i);
    assert.match(rework, /rework round 2/i);
    assert.match(rework, /must-fix/i);
  });

  it("moves, copies and drops transcripts with the records", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-session-"));
    try {
      const old = workerKey("TP-1", 1);
      const next = workerKey("TP-1", 2);
      appendWorkerTurn(dir, old, { kind: "note", text: "old turn" });
      assert.equal(moveWorkerTranscript(dir, old, next).moved, true);
      assert.deepEqual(readWorkerTranscript(dir, next).turns.map((t) => t.text), ["old turn"]);
      assert.deepEqual(readWorkerTranscript(dir, old).turns, []);

      const copySource = workerKey("TP-2", 1);
      const copyTarget = workerKey("TP-2", 2);
      appendWorkerTurn(dir, copySource, { kind: "note", text: "copy me" });
      assert.equal(copyWorkerTranscript(dir, copySource, copyTarget).copied, true);
      assert.deepEqual(readWorkerTranscript(dir, copyTarget).turns.map((t) => t.text), ["copy me"]);
      assert.deepEqual(readWorkerTranscript(dir, copySource).turns.map((t) => t.text), ["copy me"]);

      const projects = {
        [workerKey("TP-1", 1)]: { card: "TP-1" },
        [workerKey("TP-1", 2)]: { card: "TP-1" },
        [workerKey("TP-2", 1)]: { card: "TP-2" },
      };
      const dropped = dropOlderWorkerRecords(dir, projects, "TP-1", 2);
      assert.deepEqual(dropped.removed, [workerKey("TP-1", 1)]);
      assert.equal(projects[workerKey("TP-1", 1)], undefined);
      assert.ok(projects[workerKey("TP-1", 2)], "the current round is kept");
      assert.ok(projects[workerKey("TP-2", 1)], "another card's record is kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker record liveness", () => {
  it("treats a closed record as not running even when its old status says running", () => {
    assert.equal(workerRecordIsRunning({ status: "running" }), true);
    assert.equal(
      workerRecordIsRunning({ status: "running", closedAt: "2026-01-01T00:00:00.000Z" }),
      false,
      "closeEntry stamps closedAt; the mid-turn status must not keep the card claimed",
    );
    assert.equal(workerRecordIsRunning({ status: "idle" }), false);
    assert.equal(workerRecordIsRunning(null), false);
  });
});
