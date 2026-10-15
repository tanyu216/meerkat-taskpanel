/**
 * The CLI test harness (§F-E1, §F-E2).
 *
 * Every case runs a *real* `taskctl` process against a *real* `taskd` process,
 * both on loopback with ephemeral ports — the same two processes production
 * runs, wired the same way (a runtime pointer, a token file, `TASKD_*` env).
 *
 * Why a **separate** daemon process rather than an in-process server: the CLI is
 * started with `spawnSync`, which blocks this process's event loop for the whole
 * call. An in-process HTTP server would therefore be unable to answer, and every
 * test would deadlock until the client's timeout. A child daemon sidesteps that
 * and has the pleasant side effect of exercising `main.mjs` in every case.
 *
 * Isolation: each board gets a fresh `mkdtemp` data dir *and* a
 * `TASKD_RUNTIME_POINTER` inside it, so nothing here can touch `./.data` or a
 * developer's running board. Ports are always `0` — **never** the default 9527.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CLI = join(ROOT, "src", "cli", "index.mjs");
/** The daemon *program* (what autostart spawns); `index.mjs` is the library. */
export const SERVER = join(ROOT, "src", "server", "main.mjs");

/**
 * Environment keys a child must never inherit from the developer's shell.
 *
 * `USER`/`LOGNAME` are in the list for a different reason than the `TASKD_*`
 * ones: the CLI derives an unnamed actor from them, so leaving them in would
 * make `author_id` depend on who ran the suite. Tests must not be
 * machine-specific.
 */
const TASKD_VARS = [
  "TASKD_DATA_DIR",
  "TASKD_DB",
  "TASKD_PORT",
  "TASKD_HOST",
  "TASKD_TOKEN",
  "TASKD_RUNTIME_POINTER",
  "TASKD_NO_AUTOSTART",
  "TASKCTL_AGENT",
  "TASKCTL_AGENT_PLATFORM",
  "TASKCTL_SESSION_ID",
  "USER",
  "LOGNAME",
];

const tempDirs = [];

/** A temp dir removed by `cleanupTempDirs()` in an `after` hook. */
export function makeTempDir(prefix = "meerkat-taskpanel-cli-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove every temp dir this harness created. */
export function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** `process.env` with every meerkat-taskpanel variable stripped. */
export function baseEnv() {
  const env = { ...process.env };
  for (const key of TASKD_VARS) delete env[key];
  return env;
}

/** Poll until `predicate()` is true, or give up. */
export async function waitUntil(predicate, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Read a JSON file, or `null` when it is not there (yet). */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Start a real `taskd` on an ephemeral loopback port.
 *
 * @param {{dataDir?: string, env?: object, waitMs?: number}} [options]
 */
export async function startTaskd(options = {}) {
  const dataDir = options.dataDir ?? makeTempDir();
  const pointerPath = join(dataDir, "runtime.json");
  const env = {
    ...baseEnv(),
    TASKD_DATA_DIR: dataDir,
    TASKD_PORT: "0",
    TASKD_HOST: "127.0.0.1",
    TASKD_RUNTIME_POINTER: pointerPath,
    ...options.env,
  };

  const child = spawn(process.execPath, [SERVER], { env, stdio: "ignore", detached: false });
  const ready = await waitUntil(() => pointerIsHealthy(pointerPath), {
    timeoutMs: options.waitMs ?? 10_000,
  });
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(`taskd did not come up in ${dataDir}; see ${join(dataDir, "logs", "taskd.log")}`);
  }

  const pointer = readJsonFile(pointerPath);
  const token = readTokenFile(dataDir);
  return {
    dataDir,
    pointerPath,
    pointer,
    url: pointer.url,
    port: pointer.port,
    pid: child.pid,
    token,
    child,
    async close() {
      await stopProcess(child);
      return { pointerRemoved: existsSync(pointerPath) === false };
    },
  };
}

/** Is the address in the pointer answering? A miss is a `false`, never a throw. */
async function pointerIsHealthy(pointerPath) {
  const pointer = readJsonFile(pointerPath);
  if (pointer === null || typeof pointer.url !== "string") return false;
  try {
    const response = await fetch(`${pointer.url}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok" || body?.data?.status === "ok";
  } catch {
    return false;
  }
}

/** SIGTERM, wait, then SIGKILL if it will not go. */
export async function stopProcess(child, { timeoutMs = 5_000 } = {}) {
  if (child === null || child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  await exited;
  clearTimeout(timer);
}

/** The token `taskd` generated, read straight off the file. */
export function readTokenFile(dataDir) {
  try {
    return readFileSync(join(dataDir, "token"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Run the real CLI, synchronously.
 *
 * @param {string[]} args
 * @param {{url?: string|null, dataDir?: string, env?: object, input?: string, cwd?: string, timeout?: number, token?: string, noUrl?: boolean}} [options]
 */
export function runCli(args, options = {}) {
  const dataDir = options.dataDir ?? makeTempDir();
  const env = {
    ...baseEnv(),
    TASKD_DATA_DIR: dataDir,
    TASKD_RUNTIME_POINTER: join(dataDir, "runtime.json"),
    TASKD_PORT: "0",
    // Default-off: a case that wants autostart opts in explicitly (F-E2 keeps
    // that to exactly one case).
    TASKD_NO_AUTOSTART: "1",
    ...(options.token === undefined ? {} : { TASKD_TOKEN: options.token }),
    ...(options.env ?? {}),
  };
  const argv = [...args];
  if (options.url !== undefined && options.url !== null && options.noUrl !== true) {
    argv.push("--url", options.url);
  }
  const run = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    input: options.input,
    env,
    cwd: options.cwd ?? ROOT,
    timeout: options.timeout ?? 60_000,
  });
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    ok: run.status === 0,
  };
}

/**
 * A URL nothing is listening on.
 *
 * A *closed* port refuses immediately; a made-up one (`:1`) may sit in a
 * firewall's black hole for the full client timeout, which turns a unit test
 * into a two-minute wait. So bind port 0, learn the port, let it go.
 */
export async function closedPortUrl() {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** `--json` stdout, parsed. Throws with the raw output when it is not JSON. */
export function parseJson(run) {
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(
      `stdout is not JSON (${err.message})\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    );
  }
}

/** The `data` half of an `--json` success envelope. */
export function dataOf(run) {
  const envelope = parseJson(run);
  if (envelope.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(envelope)}`);
  return envelope.data;
}

/** The `error` half of an `--json` failure envelope. */
export function errorOf(run) {
  const envelope = parseJson(run);
  if (envelope.ok !== false) throw new Error(`expected ok:false, got ${JSON.stringify(envelope)}`);
  return envelope.error;
}

/**
 * Start a board, hand `fn` a CLI bound to it, and always stop the board.
 *
 * @param {(ctx: {run: Function, runNoUrl: Function, url: string, dataDir: string, token: string, taskd: object}) => any} fn
 */
export async function withCli(fn, options = {}) {
  const taskd = await startTaskd(options);
  try {
    return await fn({
      taskd,
      url: taskd.url,
      dataDir: taskd.dataDir,
      token: taskd.token,
      run: (args, opts = {}) => runCli(args, { url: taskd.url, dataDir: taskd.dataDir, ...opts }),
      runNoUrl: (args, opts = {}) => runCli(args, { dataDir: taskd.dataDir, ...opts }),
    });
  } finally {
    await taskd.close();
  }
}
