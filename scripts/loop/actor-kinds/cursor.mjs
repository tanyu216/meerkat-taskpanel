/**
 * Cursor's resident session adapter (Agent Client Protocol).
 *
 * One `cursor-agent acp` process serves the pool. A session is
 * `session/new {cwd}` (or `session/load` / `session/resume` with the stored id),
 * and a turn is `session/prompt` — the response's `stopReason` is the
 * completion signal, with `session/update` notifications carrying the stream.
 * The server's `session/request_permission` request is always answered, so an
 * unattended turn never stalls on a prompt.
 *
 * Verified against the published ACP shape, not against a live binary on this
 * host; `scripts/verify/kind-session-matrix.mjs` is the probe. An older CLI
 * without ACP keeps the one-shot path (`cursor-agent -p`) — it cannot run a
 * resident pool.
 */

import { spawn } from "node:child_process";

import { extractAgentIds } from "../ledger.mjs";
import { lineSplitter, writeJsonLine } from "../kind-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** The client capabilities this adapter declares to the agent. */
export const CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
});

/** The allow option a permission request offers; the first one is the fallback. */
export function allowOption(options) {
  const rows = Array.isArray(options) ? options : [];
  const preferred = rows.find((option) => /allow/i.test(String(option?.kind ?? "")));
  const chosen = preferred ?? rows[0] ?? null;
  return chosen === null ? null : String(chosen.optionId ?? chosen.option_id ?? chosen.id ?? "");
}

class CursorSession {
  /**
   * @param {{pool: object, cwd: string, sessionId?: string|null, role?: string}} input
   */
  constructor(input) {
    this.pool = input.pool;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.closed = false;
    this.turnIds = [];
    this.text = "";
    this.current = null;
    this.ready = this.open(input.sessionId ?? null);
  }

  get pid() {
    return this.pool.pid ?? null;
  }

  async open(resumeId) {
    try {
      if (resumeId !== null) {
        try {
          await this.pool.request("session/load", { sessionId: resumeId, cwd: this.cwd, mcpServers: [] });
          this.sessionId = resumeId;
          this.pool.onEvent?.({ type: "init", sessionId: resumeId, cwd: this.cwd });
          return { ok: true };
        } catch {
          // An unknown session id (or a CLI without load): start a new one.
        }
      }
      const result = await this.pool.request("session/new", { cwd: this.cwd, mcpServers: [] });
      this.sessionId = String(result?.sessionId ?? result?.session_id ?? "");
      if (this.sessionId === "") return { ok: false, error: "session/new returned no session id" };
      this.pool.onEvent?.({ type: "init", sessionId: this.sessionId, cwd: this.cwd });
      return { ok: true };
    } catch (err) {
      this.closed = true;
      return { ok: false, error: err.message };
    }
  }

  /** @param {object} update */
  handleUpdate(update) {
    const kind = String(update?.sessionUpdate ?? update?.type ?? "");
    if (kind === "agent_message_chunk") {
      const text = update?.content?.text;
      if (typeof text === "string") this.text += text;
    }
    for (const subagentId of extractAgentIds(JSON.stringify(update ?? {}))) {
      if (!this.turnIds.includes(subagentId)) {
        this.turnIds.push(subagentId);
        this.pool.onEvent?.({ type: "subagent", sessionId: this.sessionId, subagentId, phase: kind });
      }
    }
  }

  finish(outcome) {
    if (this.current === null) return;
    const current = this.current;
    this.current = null;
    clearTimeout(current.timer);
    current.resolve({ ...outcome, sessionId: this.sessionId, cwd: this.cwd, ids: this.turnIds.slice() });
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
    const ready = await this.ready;
    if (ready.ok !== true) {
      this.closed = true;
      return { ok: false, error: ready.error ?? "session could not be opened", sessionId: this.sessionId, cwd: this.cwd };
    }
    const timeoutMs = Number(options.timeoutMs ?? this.pool.opts?.sessionTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    this.turnIds = [];
    this.text = "";
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish({ ok: false, error: `turn timed out after ${timeoutMs}ms` });
        this.interrupt().catch(() => {});
      }, Math.max(1, timeoutMs));
      this.current = { resolve, timer };
      this.pool
        .request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: String(prompt) }],
        })
        .then((result) => {
          const stop = String(result?.stopReason ?? result?.stop_reason ?? "end_turn");
          this.finish({
            ok: stop !== "error" && stop !== "refusal",
            result: this.text,
            error: stop === "error" || stop === "refusal" ? `turn stopped: ${stop}` : null,
          });
        })
        .catch((err) => this.finish({ ok: false, error: err.message }));
    });
  }

  async interrupt() {
    if (this.closed || this.sessionId === null) return;
    try {
      await this.pool.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      // Already settled.
    }
  }

  async close() {
    this.closed = true;
    this.finish({ ok: false, error: "session is closed" });
  }
}

/**
 * @param {{opts: object, log: (line: string) => void, bin?: string, onEvent?: (event: object) => void}} input
 */
export function createCursorPool(input) {
  const log = input.log ?? (() => {});
  const opts = input.opts ?? {};
  const sessions = new Set();
  let nextId = 1;
  const pending = new Map();
  let initError = null;

  const child = spawn(input.bin ?? "cursor-agent", ["acp"], {
    env: { ...process.env, TP_NODE: process.execPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const write = (value) => {
    try {
      writeJsonLine(child.stdin, value);
    } catch (err) {
      log(`cursor: write failed: ${err.message}`);
    }
  };

  const failAll = (error) => {
    for (const [, entry] of pending) entry.reject(new Error(error));
    pending.clear();
    for (const session of sessions) session.finish({ ok: false, error });
  };

  child.on("error", (err) => {
    initError = `spawn error: ${err.message}`;
    log(`cursor: ${initError}`);
    failAll(initError);
  });
  child.on("exit", (code, signal) => {
    initError = `cursor-agent exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    log(`cursor: ${initError}`);
    failAll(initError);
    for (const session of sessions) session.closed = true;
  });
  child.stderr.on("data", lineSplitter((line) => {
    if (/error|warn/i.test(line)) log(`cursor: ${line.slice(0, 300)}`);
  }));

  const requestRaw = (method, params) => {
    if (initError !== null) return Promise.reject(new Error(initError));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method, params) => {
    if (initError !== null) return Promise.reject(new Error(initError));
    write({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  };

  // Handshake: initialize, then authenticate when the agent offers a login
  // method. An "already authenticated" failure is not fatal — the session calls
  // below report what actually matters.
  const handshake = requestRaw("initialize", {
    protocolVersion: 1,
    clientCapabilities: CLIENT_CAPABILITIES,
  })
    .then(async (result) => {
      const methods = Array.isArray(result?.authMethods) ? result.authMethods : [];
      const method = methods[0];
      if (method !== undefined) {
        try {
          await requestRaw("authenticate", { methodId: method.id ?? method.methodId ?? "cursor_login" });
        } catch (err) {
          log(`cursor: authenticate failed (${err.message}) — continuing`);
        }
      }
      return result;
    })
    .catch((err) => {
      initError = `initialize failed: ${err.message}`;
      log(`cursor: ${initError}`);
      throw err;
    });

  const pool = {
    actorKind: "cursor",
    opts,
    log,
    get pid() {
      return child.pid ?? null;
    },
    onEvent: input.onEvent ?? null,
    notify,
    async request(method, params) {
      await handshake;
      return requestRaw(method, params);
    },
    openSession(options) {
      const session = new CursorSession({ pool, cwd: options.cwd, sessionId: options.sessionId ?? null, role: options.role });
      sessions.add(session);
      return session;
    },
    async close() {
      for (const session of sessions) await session.close();
      sessions.clear();
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
    get size() {
      return sessions.size;
    },
  };

  child.stdout.on("data", lineSplitter((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`cursor: non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined && message.error !== null) {
        entry.reject(new Error(String(message.error.message ?? "cursor error")));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    // The agent asking the client for something — always answer.
    if (message.id !== undefined && typeof message.method === "string") {
      if (message.method === "session/request_permission") {
        const optionId = allowOption(message.params?.options);
        write({
          jsonrpc: "2.0",
          id: message.id,
          result:
            optionId === ""
              ? { outcome: { outcome: "cancelled" } }
              : { outcome: { outcome: "selected", optionId } },
        });
      } else {
        write({ jsonrpc: "2.0", id: message.id, result: {} });
      }
      return;
    }
    if (message.method === "session/update") {
      const params = message.params ?? {};
      for (const session of sessions) {
        if (session.sessionId === params.sessionId) session.handleUpdate(params.update ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      log(`cursor: notification ${message.method}`);
    }
  }));

  return pool;
}
