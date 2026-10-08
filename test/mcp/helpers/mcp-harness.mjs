/**
 * The MCP test harness (§5, plan §6 step 2).
 *
 * Three ways to reach the same server, because M3 has three different things to
 * prove and they are not all provable the same way:
 *
 *   1. **In-process** (`createMcpSession`) — call `handleMessage` directly. This
 *      is where per-tool behaviour is tested: no framing, no process lifetime,
 *      so a failure is unambiguously about the tool.
 *   2. **A real child process over stdio** (`startMcp`) — this is where the
 *      *transport* is tested: newline framing, chunked writes, EOF flushing,
 *      stdout purity, exit codes. Nothing here is mocked.
 *   3. **A real board** (`withMcp`) — reuses `test/cli/helpers/cli-harness.mjs`
 *      to spawn a real `taskd`, so every tool test exercises the same
 *      `createBoardClient` → HTTP → service path production runs.
 *
 * ⚠️ `startMcp` uses **async `spawn`**, never `spawnSync`. `spawnSync` blocks
 * this process's event loop for the whole conversation, and anything this
 * process hosts — a board, a timer, a socket — would never run, so the child
 * would wait forever for an answer that cannot be produced. `cli-harness.mjs`
 * documents the same trap for the CLI; stdio makes it worse, because a deadlock
 * looks like a hang rather than a failure.
 *
 * Isolation: every board gets a fresh `mkdtemp` data dir and its own
 * `TASKD_RUNTIME_POINTER`; ports are always `0`, never 9527.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { createMcpServer } from "../../../src/mcp/index.mjs";
import {
  ROOT,
  baseEnv,
  cleanupTempDirs,
  closedPortUrl,
  dataOf,
  errorOf,
  makeTempDir,
  parseJson,
  readJsonFile,
  runCli,
  startTaskd,
  waitUntil,
} from "../../cli/helpers/cli-harness.mjs";

export {
  ROOT,
  baseEnv,
  cleanupTempDirs,
  closedPortUrl,
  dataOf,
  errorOf,
  makeTempDir,
  parseJson,
  readJsonFile,
  runCli,
  startTaskd,
  waitUntil,
};

/** The executable a host would put in its MCP config. */
export const MCP_MAIN = join(ROOT, "src", "mcp", "main.mjs");

/** Default per-line wait. Generous: a cold `node` start plus a first HTTP call. */
export const LINE_TIMEOUT_MS = 20_000;

/**
 * What a `tools/call` came back as, normalised.
 *
 * Two failure shapes exist and conflating them would blur the milestone's
 * central distinction, so they stay separate:
 *
 *   `kind: "rpc"`  — the *protocol* refused (`-32602` for an unknown tool or a
 *                    bad argument, `-32601` for an unknown method). The tool
 *                    never ran.
 *   `kind: "tool"` — the tool ran and the board refused (or it succeeded).
 *                    `isError` says which; `payload` is the error document.
 *
 * @param {object|null} envelope a parsed JSON-RPC response
 */
export function readToolResult(envelope) {
  if (envelope === null || envelope === undefined) return { kind: "notification", isError: null, payload: null, content: [], rpc: null, envelope: null };
  if (envelope.error !== undefined && envelope.error !== null) {
    return { kind: "rpc", isError: null, payload: null, content: [], rpc: envelope.error, envelope };
  }
  const result = envelope.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0]?.text ?? "";
  let payload = null;
  try {
    payload = JSON.parse(first);
  } catch {
    payload = null;
  }
  return { kind: "tool", isError: result.isError === true, payload, content, rpc: null, envelope };
}

/** Convenience: the JSON-RPC error code, or `null` when it was a tool result. */
export function rpcCode(result) {
  return result.rpc === null ? null : result.rpc.code;
}

/**
 * An in-process MCP session: `handleMessage` called straight, no process.
 *
 * @param {{url?: string|null, token?: string|null, env?: object}} [options]
 */
export function createMcpSession(options = {}) {
  const server = createMcpServer(options);
  let counter = 0;

  const session = {
    server,
    /** Send one JSON-RPC message and parse whatever comes back (`null` = silence). */
    async request(method, params) {
      counter += 1;
      const message = { jsonrpc: "2.0", id: counter, method };
      if (params !== undefined) message.params = params;
      const raw = await server.handleLine(JSON.stringify(message));
      return raw === null ? null : JSON.parse(raw);
    },
    /** Send one JSON-RPC *notification* and assert the silence. */
    async notify(method, params) {
      const message = { jsonrpc: "2.0", method };
      if (params !== undefined) message.params = params;
      return server.handleLine(JSON.stringify(message));
    },
    /** `tools/call`, normalised. */
    async call(name, args) {
      return readToolResult(await session.request("tools/call", { name, arguments: args ?? {} }));
    },
    initialize(clientInfo = { name: "claude-code", version: "0" }) {
      return session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo });
    },
    toolsList() {
      return session.request("tools/list");
    },
  };
  return session;
}

/**
 * A board plus an in-process MCP session pointed at it.
 *
 * `fn` receives the harness context extended with `call`/`request`/`initialize`
 * and the usual CLI helpers bound to the same board (`run`, `dataOf`, …), so a
 * test can seed with one surface and assert with the other.
 *
 * @param {(ctx: object) => any} fn
 * @param {{dataDir?: string, env?: object}} [options]
 */
export async function withMcp(fn, options = {}) {
  const taskd = await startTaskd(options);
  try {
    const session = createMcpSession({
      url: taskd.url,
      token: taskd.token,
      env: baseEnv(),
    });
    return await fn({
      taskd,
      url: taskd.url,
      dataDir: taskd.dataDir,
      token: taskd.token,
      run: (args, opts = {}) => runCli(args, { url: taskd.url, dataDir: taskd.dataDir, ...opts }),
      ...session,
    });
  } finally {
    await taskd.close();
  }
}

/**
 * Start `node src/mcp/main.mjs` as a real child process, wired to real pipes.
 *
 * @param {{env?: object, args?: string[], dataDir?: string}} [options]
 */
export async function startMcp(options = {}) {
  const env = { ...baseEnv(), ...(options.env ?? {}) };
  const child = spawn(process.execPath, [MCP_MAIN, ...(options.args ?? [])], {
    env,
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  /** Every complete stdout line, in arrival order. */
  const lines = [];
  /** How many of those a caller has already read (`silentFor` needs the cursor). */
  let read = 0;
  /** Resolvers waiting for the next line. */
  const waiters = [];
  let stdoutBuffer = "";
  let stderr = "";
  let exit = null;
  const exitWaiters = [];

  /** Hand the next unread line to the first *live* waiter, if there is one. */
  const pump = () => {
    while (lines.length > read && waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter.settled) continue; // a timed-out waiter must not eat a line
      read += 1;
      waiter.resolve(lines[read - 1]);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let at = stdoutBuffer.indexOf("\n");
    while (at !== -1) {
      lines.push(stdoutBuffer.slice(0, at));
      stdoutBuffer = stdoutBuffer.slice(at + 1);
      at = stdoutBuffer.indexOf("\n");
    }
    pump();
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // A child that exits while a test is still writing would otherwise raise an
  // unhandled `EPIPE` inside the test runner — which reads as "the suite is
  // broken" rather than "the server refused argv".
  child.stdin.on("error", () => {});

  child.on("exit", (code, signal) => {
    exit = { code, signal };
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter.settled) waiter.reject(new Error("the MCP process exited before answering"));
    }
    while (exitWaiters.length > 0) exitWaiters.shift()(exit);
  });

  const session = {
    child,
    lines,
    stderr: () => stderr,
    /** The part of stdout that is not (yet) a whole line — must stay empty. */
    dangling: () => stdoutBuffer,

    /** Raw bytes in. Used to prove chunked framing: two writes, one message. */
    write(text) {
      child.stdin.write(text);
    },
    /** One message, one line. */
    send(message) {
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    },
    /** One JSON-RPC request; returns the parsed response. */
    async request(method, params, id = null) {
      const message = { jsonrpc: "2.0", id: id ?? lines.length + 1, method };
      if (params !== undefined) message.params = params;
      session.send(message);
      return JSON.parse(await session.nextLine());
    },
    /** One JSON-RPC notification (no `id`, so no reply is allowed). */
    notify(method, params) {
      const message = { jsonrpc: "2.0", method };
      if (params !== undefined) message.params = params;
      session.send(message);
    },

    /**
     * The next stdout line.
     *
     * Lines that arrived before this call are returned immediately — a response
     * does not wait to be asked for, and a reader that only listened for lines
     * arriving *after* it subscribed would lose a fast child's answer.
     *
     * @param {{timeoutMs?: number}} [opts]
     */
    nextLine(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? LINE_TIMEOUT_MS;
      if (lines.length > read) {
        read += 1;
        return Promise.resolve(lines[read - 1]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          settled: false,
          resolve: null,
          reject: null,
        };
        const timer = setTimeout(() => {
          waiter.settled = true;
          // Drop it: a waiter that has already given up must not swallow the
          // line that arrives next (which belongs to the next `nextLine`).
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error(`no stdout line within ${timeoutMs}ms (${lines.length} so far)\n--- stderr ---\n${stderr}`));
        }, timeoutMs);
        waiter.resolve = (line) => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearTimeout(timer);
          resolve(line);
        };
        waiter.reject = (err) => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearTimeout(timer);
          reject(err);
        };
        waiters.push(waiter);
      });
    },

    /**
     * Resolve `true` when *nothing new* arrives for `ms`. This is the only way to
     * assert the rule that a notification gets no reply: a silence cannot be
     * observed, only waited out. Lines already read by a previous `nextLine` do
     * not count against it.
     */
    async silentFor(ms) {
      if (lines.length > read) return false;
      try {
        await session.nextLine({ timeoutMs: ms });
        return false;
      } catch {
        return true;
      }
    },

    /** Close stdin (EOF), then wait for the process to leave on its own. */
    async close({ timeoutMs = 10_000 } = {}) {
      if (child.stdin.writable) child.stdin.end();
      if (exit !== null) return exit;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`the MCP process did not exit within ${timeoutMs}ms\n--- stderr ---\n${stderr}`));
        }, timeoutMs);
        exitWaiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
  return session;
}

/**
 * Run `fn` with a real board *and* a real MCP child process bound to it.
 *
 * @param {(ctx: object) => any} fn
 * @param {{dataDir?: string, env?: object}} [options]
 */
export async function withMcpStdio(fn, options = {}) {
  const taskd = await startTaskd(options);
  const mcp = await startMcp({
    env: {
      TASKD_DATA_DIR: taskd.dataDir,
      TASKD_RUNTIME_POINTER: taskd.pointerPath,
      TASKD_PORT: "0",
      TASKD_NO_AUTOSTART: "1",
    },
  });
  try {
    return await fn({
      taskd,
      mcp,
      url: taskd.url,
      dataDir: taskd.dataDir,
      run: (args, opts = {}) => runCli(args, { url: taskd.url, dataDir: taskd.dataDir, ...opts }),
    });
  } finally {
    await mcp.close().catch(() => {});
    await taskd.close();
  }
}
