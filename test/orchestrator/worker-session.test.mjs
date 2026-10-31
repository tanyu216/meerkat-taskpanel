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
  isWorkerHandoff,
  isWorkerKey,
  planWorkerOpen,
  readWorkerTranscript,
  renderReplay,
  retireWorkerGenerations,
  roundOf,
  transcriptFile,
  workerKey,
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
