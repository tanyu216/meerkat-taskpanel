/**
 * OpenCode's resident session adapter.
 *
 * OpenCode is an HTTP server (`opencode serve`), so a session is a server-side
 * object and a turn is one synchronous `POST /session/:id/message` — the
 * response returns when the turn is complete, which is the completion signal
 * (the SSE stream is optional and not needed here).
 *
 * **One server per directory.** The server's API has no per-session `cwd`
 * (`GET /path` reports the server's own), and a child session inherits its
 * parent's location. So the pool starts one server per project directory and
 * creates the sessions there — the documented v1 shape, and the only one that
 * guarantees a subagent's inherits the project directory.
 *
 * Verified against the published server API (`POST /session`,
 * `POST /session/:id/message`, `POST /session/:id/abort`), not against a live
 * binary on this host; `scripts/verify/kind-session-matrix.mjs` is the probe.
 * Permission rules are OpenCode's own configuration (`opencode.json`); this
 * adapter sends no permission grants.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { extractAgentIds } from "../ledger.mjs";
import { lineSplitter } from "../kind-session.mjs";

/** Per-turn cap used when the caller does not state one. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
/** How long a freshly spawned server has to answer before the session fails. */
export const SERVER_READY_TIMEOUT_MS = 15_000;

/** A free loopback port for one server. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => (port === null ? reject(new Error("could not allocate a port")) : resolve(port)));
    });
  });
}

/** The assistant text in a message response's `parts`. */
export function messageText(body) {
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * One `opencode serve` process for one directory.
 *
 * @param {{opts: object, cwd: string, log: (line: string) => void, bin?: string}} input
 */
function startServer(input) {
  const env = { ...process.env, TP_NODE: process.execPath };
  const log = input.log;
  return freePort().then((port) => {
    const child = spawn(input.bin ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", lineSplitter(() => {}));
    child.stderr.on("data", lineSplitter((line) => {
      if (/error|warn/i.test(line)) log(`opencode[${input.cwd}]: ${line.slice(0, 300)}`);
    }));
    const server = {
      cwd: input.cwd,
      child,
      port,
      base: `http://127.0.0.1:${port}`,
      headers: {},
      closed: false,
    };
    const username = input.opts?.opencodeUser ?? process.env.OPENCODE_SERVER_USERNAME;
    const password = input.opts?.opencodePassword ?? process.env.OPENCODE_SERVER_PASSWORD;
    if (username && password) {
      server.headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
    child.on("error", (err) => {
      server.closed = true;
      log(`opencode[${input.cwd}] spawn error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      server.closed = true;
      log(`opencode[${input.cwd}] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });
    return server;
  });
}

/** Wait until the server answers `GET /session`. */
async function waitReady(server, timeoutMs = SERVER_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    if (server.closed) return { ok: false, error: "server exited before it was ready" };
    try {
      const response = await fetch(`${server.base}/session`, { headers: server.headers });
      if (response.ok) return { ok: true };
      last = `GET /session → ${response.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, error: `server not ready after ${timeoutMs}ms (${last})` };
}

class OpenCodeSession {
  /**
   * @param {{pool: object, opts: object, cwd: string, sessionId?: string|null, role?: string}} input
   */
  constructor(input) {
    this.pool = input.pool;
    this.opts = input.opts;
    this.cwd = input.cwd;
    this.role = input.role ?? "worker";
    this.sessionId = input.sessionId ?? null;
    this.server = null;
    this.closed = false;
    this.ready = this.open(input.sessionId ?? null);
  }

  get pid() {
    return this.server?.child?.pid ?? null;
  }

  async open(resumeId) {
    try {
      this.server = await this.pool.serverFor(this.cwd);
      if (resumeId !== null) {
        const response = await fetch(`${this.server.base}/session/${encodeURIComponent(resumeId)}`, {
          headers: this.server.headers,
        });
        if (response.ok) {
          this.sessionId = resumeId;
          this.pool.onEvent?.({ type: "init", sessionId: resumeId, cwd: this.cwd });
          return { ok: true };
        }
      }
      const response = await fetch(`${this.server.base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.server.headers },
        body: JSON.stringify({ title: `meerkat ${this.role} — ${this.cwd}` }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, error: `POST /session → ${response.status} ${body.slice(0, 200)}` };
      }
      const body = await response.json();
      this.sessionId = String(body?.id ?? "");
      if (this.sessionId === "") return { ok: false, error: "POST /session returned no id" };
      this.pool.onEvent?.({ type: "init", sessionId: this.sessionId, cwd: this.cwd });
      return { ok: true };
    } catch (err) {
      this.closed = true;
      this.pool.releaseServer(this.cwd);
      return { ok: false, error: err.message };
    }
  }

  /**
   * @param {string} prompt
   * @param {{timeoutMs?: number}} [options]
   */
  async send(prompt, options = {}) {
    if (this.closed) return { ok: false, error: "session is closed", sessionId: this.sessionId, cwd: this.cwd };
    const ready = await this.ready;
    if (ready.ok !== true) {
      this.closed = true;
      return { ok: false, error: ready.error ?? "session could not be opened", sessionId: this.sessionId, cwd: this.cwd };
    }
    const timeoutMs = Number(options.timeoutMs ?? this.opts?.sessionTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetch(`${this.server.base}/session/${encodeURIComponent(this.sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.server.headers },
        body: JSON.stringify({ parts: [{ type: "text", text: String(prompt) }] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          error: `POST /session/:id/message → ${response.status} ${body.slice(0, 200)}`,
          sessionId: this.sessionId,
          cwd: this.cwd,
        };
      }
      const body = await response.json();
      const ids = [
        ...extractAgentIds(JSON.stringify(body)),
        ...(await this.childSessionIds()),
      ];
      return {
        ok: true,
        result: messageText(body),
        sessionId: this.sessionId,
        cwd: this.cwd,
        ids: [...new Set(ids)],
      };
    } catch (err) {
      if (err?.name === "AbortError") {
        await this.interrupt().catch(() => {});
        return {
          ok: false,
          error: `turn timed out after ${timeoutMs}ms`,
          sessionId: this.sessionId,
          cwd: this.cwd,
        };
      }
      return { ok: false, error: err.message, sessionId: this.sessionId, cwd: this.cwd };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Child sessions are OpenCode's subagents; a version without the route is fine. */
  async childSessionIds() {
    try {
      const response = await fetch(
        `${this.server.base}/session/${encodeURIComponent(this.sessionId)}/children`,
        { headers: this.server.headers },
      );
      if (!response.ok) return [];
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body?.children) ? body.children : [];
      return rows.map((row) => (typeof row === "string" ? row : row?.id)).filter((id) => typeof id === "string" && id !== "");
    } catch {
      return [];
    }
  }

  async interrupt() {
    if (this.closed || this.server === null || this.sessionId === null) return;
    try {
      await fetch(`${this.server.base}/session/${encodeURIComponent(this.sessionId)}/abort`, {
        method: "POST",
        headers: this.server.headers,
      });
    } catch {
      // The server may be gone.
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pool.releaseServer(this.cwd);
  }
}

/**
 * @param {{opts: object, log: (line: string) => void, bin?: string, onEvent?: (event: object) => void}} input
 */
export function createOpenCodePool(input) {
  const log = input.log ?? (() => {});
  const sessions = new Set();
  /** @type {Map<string, Promise<object>>} */
  const servers = new Map();
  /** Live sessions per directory: the last one out stops the server. */
  const refs = new Map();

  const pool = {
    actorKind: "opencode",
    log,
    onEvent: input.onEvent ?? null,
    /** One server per directory, started on first use. */
    serverFor(cwd) {
      if (!servers.has(cwd)) {
        const started = startServer({ opts: input.opts ?? {}, cwd, log, bin: input.bin }).then(async (server) => {
          const ready = await waitReady(server);
          if (!ready.ok) {
            server.closed = true;
            try {
              server.child.kill("SIGTERM");
            } catch {
              // Already gone.
            }
            throw new Error(ready.error);
          }
          return server;
        });
        // A failed start must not poison the map: a later card retries.
        started.catch(() => servers.delete(cwd));
        servers.set(cwd, started);
      }
      return servers.get(cwd);
    },
    openSession(options) {
      const session = new OpenCodeSession({
        pool,
        opts: input.opts ?? {},
        cwd: options.cwd,
        sessionId: options.sessionId ?? null,
        role: options.role,
      });
      sessions.add(session);
      refs.set(options.cwd, (refs.get(options.cwd) ?? 0) + 1);
      return session;
    },
    /** The last session for a directory stops its server. */
    releaseServer(cwd) {
      const remaining = Math.max(0, (refs.get(cwd) ?? 1) - 1);
      if (remaining > 0) {
        refs.set(cwd, remaining);
        return;
      }
      refs.delete(cwd);
      const started = servers.get(cwd);
      servers.delete(cwd);
      if (started !== undefined) {
        started
          .then((server) => {
            try {
              server.child.kill("SIGTERM");
            } catch {
              // Already gone.
            }
          })
          .catch(() => {});
      }
    },
    async close() {
      for (const session of sessions) await session.close();
      sessions.clear();
      for (const [, started] of servers) {
        try {
          const server = await started;
          server.child.kill("SIGTERM");
        } catch {
          // It never started.
        }
      }
      servers.clear();
    },
    get size() {
      return sessions.size;
    },
    get serverCount() {
      return servers.size;
    },
  };
  return pool;
}
