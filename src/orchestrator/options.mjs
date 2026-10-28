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
} from "../foundation/constants.mjs";
import {
  DEFAULT_CONTINUE_SECONDS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_PING_SECONDS,
  parseEnvFile,
  parseYesNo,
  quoteArg,
  resolveClaimUnassigned,
  resolveContinueEnabled,
  resolveRecoverStale,
  resolveIntervalSeconds,
  resolveWorkflowConfig,
} from "../foundation/scheduling.mjs";
import {
  DEFAULT_TRAIL_LIMIT,
  PEER_LIVENESS_K,
  PEER_MECHANISM,
  PEER_PERIOD_MIN,
} from "../foundation/sla-patrol.mjs";
import { defaultProjectsJson } from "../foundation/project-dir.mjs";

/** The one retirement message, shared by the flag and the env/config path. */
const BACKGROUND_RETIRED =
  "background subagents are retired — no adapter reports per-subagent completion; " +
  "remove --subagent-background / MEERKAT_TASKPANEL_SUBAGENT_BACKGROUND";

// The agent-directory and path vocabulary is shared with the orchestrator and
// the installer now; re-exported because this module was its first home.
export { AGENT_DIRS, agentPaths } from "../foundation/agent-paths.mjs";
import {
  AGENT_DIRS,
  agentPaths,
  resolveKindConfigPath,
} from "../foundation/agent-paths.mjs";
import { statePathsForDir } from "../foundation/loop-state.mjs";

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
 *   * **from the checkout** (`taskctl loop …`, the documented dev run
 *     and every test) — the board sits beside the executor, so the relative answer is
 *     the right one and nothing else is consulted. This branch is why a dev run never
 *     depends on the machine's per-kind config.
 *   * **from the agent** — `install.sh` records the runtime tree under
 *     `<agent-dir>/meerkat-taskpanel/` so a loaded scheduling unit survives the
 *     checkout moving. That copy has no board of its own, so it falls back to the
 *     location the installer recorded in the per-kind config (`MEERKAT_TASKPANEL_REPO`).
 *
 * An unreadable or key-less config falls back to the executor's own location, which
 * is what a copy written by an older installer has — the tick still runs, and
 * re-running `install.sh` records the path.
 *
 * @param {string | null} configPath the per-kind config file to consult
 * @param {string} [beside] the executor's own directory — injectable so the
 *   agent-installed branch is testable without a second checkout on disk
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

/** First valid non-negative integer among flag > env > config, else fallback. */
function resolveNonNegative(input, fallback) {
  for (const value of [input.flag, input.env, input.file]) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

/** First valid positive integer among flag > env > config, else fallback. */
function resolvePositive(input, fallback) {
  for (const value of [input.flag, input.env, input.file]) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

// `taskctl loop …` forwards the CLI's global `--json`; the loop entries use it
// only where they emit a document (status/console). Accept and ignore it here.
flag("--json", () => {});
flag("--agent", (opts, value) => opts.agents.push(...list(value)));
flag("--roles-dir", (opts, value) => { opts.rolesDir = resolve(value); });
flag("--actor-kind", (opts, value) => { opts.actorKind = value; });
flag("--repo", (opts, value) => { opts.repo = resolve(value); });
flag("--ping-interval", (opts, value) => { opts.pingInterval = number("--ping-interval", value); });
flag("--continue-interval", (opts, value) => { opts.continueInterval = number("--continue-interval", value); });
flag("--continue", (opts, value) => { opts.continue = value; });
// 0034 — the origin of this loop, which decides *where* an unanswerable question
// goes. `supervisor` is the default because systemd/launchd/cron are the normal
// entries; a human running it by hand says so.
flag("--opened-by", (opts, value) => {
  if (value !== "human" && value !== "supervisor") {
    throw new Error("--opened-by must be human or supervisor");
  }
  opts.openedBy = value;
});
flag("--continue-state", (opts, value) => { opts.continueState = value; });
flag("--session", (opts) => { opts.session = true; }, "switch");
flag("--control", (opts, value) => { opts.control = value; });
flag("--resident", (opts, value) => { opts.resident = value; });
flag("--session-state", (opts, value) => { opts.sessionState = resolve(value); });
flag("--session-max-age", (opts, value) => { opts.sessionMaxAge = number("--session-max-age", value); });
flag("--session-turn-timeout", (opts, value) => { opts.sessionTurnTimeout = number("--session-turn-timeout", value); });
flag("--session-poll-ms", (opts, value) => { opts.sessionPollMs = number("--session-poll-ms", value); });
flag("--session-pool-max", (opts, value) => { opts.sessionPoolMax = number("--session-pool-max", value); });
flag("--project-concurrency", (opts, value) => { opts.projectConcurrency = number("--project-concurrency", value); });
flag("--workspace", (opts, value) => {
  const mode = String(value ?? "").trim();
  if (mode !== "worktree" && mode !== "shared") {
    throw new Error(`--workspace must be worktree or shared, got '${value}'`);
  }
  opts.workspace = mode;
});
flag("--project-idle-ms", (opts, value) => { opts.projectIdleMs = number("--project-idle-ms", value); });
flag("--allow-all-tools", (opts) => { opts.allowAllTools = true; }, "switch");
flag("--allow-all-tools-reason", (opts, value) => { opts.allowAllToolsReason = value; });
// Retired: no adapter reports a per-subagent completion, so a background row
// could never release its slot. `=no` stays accepted for the installed config;
// anything that asks for the old behavior fails loudly.
flag("--subagent-background", (opts, value) => {
  const on = value === undefined ? true : /^(yes|true|1|y|on)$/i.test(value);
  if (on) throw new Error(BACKGROUND_RETIRED);
  opts.subagentBackground = false;
}, "toggle");
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

/** The files that live beside the worker registry. */
function statePaths(state) {
  return statePathsForDir(dirname(state));
}

/** @param {NodeJS.ProcessEnv} env */
function defaultOptions(env) {
  return {
    agents: [],
    actorKind: "claude",
    repo: null,   // resolved below: --repo, else defaultRepo()
    pingInterval: undefined,     // resolved below: flag > env > per-kind config > 60
    continueInterval: undefined, // resolved below: flag > env > per-kind config > 600
    continue: undefined,
    continueState: null,
    session: false,
    control: "internal",
    resident: "auto",
    sessionState: null,
    sessionMaxAge: undefined,
    sessionTurnTimeout: undefined,
    sessionPollMs: undefined,
    sessionPoolMax: undefined,
    projectConcurrency: undefined,
    projectIdleMs: undefined,
    allowAllTools: false,
    allowAllToolsReason: null,
    // 0034 — who opened this loop. `supervisor` (systemd/launchd/cron) must
    // escalate questions to the board; a human-opened session may ask in its own
    // conversation first.
    openedBy: "supervisor",
    patrolInterval: DEFAULT_PATROL_SECONDS, // the SLA measurement period, not a schedule
    patrolIntervalExplicit: false, // true only when `--patrol-interval` was given
    maxConcurrency: undefined, // resolved below: flag > env > per-kind config > 8
    claimUnassigned: undefined,
    recoverStale: undefined,
    workflow: undefined,
    reviewer: undefined,
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
    projectsJson: null,
    help: false,
    rolesDir: null,
    workspace: undefined,
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

  if (!(opts.actorKind in AGENT_DIRS)) {
    throw new Error(`unknown actor kind '${opts.actorKind}' (expected claude|codex|pi)`);
  }

  const paths = agentPaths(opts.home, opts.actorKind);
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
  // The per-kind config and the project map live at the program root, not under
  // `--home`; `--home` still selects the state, log and roles. `--config` is the
  // explicit override and fills the value first.
  opts.kindConfigDefault = resolveKindConfigPath({ actorKind: opts.actorKind, env });
  opts.config ??= opts.kindConfigDefault;
  opts.configFile = readConfigFile(opts.config);
  // A team is a list of board identities, not a second config surface. The
  // explicit `--agent` flags win; otherwise the env/config list is the scan set.
  // Without this, a loop configured for one human name never claims a role card.
  if (opts.agents.length === 0) {
    const configured = env.MEERKAT_TASKPANEL_AGENTS ?? opts.configFile.MEERKAT_TASKPANEL_AGENTS;
    const listed = typeof configured === "string"
      ? configured.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean)
      : [];
    opts.agents = listed.length > 0
      ? listed
      : [env.TASKCTL_AGENT || env.USER || env.LOGNAME || "agent"];
  }
  const rolesDir = opts.rolesDir ?? env.MEERKAT_TASKPANEL_ROLES_DIR ?? opts.configFile.MEERKAT_TASKPANEL_ROLES_DIR;
  opts.rolesDir = typeof rolesDir === "string" && rolesDir.trim() !== "" ? resolve(rolesDir.trim()) : null;
  // One concurrency cap for the whole fleet of subagents: workers and reviewers
  // share it and compete for the slots by demand. Zero is meaningful ("claim
  // nothing"), so this uses the non-negative resolver.
  opts.maxConcurrency = resolveNonNegative(
    {
      flag: opts.maxConcurrency,
      env: env.MEERKAT_TASKPANEL_MAX_CONCURRENCY,
      file: opts.configFile.MEERKAT_TASKPANEL_MAX_CONCURRENCY,
    },
    DEFAULT_MAX_CONCURRENCY,
  );
  // Cadences follow the same precedence as every other policy: flag > env >
  // the per-kind config the installer wrote > default. Invalid values are ignored,
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
  // The resident pool. State files sit beside --state; `--session-state` names
  // the sessions file itself, for an operator who needs it elsewhere.
  opts.sessionState ??= join(dirname(opts.state), "sessions.state.json");
  opts.sessionMaxAgeMs =
    resolveNonNegative(
      {
        flag: opts.sessionMaxAge,
        env: env.MEERKAT_TASKPANEL_SESSION_MAX_AGE,
        file: opts.configFile.MEERKAT_TASKPANEL_SESSION_MAX_AGE,
      },
      24 * 60 * 60,
    ) * 1000;
  const turnSeconds = resolveIntervalSeconds({
    flag: opts.sessionTurnTimeout,
    env: env.MEERKAT_TASKPANEL_SESSION_TURN_TIMEOUT,
    file: opts.configFile.MEERKAT_TASKPANEL_SESSION_TURN_TIMEOUT,
    fallback: 30 * 60,
  });
  // 0034 — the time contract's turn bound. Below 20 minutes a turn can end
  // before a worker's first heartbeat window (10 min) has even been exercised
  // twice; at 2 hours the ledger reaps a live row whose card left the work
  // state, so the turn outlives the bookkeeping that describes it.
  if (turnSeconds < 1200 || turnSeconds >= 7200) {
    throw new Error(
      `--session-turn-timeout must be between 1200 and 7199 seconds, got ${turnSeconds} ` +
        "(the turn must outlast 2x the 10-minute heartbeat window and stay under the ledger's 2-hour reap)",
    );
  }
  opts.sessionTurnTimeoutMs = turnSeconds * 1000;
  opts.sessionPollMs = Math.max(
    50,
    resolveNonNegative(
      {
        flag: opts.sessionPollMs,
        env: env.MEERKAT_TASKPANEL_SESSION_POLL_MS,
        file: opts.configFile.MEERKAT_TASKPANEL_SESSION_POLL_MS,
      },
      1000,
    ),
  );
  opts.sessionPoolMax = Math.max(
    1,
    resolvePositive(
      {
        flag: opts.sessionPoolMax,
        env: env.MEERKAT_TASKPANEL_SESSION_POOL_MAX,
        file: opts.configFile.MEERKAT_TASKPANEL_SESSION_POOL_MAX,
      },
      8,
    ),
  );
  opts.projectConcurrency = Math.max(
    1,
    resolvePositive(
      {
        flag: opts.projectConcurrency,
        env: env.MEERKAT_TASKPANEL_PROJECT_CONCURRENCY,
        file: opts.configFile.MEERKAT_TASKPANEL_PROJECT_CONCURRENCY,
      },
      opts.maxConcurrency,
    ),
  );
  opts.projectIdleMs = resolveNonNegative(
    {
      flag: opts.projectIdleMs,
      env: env.MEERKAT_TASKPANEL_PROJECT_IDLE_MS,
      file: opts.configFile.MEERKAT_TASKPANEL_PROJECT_IDLE_MS,
    },
    30 * 60 * 1000,
  );
  // A git project's cards get their own worktree by default. `shared` is the
  // explicit old behaviour: every card in the project's checkout.
  const workspaceMode = String(
    opts.workspace ??
      env.MEERKAT_TASKPANEL_WORKSPACE ??
      opts.configFile.MEERKAT_TASKPANEL_WORKSPACE ??
      "worktree",
  ).trim();
  if (workspaceMode !== "worktree" && workspaceMode !== "shared") {
    throw new Error(
      `--workspace / MEERKAT_TASKPANEL_WORKSPACE must be worktree or shared, got '${workspaceMode}'`,
    );
  }
  opts.workspace = workspaceMode;
  const resident = String(opts.resident ?? "auto").trim().toLowerCase();
  if (resident !== "auto" && resident !== "no") throw new Error("--resident must be auto or no");
  opts.resident = resident;
  const control = String(opts.control ?? "internal").trim().toLowerCase();
  if (control !== "internal" && control !== "external") {
    throw new Error("--control must be internal or external");
  }
  if (control === "external" && opts.session !== true) {
    throw new Error("--control=external requires --session");
  }
  opts.control = control;
  const allowAll =
    parseYesNo(opts.allowAllTools === true ? "yes" : undefined) ??
    parseYesNo(env.MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS) ??
    parseYesNo(opts.configFile.MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS) ??
    false;
  opts.allowAllTools = allowAll;
  if (allowAll) {
    opts.allowAllToolsReason = String(
      opts.allowAllToolsReason ??
        env.MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON ??
        opts.configFile.MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON ??
        "",
    ).trim();
    if (opts.allowAllToolsReason === "") {
      throw new Error(
        '--allow-all-tools requires --allow-all-tools-reason "<who authorized it and why>"',
      );
    }
  }
  // The flag is a retirement shim: `=no` is inert, anything else threw above.
  // Environment/config keep flag > env > config without resurrecting the mode.
  const flagValue = opts.subagentBackground; // undefined, or false from `=no`
  const envValue = parseYesNo(env.MEERKAT_TASKPANEL_SUBAGENT_BACKGROUND);
  const configValue = parseYesNo(opts.configFile.MEERKAT_TASKPANEL_SUBAGENT_BACKGROUND);
  const background = flagValue === false ? false : envValue ?? configValue ?? false;
  if (background === true) throw new Error(BACKGROUND_RETIRED);
  if (flagValue === false || envValue === false || configValue === false) {
    opts.subagentBackground = false;
  }
  opts.repo ??= defaultRepo(opts.config);
  opts.cli ??= join(opts.repo, "src", "cli", "index.mjs");
  opts.projectsJson ??= defaultProjectsJson(env);
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
 * @returns {"ping"|"continue"|"patrol"|"poll"|"subscribe"|"session"|null}
 */
export function selectMode(opts) {
  if (opts.session) {
    if (opts.once || opts.pingOnly || opts.continueOnly || opts.patrolOnly || opts.subscribe || opts.dryRun) {
      throw new Error(
        "--session is a daemon mode; it cannot be combined with --once, --dry-run, --subscribe or another selector",
      );
    }
    return "session";
  }
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
    env: env.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED,
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
    actorKind: opts.actorKind,
    workflow: workflow.workflow,
    reviewer: workflow.reviewer,
    reviewerIsWorker,
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
 * the per-kind config are passed only when they were stated explicitly.
 *
 * @param {object} opts
 * @returns {string[]}
 */
export function loopCommandArgs(opts) {
  const args = ["--actor-kind", opts.actorKind];
  for (const agent of opts.agents) args.push("--agent", agent);
  args.push("--log", opts.log, "--state", opts.state);

  const add = (flag, value) => {
    if (value === null || value === undefined || value === "") return;
    args.push(flag, String(value));
  };
  // Only state values that differ from what the child would derive anyway,
  // or every line of the prompt carries a dozen redundant absolute paths.
  const beside = statePaths(opts.state);
  const defaults = {
    config: opts.kindConfigDefault ?? resolveKindConfigPath({ actorKind: opts.actorKind }),
    repo: defaultRepo(opts.config),
    cli: join(opts.repo, "src", "cli", "index.mjs"),
    slaLedger: beside.slaLedger,
    workflowLedger: beside.workflowLedger,
    slaLastOk: beside.slaLastOk,
  };
  for (const [flag, key] of [
    ["--config", "config"],
    ["--repo", "repo"],
    ["--cli", "cli"],
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
    ["--claim-unassigned", opts.claimUnassigned],
    ["--recover-stale", opts.recoverStale],
    ["--workflow", opts.workflow],
    ["--reviewer", opts.reviewer],
    ["--workflow-max-actions", opts.workflowMaxActions],
    ["--review-aging-minutes", opts.reviewAgingMinutes],
  ]) {
    add(flag, value);
  }
  // 0034 — only the non-default origin needs carrying; a child that omits it is
  // a supervisor-started loop, which is what it would have inherited anyway.
  if (opts.openedBy === "human") add("--opened-by", "human");
  if (opts.patrolIntervalExplicit === true || opts.patrolInterval !== DEFAULT_PATROL_SECONDS) {
    add("--patrol-interval", opts.patrolInterval);
  }
  if (opts.boardLimit !== DEFAULT_BOARD_LIMIT) add("--board-limit", opts.boardLimit);
  if (opts.trailLimit !== DEFAULT_TRAIL_LIMIT) add("--trail-limit", opts.trailLimit);
  // Always carry the resolved value: the child poll must not re-resolve the cap
  // from an env or per-kind config that differs from the one this process used.
  add("--max-concurrency", opts.maxConcurrency);
  if (opts.patrolLlm) args.push("--patrol-llm");
  // The resident settings the child `passes.mjs` re-reads: it must ask
  // `poolStatus()` about the *same* state file, and `--resident=no` must reach
  // the poll that would otherwise claim.
  const sessionDefault = join(dirname(opts.state), "sessions.state.json");
  if (opts.resident === "no") add("--resident", "no");
  if (opts.sessionState !== sessionDefault) add("--session-state", opts.sessionState);
  if (opts.projectConcurrency !== opts.maxConcurrency) {
    add("--project-concurrency", opts.projectConcurrency);
  }
  // The child pass must use the same workspace mode it was resolved with.
  add("--workspace", opts.workspace ?? "worktree");
  return args;
}

/**
 * The command a headless turn runs for the loop's passes *and* its board reads.
 *
 * The interpreter is the bare name `node`, never `process.execPath`: the control
 * session's tool allowlist is `Bash(node *)`, which matches a command whose first
 * token is literally `node`. An absolute interpreter path matches no allowlist
 * entry, so `--permission-mode dontAsk` refuses every pass — the loop then runs
 * its clocks but can never touch the board. The scheduling unit's PATH always
 * carries node's own directory (`scripts/install/lib/unit-path.mjs`), so the bare
 * name resolves where the turn runs.
 *
 * @param {object} opts
 * @returns {string}
 */
export function loopCliCommand(opts) {
  return ["node", quoteArg(opts.cli), ...loopCommandArgs(opts).map(quoteArg)].join(" ");
}

/**
 * The command a headless turn runs for its *board* reads and writes.
 *
 * Not `loopCliCommand`: that one carries the loop's own flags (`--log`, `--state`,
 * `--max-concurrency`, …), which the board subcommands do not accept. A
 * `taskctl issue list` needs only the identity, so the prefix stops there. Same
 * bare interpreter, same allowlist entry.
 *
 * @param {object} opts
 * @returns {string}
 */
export function loopBoardCommand(opts) {
  return ["node", quoteArg(opts.cli), "--actor-kind", opts.actorKind, "--agent", opts.agents[0] ?? "agent"].join(" ");
}

export const USAGE = `Usage: taskctl loop <patrol|workflow|poll|tick|console|status|run|subscribe|session|compat> [options]

Run it through \`taskctl loop <verb>\`; this page lists the shared options. The
verbs map onto the entries below, so the selectors are not part of the public
surface: \`loop session\` is the resident pool, \`loop subscribe\` the event daemon,
\`loop run --ping-once\` / \`--continue-once\` one-shot clocks.

The loop's scheduler. In its default resident shape it owns a session pool:
  session    long-lived — one control conversation (cwd = this checkout) plus one
             project conversation per target directory; a project session spawns
             the worker/reviewer subagent, which inherits that directory.
It also owns two clocks:
  ping       every ${DEFAULT_PING_SECONDS}s — prune dead worker pids; no board read, no LLM.
  continue   every ${DEFAULT_CONTINUE_SECONDS}s — hand the control session a bounded
             "Continue" prompt; that turn runs the poll, patrol and workflow entries.
             With no resident pool it runs patrol + workflow one-shot and claims nothing.

--subscribe adds an optional event daemon beside those clocks: it holds one SSE
connection and asks for a continue turn when a dispatch-relevant event arrives.
The clocks stay as the fallback (and as the only path for time-based work).

Options:
  --agent <name>            Agent(s) to work for. Repeatable / comma-separated.
                            Default: MEERKAT_TASKPANEL_AGENTS, then $TASKCTL_AGENT,
                            then $USER.
  --roles-dir <path>        Optional team roles root. Default: the project's
                            .meerkat/roles, then the loop skill's roles/.
  --actor-kind claude|codex|pi
                            Which actor kind to wake (default: claude).
  --repo <path>             Repository root (default: this checkout; an agent-installed
                            copy takes it from --config — MEERKAT_TASKPANEL_REPO).
  --ping-interval <sec>     Liveness clock (default: ${DEFAULT_PING_SECONDS}).
  --continue-interval <sec> Judgment clock (default: ${DEFAULT_CONTINUE_SECONDS} = 10 minutes).
  --continue=yes|no         Enable the continue turn (default: yes).
  --continue-state <path>   Continue lock (default: continue.state.json beside --state).
  --control=internal|external
                            Who owns the control turn (default: internal). With
                            external, the pool opens no control session and skips
                            continue.pending — a live /meerkat-loop session is the
                            control; project sessions still dispatch.
  --resident=auto|no        Use a live resident pool for continue (default: auto);
                            no forces the one-shot fallback with poll skipped.
  --session-state <path>    Sessions state file (default: sessions.state.json beside --state).
  --session-max-age <sec>   Fresh conversation after this age (default: 86400; 0 = never).
  --session-turn-timeout <sec> Per-turn cap, 1200..7199 (default: 1800). A turn
                            shorter than 2x the heartbeat window starves workers;
                            at 2h the ledger reaps them.
  --opened-by human|supervisor  Who started this loop (default: supervisor).
                            A supervisor-started loop escalates questions to the
                            board; a human-opened one may ask its own operator.
  --session-poll-ms <ms>    Queue poll interval (default: 1000).
  --session-pool-max <n>    Max resident lane sessions (default: 8).
  --project-concurrency <n> Max live subagents per project (default: --max-concurrency).
  --workspace <worktree|shared>
                            Per-card git worktree for a git project (default: worktree).
  --project-idle-ms <ms>    Close an idle project session after this (default: 1800000).
  --allow-all-tools         Enable every agent tool. Requires --allow-all-tools-reason;
                            the session runs with the operator's full OS permissions.
  --allow-all-tools-reason <text>
                            Who authorized full tool access, and why.
  --once                    Internal one-shot switch; the documented form is
                            \`taskctl loop run --ping-once|--continue-once\`.
  --ping-only               With --once, prune the worker registry and exit.
  --continue-only           With --once, run one continue turn.
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
  --max-concurrency <n>     Max concurrent subagents. Workers and reviewers share
                            this cap and compete for slots by demand; no per-role
                            reservation (default: ${DEFAULT_MAX_CONCURRENCY}; at 8 the nominal
                            working set is 6 workers + 2 reviewers).
  --claim-unassigned=yes|no Also claim unassigned cards (default: yes).
  --assignee-only           Alias for --claim-unassigned=no.
  --recover-stale=yes|no    Also recover stale in_progress claims (default: yes).
  --workflow=yes|no         Run the workflow pass when the continue turn calls it (default: yes).
  --reviewer <agent>        The independent reviewer. Unset disables review dispatch.
  --workflow-max-actions <n> Max workflow writes per pass (default: 20).
  --review-aging-minutes <n> Report a silent review card after this long (default: 60).
  --patrol-llm=yes|no       Allow patrol to start an LLM turn (default: no).
  --notify <cmd>            Run <cmd> with each patrol alert as JSON on stdin.
  --dry-run                 Print intended actions; write nothing, spawn nothing.
  --log <path>              Append log lines here (default: <home>/<agent-dir>/meerkat-taskpanel/supervisor.log).
  --state <path>            Worker registry (default: <home>/<agent-dir>/meerkat-taskpanel/supervisor.state.json).
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
  --config <path>           Per-kind config (default: <program root>/.env.<actor-kind>;
                            env: MEERKAT_TASKPANEL_CONFIG_DIR).
  --home <path>             Home the defaults are resolved against (default: $HOME).
  --cli <path>              taskctl entry (default: <repo>/src/cli/index.mjs).
  -h, --help                Show this help

The deterministic passes are also runnable on their own:
  taskctl loop patrol     notify-only SLA rows (${PEER_MECHANISM}; peer watchdog ${PEER_LIVENESS_K}x${PEER_PERIOD_MIN}min)
  taskctl loop workflow   apply the board's workflow plan
  taskctl loop poll       scan → atomic claim → enqueue the handoff;
                                          a resident project session spawns the subagent`;

