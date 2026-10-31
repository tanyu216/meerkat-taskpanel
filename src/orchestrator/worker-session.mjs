/**
 * A card's worker is its own resident conversation.
 *
 * The loop used to wake a project session and let it spawn a worker subagent.
 * That made resume parent-mediated and platform-specific. A worker session is
 * addressed by `worker:<card>:r<round>`, stored in `sessions.state.json`, and
 * resumed by the same top-level session id every actor kind already supports.
 *
 * This module owns the deterministic identity, the open plan
 * (fresh/resume/replay/blocked), the three prompts and the bounded transcript
 * that replay uses when the native session is gone. It writes only the
 * transcript and the retirement of older generations; the pool owns the session
 * state file.
 *
 * Node builtins only; no network, no dependencies.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile, writeJsonFile } from "./queue.mjs";

export const WORKER_KEY_PREFIX = "worker:";
export const WORKER_TRANSCRIPT_MAX_TURNS = 12;
export const WORKER_TRANSCRIPT_MAX_CHARS = 8000;
export const WORKER_TRANSCRIPT_TURN_CHARS = 2000;
export const WORKER_TRANSCRIPT_DIR = "worker-transcripts";

/** A card's session key for one delivery round. */
export function workerKey(card, round) {
  return `${WORKER_KEY_PREFIX}${encodeURIComponent(String(card))}:r${roundOf({ round })}`;
}

/** @param {string} key */
export function isWorkerKey(key) {
  return String(key).startsWith(WORKER_KEY_PREFIX);
}

/** The delivery round a queue row or worker record belongs to. */
export function roundOf(row) {
  const value = Number(row?.round ?? row?.delivery_round ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** A handoff row that runs a card, not a review. */
export function isWorkerHandoff(row) {
  return (
    String(row?.queue_kind ?? "handoff") === "handoff" &&
    String(row?.role ?? "worker") !== "reviewer"
  );
}

/** @param {string} key @returns {{card: string, round: number}|null} */
export function parseWorkerKey(key) {
  const match = /^worker:(.+):r(\d+)$/.exec(String(key));
  if (match === null) return null;
  try {
    return { card: decodeURIComponent(match[1]), round: Number(match[2]) };
  } catch {
    return null;
  }
}

/**
 * What the pool should do with a stored worker record.
 *
 * Order is deliberate: a blocked record never spawns; a changed or recreated
 * worktree is a new generation with a reset transcript; a missing/expired
 * native id is a replay; anything else is a same-session resume.
 *
 * @param {object|null|undefined} stored
 * @param {{targetDir: string, workspaceCreatedAt?: string|null, now: number, maxAgeMs: number}} options
 * @returns {{mode: "fresh"|"resume"|"replay"|"blocked", sessionId?: string|null, generation: number, reason: string, expired?: boolean, worktreeChanged?: boolean, transcriptReset?: boolean}}
 */
export function planWorkerOpen(stored, options = {}) {
  const targetDir = String(options.targetDir ?? "");
  const now = Number(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? 0);
  if (stored === null || stored === undefined) {
    return {
      mode: "fresh",
      generation: 1,
      reason: "no stored worker session",
      transcriptReset: true,
    };
  }
  const generation =
    Number.isInteger(stored.generation) && stored.generation > 0 ? stored.generation : 1;
  if (stored.blocked === true) {
    return { mode: "blocked", generation, reason: String(stored.lastError ?? "worker session blocked") };
  }
  const worktreeChanged =
    (typeof stored.worktree === "string" && stored.worktree !== targetDir) ||
    stored.worktree_gone === true ||
    (typeof stored.workspace_created_at === "string" &&
      typeof options.workspaceCreatedAt === "string" &&
      stored.workspace_created_at !== options.workspaceCreatedAt);
  if (worktreeChanged) {
    return {
      mode: "fresh",
      generation: generation + 1,
      reason: "worktree changed",
      worktreeChanged: true,
      transcriptReset: true,
    };
  }
  if (typeof stored.sessionId !== "string" || stored.sessionId === "") {
    return { mode: "replay", generation, reason: "no native session id" };
  }
  if (stored.needsReplay === true) {
    return { mode: "replay", generation, reason: "native session unavailable" };
  }
  if (maxAgeMs > 0 && typeof stored.startedAt === "string") {
    const age = now - Date.parse(stored.startedAt);
    if (Number.isFinite(age) && age >= maxAgeMs) {
      return { mode: "replay", generation, reason: "session exceeded max age", expired: true };
    }
  }
  return {
    mode: "resume",
    sessionId: stored.sessionId,
    generation,
    reason: "same-round re-dispatch",
  };
}

/** @param {*} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The first turn of a card's own worker session. The handoff is already built
 * in its standalone form; the session wrapper only guards against the old
 * "subagent of the project session" wording.
 */
export function buildWorkerDispatchPrompt(input = {}) {
  return String(input.handoff ?? "").trim();
}

/**
 * A same-round re-dispatch: the worker already has context, so the prompt
 * carries the answer/decision and forbids starting over.
 */
export function buildWorkerResumePrompt(input = {}) {
  const row = input.row ?? {};
  const ref = String(row.card ?? "<card>");
  const round = roundOf(row);
  const answer =
    clip(input.answer, 2000).trim() ||
    "(no answer text recorded — read the card comments newer than your question)";
  return [
    `This is a same-round resume of the worker session for card ${ref} (round ${round}).`,
    `Reason: ${String(input.reason ?? "same-round re-dispatch")}.`,
    ...(input.sessionId ? [`Resume native session ${input.sessionId}.`] : []),
    "",
    "The answer/decision since your last turn:",
    answer,
    "",
    `Re-read .meerkat/${ref}/card.md and the comments after your question before acting.`,
    "Continue the work you already started; do not start over, and do not repeat completed work.",
    "",
    String(input.handoff ?? "").trim(),
  ].join("\n");
}

/**
 * The native session is gone. Start fresh, replay the bounded transcript, and
 * verify the tree/board before repeating anything.
 */
export function buildWorkerReplayPrompt(input = {}) {
  const row = input.row ?? {};
  const ref = String(row.card ?? "<card>");
  const round = roundOf(row);
  const transcript =
    typeof input.transcript === "string" ? input.transcript : renderReplay(input.transcript);
  const answer = clip(input.answer, 2000).trim() || "(none recorded)";
  return [
    `The native session for card ${ref} (round ${round}) could not be resumed: ${String(
      input.nativeError ?? input.reason ?? "session unavailable",
    )}.`,
    "This is a NEW session; the bounded transcript of the previous worker follows.",
    "",
    "Previous transcript:",
    clip(transcript, WORKER_TRANSCRIPT_MAX_CHARS).trim() || "(no transcript recorded)",
    "",
    "The answer/decision since the last turn:",
    answer,
    "",
    `Before acting, verify the worktree and the board: re-read .meerkat/${ref}/card.md, check git status/log and the card comments. Do not repeat work that is already done.`,
    "",
    String(input.handoff ?? "").trim(),
  ].join("\n");
}

/** @param {string} stateDir @param {string} key */
export function transcriptFile(stateDir, key) {
  const digest = createHash("sha256").update(String(key)).digest("hex");
  return join(String(stateDir), WORKER_TRANSCRIPT_DIR, `${digest}.json`);
}

/** @param {string} stateDir @param {string} key */
export function readWorkerTranscript(stateDir, key) {
  const file = transcriptFile(stateDir, key);
  const read = readJsonFile(file, { version: 1, turns: [] });
  if (read.error !== null) return { version: 1, turns: [], error: read.error, file };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  const turns = Array.isArray(value.turns)
    ? value.turns.filter((turn) => turn !== null && typeof turn === "object")
    : [];
  return { version: 1, turns, error: null, file };
}

/** Append one bounded turn; older turns are dropped to keep replay cheap. */
export function appendWorkerTurn(stateDir, key, turn = {}) {
  const read = readWorkerTranscript(stateDir, key);
  const turns = [
    ...read.turns,
    {
      at: String(turn.at ?? new Date().toISOString()),
      kind: String(turn.kind ?? "note"),
      text: clip(turn.text, WORKER_TRANSCRIPT_TURN_CHARS),
    },
  ];
  while (turns.length > WORKER_TRANSCRIPT_MAX_TURNS) turns.shift();
  while (
    turns.reduce((sum, entry) => sum + String(entry.text ?? "").length, 0) >
    WORKER_TRANSCRIPT_MAX_CHARS
  ) {
    turns.shift();
  }
  const written = writeJsonFile(transcriptFile(stateDir, key), { version: 1, turns });
  return { ok: written.ok, turns, error: written.error };
}

/** Render a stored transcript as the bounded replay block. */
export function renderReplay(transcript) {
  const turns = Array.isArray(transcript)
    ? transcript
    : Array.isArray(transcript?.turns)
      ? transcript.turns
      : [];
  const text = turns
    .map((turn) => `[${String(turn.kind ?? "note")}] ${String(turn.text ?? "")}`)
    .join("\n");
  return text.length > WORKER_TRANSCRIPT_MAX_CHARS
    ? text.slice(-WORKER_TRANSCRIPT_MAX_CHARS)
    : text;
}

/** Read the `worker:` records from `sessions.state.json` without touching lanes. */
export function readWorkerSessions(stateDir) {
  const file = join(String(stateDir), "sessions.state.json");
  const read = readJsonFile(file, { version: 1, projects: {} });
  if (read.error !== null) return { version: 1, workers: {}, error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  const projects =
    value.projects !== null && typeof value.projects === "object" ? value.projects : {};
  const workers = {};
  for (const [key, record] of Object.entries(projects)) {
    if (isWorkerKey(key)) workers[key] = record;
  }
  return { version: Number(value.version ?? 1), workers, error: null };
}

/**
 * Drop worker records (and transcripts) from earlier rounds of one card. A
 * round bump is a new generation; the old conversation must not be resumed.
 */
export function retireWorkerGenerations(stateDir, card, keepRound) {
  const file = join(String(stateDir), "sessions.state.json");
  const read = readJsonFile(file, { version: 1, control: null, projects: {} });
  if (read.error !== null) return { removed: [], error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  const projects =
    value.projects !== null && typeof value.projects === "object" ? { ...value.projects } : {};
  const prefix = `${WORKER_KEY_PREFIX}${encodeURIComponent(String(card))}:r`;
  const removed = [];
  for (const key of Object.keys(projects)) {
    if (!key.startsWith(prefix)) continue;
    const parsed = parseWorkerKey(key);
    if (parsed === null || parsed.round >= Number(keepRound)) continue;
    delete projects[key];
    removed.push(key);
    try {
      rmSync(transcriptFile(stateDir, key), { force: true });
    } catch {
      // The transcript is best-effort state; a failed unlink must not block.
    }
  }
  if (removed.length === 0) return { removed, error: null };
  const written = writeJsonFile(file, { ...value, projects });
  return { removed, error: written.ok ? null : written.error };
}
