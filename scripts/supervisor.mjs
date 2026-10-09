#!/usr/bin/env node
/**
 * The host-external supervisor — the loop Claude Code and Codex do not have.
 *
 * Claude Code and Codex only run when something opens a session; they have no
 * timers. So the "cheap 1-minute scan → atomic claim → wake a worker → 5-minute
 * patrol" loop they need cannot live inside them. It lives here, outside the
 * host, and the host is just the worker that gets woken.
 *
 * One **tick**:
 *
 *   1. **scan** — for each agent, run `taskctl issue candidates` (a local CLI
 *      read: $0, no LLM). An empty scan plans no work, so nothing is spawned.
 *   2. **claim** — for every planned wake, move the card to `in_progress` first.
 *      The board's CAS is the *only* dispatch: if the claim is refused, no
 *      worker is started. Waking is therefore idempotent and bounded.
 *   3. **wake** — start the host worker (`claude -p` / `codex exec` / `pi run`)
 *      with a fresh, bounded handoff, then record its pid in the state file.
 *   4. **patrol** — a slower pass over `in_progress` cards: a heartbeat older
 *      than 30 minutes is escalated, and a heartbeat that cannot be read is
 *      *reported*, never silently dropped. No LLM turn by default.
 *
 * The decision half is pure and lives in `src/shared/scheduling.mjs`; this file
 * is the I/O half. That split is what lets `test/scheduling/supervisor.test.mjs`
 * prove "an empty scan spawns nothing" with an injected spy instead of a board.
 *
 * Usage:
 *   node scripts/supervisor.mjs --host claude --agent alice [--once]
 *   node scripts/supervisor.mjs --agent alice,bob --poll-interval 60 --patrol-interval 300
 *
 * Run with: node scripts/supervisor.mjs --help
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_POLL_SECONDS,
  buildHandoff,
  candidateArgs,
  parseEnvFile,
  planPatrol,
  planTick,
  pruneRegistry,
  resolveClaimUnassigned,
  wakeCommand,
} from "../src/shared/scheduling.mjs";

// Re-exported so a caller can import the whole supervisor surface from one place.
export {
  buildHandoff,
  candidateArgs,
  planPatrol,
  planTick,
  pruneRegistry,
  resolveClaimUnassigned,
  wakeCommand,
};

/** Host → dot-directory under the target home. */
export const HOST_DIRS = Object.freeze({ claude: ".claude", codex: ".codex", pi: ".agents" });

const USAGE = `Usage: node scripts/supervisor.mjs [options]

A host-external supervisor: scan, claim, wake a worker, patrol.

Options:
  --agent <name>          Agent(s) to work for. Repeatable / comma-separated.
                          Default: $TASKCTL_AGENT, then $USER.
  --host claude|codex|pi  Which worker to wake (default: claude).
  --repo <path>           Repository root (default: this checkout).
  --poll-interval <sec>   Poll cadence in loop mode (default: ${DEFAULT_POLL_SECONDS}).
  --patrol-interval <sec> Patrol cadence in loop mode (default: ${DEFAULT_PATROL_SECONDS}).
  --max-concurrency <n>   Max concurrently running workers (default: ${DEFAULT_MAX_CONCURRENCY}).
  --claim-unassigned=yes|no   Also claim unassigned cards (the public pool). Default: yes.
  --assignee-only         Alias for --claim-unassigned=no.
  --once                  Run a single tick and exit (for tests / cron): the poll
                          pass, or the patrol pass with --patrol-only.
  --patrol-only           With --once, run only the patrol pass.
  --patrol-llm=yes|no     Allow patrol to start an LLM turn (default: no).
  --notify <cmd>          Run <cmd> with each patrol alert as JSON on stdin.
  --dry-run               Print intended actions; claim nothing, spawn nothing.
  --log <path>            Append log lines here (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.log).
  --state <path>          Running-registry file (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.state.json).
  --config <path>         Host config file to read the default from (default: <home>/<host-dir>/meerkat-taskpanel.env).
  --home <path>           Home the defaults are resolved against (default: $HOME).
  --cli <path>            taskctl entry to read/claim through (default: <repo>/src/cli/index.mjs).
  -h, --help              Show this help
`;

// ---------------------------------------------------------------------------
// The pure decision is imported; the two runners below apply it with injected
// side effects, so tests can supply spies.
// ---------------------------------------------------------------------------

/**
 * One poll pass.
 *
 * @param {{
 *   agents: string[],
 *   registry: object,
 *   config: object,
 *   readCandidates: (agent: string, opts: {claimUnassigned: boolean}) => Promise<object[]>,
 *   claim: (identifier: string, agent: string) => Promise<{ok: boolean, error?: string}>,
 *   spawnWorker: (action: object, card: object|undefined) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runPollTick(deps) {
  const { agents, registry, config, readCandidates, claim, spawnWorker, now, log } = deps;

  const candidates = [];
  for (const agent of agents) {
    const found = await readCandidates(agent, { claimUnassigned: config.claimUnassigned === true });
    for (const candidate of found ?? []) candidates.push({ ...candidate, agent: candidate.agent ?? agent });
  }

  const actions = planTick({ candidates, registry, config });
  const cardById = new Map();
  for (const candidate of candidates) cardById.set(String(candidate.identifier), candidate);

  let spawned = 0;
  let claimed = 0;
  let conflicts = 0;
  let failed = 0;

  for (const action of actions) {
    if (action.type === "skip") {
      log(`skip ${action.identifier} (${action.why})`);
      continue;
    }

    // Atomic claim first: the board (not the supervisor) decides the winner.
    const verdict = await claim(action.identifier, action.agent);
    if (!verdict?.ok) {
      conflicts += 1;
      log(`claim refused ${action.identifier} (${verdict?.error ?? "conflict"}) — not waking`);
      continue;
    }
    claimed += 1;

    const outcome = await spawnWorker(action, cardById.get(action.identifier));
    if (!outcome?.ok) {
      // Honest failure: a card we could not wake is not "running".
      failed += 1;
      log(`wake failed ${action.identifier}: ${outcome?.error ?? "unknown error"}`);
      continue;
    }
    spawned += 1;
    if (outcome.pid !== undefined && outcome.pid !== null) {
      registry.running[action.identifier] = { agent: action.agent, pid: outcome.pid, startedAt: now() };
    }
    log(`woke ${action.identifier} for ${action.agent} (${action.reason})${outcome.pid ? ` pid ${outcome.pid}` : " [dry-run]"}`);
  }

  return { actions, spawned, claimed, conflicts, failed };
}

/**
 * One patrol pass. Alerts are logged and notified; the LLM stays off unless
 * `config.patrolLlm` is explicitly on.
 *
 * @param {{
 *   tasks: object[],
 *   config: object,
 *   spawnPatrol: (alert: object) => Promise<{ok: boolean}>,
 *   notify: (alert: object) => void,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runPatrolTick(deps) {
  const { tasks, config, spawnPatrol, notify, now, log } = deps;
  const alerts = planPatrol({ tasks, now: now() });

  let spawns = 0;
  for (const alert of alerts) {
    log(alert.type === "stale"
      ? `patrol: stale ${alert.identifier} (heartbeat ${Math.round(alert.ageMs / 60_000)}m old)`
      : `patrol: heartbeat-unreadable ${alert.identifier} (${alert.reason})`);
    notify(alert);
    if (config.patrolLlm === true && alert.type === "stale") {
      const outcome = await spawnPatrol(alert);
      if (outcome?.ok) spawns += 1;
    }
  }
  return { alerts, spawns };
}

// ---------------------------------------------------------------------------
// Registry (crash survival) + process liveness
// ---------------------------------------------------------------------------

/** @returns {boolean} whether a pid is still alive. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by another user — still alive.
    return err?.code === "EPERM";
  }
}

/** Read the running registry; a missing/corrupt file is an empty registry, never a crash. */
export function loadRegistry(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.running && typeof parsed.running === "object") return parsed;
  } catch {
    // Missing or unreadable — start clean.
  }
  return { version: 1, running: {} };
}

/** Persist the running registry. */
export function saveRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv, env = process.env) {
  const opts = {
    agents: [],
    host: "claude",
    repo: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    pollInterval: DEFAULT_POLL_SECONDS,
    patrolInterval: DEFAULT_PATROL_SECONDS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    claimUnassigned: undefined,
    once: false,
    patrolOnly: false,
    patrolLlm: false,
    notify: null,
    dryRun: false,
    log: null,
    state: null,
    config: null,
    home: env.HOME || env.USERPROFILE || homedir(),
    cli: null,
    help: false,
  };

  const number = (flag, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a number, got '${raw}'`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (flag) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (arg === "--agent") opts.agents.push(...take("--agent").split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg.startsWith("--agent=")) opts.agents.push(...arg.slice(8).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--host") opts.host = take("--host");
    else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
    else if (arg === "--repo") opts.repo = resolve(take("--repo"));
    else if (arg.startsWith("--repo=")) opts.repo = resolve(arg.slice(7));
    else if (arg === "--poll-interval") opts.pollInterval = number("--poll-interval", take("--poll-interval"));
    else if (arg.startsWith("--poll-interval=")) opts.pollInterval = number("--poll-interval", arg.slice(16));
    else if (arg === "--patrol-interval") opts.patrolInterval = number("--patrol-interval", take("--patrol-interval"));
    else if (arg.startsWith("--patrol-interval=")) opts.patrolInterval = number("--patrol-interval", arg.slice(18));
    else if (arg === "--max-concurrency") opts.maxConcurrency = number("--max-concurrency", take("--max-concurrency"));
    else if (arg.startsWith("--max-concurrency=")) opts.maxConcurrency = number("--max-concurrency", arg.slice(18));
    else if (arg === "--claim-unassigned") opts.claimUnassigned = take("--claim-unassigned");
    else if (arg.startsWith("--claim-unassigned=")) opts.claimUnassigned = arg.slice(19);
    else if (arg === "--assignee-only") opts.claimUnassigned = "no";
    else if (arg === "--once") opts.once = true;
    else if (arg === "--patrol-only") opts.patrolOnly = true;
    else if (arg === "--patrol-llm") opts.patrolLlm = true;
    else if (arg.startsWith("--patrol-llm=")) opts.patrolLlm = /^(yes|true|1|y|on)$/i.test(arg.slice(13));
    else if (arg === "--notify") opts.notify = take("--notify");
    else if (arg.startsWith("--notify=")) opts.notify = arg.slice(9);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--log") opts.log = take("--log");
    else if (arg.startsWith("--log=")) opts.log = arg.slice(6);
    else if (arg === "--state") opts.state = take("--state");
    else if (arg.startsWith("--state=")) opts.state = arg.slice(8);
    else if (arg === "--config") opts.config = take("--config");
    else if (arg.startsWith("--config=")) opts.config = arg.slice(9);
    else if (arg === "--home") opts.home = resolve(take("--home"));
    else if (arg.startsWith("--home=")) opts.home = resolve(arg.slice(7));
    else if (arg === "--cli") opts.cli = take("--cli");
    else if (arg.startsWith("--cli=")) opts.cli = arg.slice(6);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  if (opts.agents.length === 0) {
    const fallback = env.TASKCTL_AGENT || env.USER || env.LOGNAME || "agent";
    opts.agents = [fallback];
  }
  if (!(opts.host in HOST_DIRS)) throw new Error(`unknown host '${opts.host}' (expected claude|codex|pi)`);

  const hostDir = HOST_DIRS[opts.host];
  opts.log ??= join(opts.home, hostDir, "meerkat-taskpanel", "supervisor.log");
  opts.state ??= join(opts.home, hostDir, "meerkat-taskpanel", "supervisor.state.json");
  opts.config ??= join(opts.home, hostDir, "meerkat-taskpanel.env");
  opts.cli ??= join(opts.repo, "src", "cli", "index.mjs");
  return opts;
}

// ---------------------------------------------------------------------------
// Real (default) dependencies
// ---------------------------------------------------------------------------

/** Run the taskctl CLI and parse its `--json` envelope. Returns `{ok, data|error}`. */
function runCli(opts, agent, args, { input = null } = {}) {
  const run = spawnSync(process.execPath, [opts.cli, "--json", "--agent", agent, ...args], {
    encoding: "utf8",
    input,
    env: process.env,
  });
  if (run.error) return { ok: false, error: run.error.message };
  try {
    const parsed = JSON.parse(run.stdout ?? "");
    return parsed?.ok === true ? { ok: true, data: parsed.data ?? {} } : { ok: false, error: parsed?.error?.message ?? `exit ${run.status}` };
  } catch {
    return { ok: false, error: (run.stderr ?? "").trim() || `exit ${run.status}` };
  }
}

function readConfigFile(path) {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function spawnWorkerReal(opts, config) {
  return (action, card) => {
    const prompt = buildHandoff({ card: card ?? { identifier: action.identifier }, agent: action.agent, host: opts.host });
    const cmd = wakeCommand({ host: opts.host, prompt, wakeCommand: config.wakeCommand ?? null });
    return new Promise((resolveResult) => {
      const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore" });
      child.once("error", (err) => resolveResult({ ok: false, error: err.message }));
      child.once("spawn", () => {
        child.unref();
        resolveResult({ ok: true, pid: child.pid });
      });
    });
  };
}

function notifyReal(opts, log) {
  return (alert) => {
    if (!opts.notify) return;
    const run = spawnSync(opts.notify, { shell: true, input: JSON.stringify(alert), encoding: "utf8" });
    if (run.error) log(`notify failed: ${run.error.message}`);
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`supervisor: ${err.message}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`supervisor: ${line}\n`);
    if (!opts.dryRun) {
      try {
        mkdirSync(dirname(opts.log), { recursive: true });
        appendFileSync(opts.log, `${stamped}\n`);
      } catch {
        // Logging must never take the supervisor down.
      }
    }
  };

  const configFile = readConfigFile(opts.config);
  const claimUnassigned = resolveClaimUnassigned({
    flag: opts.claimUnassigned,
    // legacy-name-compat: accept the pre-rename env var too.
    env: env.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED ?? env.TASKPANEL_CLAIM_UNASSIGNED,
    file: configFile,
  });
  const config = { maxConcurrency: opts.maxConcurrency, claimUnassigned, patrolLlm: opts.patrolLlm, host: opts.host };

  const registry = opts.dryRun
    ? { version: 1, running: {} }
    : pruneRegistry(loadRegistry(opts.state), isProcessAlive);

  const deps = {
    agents: opts.agents,
    registry,
    config,
    readCandidates: (agent, { claimUnassigned: pool }) => {
      const read = runCli(opts, agent, candidateArgs(agent, pool));
      if (!read.ok) {
        log(`scan failed for ${agent}: ${read.error}`);
        return [];
      }
      return read.data.candidates ?? [];
    },
    claim: (identifier, agent) => {
      if (opts.dryRun) return { ok: true };
      const moved = runCli(opts, agent, ["issue", "move", identifier, "in_progress"]);
      return moved.ok ? { ok: true } : { ok: false, error: moved.error };
    },
    spawnWorker: opts.dryRun ? async () => ({ ok: true, pid: null }) : spawnWorkerReal(opts, config),
    now: () => new Date().toISOString(),
    log,
  };

  log(`tick: host=${opts.host} agents=${opts.agents.join(",")} claim_unassigned=${claimUnassigned ? "yes" : "no"}${opts.dryRun ? " (dry-run)" : ""}`);

  let failed = 0;

  if (!opts.patrolOnly) {
    const poll = await runPollTick(deps);
    failed += poll.failed;
    log(`poll: ${poll.actions.length} action(s), ${poll.spawned} woke, ${poll.conflicts} refused, ${poll.failed} failed`);
  }

  if (opts.once) {
    // Each scheduling unit drives exactly one layer: the poll line above, or the
    // patrol pass here. Keeping them separate is the whole point of the two-layer
    // design — a 1-minute poll must not sweep every in_progress card every minute.
    if (opts.patrolOnly) {
      const read = opts.dryRun ? { ok: false } : readInProgress(opts, log);
      const patrol = await runPatrolTick({
        tasks: read.ok ? read.data.tasks ?? [] : [],
        config,
        spawnPatrol: async (alert) => {
          if (opts.dryRun) return { ok: false };
          const card = { identifier: alert.identifier };
          return spawnWorkerReal(opts, config)({ identifier: alert.identifier, agent: alert.agent ?? opts.agents[0] }, card);
        },
        notify: opts.dryRun ? () => {} : notifyReal(opts, log),
        now: () => new Date().toISOString(),
        log,
      });
      log(`patrol: ${patrol.alerts.length} alert(s), ${patrol.spawns} LLM turn(s)`);
    }
    if (!opts.dryRun) saveRegistry(opts.state, registry);
    return failed > 0 ? 1 : 0;
  }

  // Loop mode: poll and patrol on their own cadences.
  const pollTimer = setInterval(async () => {
    try {
      const poll = await runPollTick(deps);
      log(`poll: ${poll.actions.length} action(s), ${poll.spawned} woke, ${poll.conflicts} refused, ${poll.failed} failed`);
      if (!opts.dryRun) saveRegistry(opts.state, registry);
    } catch (err) {
      log(`poll error: ${err.message}`);
    }
  }, Math.max(1, opts.pollInterval) * 1000);

  const patrolTimer = setInterval(async () => {
    try {
      const read = readInProgress(opts, log);
      await runPatrolTick({
        tasks: read.ok ? read.data.tasks ?? [] : [],
        config,
        spawnPatrol: async () => ({ ok: false }),
        notify: notifyReal(opts, log),
        now: () => new Date().toISOString(),
        log,
      });
    } catch (err) {
      log(`patrol error: ${err.message}`);
    }
  }, Math.max(1, opts.patrolInterval) * 1000);

  // The ref'd timers keep the loop alive; a signal persists the registry first.
  const shutdown = () => {
    clearInterval(pollTimer);
    clearInterval(patrolTimer);
    if (!opts.dryRun) saveRegistry(opts.state, registry);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Loop mode never resolves: the supervisor is a daemon until signalled.
  return await new Promise(() => {});
}

/** Read every in_progress card (patrol's input). */
function readInProgress(opts, log) {
  const read = runCli(opts, opts.agents[0], ["issue", "list", "--status", "in_progress"]);
  if (!read.ok) {
    log(`patrol scan failed: ${read.error}`);
    return { ok: false };
  }
  return read;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
