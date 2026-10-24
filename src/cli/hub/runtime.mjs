/**
 * Where the local event hub lives, how a client finds it, and how one is
 * started when it is not running.
 *
 * The hub is a **per-user, per-board** process: one SSE connection for every
 * consumer on this machine that talks to the same board with the same token.
 * The coordinate that keeps those consumers together is a small pointer file in
 * a per-user runtime directory:
 *
 *     <runtime-dir>/hub-<key>.json   {pid, port, token, log, startedAt}
 *     <runtime-dir>/hub-<key>.log    the hub's own stdout/stderr
 *     <runtime-dir>/hub-<key>.lock   the start mutex (O_EXCL)
 *     <runtime-dir>/hub-<key>.state.json  persistent (detached) registrations
 *
 * `key` is derived from the resolved board URL and a fingerprint of the token,
 * never the token itself. Starting is a detached spawn, which is the only
 * primitive that survives a harness that tears down its command's process group
 * (codex does; see `docs/events.md`).
 *
 * Node builtins only. No board access here.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DomainError } from "../../foundation/errors.mjs";

/** The socket protocol generation. A client with another number is refused. */
export const HUB_PROTOCOL = 1;

/** A hub with nothing to serve exits after this long. Persistent registrations keep it alive. */
export const HUB_IDLE_MS = 5 * 60 * 1000;

/** How long a client waits for a freshly spawned hub to publish its pointer. */
export const HUB_START_TIMEOUT_MS = 10_000;

/** A lock older than this belongs to a start that died; it may be reclaimed. */
const LOCK_STALE_MS = 60_000;

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

/** @param {string} dir */
export function ensureHubDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a shared filesystem may refuse chmod; the contents are still 0600 */
  }
}

/** @param {string} path */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * An atomic, owner-only JSON file. The temp name is unique per process and
 * moment; the rename is the visible publish.
 *
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonFile(path, value) {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

/** @param {string} path */
export function removeFile(path) {
  rmSync(path, { force: true });
}

/**
 * `kill(pid, 0)` with the repo's EPERM-means-alive convention.
 *
 * @param {unknown} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Claim the start mutex. Returns `{ok:false}` when another starter owns it.
 *
 * @param {string} path
 * @returns {{ok: boolean}}
 */
export function acquireLock(path) {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
    return { ok: true };
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false };
    throw err;
  }
}

/** Release a lock this process owns. */
export function releaseLock(path) {
  removeFile(path);
}

/**
 * A lock is stale when its owner is gone or it has been held far longer than a
 * start should take. A stale lock is removed by the next starter.
 *
 * @param {string} path
 * @param {() => number} now
 */
export function lockIsStale(path, now = Date.now) {
  const lock = readJsonFile(path);
  if (lock === null) return true;
  if (!pidAlive(lock.pid)) return true;
  return now() - Number(lock.startedAt ?? 0) > LOCK_STALE_MS;
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
 * The token is the **hub's** token from the pointer, not the board token: the
 * pointer is the only place the local credential is published, and the file is
 * 0600.
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
  ensureHubDir(paths.dir);

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

  ensureHubDir(paths.dir);
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
