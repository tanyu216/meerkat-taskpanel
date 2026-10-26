/**
 * The client side of the local event hub — where it lives, how a consumer
 * finds it, how one is started, and the request/stream protocol.
 *
 * The hub **server** stays in `src/cli/hub/server.mjs` (it is a `taskctl`
 * process). This module is the foundation half both the CLI and the loop
 * orchestrator need: one authenticated socket, a `hubRecords` async generator
 * for streams, and `hubAnswer`/`hubCall` for one-shot requests.
 *
 * The hub is per-user, per-board: the coordinate is a small pointer file in a
 * per-user runtime directory, keyed by the resolved board URL and a token
 * fingerprint (never the token itself). Starting is a detached spawn.
 *
 * Node builtins only; no board access here.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  acquireLock,
  ensurePrivateDir,
  lockIsStale,
  readJsonFile,
  releaseLock,
  removeFile,
} from "./daemon-state.mjs";
import { DomainError } from "./errors.mjs";

/** The socket protocol generation. A client with another number is refused. */
export const HUB_PROTOCOL = 1;

/** A hub with nothing to serve exits after this long. Persistent registrations keep it alive. */
export const HUB_IDLE_MS = 5 * 60 * 1000;

/** How long a client waits for a freshly spawned hub to publish its pointer. */
export const HUB_START_TIMEOUT_MS = 10_000;

/** The health check's budget: a local socket should answer immediately. */
const HELLO_TIMEOUT_MS = 1_000;

/**
 * The per-user runtime directory. `MEERKAT_HUB_DIR` is the test and harness
 * override; otherwise XDG on POSIX and LOCALAPPDATA on Windows, falling back to
 * the install root.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function hubDir(env = process.env) {
  const explicit = env.MEERKAT_HUB_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg !== undefined && xdg !== "") return join(resolve(xdg), "meerkat-taskpanel");
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local !== undefined && local !== "") return join(resolve(local), "meerkat-taskpanel", "run");
  }
  return join(homedir(), ".meerkat-taskpanel", "run");
}

/**
 * The hub's identity on disk: the resolved board URL plus a token fingerprint.
 * A rotated token therefore starts (and finds) a different hub rather than
 * silently reusing a stream authenticated as the old one.
 *
 * @param {string} url
 * @param {string} token
 * @returns {string}
 */
export function hubKey(url, token) {
  const fingerprint = createHash("sha256")
    .update(typeof token === "string" ? token : "")
    .digest("hex")
    .slice(0, 8);
  return createHash("sha256")
    .update(`${String(url)}\0${fingerprint}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Every path one hub owns.
 *
 * @param {string} url resolved board URL
 * @param {string} token
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hubPaths(url, token, env = process.env) {
  const dir = hubDir(env);
  const key = hubKey(url, token);
  return {
    dir,
    key,
    pointer: join(dir, `hub-${key}.json`),
    lock: join(dir, `hub-${key}.lock`),
    owner: join(dir, `hub-${key}.owner`),
    log: join(dir, `hub-${key}.log`),
    state: join(dir, `hub-${key}.state.json`),
  };
}

/**
 * Turn a hub `error` record into the domain error the CLI renders.
 *
 * @param {unknown} data
 * @returns {DomainError}
 */
export function hubError(data) {
  const payload = data !== null && typeof data === "object" ? data : {};
  return new DomainError(
    typeof payload.code === "string" && payload.code !== "" ? payload.code : "CLI_IO",
    {
      message: typeof payload.message === "string" && payload.message !== ""
        ? payload.message
        : "events hub reported an error",
      ...(payload.details === undefined ? {} : { details: payload.details }),
      ...(payload.hint === undefined ? {} : { hint: payload.hint }),
    },
  );
}

/**
 * Open one hub session and yield every record after the authenticated hello.
 *
 * The caller writes the actual request by passing it here; it is sent as soon
 * as hello is accepted. The socket closes when the generator is closed, when the
 * hub closes it, or on any transport failure (which throws).
 *
 * @param {{port: number, token: string}} pointer
 * @param {object} request
 * @param {{idleMs?: number}} [options] end the local stream after this long with
 *   no records; heartbeats count, exactly like the direct SSE stream
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* hubRecords(pointer, request, options = {}) {
  const { idleMs = 0 } = options;
  if (typeof pointer?.port !== "number" || typeof pointer?.token !== "string") {
    throw new DomainError("CLI_IO", {
      message: "events hub: the hub pointer is not usable",
      details: { pointer: pointer ?? null },
    });
  }

  const socket = connect(Number(pointer.port), "127.0.0.1");
  socket.setEncoding("utf8");
  let authed = false;
  let buffer = "";
  let idleTimer = null;

  const armIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!Number.isInteger(idleMs) || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      socket.destroy(new DomainError("CLI_IO", {
        message: `the local hub was silent for ${idleMs}ms`,
        details: { reason: "idle", idle_ms: idleMs },
      }));
    }, idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  // A hub that never answers hello is not a hub worth waiting for. Once the
  // session is authenticated the socket is a stream bounded only by the
  // caller's idle option.
  const helloTimeout = setTimeout(() => {
    socket.destroy(new Error("the local hub did not answer the hello"));
  }, HELLO_TIMEOUT_MS);
  if (typeof helloTimeout.unref === "function") helloTimeout.unref();

  try {
    socket.write(`${JSON.stringify({ op: "hello", protocol: HUB_PROTOCOL, token: pointer.token })}\n`);
    for await (const chunk of socket) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          throw new DomainError("CLI_IO", {
            message: "events hub: the local hub wrote a malformed line",
          });
        }
        if (!authed) {
          if (record?.op !== "hello" || record.ok !== true) {
            throw new DomainError("CLI_IO", {
              message: "events hub: the local hub refused this client",
              details: { reason: record?.error ?? null },
            });
          }
          authed = true;
          clearTimeout(helloTimeout);
          armIdle();
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        armIdle();
        yield record;
      }
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("CLI_IO", {
      message: `events hub: lost the local hub connection: ${err?.message ?? err}`,
      details: { port: pointer.port },
    });
  } finally {
    clearTimeout(helloTimeout);
    if (idleTimer !== null) clearTimeout(idleTimer);
    socket.destroy();
  }
}

/**
 * A one-answer request (`watch-status`, `watch-stop`). The hub replies with a
 * record carrying `op`; anything else before it is an error or a heartbeat.
 *
 * @param {{port: number, token: string}} pointer
 * @param {object} request
 * @param {(record: object) => boolean} isAnswer
 * @returns {Promise<object>}
 */
export async function hubAnswer(pointer, request, isAnswer) {
  for await (const record of hubRecords(pointer, request)) {
    if (record?.type === "heartbeat") continue;
    if (record?.type === "error") throw hubError(record.data);
    if (record?.op === "error" && record.ok === false) throw hubError(record.error);
    if (isAnswer(record)) return record;
  }
  throw new DomainError("CLI_IO", {
    message: "events hub: the local hub closed before answering",
    details: { port: pointer.port },
  });
}

/**
 * One authenticated request/response over the hub socket. Used for the health
 * check and for `watch-status` / `watch-stop`, where the answer is a single
 * document rather than a stream.
 *
 * @param {{port:number}} pointer
 * @param {string} token
 * @param {object} payload
 * @param {{timeoutMs?: number, match?: (record: object) => boolean}} [options]
 * @returns {Promise<object>}
 */
export function hubCall(pointer, token, payload, options = {}) {
  const { timeoutMs = HELLO_TIMEOUT_MS, match = (record) => record?.op !== "hello" && record?.type === undefined } = options;
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;
    let sent = false;
    const socket = connect(Number(pointer.port), "127.0.0.1");
    const timer = setTimeout(() => {
      finish(new DomainError("CLI_IO", {
        message: "events hub: the local hub did not answer in time",
        details: { port: pointer.port, timeout_ms: timeoutMs },
      }));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (failure !== undefined) reject(failure);
      else resolvePromise(value);
    };

    socket.setEncoding("utf8");
    socket.on("error", (err) => finish(new DomainError("CLI_IO", {
      message: `events hub: cannot reach the local hub: ${err.message}`,
      details: { port: pointer.port },
    })));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ op: "hello", protocol: HUB_PROTOCOL, token })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          finish(new DomainError("CLI_IO", { message: "events hub: the local hub wrote a malformed line" }));
          return;
        }
        if (record?.op === "hello" && record.ok !== true) {
          finish(new DomainError("CLI_IO", {
            message: "events hub: the local hub refused this client",
            details: { reason: record.error ?? null },
          }));
          return;
        }
        if (record?.op === "hello") {
          if (!sent) {
            sent = true;
            socket.write(`${JSON.stringify(payload)}\n`);
          }
          continue;
        }
        if (match(record)) finish(undefined, record);
      }
    });
    socket.on("close", () => {
      finish(new DomainError("CLI_IO", {
        message: "events hub: the local hub closed the connection before answering",
        details: { port: pointer.port },
      }));
    });
  });
}

/**
 * A best-effort health check: an authenticated hello is enough to prove the
 * pointer names a live hub, not a fossil left by a crash.
 *
 * @param {object|null} pointer
 * @returns {Promise<boolean>}
 */
export async function hubHealthy(pointer) {
  if (pointer === null || typeof pointer?.port !== "number" || typeof pointer?.token !== "string") {
    return false;
  }
  try {
    await hubCall(pointer, pointer.token, { op: "ping" }, {
      timeoutMs: HELLO_TIMEOUT_MS,
      match: (record) => record?.op === "ping",
    });
    return true;
  } catch {
    return false;
  }
}

/** The last few lines of a log, for a failure message that names the reason. */
export function logTail(path, max = 1_200) {
  try {
    return readFileSync(path, "utf8").slice(-max);
  } catch {
    return "";
  }
}

/**
 * Sleep while the starter waits for a hub. This timer must stay **ref'd**: in
 * the short-lived CLI process it is the only handle keeping the event loop
 * alive, and an unref'd one makes Node exit 13 (unsettled top-level await)
 * before the hub answers.
 */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Find the hub for this board, starting one when none answers.
 *
 * The lock is the mutex: several workers may notice the absence at the same
 * moment, but only one spawns. The losers poll for the pointer. A lock held by
 * a dead starter is reclaimed.
 *
 * @param {{
 *   url: string,
 *   token: string,
 *   actorKind: string,
 *   asHuman?: boolean,
 *   agent?: string|null,
 *   envFile?: string|null,
 *   entry: string,
 *   env?: NodeJS.ProcessEnv,
 *   waitTimeoutMs?: number,
 *   log?: (line: string) => void,
 * }} input
 * @returns {Promise<{pointer: object, paths: object, spawned: boolean}>}
 */
export async function ensureHub(input) {
  const {
    url,
    token,
    actorKind,
    asHuman = false,
    agent = null,
    envFile = null,
    entry,
    env = process.env,
    waitTimeoutMs = HUB_START_TIMEOUT_MS,
    log = () => {},
  } = input;

  if (typeof url !== "string" || url === "") {
    throw new DomainError("CLI_IO", {
      message: "events hub: the board URL is not resolved",
      hint: { fix: "run the command with --url, or make sure taskd is reachable" },
    });
  }

  const paths = hubPaths(url, token, env);
  ensurePrivateDir(paths.dir);

  const existing = readJsonFile(paths.pointer);
  if (existing !== null && await hubHealthy(existing)) {
    return { pointer: existing, paths, spawned: false };
  }

  let claimed = acquireLock(paths.lock).ok;
  if (!claimed) {
    if (lockIsStale(paths.lock)) {
      removeFile(paths.lock);
      claimed = acquireLock(paths.lock).ok;
    }
    if (!claimed) {
      // Another starter is in flight. It will publish the pointer or fail.
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        const pointer = readJsonFile(paths.pointer);
        if (pointer !== null && await hubHealthy(pointer)) {
          return { pointer, paths, spawned: false };
        }
        await sleep(100);
      }
      throw new DomainError("CLI_IO", {
        message: "events hub: another client is starting a hub but it did not come up",
        details: { lock: paths.lock },
        hint: { fix: `inspect ${paths.log}, then remove ${paths.lock} if no hub process exists` },
      });
    }
  }

  ensurePrivateDir(paths.dir);
  const args = [entry, "events", "hub", "--url", url];
  // `--actor-kind human` is reserved; a human caller is spelled `--as-human`.
  if (asHuman) args.push("--as-human");
  else args.push("--actor-kind", actorKind);
  if (typeof agent === "string" && agent !== "") args.push("--agent", agent);
  if (typeof envFile === "string" && envFile !== "") args.push("--env-file", envFile);

  // The token is a bearer secret; it travels in the child's environment, never
  // in argv (where `ps` could read it). An absent token stays absent: a literal
  // `"null"` would be sent as an API key.
  const childEnv = { ...env };
  if (typeof token === "string" && token !== "") childEnv.TASKD_TOKEN = token;
  else delete childEnv.TASKD_TOKEN;
  let logFd = null;
  try {
    logFd = openSync(paths.log, "a", 0o600);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
      cwd: process.cwd(),
    });
    child.unref();
  } catch (err) {
    releaseLock(paths.lock);
    throw new DomainError("CLI_IO", {
      message: `events hub: could not start the local hub: ${err.message}`,
      details: { entry, log: paths.log },
    });
  } finally {
    if (logFd !== null) closeSync(logFd);
  }

  log(`events hub: started ${entry} (log ${paths.log})`);

  const deadline = Date.now() + waitTimeoutMs;
  try {
    while (Date.now() < deadline) {
      const pointer = readJsonFile(paths.pointer);
      if (pointer !== null && await hubHealthy(pointer)) {
        return { pointer, paths, spawned: true };
      }
      await sleep(100);
    }
    throw new DomainError("CLI_IO", {
      message: "events hub: the local hub did not publish a usable pointer",
      details: { pointer: paths.pointer, log: paths.log },
      hint: { fix: `inspect ${paths.log}; retry with --standalone when the hub cannot run here` },
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "CLI_IO") {
      err.details = { ...(err.details ?? {}), log_tail: logTail(paths.log) };
    }
    throw err;
  } finally {
    releaseLock(paths.lock);
  }
}

/** A fresh bearer token for one hub. Never written anywhere but the 0600 pointer. */
export function newHubToken() {
  return randomBytes(24).toString("hex");
}
