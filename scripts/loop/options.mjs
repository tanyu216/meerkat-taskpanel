/**
 * The loop's option surface — one parser for the scheduler and every entry.
 *
 * Flags are declared in `FLAGS`; the parse loop is generic. The continue prompt
 * re-serialises only the values a child entry must share (`loopCommandArgs`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BOARD_LIMIT,
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../src/foundation/constants.mjs";
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
} from "../../src/foundation/scheduling.mjs";
import {
  DEFAULT_TRAIL_LIMIT,
  PEER_LIVENESS_K,
  PEER_MECHANISM,
  PEER_PERIOD_MIN,
} from "../../src/foundation/sla-patrol.mjs";

/** Host → dot-directory under the target home. */
export const HOST_DIRS = Object.freeze({
  claude: ".claude",
  codex: ".codex",
  pi: ".agents",
  opencode: ".config/opencode",
  cursor: ".cursor",
});

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

/**
 * One flag declaration.
 *
 * `kind`:
 *   * `"value"` (default) — `--flag value` or `--flag=value`;
 *   * `"switch"` — no value, and `--flag=value` is refused;
 *   * `"toggle"` — bare form means on; `=yes|no` also accepted.
 */
const FLAGS = new Map();

/** @param {string} name @param {(opts: object, value?: string) => void} set @param {"value"|"switch"|"toggle"} [kind] */
function flag(name, set, kind = "value") {
  FLAGS.set(name, { set, kind });
}

/** Split a repeatable/comma-separated value. */
function list(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** @param {string} name @param {string} raw */
function number(name, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a number, got '${raw}'`);
  return value;
}

flag("--agent", (opts, value) => opts.agents.push(...list(value)));
flag("--host", (opts, value) => { opts.host = value; });
flag("--repo", (opts, value) => { opts.repo = resolve(value); });
flag("--ping-interval", (opts, value) => { opts.pingInterval = number("--ping-interval", value); });
// Deprecated alias for the ping clock. The old units pass a bare `--once`, so
// the alias only has to keep the flag itself working.
flag("--poll-interval", (opts, value) => {
  opts.pingInterval = number("--poll-interval", value);
  opts.legacyPollInterval = true;
});
flag("--continue-interval", (opts, value) => { opts.continueInterval = number("--continue-interval", value); });
flag("--continue", (opts, value) => { opts.continue = value; });
flag("--continue-state", (opts, value) => { opts.continueState = value; });
flag("--patrol-interval", (opts, value) => {
  opts.patrolInterval = number("--patrol-interval", value);
  // The default is also 300, so the value alone cannot say whether this was the
  // operator's explicit choice. Without the marker a supervisor invoked with
  // `--patrol-interval 300` could not override a board configured with 600.
  opts.patrolIntervalExplicit = true;
});
flag("--max-concurrency", (opts, value) => { opts.maxConcurrency = number("--max-concurrency", value); });
flag("--claim-unassigned", (opts, value) => { opts.claimUnassigned = value; });
flag("--assignee-only", (opts) => { opts.claimUnassigned = "no"; }, "switch");
flag("--recover-stale", (opts, value) => { opts.recoverStale = value; });
flag("--workflow", (opts, value) => { opts.workflow = value; });
flag("--reviewer", (opts, value) => { opts.reviewer = value; });
flag("--auto-accept-reviews", (opts, value) => { opts.autoAcceptReviews = value; });
// Advisory copy of the board's acceptance policy (the board decides).
flag("--acceptance", (opts, value) => { opts.acceptance = value; });
flag("--acceptance-policy", (opts, value) => { opts.acceptance = value; });
flag("--workflow-max-actions", (opts, value) => { opts.workflowMaxActions = value; });
flag("--review-aging-minutes", (opts, value) => { opts.reviewAgingMinutes = value; });
flag("--once", (opts) => { opts.once = true; }, "switch");
flag("--ping-only", (opts) => { opts.pingOnly = true; }, "switch");
flag("--continue-only", (opts) => { opts.continueOnly = true; }, "switch");
flag("--patrol-only", (opts) => { opts.patrolOnly = true; }, "switch");
flag("--subscribe", (opts) => { opts.subscribe = true; }, "switch");
flag("--url", (opts, value) => { opts.url = value; });
flag("--env-file", (opts, value) => { opts.envFile = value; });
flag("--token", (opts, value) => { opts.token = value; });
flag("--sse-idle-ms", (opts, value) => { opts.sseIdleMs = number("--sse-idle-ms", value); });
flag("--event-debounce-ms", (opts, value) => { opts.eventDebounceMs = number("--event-debounce-ms", value); });
flag("--event-debounce-max-ms", (opts, value) => { opts.eventDebounceMaxMs = number("--event-debounce-max-ms", value); });
flag("--event-continue", (opts, value) => { opts.eventContinue = value; });
flag("--event-continue-min-ms", (opts, value) => { opts.eventContinueMinMs = number("--event-continue-min-ms", value); });
flag("--patrol-llm", (opts, value) => {
  opts.patrolLlm = value === undefined ? true : /^(yes|true|1|y|on)$/i.test(value);
}, "toggle");
flag("--notify", (opts, value) => { opts.notify = value; });
flag("--dry-run", (opts) => { opts.dryRun = true; }, "switch");
flag("--log", (opts, value) => { opts.log = value; });
flag("--state", (opts, value) => { opts.state = value; });
flag("--sla-ledger", (opts, value) => { opts.slaLedger = value; });
flag("--workflow-ledger", (opts, value) => { opts.workflowLedger = value; });
flag("--sla-leader", (opts, value) => { opts.slaLeader = value; });
flag("--sla-last-ok", (opts, value) => { opts.slaLastOk = value; });
flag("--sla-peer", (opts, value) => { opts.slaPeer = value; });
flag("--board-limit", (opts, value) => { opts.boardLimit = number("--board-limit", value); });
flag("--trail-limit", (opts, value) => { opts.trailLimit = number("--trail-limit", value); });
flag("--config", (opts, value) => { opts.config = value; });
flag("--home", (opts, value) => { opts.home = resolve(value); });
flag("--cli", (opts, value) => { opts.cli = value; });
flag("--glue", (opts, value) => { opts.glue = value; });
flag("--projects-json", (opts, value) => { opts.projectsJson = value; });
flag("--wake-command", (opts, value) => { opts.wakeCommand = value; });

/** Host-local files derived from `--home` and `--host`. */
function hostPaths(home, host) {
  const dir = join(home, HOST_DIRS[host]);
  return {
    log: join(dir, "meerkat-taskpanel", "supervisor.log"),
    state: join(dir, "meerkat-taskpanel", "supervisor.state.json"),
    config: join(dir, "meerkat-taskpanel.env"),
    glue: join(dir, "bin", `wake-${host}.sh`),
    projectsJson: join(dir, "skills", "meerkat-taskpanel", "projects.json"),
  };
}

/** The files that live beside the worker registry. */
function statePaths(state) {
  const dir = dirname(state);
  return {
    continueState: join(dir, "continue.state.json"),
    slaLedger: join(dir, "sla-ledger.json"),
    workflowLedger: join(dir, "workflow-ledger.json"),
    slaLastOk: join(dir, "loop-patrol-last-ok.json"),
  };
}

/** @param {NodeJS.ProcessEnv} env */
function defaultOptions(env) {
  return {
    agents: [],
    host: "claude",
    repo: null,   // resolved below: --repo, else defaultRepo()
    pingInterval: undefined,     // resolved below: flag > env > host config > 60
    continueInterval: undefined, // resolved below: flag > env > host config > 600
    continue: undefined,
    continueState: null,
    patrolInterval: DEFAULT_PATROL_SECONDS, // the SLA measurement period, not a schedule
    patrolIntervalExplicit: false, // true only when `--patrol-interval` was given
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    claimUnassigned: undefined,
    recoverStale: undefined,
    workflow: undefined,
    reviewer: undefined,
    autoAcceptReviews: undefined,
    acceptance: undefined,
    workflowMaxActions: undefined,
    reviewAgingMinutes: undefined,
    once: false,
    pingOnly: false,
    continueOnly: false,
    patrolOnly: false,
    subscribe: false,
    url: null,
    envFile: null,
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
    workflowLedger: null,
    slaLeader: null,
    slaLastOk: null,
    slaPeer: null,
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
}

/** @param {string[]} argv */
export function parseArgs(argv, env = process.env) {
  const opts = defaultOptions(env);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);

    if (name === "-h" || name === "--help") {
      opts.help = true;
      continue;
    }

    const spec = FLAGS.get(name);
    if (spec === undefined) throw new Error(`unknown option: ${arg}`);

    if (spec.kind === "switch" || (spec.kind === "toggle" && equals === -1)) {
      if (spec.kind === "switch" && equals !== -1) throw new Error(`unknown option: ${arg}`);
      spec.set(opts);
      continue;
    }

    let value;
    if (equals !== -1) value = arg.slice(equals + 1);
    else {
      value = argv[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
    }
    spec.set(opts, value);
  }

  if (opts.agents.length === 0) {
    const fallback = env.TASKCTL_AGENT || env.USER || env.LOGNAME || "agent";
    opts.agents = [fallback];
  }
  if (!(opts.host in HOST_DIRS)) {
    throw new Error(`unknown host '${opts.host}' (expected claude|codex|pi|opencode|cursor)`);
  }

  const paths = hostPaths(opts.home, opts.host);
  opts.log ??= paths.log;
  opts.state ??= paths.state;
  // The lock and the ledgers sit beside the worker registry, never inside it: an
  // entry there would consume a worker slot.
  const beside = statePaths(opts.state);
  opts.continueState ??= beside.continueState;
  opts.slaLedger ??= beside.slaLedger;
  opts.workflowLedger ??= beside.workflowLedger;
  opts.slaLastOk ??= beside.slaLastOk;
  opts.slaLeader ??= env.MEERKAT_TASKPANEL_SLA_LEADER ?? null;
  opts.slaPeer ??= env.MEERKAT_TASKPANEL_SLA_PEER ?? null;
  opts.config ??= paths.config;
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
  opts.glue ??= paths.glue;
  opts.projectsJson ??= paths.projectsJson;
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
 * Merge the deployment reviewer with the project-level overrides (0031).
 *
 * `resolveLoopConfig` is synchronous and has no board access; the async entries
 * (poll/workflow/patrol) read `project list` and call this to get the effective
 * reviewer set. A reviewer that is also a worker stays in the worker lane and
 * is not scanned twice.
 *
 * @param {object} opts
 * @param {{reviewer: string|null}} config
 * @param {string[]} projectReviewers
 * @returns {{reviewers: string[], reviewerWorkers: string[], scanAgents: string[]}}
 */
export function mergeReviewerSets(opts, config, projectReviewers = []) {
  const workers = Array.isArray(opts.agents) ? opts.agents : [];
  const reviewers = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const name = value.trim();
    if (name !== "" && !reviewers.includes(name)) reviewers.push(name);
  };
  add(config?.reviewer);
  for (const reviewer of Array.isArray(projectReviewers) ? projectReviewers : []) add(reviewer);

  const reviewerWorkers = reviewers.filter((reviewer) => workers.includes(reviewer));
  const scanAgents = [
    ...workers,
    ...reviewers.filter((reviewer) => !workers.includes(reviewer)),
  ];
  return { reviewers, reviewerWorkers, scanAgents };
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
      acceptance: opts.acceptance,
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
    acceptancePolicy: workflow.acceptancePolicy,
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
  // Only state values that differ from what the child would derive anyway,
  // or every line of the prompt carries a dozen redundant absolute paths.
  const paths = hostPaths(opts.home, opts.host);
  const beside = statePaths(opts.state);
  const defaults = {
    config: paths.config,
    repo: defaultRepo(opts.config),
    cli: join(opts.repo, "src", "cli", "index.mjs"),
    glue: paths.glue,
    projectsJson: paths.projectsJson,
    slaLedger: beside.slaLedger,
    workflowLedger: beside.workflowLedger,
    slaLastOk: beside.slaLastOk,
  };
  for (const [flag, key] of [
    ["--config", "config"],
    ["--repo", "repo"],
    ["--cli", "cli"],
    ["--glue", "glue"],
    ["--projects-json", "projectsJson"],
    ["--sla-ledger", "slaLedger"],
    ["--workflow-ledger", "workflowLedger"],
    ["--sla-last-ok", "slaLastOk"],
  ]) {
    if (opts[key] !== defaults[key]) add(flag, opts[key]);
  }
  for (const [flag, value] of [
    ["--url", opts.url],
    ["--env-file", opts.envFile],
    ["--sla-peer", opts.slaPeer],
    ["--sla-leader", opts.slaLeader],
    ["--notify", opts.notify],
    ["--wake-command", opts.wakeCommand],
    ["--claim-unassigned", opts.claimUnassigned],
    ["--recover-stale", opts.recoverStale],
    ["--workflow", opts.workflow],
    ["--reviewer", opts.reviewer],
    ["--auto-accept-reviews", opts.autoAcceptReviews],
    ["--acceptance", opts.acceptance],
    ["--workflow-max-actions", opts.workflowMaxActions],
    ["--review-aging-minutes", opts.reviewAgingMinutes],
  ]) {
    add(flag, value);
  }
  if (opts.patrolIntervalExplicit === true || opts.patrolInterval !== DEFAULT_PATROL_SECONDS) {
    add("--patrol-interval", opts.patrolInterval);
  }
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
             "Continue" prompt; that turn runs the poll, patrol and workflow entries.

--subscribe adds an optional event daemon beside those clocks: it holds one SSE
connection and asks for a continue turn when a dispatch-relevant event arrives.
The clocks stay as the fallback (and as the only path for time-based work).

Options:
  --agent <name>            Agent(s) to work for. Repeatable / comma-separated.
                            Default: $TASKCTL_AGENT, then $USER.
  --host claude|codex|pi|opencode|cursor    Which worker/agent to wake (default: claude).
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
  --url <url>               Board URL (default: TASKD_URL in the process env or
                            install-root .env, then the runtime pointer).
  --env-file <path>         Config file (default: MEERKAT_TASKPANEL_ENV_FILE,
                            then <repo>/.env).
  --token <token>           Board token (default: $TASKD_TOKEN / TASKD_TOKEN_FILE
                            / pointer tokenFile).
  --sse-idle-ms <ms>        Reconnect after this much stream silence (default: 45000).
  --event-debounce-ms <ms>  Coalesce a burst of events (default: 300).
  --event-debounce-max-ms <ms>
                            Never delay the first pending event past this (default: 2000).
  --event-continue=yes|no   Let events wake a continue turn (default: yes).
  --event-continue-min-ms <ms>
                            At most one event-triggered turn per interval (default: 60000).
  --patrol-interval <sec>   SLA measurement period P (default: the board's
                            TASKD_SLA_PERIOD_SECONDS, else ${DEFAULT_PATROL_SECONDS}). It no longer
                            schedules anything; an explicit value overrides the board.
  --max-concurrency <n>     Max concurrent workers (default: ${DEFAULT_MAX_CONCURRENCY}).
  --claim-unassigned=yes|no Also claim unassigned cards (default: yes).
  --assignee-only           Alias for --claim-unassigned=no.
  --recover-stale=yes|no    Also recover stale in_progress claims (default: yes).
  --workflow=yes|no         Run the workflow pass when the continue turn calls it (default: yes).
  --reviewer <agent>        The independent reviewer. Unset disables review dispatch.
  --auto-accept-reviews=yes|no
                            Close a review card after applying its verdict (default: yes).
  --acceptance <policy>     human-only | both | agent-only (default: both). Advisory: the
                            board decides the plan; the loop prints this copy at startup
                            for diagnostics and keeps it for compatibility.
  --workflow-max-actions <n> Max workflow writes per pass (default: 20).
  --review-aging-minutes <n> Report a silent review card after this long (default: 60).
  --patrol-llm=yes|no       Allow patrol to start an LLM turn (default: no).
  --notify <cmd>            Run <cmd> with each patrol alert as JSON on stdin.
  --dry-run                 Print intended actions; write nothing, spawn nothing.
  --log <path>              Append log lines here (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.log).
  --state <path>            Worker registry (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.state.json).
  --sla-ledger <path>       SLA de-duplication ledger (default: a sibling of --state).
  --workflow-ledger <path>  Workflow alert de-duplication ledger (default: a sibling of --state).
  --sla-leader <id>         The author id the leader writes under (default: the board's human
                            decision authority). Passed to sla list|get.
  --sla-last-ok <path>      This mechanism's last-successful-run marker.
  --sla-peer <path>         The peer inspector's last-ok marker (a local file; the board cannot
                            see it, so this one row is computed here).
  --board-limit <n>         Max cards per read (default: ${DEFAULT_BOARD_LIMIT}); passed to sla list.
  --trail-limit <n>         Max comment trails per SLA read (default: ${DEFAULT_TRAIL_LIMIT}); passed
                            to sla list.
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
  node scripts/loop/workflow.mjs   apply the board's workflow plan
  node scripts/loop/continue.mjs   one judgment turn`;

