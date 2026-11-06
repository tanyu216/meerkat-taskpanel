/**
 * Claude Code's resident session adapter.
 *
 * One `claude -p --input-format stream-json --output-format stream-json` process
 * owns one conversation. The process stays alive between turns; `send()` writes
 * one user message and waits for that turn's `result` event. A card session is
 * opened with `cwd = target_dir`, so the card's work happens in its own
 * worktree and nothing is spawned from inside the session.
 *
 * The adapter never uses `--bare`: it would skip skill discovery, including the
 * model-invocable `meerkat-chat` console a human uses.
 */

import { spawn } from "node:child_process";

import { claudeAllowedTools } from "../../foundation/role-tools.mjs";
import { lineSplitter, writeJsonLine } from "../kind-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The tool surface a role gets when full access is not enabled. The operator
 * can enable `--allow-all-tools`, which replaces this with bypassPermissions.
 *
 * @param {string} role
 */
export function allowedToolsFor(role) {
  // A card session owns its whole card: nothing spawns a subagent, so no role
  // carries `Agent`/`Task`. The table lives once in foundation so the installer
  // renders the same surface (`src/foundation/role-tools.mjs`).
  return claudeAllowedTools(String(role ?? "worker"));
}

/**
 * The argv for one Claude resident session.
 *
 * @param {{opts: object, sessionId?: string|null, role?: string, systemPrompt?: string|null}} input
 * @returns {string[]}
 */
export function sessionArgs(input) {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (input.opts?.allowAllTools === true) {
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", "dontAsk");
    const tools = allowedToolsFor(String(input.role ?? "worker"));
    if (tools !== "") args.push("--allowedTools", tools);
  }
  if (input.sessionId !== undefined && input.sessionId !== null && input.sessionId !== "") {
    args.push("--resume", String(input.sessionId));
  }
  // The card's context is a system prompt from the first turn, so a lost opener
  // turn cannot leave the agent without the card, plan, flags or board rules.
  if (typeof input.systemPrompt === "string" && input.systemPrompt !== "") {
    args.push("--append-system-prompt", input.systemPrompt);
  }
  return args;
}

/** @param {object} event */
function assistantText(event) {
  const content = event?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Poll a predicate without a dependency. */
function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

class ClaudeSession {
  /**
   * @param {{opts: object, cwd: string, sessionId?: string|null, role?: string,
   *   systemPrompt?: string|null, bin?: string, log: (line: string) => void,
   *   onEvent?: (event: object) => void}} input
   */
  constructor(input) {
    this.opts = input.opts;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.resumeId = input.sessionId ?? null;
    this.sawResult = false;
    this.resumeMismatch = false;
    this.log = input.log;
    this.onEvent = input.onEvent ?? null;
    this.closed = false;
    this.current = null;
    // The session's own kind environment: its shim directory leads PATH and
    // TASKCTL_ACTOR_KIND is pinned, so a codex worker spawned by a claude
    // supervisor still writes as codex.
    this.child = spawn(input.bin ?? "claude", sessionArgs(input), {
      cwd: this.cwd,
      env: { ...(input.env ?? process.env), TP_NODE: process.execPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", lineSplitter((line) => this.handleLine(line)));
    this.child.stderr.on("data", lineSplitter((line) => this.log(`claude[${this.cwd}] ${line}`)));
    // A child that exits between the turn starting and the prompt write makes
    // the stdin socket emit EPIPE. Without a listener that is an uncaught
    // exception that takes the pool down; it is this turn's failure instead.
    this.child.stdin.on("error", (err) => {
      this.log(`claude[${this.cwd}] stdin error: ${err.message}`);
      this.finish({ ok: false, error: `session stdin closed: ${err.message}` });
    });
    this.child.on("error", (err) => {
      this.log(`claude[${this.cwd}] spawn error: ${err.message}`, {
        level: "error",
        event: "turn_spawn_failed",
      });
      this.finish({
        ok: false,
        resumeFailed: this.resumeId !== null && !this.sawResult,
        error: `spawn error: ${err.message}`,
      });
      this.closed = true;
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.finish({
        ok: false,
        resumeFailed: this.resumeId !== null && !this.sawResult,
        error: `claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
    });
  }

  get pid() {
    return this.child.pid ?? null;
  }

  /** @param {string} line */
  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.log(`claude[${this.cwd}] non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof event?.session_id === "string" && event.session_id !== "") {
      this.sessionId = event.session_id;
      if (this.resumeId !== null && this.sessionId !== this.resumeId) this.resumeMismatch = true;
    }
    if (event.type === "system" && event.subtype === "init") {
      this.onEvent?.({ type: "init", sessionId: this.sessionId, cwd: this.cwd });
      return;
    }
    if (event.type === "assistant") {
      this.onEvent?.({
        type: "assistant",
        sessionId: this.sessionId,
        text: assistantText(event).slice(0, 500),
      });
      return;
    }
    if (event.type === "user") {
      // Tool results live in user messages; no card session spawns an agent, so
      // there is no handle to collect.
      return;
    }
    if (event.type === "result") {
      this.sawResult = true;
      this.onEvent?.({ type: "result", sessionId: this.sessionId, result: event });
      this.finish({
        ok: event.is_error !== true,
        result: event.result ?? null,
        error: event.is_error === true ? String(event.subtype ?? "error") : null,
      });
      return;
    }
    this.onEvent?.({
      type: "event",
      sessionId: this.sessionId,
      eventType: event.type ?? "unknown",
      subtype: event.subtype ?? null,
    });
  }

  /** Resolve the in-flight turn exactly once. */
  finish(outcome) {
    if (this.current === null) return;
    const current = this.current;
    this.current = null;
    clearTimeout(current.timer);
    current.resolve({
      ...outcome,
      resumeFailed: outcome.resumeFailed === true || this.resumeMismatch === true,
      sessionId: this.sessionId,
      cwd: this.cwd,
    });
  }

  /**
   * Send one user message and wait for its `result`.
   *
   * @param {string} prompt
   * @param {{timeoutMs?: number}} [options]
   */
  send(prompt, options = {}) {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: "session is closed", sessionId: this.sessionId, cwd: this.cwd });
    }
    if (this.current !== null) {
      return Promise.resolve({ ok: false, error: "a turn is already in flight", sessionId: this.sessionId, cwd: this.cwd });
    }
    const timeoutMs = Number(options.timeoutMs ?? this.opts?.sessionTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    this.sawResult = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish({ ok: false, error: `turn timed out after ${timeoutMs}ms` });
        this.interrupt().catch(() => {});
      }, Math.max(1, timeoutMs));
      this.current = { resolve, timer };
      try {
        writeJsonLine(this.child.stdin, {
          type: "user",
          message: { role: "user", content: String(prompt) },
          parent_tool_use_id: null,
        });
      } catch (err) {
        this.finish({ ok: false, error: `session stdin closed: ${err?.message ?? String(err)}` });
      }
    });
  }

  /** Ask the turn to stop; escalate to SIGTERM if it does not. */
  async interrupt() {
    if (this.closed || this.child.exitCode !== null) return;
    try {
      this.child.kill("SIGINT");
    } catch {
      // Already gone.
    }
    const finished = await waitFor(() => this.current === null || this.closed, 10_000);
    if (!finished && !this.closed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  /** Close stdin and wait for a clean exit, then hard-stop. */
  async close() {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    const exited = await waitFor(() => this.closed, 5_000);
    if (!exited && !this.closed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await waitFor(() => this.closed, 2_000);
    }
  }
}

/**
 * @param {{opts: object, log: (line: string) => void, bin?: string, onEvent?: (event: object) => void}} input
 */
export function createClaudePool(input) {
  const sessions = new Set();
  return {
    actorKind: "claude",
    /**
     * @param {{cwd: string, sessionId?: string|null, role?: string, systemPrompt?: string|null}} options
     */
    openSession(options) {
      const session = new ClaudeSession({
        opts: input.opts ?? {},
        cwd: options.cwd,
        sessionId: options.sessionId ?? null,
        role: options.role ?? "worker",
        systemPrompt: options.systemPrompt ?? null,
        bin: input.bin,
        env: input.env,
        log: input.log,
        onEvent: input.onEvent,
      });
      sessions.add(session);
      return session;
    },
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
    },
    get size() {
      return sessions.size;
    },
  };
}
