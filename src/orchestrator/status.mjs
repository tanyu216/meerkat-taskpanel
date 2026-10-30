#!/usr/bin/env node
/**
 * The supervisor's runtime status — and the one explicit takeover a live
 * session may perform.
 *
 * The loop has one control turn and one dispatcher (the resident pool). This
 * entry answers "who is driving it right now?" from facts, never from a guess:
 *
 *   * the pool's own state file (`sessions.state.json`: poolPid + heartbeat);
 *   * `session.lock` (the pool is starting);
 *   * the continue files (a turn is pending, processing or one-shot);
 *   * the subscriber state (the event daemon is alive);
 *   * the installed units (launchd / systemd / cron) — "configured but idle"
 *     must not be mistaken for "absent", or a session would race the service
 *     manager for the same pool.
 *
 * `--take-over` starts the pool in **external control** mode: the pool keeps
 * the project sessions and the card queue, while the live session runs the
 * control turn. It refuses whenever anything else could own the loop, and it
 * records the pid so `--stop` only ever stops what this command started.
 *
 * Node builtins only.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../foundation/entry-guard.mjs";

import { AGENT_DIRS, parseArgs, resolveLoopConfig, resolveScanSet } from "./options.mjs";
import { readContinue } from "./queue.mjs";
import {
  isProcessAlive,
  loadContinueLock,
  loadSubscribeState,
  subscribeStatePath,
} from "./runtime.mjs";
import { SESSION_LOCK_FILE, poolStatus } from "./session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(HERE, "supervisor.mjs");
const SESSION_RECORD = "supervisor.session.json";
const UNITS = Object.freeze(["session", "ping", "continue", "subscribe"]);

const USAGE = `Usage: taskctl loop status [--json] [--agent <name>] [--actor-kind <kind>]
         [--state <path>] [--log <path>] [--config <path>]
         [--take-over | --stop]

Reports whether a supervisor/pool is running and what is driving it.
  --take-over  start the pool in external-control mode (explicit; refuses unless absent)
  --stop       stop the pool this session started
Nothing here is a scheduler: status only reads, and a takeover is one pool.`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `<stateDir>/supervisor.session.json` — the pool this session started. */
function recordPath(opts) {
  return join(dirname(String(opts.state)), SESSION_RECORD);
}

function defaultRun(command, args) {
  const out = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
    error: out.error ?? null,
  };
}

/**
 * Unit load state, all three mechanisms. A missing binary or manager is
 * "not loaded", never an error.
 *
 * @param {object} opts
 * @param {{run?: (command: string, args: string[]) => object}} [deps]
 */
export function probeUnits(opts, deps = {}) {
  const run = deps.run ?? defaultRun;
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : "agent";
  const kind = opts.actorKind ?? "claude";
  const uid = process.getuid?.() ?? 0;
  const agentDirName = AGENT_DIRS[kind] ?? AGENT_DIRS.claude;
  const marker = `# >>> meerkat-taskpanel (~/${agentDirName}) >>>`;

  const label = (unit) => `com.meerkat-taskpanel.${agent}.${kind}.${unit}`;
  const launchdUnits = {};
  for (const unit of UNITS) {
    launchdUnits[unit] = run("launchctl", ["print", `gui/${uid}/${label(unit)}`]).status === 0;
  }

  const systemdNames = {
    session: "meerkat-taskpanel-session.service",
    ping: "meerkat-taskpanel-ping.timer",
    continue: "meerkat-taskpanel-continue.timer",
    subscribe: "meerkat-taskpanel-subscribe.service",
  };
  const systemdUnits = {};
  for (const [unit, name] of Object.entries(systemdNames)) {
    systemdUnits[unit] = run("systemctl", ["--user", "is-enabled", name]).status === 0;
  }

  const crontab = run("crontab", ["-l"]);
  const cronBlock = crontab.status === 0 && String(crontab.stdout ?? "").includes(marker);

  const any = (units) => Object.values(units).some(Boolean);
  return {
    agent,
    kind,
    launchd: { loaded: launchdUnits, any: any(launchdUnits) },
    systemd: { loaded: systemdUnits, any: any(systemdUnits) },
    cron: { loaded: { block: cronBlock }, any: cronBlock },
    any: any(launchdUnits) || any(systemdUnits) || cronBlock,
  };
}

/**
 * The runtime verdict. `verdict` is one of:
 * `running | busy | starting | configured-idle | partial | absent`.
 *
 * @param {object} opts
 * @param {{isAlive?: Function, now?: Function, run?: Function}} [deps]
 */
export function probeSupervisor(opts, deps = {}) {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const stateDir = dirname(String(opts.state));

  const pool = poolStatus({ opts, isAlive, now });
  const sessions =
    readJson(opts.sessionState ?? join(stateDir, "sessions.state.json")) ?? null;
  const controlMode = sessions?.controlMode === "external" ? "external" : "internal";
  const lock = readJson(join(stateDir, SESSION_LOCK_FILE));
  const starting =
    pool.live !== true && Number.isInteger(lock?.pid) && isAlive(lock.pid);

  const continueState = readContinue(stateDir);
  const oneShot = loadContinueLock(opts.continueState);
  const subscribeState = loadSubscribeState(subscribeStatePath(stateDir));
  const subscribeLive =
    Number.isInteger(subscribeState?.pid) && isAlive(subscribeState.pid);

  const units = probeUnits(opts, deps);
  const record = readJson(recordPath(opts));
  const recordLive =
    record !== null && Number.isInteger(record.poolPid) && isAlive(record.poolPid);

  let verdict;
  if (oneShot !== null || continueState.processing !== null) verdict = "busy";
  else if (pool.live === true) verdict = "running";
  else if (starting) verdict = "starting";
  else if (units.any) verdict = "configured-idle";
  else if (subscribeLive || continueState.pending !== null) verdict = "partial";
  else verdict = "absent";

  // The scan set the loop will use, resolved exactly as the loop resolves it. This is
  // what tells a team install whether its roles can ever be claimed: a name outside
  // this list is never scanned, and its cards strand. Status is a read, so a config it
  // cannot resolve falls back to the names it was given rather than failing.
  let agents = Array.isArray(opts.agents) ? [...opts.agents] : [];
  try {
    // `--agent` on a status call names the *units* (the shim supplies one on every
    // invocation); it is not the scan set. Passing it through would report the
    // installer's default exactly when the question matters — "does the config's team
    // get scanned?" — so the scan set is resolved without it, from the config/env.
    const scan = resolveScanSet([], opts);
    agents = resolveLoopConfig({ ...opts, agents: scan }).scanAgents;
  } catch {
    // fall through with the names from the command line
  }

  return {
    verdict,
    agents,
    pool: {
      ...pool,
      starting,
      controlMode,
      lockPid: Number.isInteger(lock?.pid) ? lock.pid : null,
    },
    continue: {
      pending: continueState.pending !== null,
      processing: continueState.processing !== null,
      oneShot: oneShot === null ? null : { pid: oneShot.pid ?? null, startedAt: oneShot.startedAt ?? null },
    },
    subscribe: {
      live: subscribeLive,
      pid: subscribeState?.pid ?? null,
      connectedAt: subscribeState?.connectedAt ?? null,
      nextAttemptAt: subscribeState?.nextAttemptAt ?? null,
    },
    units,
    sessionStarted: record === null ? null : { ...record, live: recordLive },
  };
}

/**
 * Start the pool in external-control mode. Refuses unless the verdict is
 * `absent`; the caller (the skill) owns the human confirmation.
 *
 * @param {object} opts
 * @param {{spawn?: Function, isAlive?: Function, now?: Function, sleep?: Function,
 *          waitMs?: number, pollMs?: number, run?: Function}} [deps]
 */
export async function takeOver(opts, deps = {}) {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawnFn = deps.spawn ?? spawn;
  const report = probeSupervisor(opts, deps);
  if (report.verdict !== "absent") {
    return { ok: false, reason: `supervisor is ${report.verdict}` };
  }

  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : "agent";
  const args = [
    SUPERVISOR,
    "--session",
    "--control=external",
    "--actor-kind",
    opts.actorKind,
    "--agent",
    agent,
    "--log",
    opts.log,
    "--state",
    opts.state,
  ];
  if (opts.config) args.push("--config", opts.config);
  if (opts.repo) args.push("--repo", opts.repo);

  const child = spawnFn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: opts.repo ?? process.cwd(),
    env: process.env,
  });
  child.unref?.();

  const record = {
    version: 1,
    poolPid: child.pid,
    controlMode: "external",
    startedAt: new Date(now()).toISOString(),
    log: opts.log,
    config: opts.config ?? null,
  };
  writeJson(recordPath(opts), record);

  const deadline = now() + (deps.waitMs ?? 30_000);
  while (now() < deadline) {
    if (poolStatus({ opts, isAlive, now }).live === true) {
      return { ok: true, poolPid: child.pid, log: opts.log, stop: "status.mjs --stop" };
    }
    if (!isAlive(child.pid)) break;
    await sleep(deps.pollMs ?? 200);
  }
  return {
    ok: false,
    reason: "the pool did not come up",
    poolPid: child.pid,
    log: opts.log,
    stop: "status.mjs --stop",
  };
}

/**
 * Stop only the pool recorded by `takeOver`. An installed supervisor is never
 * touched: its service manager owns it.
 *
 * @param {object} opts
 * @param {{kill?: Function, isAlive?: Function, now?: Function, sleep?: Function,
 *          waitMs?: number, pollMs?: number}} [deps]
 */
export async function stopSupervisor(opts, deps = {}) {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const path = recordPath(opts);
  const record = readJson(path);
  if (record === null || !Number.isInteger(record.poolPid)) {
    return { ok: false, reason: "no session-started supervisor" };
  }
  if (!isAlive(record.poolPid)) {
    rmSync(path, { force: true });
    return { ok: true, already: true, poolPid: record.poolPid };
  }
  try {
    kill(record.poolPid, "SIGTERM");
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const deadline = now() + (deps.waitMs ?? 15_000);
  while (now() < deadline && isAlive(record.poolPid)) {
    await sleep(deps.pollMs ?? 200);
  }
  if (isAlive(record.poolPid)) {
    return { ok: false, reason: `pid ${record.poolPid} did not stop` };
  }
  rmSync(path, { force: true });
  return { ok: true, poolPid: record.poolPid };
}

function humanReport(report) {
  const pool = report.pool.live
    ? `running (pid ${report.pool.poolPid}, control ${report.pool.controlMode}, heartbeat ${Math.round((report.pool.heartbeatAgeMs ?? 0) / 1000)}s)`
    : report.pool.starting
      ? `starting (lock pid ${report.pool.lockPid ?? "?"})`
      : `not running (${report.pool.reason})`;
  const units = [
    ...Object.entries(report.units.launchd.loaded).map(([u, v]) => `launchd:${u}=${v ? "loaded" : "not loaded"}`),
    ...Object.entries(report.units.systemd.loaded).map(([u, v]) => `systemd:${u}=${v ? "enabled" : "not enabled"}`),
    `cron:block=${report.units.cron.any ? "present" : "absent"}`,
  ].join(", ");
  return [
    `supervisor: ${report.verdict}`,
    `  pool:      ${pool}`,
    `  continue:  ${report.continue.processing ? "processing" : report.continue.pending ? "pending" : report.continue.oneShot ? `one-shot pid ${report.continue.oneShot.pid}` : "idle"}`,
    `  subscribe: ${report.subscribe.live ? `running (pid ${report.subscribe.pid})` : "not running"}`,
    `  agents:    ${report.agents.length > 0 ? report.agents.join(",") : "(none)"}`,
    `  units:     ${units}`,
    ...(report.sessionStarted === null
      ? []
      : [`  session:   started pid ${report.sessionStarted.poolPid}${report.sessionStarted.live ? "" : " (gone)"}`]),
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env, deps = {}, io = {}) {
  const writeOut = io.out ?? ((text) => process.stdout.write(text));
  const writeErr = io.err ?? ((text) => process.stderr.write(text));
  const own = new Set(["--json", "--take-over", "--stop"]);
  const flags = argv.filter((arg) => own.has(arg));
  const rest = argv.filter((arg) => !own.has(arg));
  if (flags.includes("--take-over") && flags.includes("--stop")) {
    writeErr("status: choose one of --take-over or --stop\n");
    return 2;
  }

  let opts;
  try {
    opts = parseArgs(rest, env);
  } catch (error) {
    writeErr(`status: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    writeOut(`${USAGE}\n`);
    return 0;
  }

  const json = flags.includes("--json");
  const emit = (value, human) => {
    writeOut(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
  };

  if (flags.includes("--take-over")) {
    const result = await takeOver(opts, deps);
    emit(
      result,
      result.ok
        ? `supervisor: started pool pid ${result.poolPid} (external control)\n  log: ${result.log}\n  stop: ${result.stop}`
        : `supervisor: takeover refused — ${result.reason}`,
    );
    return result.ok ? 0 : 1;
  }
  if (flags.includes("--stop")) {
    const result = await stopSupervisor(opts, deps);
    emit(
      result,
      result.ok
        ? `supervisor: stopped pool pid ${result.poolPid}${result.already ? " (already gone)" : ""}`
        : `supervisor: not stopped — ${result.reason}`,
    );
    return result.ok ? 0 : 1;
  }

  const report = probeSupervisor(opts, deps);
  emit(report, humanReport(report));
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
