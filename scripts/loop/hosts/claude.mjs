/**
 * Claude Code's resident session adapter.
 *
 * One `claude -p --input-format stream-json --output-format stream-json` process
 * owns one conversation. The process stays alive between turns; `send()` writes
 * one user message and waits for that turn's `result` event. A project session
 * is opened with `cwd = target_dir`, so the worker/reviewer subagents it spawns
 * inherit the project directory.
 *
 * The adapter never uses `--bare`: it would skip skill discovery, including the
 * command-only `meerkat-loop` skill the control session invokes.
 */

import { spawn } from "node:child_process";

import { extractAgentIds } from "../ledger.mjs";
import { lineSplitter, writeJsonLine } from "../host-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The tool surface a role gets when full access is not enabled. The operator
 * can enable `--allow-all-tools`, which replaces this with bypassPermissions.
 *
 * @param {string} role
 */
export function allowedToolsFor(role) {
  switch (role) {
    case "control":
      return "Read,Bash(taskctl *),Bash(node *)";
    case "reviewer":
      return "Read,Grep,Glob,Bash(taskctl *),Bash(git *)";
    case "worker":
    default:
      return "Read,Edit,Write,Grep,Glob,Bash(taskctl *),Bash(node *),Bash(git *)";
  }
}

/**
 * The argv for one Claude resident session.
 *
 * @param {{opts: object, sessionId?: string|null, role?: string}} input
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
   *   bin?: string, log: (line: string) => void, onEvent?: (event: object) => void}} input
   */
  constructor(input) {
    this.opts = input.opts;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.log = input.log;
    this.onEvent = input.onEvent ?? null;
    this.closed = false;
    this.current = null;
    this.turnIds = [];
    this.child = spawn(input.bin ?? "claude", sessionArgs(input), {
      cwd: this.cwd,
      env: { ...process.env, TP_NODE: process.execPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", lineSplitter((line) => this.handleLine(line)));
    this.child.stderr.on("data", lineSplitter((line) => this.log(`claude[${this.cwd}] ${line}`)));
    this.child.on("error", (err) => {
      this.log(`claude[${this.cwd}] spawn error: ${err.message}`);
      this.finish({ ok: false, error: `spawn error: ${err.message}` });
      this.closed = true;
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.finish({ ok: false, error: `claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})` });
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
      // Tool results live in user messages. The Agent tool's result carries
      // `agentId: …`; that is the handle the ledger stores for reattach.
      for (const subagentId of extractAgentIds(JSON.stringify(event.message?.content ?? ""))) {
        if (!this.turnIds.includes(subagentId)) this.turnIds.push(subagentId);
        this.onEvent?.({ type: "subagent", sessionId: this.sessionId, subagentId, phase: "result" });
      }
      return;
    }
    if (event.type === "result") {
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
      sessionId: this.sessionId,
      cwd: this.cwd,
      ids: this.turnIds.slice(),
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
    this.turnIds = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish({ ok: false, error: `turn timed out after ${timeoutMs}ms` });
        this.interrupt().catch(() => {});
      }, Math.max(1, timeoutMs));
      this.current = { resolve, timer };
      writeJsonLine(this.child.stdin, {
        type: "user",
        message: { role: "user", content: String(prompt) },
        parent_tool_use_id: null,
      });
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
    host: "claude",
    /**
     * @param {{cwd: string, sessionId?: string|null, role?: string}} options
     */
    openSession(options) {
      const session = new ClaudeSession({
        opts: input.opts ?? {},
        cwd: options.cwd,
        sessionId: options.sessionId ?? null,
        role: options.role ?? "worker",
        bin: input.bin,
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
