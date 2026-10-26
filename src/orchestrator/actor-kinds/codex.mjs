/**
 * Codex's resident session adapter.
 *
 * One `codex app-server --listen stdio://` process serves the whole pool. Each
 * session is a **thread** (`thread/start`, or `thread/resume` with the stored
 * thread id), and a turn is `turn/start` → `turn/completed`. The protocol is
 * JSON-RPC 2.0 over LF-delimited stdio; responses carry the request `id`, and
 * progress arrives as notifications.
 *
 * Subagents are **child threads**: a `collabAgentToolCall` item carries
 * `receiverThreadIds`, which the ledger records for reattach (`thread/resume`).
 *
 * Verified against codex-cli 0.161.0 (`app-server generate-json-schema`).
 */

import { spawn } from "node:child_process";

import { extractAgentIds } from "../ledger.mjs";
import { lineSplitter, writeJsonLine } from "../kind-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

const CLIENT_INFO = Object.freeze({ name: "meerkat-taskpanel-loop", version: "1.0.0" });

/**
 * The thread's approval/sandbox posture.
 *
 * With `--allow-all-tools`, the thread runs unattended with approvals off and a
 * full-access sandbox — the documented opt-in; the project directory is not an
 * isolation boundary. Otherwise approvals stay on and the sandbox is the
 * workspace.
 *
 * @param {{opts?: object}} input
 * @returns {{approvalPolicy: string, sandbox: string}}
 */
export function threadPolicy(input = {}) {
  if (input.opts?.allowAllTools === true) {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

/**
 * `thread/start` params for one session.
 *
 * @param {{opts?: object, cwd: string}} input
 */
export function threadStartParams(input) {
  return { cwd: input.cwd, ...threadPolicy(input) };
}

/**
 * `thread/resume` params for one stored session.
 *
 * @param {{opts?: object, cwd?: string, threadId: string}} input
 */
export function threadResumeParams(input) {
  const params = { threadId: input.threadId, ...threadPolicy(input) };
  if (typeof input.cwd === "string" && input.cwd !== "") params.cwd = input.cwd;
  return params;
}

/**
 * `turn/start` params. The user input is one text item.
 *
 * @param {{threadId: string, prompt: string}} input
 */
export function turnStartParams(input) {
  return { threadId: input.threadId, input: [{ type: "text", text: String(input.prompt) }] };
}

/** A pending request that must be answered rather than left hanging. */
function serverReply(method, params) {
  if (/requestUserInput|toolRequestUserInput|mcpServer\/elicitation/i.test(method)) {
    return { answers: {}, action: "decline" };
  }
  if (/"permissions"/i.test(JSON.stringify(params ?? {})) || /permissions/i.test(method)) {
    // A permissions request already granted by the sandbox posture: accept the
    // requested profile verbatim.
    const requested = params?.permissions ?? params?.profile ?? {};
    return { permissions: requested };
  }
  return { decision: "accept" };
}

/** The child thread ids a `collabAgentToolCall` item reports. */
function childThreadIds(item) {
  const ids = Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds : [];
  const fromStates = item?.agentsStates !== null && typeof item?.agentsStates === "object"
    ? Object.keys(item.agentsStates)
    : [];
  return [...new Set([...ids, ...fromStates].filter((id) => typeof id === "string" && id !== ""))];
}

class CodexSession {
  /**
   * @param {{pool: object, opts: object, cwd: string, sessionId?: string|null, role?: string}} input
   */
  constructor(input) {
    this.pool = input.pool;
    this.opts = input.opts;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.threadId = null;
    this.turnId = null;
    this.closed = false;
    this.turnIds = [];
    this.current = null;
    this.text = "";
    this.ready = this.open(input.sessionId ?? null);
  }

  get pid() {
    return this.pool.pid ?? null;
  }

  async open(resumeId) {
    try {
      const params = resumeId === null
        ? threadStartParams({ opts: this.opts, cwd: this.cwd })
        : threadResumeParams({ opts: this.opts, cwd: this.cwd, threadId: resumeId });
      const result = await this.pool.request(resumeId === null ? "thread/start" : "thread/resume", params);
      const thread = result?.thread ?? {};
      this.threadId = String(thread.id ?? resumeId ?? "");
      this.sessionId = String(thread.sessionId ?? thread.id ?? resumeId ?? this.sessionId ?? "");
      this.pool.onEvent?.({ type: "init", sessionId: this.sessionId, cwd: this.cwd });
      return { ok: true };
    } catch (err) {
      this.closed = true;
      return { ok: false, error: err.message };
    }
  }

  /** @param {object} notification */
  handleNotification(method, params) {
    if (method === "item/started" || method === "item/completed") {
      const item = params?.item ?? {};
      for (const subagentId of childThreadIds(item)) {
        if (!this.turnIds.includes(subagentId)) this.turnIds.push(subagentId);
        this.pool.onEvent?.({ type: "subagent", sessionId: this.sessionId, subagentId, phase: item.type });
      }
      const text = typeof item.text === "string" ? item.text : "";
      if (text !== "") this.text = text;
      for (const agentId of extractAgentIds(JSON.stringify(item))) {
        if (!this.turnIds.includes(agentId)) this.turnIds.push(agentId);
        this.pool.onEvent?.({ type: "subagent", sessionId: this.sessionId, subagentId: agentId, phase: "result" });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (typeof params?.delta === "string") this.text += params.delta;
      return;
    }
    if (method === "error") {
      this.pool.log(`codex[${this.cwd}] error: ${String(params?.message ?? params?.error ?? "").slice(0, 300)}`);
      return;
    }
    if (method === "turn/started" && params?.threadId === this.threadId && typeof params.turn?.id === "string") {
      this.turnId = params.turn.id;
      return;
    }
    if (method === "turn/completed" && params?.threadId === this.threadId) {
      const turn = params.turn ?? {};
      const failed = turn.status === "failed";
      this.finish({
        ok: !failed,
        result: this.text,
        error: failed ? String(turn.error?.message ?? turn.error ?? "turn failed") : null,
      });
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
      return { ok: false, error: ready.error ?? "thread could not be opened", sessionId: this.sessionId, cwd: this.cwd };
    }
    const timeoutMs = Number(options.timeoutMs ?? this.opts?.sessionTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    this.turnIds = [];
    this.text = "";
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish({ ok: false, error: `turn timed out after ${timeoutMs}ms` });
        this.interrupt().catch(() => {});
      }, Math.max(1, timeoutMs));
      this.current = { resolve, timer };
      this.pool
        .request("turn/start", turnStartParams({ threadId: this.threadId, prompt }))
        .then((result) => {
          if (typeof result?.turn?.id === "string") this.turnId = result.turn.id;
        })
        .catch((err) => {
          this.finish({ ok: false, error: err.message });
        });
    });
  }

  async interrupt() {
    if (this.closed || this.threadId === null || this.turnId === null) return;
    try {
      await this.pool.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // Already finished.
    }
  }

  async close() {
    this.closed = true;
    this.finish({ ok: false, error: "session is closed" });
  }
}

/**
 * One app-server process, shared by every thread.
 *
 * @param {{opts: object, log: (line: string) => void, bin?: string, onEvent?: (event: object) => void}} input
 */
export function createCodexPool(input) {
  const log = input.log ?? (() => {});
  const opts = input.opts ?? {};
  const sessions = new Set();
  let nextId = 1;
  const pending = new Map();
  let initError = null;

  const child = spawn(input.bin ?? "codex", ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, TP_NODE: process.execPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const failAll = (error) => {
    for (const [, entry] of pending) entry.reject(new Error(error));
    pending.clear();
    for (const session of sessions) session.finish({ ok: false, error });
  };

  child.on("error", (err) => {
    initError = `spawn error: ${err.message}`;
    log(`codex: ${initError}`);
    failAll(initError);
  });
  child.on("exit", (code, signal) => {
    initError = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    log(`codex: ${initError}`);
    failAll(initError);
    for (const session of sessions) session.closed = true;
  });
  child.stderr.on("data", lineSplitter((line) => {
    if (/ERROR|WARN/i.test(line)) log(`codex: ${line.slice(0, 300)}`);
  }));

  const write = (value) => {
    try {
      writeJsonLine(child.stdin, value);
    } catch (err) {
      log(`codex: write failed: ${err.message}`);
    }
  };

  const requestRaw = (method, params) => {
    if (initError !== null) return Promise.reject(new Error(initError));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };

  // Every request waits for the handshake: app-server does not accept
  // thread/turn requests before `initialize`.
  const handshake = requestRaw("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true },
  })
    .then((result) => {
      write({ jsonrpc: "2.0", method: "initialized" });
      return result;
    })
    .catch((err) => {
      initError = `initialize failed: ${err.message}`;
      log(`codex: ${initError}`);
      throw err;
    });
  const request = async (method, params) => {
    await handshake;
    return requestRaw(method, params);
  };

  const pool = {
    actorKind: "codex",
    get pid() {
      return child.pid ?? null;
    },
    request,
    log,
    onEvent: input.onEvent ?? null,
    openSession(options) {
      const session = new CodexSession({ pool, opts, cwd: options.cwd, sessionId: options.sessionId ?? null, role: options.role });
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
      log(`codex: non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined && message.error !== null) {
        entry.reject(new Error(String(message.error.message ?? "codex error")));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    // A request from the server (approval, user input): answer, never hang.
    if (message.id !== undefined && typeof message.method === "string") {
      const reply = serverReply(message.method, message.params);
      write({ jsonrpc: "2.0", id: message.id, result: reply });
      return;
    }
    // A notification.
    if (typeof message.method === "string") {
      const params = message.params ?? {};
      const threadId = params.threadId ?? params.thread?.id;
      for (const session of sessions) {
        if (session.threadId !== null && (threadId === undefined || session.threadId === threadId)) {
          session.handleNotification(message.method, params);
        }
      }
    }
  }));

  return pool;
}
