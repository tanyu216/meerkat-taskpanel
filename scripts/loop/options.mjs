#!/usr/bin/env node
/**
 * The loop's option surface — one parser for the scheduler and every entry.
 *
 * Keeping this in one place is what makes `node scripts/loop/poll.mjs` and
 * `node scripts/supervisor.mjs --once` mean the same thing: the entries and
 * the scheduler receive the same flags, the same host config and the same
 * defaults. The continue prompt re-serialises only the values a child entry
 * must share (`loopCommandArgs`), never the whole option object.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../src/shared/constants.mjs";
import {
  DEFAULT_CONTINUE_SECONDS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_PING_SECONDS,
  parseEnvFile,
  resolveClaimUnassigned,
  resolveContinueEnabled,
  resolveRecoverStale,
  resolveIntervalSeconds,
  resolveWorkflowConfig,
} from "../../src/shared/scheduling.mjs";
import {
  DEFAULT_BOARD_LIMIT,
  DEFAULT_TRAIL_LIMIT,
  LEADER_LOOKBACK_DAYS,
  PEER_LIVENESS_K,
  PEER_MECHANISM,
  PEER_PERIOD_MIN,
} from "../../src/shared/sla-patrol.mjs";

/** Host → dot-directory under the target home. */
export const HOST_DIRS = Object.freeze({ claude: ".claude", codex: ".codex", pi: ".agents" });

/** Parse a `KEY=value` env file, or `{}` when it is absent/unreadable. */
export function readConfigFile(path) {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The checkout whose `taskctl` this supervisor drives, for a run that was not told.
 *
 * There are two places a supervisor can run from, and they need different answers:
 *
 *   * **from the checkout** (`node scripts/supervisor.mjs`, the documented dev run
 *     and every test) — the board sits beside the executor, so the relative answer is
 *     the right one and nothing else is consulted. This branch is why a dev run never
 *     depends on the machine's host config.
 *   * **from the host** — `install.sh` copies the loop body under
 *     `<host-dir>/meerkat-taskpanel/` so a loaded scheduling unit survives the
 *     checkout moving. That copy has no board of its own, so it falls back to the
 *     location the installer recorded in the host config (`MEERKAT_TASKPANEL_REPO`).
 *
 * An unreadable or key-less config falls back to the executor's own location, which
 * is what a copy written by an older installer has — the tick still runs, and
 * re-running `install.sh` records the path.
 *
 * @param {string | null} configPath the host config file to consult
 * @param {string} [beside] the executor's own directory — injectable so the
 *   host-installed branch is testable without a second checkout on disk
 * @returns {string} an absolute directory
 */
export function defaultRepo(configPath, beside = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  if (existsSync(join(beside, "src", "cli", "index.mjs"))) return beside;
  const recorded = configPath === null ? null : readConfigFile(configPath).MEERKAT_TASKPANEL_REPO;
  return recorded ? resolve(recorded) : beside;
}

/** @param {string[]} argv */
export function parseArgs(argv, env = process.env) {
  const opts = {
    agents: [],
    host: "claude",
    repo: null,   // resolved below: --repo, else defaultRepo()
    pingInterval: undefined,     // resolved below: flag > env > host config > 60
    continueInterval: undefined, // resolved below: flag > env > host config > 600
    continue: undefined,
    continueState: null,
    patrolInterval: DEFAULT_PATROL_SECONDS, // the SLA measurement period, not a schedule
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    claimUnassigned: undefined,
    recoverStale: undefined,
    workflow: undefined,
    reviewer: undefined,
    autoAcceptReviews: undefined,
    workflowMaxActions: undefined,
    reviewAgingMinutes: undefined,
    once: false,
    pingOnly: false,
    continueOnly: false,
    patrolOnly: false,
    subscribe: false,
    url: null,
    token: null,
    sseIdleMs: undefined,
    eventDebounceMs: undefined,
    eventDebounceMaxMs: undefined,
    eventContinue: undefined,
    eventContinueMinMs: undefined,
    legacyPollInterval: false,
    patrolLlm: false,
    notify: null,
    dryRun: false,
    log: null,
    state: null,
    slaLedger: null,
    slaLeader: null,
    slaLastOk: null,
    slaPeer: null,
    slaLookbackDays: null,
    boardLimit: DEFAULT_BOARD_LIMIT,
    trailLimit: DEFAULT_TRAIL_LIMIT,
    config: null,
    home: env.HOME || env.USERPROFILE || homedir(),
    cli: null,
    glue: null,
    projectsJson: null,
    wakeCommand: null,
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
    else if (arg === "--ping-interval") opts.pingInterval = number("--ping-interval", take("--ping-interval"));
    else if (arg.startsWith("--ping-interval=")) opts.pingInterval = number("--ping-interval", arg.slice(16));
    else if (arg === "--continue-interval") opts.continueInterval = number("--continue-interval", take("--continue-interval"));
    else if (arg.startsWith("--continue-interval=")) opts.continueInterval = number("--continue-interval", arg.slice(20));
    else if (arg === "--continue") opts.continue = take("--continue");
    else if (arg.startsWith("--continue=")) opts.continue = arg.slice(11);
    else if (arg === "--continue-state") opts.continueState = take("--continue-state");
    else if (arg.startsWith("--continue-state=")) opts.continueState = arg.slice(17);
    // Deprecated alias: the old poll cadence now names the ping clock. The old
    // units pass a bare `--once`, not this flag, so the compatibility surface is
    // the mode selector, not this alias.
    else if (arg === "--poll-interval") {
      opts.pingInterval = number("--poll-interval", take("--poll-interval"));
      opts.legacyPollInterval = true;
    } else if (arg.startsWith("--poll-interval=")) {
      opts.pingInterval = number("--poll-interval", arg.slice(16));
      opts.legacyPollInterval = true;
    } else if (arg === "--patrol-interval") opts.patrolInterval = number("--patrol-interval", take("--patrol-interval"));
    else if (arg.startsWith("--patrol-interval=")) opts.patrolInterval = number("--patrol-interval", arg.slice(18));
    else if (arg === "--max-concurrency") opts.maxConcurrency = number("--max-concurrency", take("--max-concurrency"));
    else if (arg.startsWith("--max-concurrency=")) opts.maxConcurrency = number("--max-concurrency", arg.slice(18));
    else if (arg === "--claim-unassigned") opts.claimUnassigned = take("--claim-unassigned");
    else if (arg.startsWith("--claim-unassigned=")) opts.claimUnassigned = arg.slice(19);
    else if (arg === "--assignee-only") opts.claimUnassigned = "no";
    else if (arg === "--recover-stale") opts.recoverStale = take("--recover-stale");
    else if (arg.startsWith("--recover-stale=")) opts.recoverStale = arg.slice(16);
    else if (arg === "--workflow") opts.workflow = take("--workflow");
    else if (arg.startsWith("--workflow=")) opts.workflow = arg.slice(11);
    else if (arg === "--reviewer") opts.reviewer = take("--reviewer");
    else if (arg.startsWith("--reviewer=")) opts.reviewer = arg.slice(11);
    else if (arg === "--auto-accept-reviews") opts.autoAcceptReviews = take("--auto-accept-reviews");
    else if (arg.startsWith("--auto-accept-reviews=")) opts.autoAcceptReviews = arg.slice(22);
    else if (arg === "--workflow-max-actions") opts.workflowMaxActions = take("--workflow-max-actions");
    else if (arg.startsWith("--workflow-max-actions=")) opts.workflowMaxActions = arg.slice(23);
    else if (arg === "--review-aging-minutes") opts.reviewAgingMinutes = take("--review-aging-minutes");
    else if (arg.startsWith("--review-aging-minutes=")) opts.reviewAgingMinutes = arg.slice(23);
    else if (arg === "--once") opts.once = true;
    else if (arg === "--ping-only") opts.pingOnly = true;
    else if (arg === "--continue-only") opts.continueOnly = true;
    else if (arg === "--patrol-only") opts.patrolOnly = true;
    else if (arg === "--subscribe") opts.subscribe = true;
    else if (arg === "--url") opts.url = take("--url");
    else if (arg.startsWith("--url=")) opts.url = arg.slice(6);
    else if (arg === "--token") opts.token = take("--token");
    else if (arg.startsWith("--token=")) opts.token = arg.slice(8);
    else if (arg === "--sse-idle-ms") opts.sseIdleMs = number("--sse-idle-ms", take("--sse-idle-ms"));
    else if (arg.startsWith("--sse-idle-ms=")) opts.sseIdleMs = number("--sse-idle-ms", arg.slice(14));
    else if (arg === "--event-debounce-ms") opts.eventDebounceMs = number("--event-debounce-ms", take("--event-debounce-ms"));
    else if (arg.startsWith("--event-debounce-ms=")) opts.eventDebounceMs = number("--event-debounce-ms", arg.slice(20));
    else if (arg === "--event-debounce-max-ms") opts.eventDebounceMaxMs = number("--event-debounce-max-ms", take("--event-debounce-max-ms"));
    else if (arg.startsWith("--event-debounce-max-ms=")) opts.eventDebounceMaxMs = number("--event-debounce-max-ms", arg.slice(24));
    else if (arg === "--event-continue") opts.eventContinue = take("--event-continue");
    else if (arg.startsWith("--event-continue=")) opts.eventContinue = arg.slice(17);
    else if (arg === "--event-continue-min-ms") opts.eventContinueMinMs = number("--event-continue-min-ms", take("--event-continue-min-ms"));
    else if (arg.startsWith("--event-continue-min-ms=")) opts.eventContinueMinMs = number("--event-continue-min-ms", arg.slice(24));
    else if (arg === "--patrol-llm") opts.patrolLlm = true;
    else if (arg.startsWith("--patrol-llm=")) opts.patrolLlm = /^(yes|true|1|y|on)$/i.test(arg.slice(13));
    else if (arg === "--notify") opts.notify = take("--notify");
    else if (arg.startsWith("--notify=")) opts.notify = arg.slice(9);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--log") opts.log = take("--log");
    else if (arg.startsWith("--log=")) opts.log = arg.slice(6);
    else if (arg === "--state") opts.state = take("--state");
    else if (arg.startsWith("--state=")) opts.state = arg.slice(8);
    else if (arg === "--sla-ledger") opts.slaLedger = take("--sla-ledger");
    else if (arg.startsWith("--sla-ledger=")) opts.slaLedger = arg.slice(13);
    else if (arg === "--sla-leader") opts.slaLeader = take("--sla-leader");
    else if (arg.startsWith("--sla-leader=")) opts.slaLeader = arg.slice(13);
    else if (arg === "--sla-last-ok") opts.slaLastOk = take("--sla-last-ok");
    else if (arg.startsWith("--sla-last-ok=")) opts.slaLastOk = arg.slice(14);
    else if (arg === "--sla-peer") opts.slaPeer = take("--sla-peer");
    else if (arg.startsWith("--sla-peer=")) opts.slaPeer = arg.slice(11);
    else if (arg === "--board-limit") opts.boardLimit = number("--board-limit", take("--board-limit"));
    else if (arg.startsWith("--board-limit=")) opts.boardLimit = number("--board-limit", arg.slice(14));
    else if (arg === "--trail-limit") opts.trailLimit = number("--trail-limit", take("--trail-limit"));
    else if (arg.startsWith("--trail-limit=")) opts.trailLimit = number("--trail-limit", arg.slice(14));
    else if (arg === "--config") opts.config = take("--config");
    else if (arg.startsWith("--config=")) opts.config = arg.slice(9);
    else if (arg === "--home") opts.home = resolve(take("--home"));
    else if (arg.startsWith("--home=")) opts.home = resolve(arg.slice(7));
    else if (arg === "--cli") opts.cli = take("--cli");
    else if (arg.startsWith("--cli=")) opts.cli = arg.slice(6);
    else if (arg === "--glue") opts.glue = take("--glue");
    else if (arg.startsWith("--glue=")) opts.glue = arg.slice(7);
    else if (arg === "--projects-json") opts.projectsJson = take("--projects-json");
    else if (arg.startsWith("--projects-json=")) opts.projectsJson = arg.slice(16);
    else if (arg === "--wake-command") opts.wakeCommand = take("--wake-command");
    else if (arg.startsWith("--wake-command=")) opts.wakeCommand = arg.slice(15);
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
  // The continue lock lives beside the worker registry but never inside it: the
  // registry is the poll's concurrency gate, and a lock entry would consume a
  // worker slot.
  opts.continueState ??= join(dirname(opts.state), "continue.state.json");
  // The ledger sits beside the state file by default, so a host with a custom
  // --state keeps one directory for everything the supervisor remembers.
  opts.slaLedger ??= join(dirname(opts.state), "sla-ledger.json");
  // The liveness marker goes beside them, for the same reason — and it is the
  // path a peer deployment points its own `--sla-peer` at (`<mech>-last-ok.json`
  // is this mechanism's name for it, mirroring the peer's `sla-scan` marker).
  opts.slaLastOk ??= join(dirname(opts.state), "loop-patrol-last-ok.json");
  // The leader identity is deployable, not hard-coded (§3 of the contract).
  opts.slaLeader ??= env.MEERKAT_TASKPANEL_SLA_LEADER ?? null;
  opts.slaPeer ??= env.MEERKAT_TASKPANEL_SLA_PEER ?? null;
  // The leader lookback is a mechanism parameter with a default, not a knob a
  // deployment normally touches — it is read here so `planSlaPatrol`'s caller
  // states it rather than leaving it implicit.
  opts.slaLookbackDays ??= LEADER_LOOKBACK_DAYS;
  opts.config ??= join(opts.home, hostDir, "meerkat-taskpanel.env");
  opts.configFile = readConfigFile(opts.config);
  // Cadences follow the same precedence as every other policy: flag > env >
  // the host config the installer wrote > default. Invalid values are ignored,
  // never allowed to wedge a clock.
  opts.pingInterval = resolveIntervalSeconds({
    flag: opts.pingInterval,
    env: env.MEERKAT_TASKPANEL_PING_INTERVAL,
    file: opts.configFile.MEERKAT_TASKPANEL_PING_INTERVAL,
    fallback: DEFAULT_PING_SECONDS,
  });
  opts.continueInterval = resolveIntervalSeconds({
    flag: opts.continueInterval,
    env: env.MEERKAT_TASKPANEL_CONTINUE_INTERVAL,
    file: opts.configFile.MEERKAT_TASKPANEL_CONTINUE_INTERVAL,
    fallback: DEFAULT_CONTINUE_SECONDS,
  });
  opts.repo ??= defaultRepo(opts.config);
  opts.cli ??= join(opts.repo, "src", "cli", "index.mjs");
  // The two host-local artefacts a wake needs: the glue that owns the working
  // directory, and the project map it resolves that directory from. Both live
  // under the host's dot-directory, exactly where `install.sh` put them.
  opts.glue ??= join(opts.home, hostDir, "bin", `wake-${opts.host}.sh`);
  opts.projectsJson ??= join(opts.home, hostDir, "skills", "meerkat-taskpanel", "projects.json");
  // Event-subscriber defaults. A flag always wins; these are the values a
  // deployment never normally states.
  opts.sseIdleMs ??= SSE_SUBSCRIBE_IDLE_MS;
  opts.eventDebounceMs ??= EVENT_DEBOUNCE_MS;
  opts.eventDebounceMaxMs ??= EVENT_DEBOUNCE_MAX_MS;
  opts.eventContinueMinMs ??= EVENT_CONTINUE_MIN_MS;
  return opts;
}

/**
 * Which clock (or one-shot entry) this invocation selects.
 *
 * `null` means daemon: ping + continue. A bare `--once` remains the old
 * supervisor's behaviour on purpose — an upgrade without `--force` leaves the
 * previously installed poll unit in place, and that unit must keep discovering
 * work rather than silently becoming a ping. The installed units are explicit
 * (`--ping-only` / `--continue-only`).
 *
 * @param {object} opts
 * @returns {"ping"|"continue"|"patrol"|"poll"|"subscribe"|null}
 */
export function selectMode(opts) {
  if (opts.subscribe) {
    if (opts.once || opts.pingOnly || opts.continueOnly || opts.patrolOnly) {
      throw new Error("--subscribe is a daemon mode; it cannot be combined with --once or another selector");
    }
    if (opts.dryRun) {
      throw new Error("--subscribe is a daemon mode; --dry-run is not supported");
    }
    return "subscribe";
  }
  const selectors = [
    opts.pingOnly ? "ping" : null,
    opts.continueOnly ? "continue" : null,
    opts.patrolOnly ? "patrol" : null,
  ].filter(Boolean);
  if (selectors.length > 1) {
    throw new Error("choose one of --ping-only, --continue-only, --patrol-only");
  }
  if (selectors.length === 1) {
    if (!opts.once) throw new Error(`${selectors[0]} requires --once`);
    return selectors[0];
  }
  if (opts.once) return "poll";
  return null;
}

/**
 * The agents one poll scans: the configured workers, plus a dedicated reviewer
 * when one is configured. A reviewer that is also a worker keeps the normal
 * worker lane and is not scanned twice.
 *
 * @param {object} opts
 * @param {{workflow: boolean, reviewer: string|null}} workflow
 * @param {boolean} reviewerIsWorker
 * @returns {string[]}
 */
export function buildScanAgents(opts, workflow, reviewerIsWorker) {
  return workflow.workflow && workflow.reviewer !== null && !reviewerIsWorker
    ? [...opts.agents, workflow.reviewer]
    : [...opts.agents];
}

/**
 * Resolve the policies every entry shares, from the same flag/env/config
 * precedence the original supervisor used.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{config: object, reviewerIsWorker: boolean, scanAgents: string[], continueEnabled: boolean}}
 */
export function resolveLoopConfig(opts, env = process.env) {
  const configFile = opts.configFile ?? readConfigFile(opts.config);
  const claimUnassigned = resolveClaimUnassigned({
    flag: opts.claimUnassigned,
    // legacy-name-compat: accept the pre-rename env var too.
    env: env.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED ?? env.TASKPANEL_CLAIM_UNASSIGNED,
    file: configFile,
  });
  const recoverStale = resolveRecoverStale({
    flag: opts.recoverStale,
    env: env.MEERKAT_TASKPANEL_RECOVER_STALE,
    file: configFile,
  });
  const workflow = resolveWorkflowConfig({
    flags: {
      workflow: opts.workflow,
      reviewer: opts.reviewer,
      autoAcceptReviews: opts.autoAcceptReviews,
      workflowMaxActions: opts.workflowMaxActions,
      reviewAgingMinutes: opts.reviewAgingMinutes,
    },
    env,
    file: configFile,
  });
  const reviewerIsWorker = workflow.reviewer !== null && opts.agents.includes(workflow.reviewer);
  const config = {
    maxConcurrency: opts.maxConcurrency,
    claimUnassigned,
    recoverStale,
    patrolLlm: opts.patrolLlm,
    host: opts.host,
    wakeCommand: opts.wakeCommand,
    workflow: workflow.workflow,
    reviewer: workflow.reviewer,
    reviewerIsWorker,
    autoAcceptReviews: workflow.autoAcceptReviews,
    maxActions: workflow.maxActions,
    reviewAgingMs: workflow.reviewAgingMs,
  };
  return {
    config,
    reviewerIsWorker,
    scanAgents: buildScanAgents(opts, workflow, reviewerIsWorker),
    continueEnabled: resolveContinueEnabled({
      flag: opts.continue,
      env: env.MEERKAT_TASKPANEL_CONTINUE,
      file: configFile,
    }),
    eventContinueEnabled: resolveContinueEnabled({
      flag: opts.eventContinue,
      env: env.MEERKAT_TASKPANEL_EVENT_CONTINUE,
      file: configFile,
    }),
  };
}

/**
 * The argv a child entry must share with the scheduler that woke it. Only
 * consistency-critical values are emitted; policies the child can re-read from
 * the host config are passed only when they were stated explicitly.
 *
 * @param {object} opts
 * @returns {string[]}
 */
export function loopCommandArgs(opts) {
  const args = ["--host", opts.host];
  for (const agent of opts.agents) args.push("--agent", agent);
  args.push("--log", opts.log, "--state", opts.state);

  const add = (flag, value) => {
    if (value === null || value === undefined || value === "") return;
    args.push(flag, String(value));
  };
  // Only state values that differ from what the child would derive anyway.
  // Otherwise every line of the prompt carries a dozen redundant absolute
  // paths, three times over.
  const hostDir = HOST_DIRS[opts.host];
  const defaults = {
    config: join(opts.home, hostDir, "meerkat-taskpanel.env"),
    repo: defaultRepo(opts.config),
    cli: join(opts.repo, "src", "cli", "index.mjs"),
    glue: join(opts.home, hostDir, "bin", `wake-${opts.host}.sh`),
    projectsJson: join(opts.home, hostDir, "skills", "meerkat-taskpanel", "projects.json"),
    slaLedger: join(dirname(opts.state), "sla-ledger.json"),
    slaLastOk: join(dirname(opts.state), "loop-patrol-last-ok.json"),
  };
  for (const [flag, key] of [
    ["--config", "config"],
    ["--repo", "repo"],
    ["--cli", "cli"],
    ["--glue", "glue"],
    ["--projects-json", "projectsJson"],
    ["--sla-ledger", "slaLedger"],
    ["--sla-last-ok", "slaLastOk"],
  ]) {
    if (opts[key] !== defaults[key]) add(flag, opts[key]);
  }
  for (const [flag, value] of [
    ["--sla-peer", opts.slaPeer],
    ["--sla-leader", opts.slaLeader],
    ["--notify", opts.notify],
    ["--wake-command", opts.wakeCommand],
    ["--claim-unassigned", opts.claimUnassigned],
    ["--recover-stale", opts.recoverStale],
    ["--workflow", opts.workflow],
    ["--reviewer", opts.reviewer],
    ["--auto-accept-reviews", opts.autoAcceptReviews],
    ["--workflow-max-actions", opts.workflowMaxActions],
    ["--review-aging-minutes", opts.reviewAgingMinutes],
  ]) {
    add(flag, value);
  }
  if (opts.patrolInterval !== DEFAULT_PATROL_SECONDS) add("--patrol-interval", opts.patrolInterval);
  if (opts.boardLimit !== DEFAULT_BOARD_LIMIT) add("--board-limit", opts.boardLimit);
  if (opts.trailLimit !== DEFAULT_TRAIL_LIMIT) add("--trail-limit", opts.trailLimit);
  if (opts.maxConcurrency !== DEFAULT_MAX_CONCURRENCY) add("--max-concurrency", opts.maxConcurrency);
  if (opts.patrolLlm) args.push("--patrol-llm");
  return args;
}

export const USAGE = `Usage: node scripts/supervisor.mjs [options]

The loop's scheduler. It owns two clocks and nothing else:
  ping       every ${DEFAULT_PING_SECONDS}s — prune dead worker pids; no board read, no LLM.
  continue   every ${DEFAULT_CONTINUE_SECONDS}s — wake the host agent with a bounded
             "继续" prompt; that turn runs the poll, patrol and workflow entries.

--subscribe adds an optional event daemon beside those clocks: it holds one SSE
connection and asks for a continue turn when a dispatch-relevant event arrives.
The clocks stay as the fallback (and as the only path for time-based work).

Options:
  --agent <name>            Agent(s) to work for. Repeatable / comma-separated.
                            Default: $TASKCTL_AGENT, then $USER.
  --host claude|codex|pi    Which worker/agent to wake (default: claude).
  --repo <path>             Repository root (default: this checkout; a host-installed
                            copy takes it from --config — MEERKAT_TASKPANEL_REPO).
  --ping-interval <sec>     Liveness clock (default: ${DEFAULT_PING_SECONDS}).
  --continue-interval <sec> Judgment clock (default: ${DEFAULT_CONTINUE_SECONDS} = 10 minutes).
  --continue=yes|no         Enable the continue turn (default: yes).
  --continue-state <path>   Continue lock (default: continue.state.json beside --state).
  --once                    Run one pass and exit. With no selector this is the
                            LEGACY poll pass; new units pass --ping-only or
                            --continue-only.
  --ping-only               With --once, prune the worker registry and exit.
  --continue-only           With --once, run one continue turn.
  --patrol-only             With --once, run one SLA patrol pass (legacy units).
  --subscribe               Run the event subscriber daemon (SSE -> one continue
                            turn per burst). launchd/systemd only; cron cannot
                            host a long-lived process. Cannot be combined with
                            --once or another selector.
  --url <url>               Board URL for the subscriber (default: runtime pointer).
  --token <token>           Board token (default: $TASKD_TOKEN / pointer tokenFile).
  --sse-idle-ms <ms>        Reconnect after this much stream silence (default: 45000).
  --event-debounce-ms <ms>  Coalesce a burst of events (default: 300).
  --event-debounce-max-ms <ms>
                            Never delay the first pending event past this (default: 2000).
  --event-continue=yes|no   Let events wake a continue turn (default: yes).
  --event-continue-min-ms <ms>
                            At most one event-triggered turn per interval (default: 60000).
  --patrol-interval <sec>   SLA measurement period (default: ${DEFAULT_PATROL_SECONDS}); it no
                            longer schedules anything.
  --max-concurrency <n>     Max concurrent workers (default: ${DEFAULT_MAX_CONCURRENCY}).
  --claim-unassigned=yes|no Also claim unassigned cards (default: yes).
  --assignee-only           Alias for --claim-unassigned=no.
  --recover-stale=yes|no    Also recover stale in_progress claims (default: yes).
  --workflow=yes|no         Run the workflow pass when the continue turn calls it (default: yes).
  --reviewer <agent>        The independent reviewer. Unset disables review dispatch.
  --auto-accept-reviews=yes|no
                            Close a review card after applying its verdict (default: yes).
  --workflow-max-actions <n> Max workflow writes per pass (default: 20).
  --review-aging-minutes <n> Report a silent review card after this long (default: 60).
  --patrol-llm=yes|no       Allow patrol to start an LLM turn (default: no).
  --notify <cmd>            Run <cmd> with each patrol alert as JSON on stdin.
  --dry-run                 Print intended actions; write nothing, spawn nothing.
  --log <path>              Append log lines here (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.log).
  --state <path>            Worker registry (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.state.json).
  --sla-ledger <path>       SLA de-duplication ledger (default: a sibling of --state).
  --sla-leader <id>         The author id the leader writes under (default: human decisions).
  --sla-last-ok <path>      This mechanism's last-successful-run marker.
  --sla-peer <path>         The peer inspector's last-ok marker.
  --board-limit <n>         Max cards read per pass (default: ${DEFAULT_BOARD_LIMIT}).
  --trail-limit <n>         Max comment trails read per pass (default: ${DEFAULT_TRAIL_LIMIT}).
  --config <path>           Host config (default: <home>/<host-dir>/meerkat-taskpanel.env).
  --home <path>             Home the defaults are resolved against (default: $HOME).
  --cli <path>              taskctl entry (default: <repo>/src/cli/index.mjs).
  --glue <path>             Wake glue (default: <home>/<host-dir>/bin/wake-<host>.sh).
  --wake-command <cmd>      Your own wake command instead of the built-in host forms.
  --projects-json <path>    Host-local project map handed to the glue.
  -h, --help                Show this help

The deterministic entries are also runnable on their own:
  node scripts/loop/poll.mjs       scan → atomic claim → wake a worker
  node scripts/loop/patrol.mjs     notify-only SLA rows (${PEER_MECHANISM}; peer watchdog ${PEER_LIVENESS_K}x${PEER_PERIOD_MIN}min)
  node scripts/loop/workflow.mjs   reconcile / review dispatch / verdicts
  node scripts/loop/continue.mjs   one judgment turn`;

