/**
 * Pi's resident session adapter.
 *
 * One `pi --mode rpc` process owns one conversation, launched in the session's
 * cwd. The protocol is LF-delimited JSONL: a command carries an `id` and gets a
 * `response`; progress arrives as events (`agent_start`, `message_*`, `turn_end`),
 * and **`agent_settled`** is the turn-finished signal (`agent_end` is the end of
 * an agent run, not of the prompt queue).
 *
 * Resume uses `--session-id <id>`; `get_state` is where the id comes from when Pi
 * created the conversation.
 *
 * Verified against pi 1.0.4 (`--mode rpc`).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { lineSplitter, writeJsonLine } from "../kind-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The argv for one Pi resident session.
 *
 * `--allow-all-tools` adds `--approve` (trust project-local files); Pi has no
 * sandbox of its own, so the process always carries the user's OS permissions.
 * The role allowlist is applied through `--tools` when full access is off.
 *
 * @param {{opts?: object, role?: string, sessionId?: string|null, skillPath?: string|null,
 *   systemPrompt?: string|null}} input
 * @returns {string[]}
 */
export function sessionArgs(input = {}) {
  const args = ["--mode", "rpc"];
  if (input.sessionId !== undefined && input.sessionId !== null && input.sessionId !== "") {
    args.push("--session-id", String(input.sessionId));
  }
  // Pi has no `/<skill>` message expansion. `--append-system-prompt` reads a
  // file when the argument is an existing path, so the role entry becomes part
  // of the system prompt for the life of the process.
  if (typeof input.skillPath === "string" && input.skillPath !== "" && existsSync(input.skillPath)) {
    args.push(
      "--append-system-prompt",
      `Skill directory: ${dirname(input.skillPath)}.\n` +
        "Relative paths in this skill resolve against that directory.",
      "--append-system-prompt",
      input.skillPath,
    );
  }
  // The card's context is a system prompt from the first turn, so a lost opener
  // turn cannot leave the agent without the card, plan, flags or board rules.
  if (typeof input.systemPrompt === "string" && input.systemPrompt !== "") {
    args.push("--append-system-prompt", input.systemPrompt);
  }
  if (input.opts?.allowAllTools === true) {
    args.push("--approve");
  } else {
    const tools = allowedToolsFor(String(input.role ?? "worker"));
    if (tools !== "") args.push("--tools", tools);
  }
  return args;
}

/**
 * The tool surface a role gets when full access is not enabled. A card session
 * owns its whole card, so no role gets a subagent tool.
 *
 * @param {string} role
 * @returns {string}
 */
export function allowedToolsFor(role) {
  switch (role) {
    case "director":
      return "read,bash";
    case "reviewer":
      return "read,bash";
    case "worker":
    default:
      return "read,bash,edit,write";
  }
}

/** The text an assistant message event carries. */
function assistantText(message) {
  if (message?.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

class PiSession {
  /**
   * @param {{opts: object, cwd: string, sessionId?: string|null, role?: string,
   *   skillPath?: string|null, systemPrompt?: string|null, bin?: string,
   *   log: (line: string) => void, onEvent?: (event: object) => void}} input
   */
  constructor(input) {
    this.opts = input.opts;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.resumeId = input.sessionId ?? null;
    this.resumeMismatch = false;
    this.sawSettled = false;
    this.log = input.log;
    this.onEvent = input.onEvent ?? null;
    this.closed = false;
    this.current = null;
    this.text = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(input.bin ?? "pi", sessionArgs(input), {
      cwd: this.cwd,
      env: { ...(input.env ?? process.env), TP_NODE: process.execPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", lineSplitter((line) => this.handleLine(line)));
    this.child.stderr.on("data", lineSplitter((line) => this.log(`pi[${this.cwd}] ${line}`)));
    this.child.on("error", (err) => {
      this.log(`pi[${this.cwd}] spawn error: ${err.message}`, {
        level: "error",
        event: "turn_spawn_failed",
      });
      this.finish({
        ok: false,
        resumeFailed: this.resumeId !== null && !this.sawSettled,
        error: `spawn error: ${err.message}`,
      });
      this.closed = true;
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.finish({
        ok: false,
        resumeFailed: this.resumeId !== null && !this.sawSettled,
        error: `pi exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
    });
    this.fetchState();
  }

  get pid() {
    return this.child.pid ?? null;
  }

  /**
   * Ask Pi for the conversation id it created. A failure is not fatal.
   *
   * The id is learned in `handleLine`, on the response line itself — not in a
   * `.then`. A pipe can deliver that response and `agent_settled` in one chunk,
   * and the adapter reads the lines synchronously; a microtask would run only
   * after the turn had already settled with `sessionId: null`.
   */
  fetchState() {
    this.command("get_state").catch(() => {});
  }

  /** @param {object} data */
  learnSessionId(data) {
    const id = data?.sessionId ?? data?.session_id ?? null;
    if (typeof id !== "string" || id === "" || id === this.sessionId) return;
    this.sessionId = id;
    if (this.resumeId !== null && id !== this.resumeId) this.resumeMismatch = true;
    this.onEvent?.({ type: "init", sessionId: id, cwd: this.cwd });
  }

  /** @param {string} type @param {object} [params] */
  command(type, params = {}) {
    if (this.closed) return Promise.reject(new Error("session is closed"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { type, resolve, reject });
      try {
        writeJsonLine(this.child.stdin, { id, type, ...params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** @param {string} line */
  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.log(`pi[${this.cwd}] non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (event.type === "response" && event.id !== undefined) {
      const entry = this.pending.get(String(event.id));
      if (entry === undefined) return;
      this.pending.delete(String(event.id));
      if (event.success === false) {
        entry.reject(new Error(String(event.error ?? "pi command failed")));
      } else {
        const data = event.data ?? {};
        if (entry.type === "get_state") this.learnSessionId(data);
        entry.resolve(data);
      }
      return;
    }
    // An extension asking for confirmation: approve, so an unattended turn never
    // stalls on a prompt. Pi has no sandbox; this is not a permission boundary.
    if (/extension_ui_request/i.test(String(event.type ?? "")) && event.id !== undefined) {
      try {
        writeJsonLine(this.child.stdin, { type: "extension_ui_response", id: event.id, confirmed: true });
      } catch {
        // The session is going away.
      }
      return;
    }
    if (event.type === "message_end") {
      const text = assistantText(event.message);
      if (text !== "") this.text += text;
      return;
    }
    if (event.type === "agent_settled") {
      this.sawSettled = true;
      this.finish({ ok: true, result: this.text });
      return;
    }
    this.onEvent?.({
      type: "event",
      sessionId: this.sessionId,
      eventType: event.type ?? "unknown",
    });
  }

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
   * @param {string} prompt
   * @param {{timeoutMs?: number}} [options]
   */
  async send(prompt, options = {}) {
    if (this.closed) return { ok: false, error: "session is closed", sessionId: this.sessionId, cwd: this.cwd };
    if (this.current !== null) {
      return { ok: false, error: "a turn is already in flight", sessionId: this.sessionId, cwd: this.cwd };
    }
    const timeoutMs = Number(options.timeoutMs ?? this.opts?.sessionTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    this.text = "";
    this.sawSettled = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish({ ok: false, error: `turn timed out after ${timeoutMs}ms` });
        this.interrupt().catch(() => {});
      }, Math.max(1, timeoutMs));
      this.current = { resolve, timer };
      this.command("prompt", { message: String(prompt) }).catch((err) => {
        this.finish({ ok: false, error: err.message });
      });
    });
  }

  async interrupt() {
    if (this.closed) return;
    try {
      await this.command("abort");
    } catch {
      // Already settled.
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.finish({ ok: false, error: "session is closed" });
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/**
 * @param {{opts: object, log: (line: string) => void, bin?: string,
 *   onEvent?: (event: object) => void, home?: string}} input
 */
export function createPiPool(input) {
  const sessions = new Set();
  return {
    actorKind: "pi",
    openSession(options) {
      const session = new PiSession({
        opts: input.opts ?? {},
        cwd: options.cwd,
        sessionId: options.sessionId ?? null,
        role: options.role ?? "worker",
        skillPath: options.skillPath ?? null,
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
