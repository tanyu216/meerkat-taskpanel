/**
 * The scheduling policy — the *decision* half of the host-external supervisor.
 *
 * A supervisor tick has two halves that must not be tangled: what to do (this
 * file, pure) and doing it (spawning `claude -p` / `codex exec`, reading the
 * board — `scripts/supervisor.mjs`, I/O). Keeping the decision pure means the
 * load-bearing rules are decided without a clock, a process or a database:
 *
 *   * **fire-only.** A scan with no candidates plans no work, so no worker is
 *     ever started for an empty scan — the whole point of the cheap poll entry.
 *   * **atomic claim = the only dispatch.** The plan says *what* to wake; the
 *     runner claims first and only wakes a card whose claim was accepted.
 *   * **idempotent.** A card already in the running registry — or offered twice
 *     in one tick (the public pool) — is skipped, never re-woken.
 *   * **bounded.** New wakes never exceed `maxConcurrency − running`.
 *   * **fresh heartbeat = no-op; a broken heartbeat is never silent.** Patrol
 *     returns an alert for a stale claim *and* for a heartbeat it cannot read.
 *
 * Layers: `shared` imports nothing from `src/`; only `constants.mjs` and
 * `errors.mjs` (both pure) are used here.
 */

import { CLAIM_STALE_SAME_MS } from "./constants.mjs";
import { DomainError } from "./errors.mjs";

/** Default cap on concurrently running workers. */
export const DEFAULT_MAX_CONCURRENCY = 8;
/** Legacy poll cadence, seconds — kept for older callers; the clock is `DEFAULT_PING_SECONDS`. */
export const DEFAULT_POLL_SECONDS = 60;
/** The SLA measurement period, seconds — no longer a scheduling cadence. */
export const DEFAULT_PATROL_SECONDS = 300;
/**
 * Default ping cadence, seconds — the scheduler's liveness clock. Ping only
 * prunes dead worker pids from the registry; it never reads the board.
 */
export const DEFAULT_PING_SECONDS = 60;
/**
 * Default continue cadence, seconds — the scheduler's judgment clock. A
 * continue turn wakes the host agent with a bounded prompt; that turn runs the
 * deterministic poll, patrol and workflow entries.
 */
export const DEFAULT_CONTINUE_SECONDS = 600; // 10 minutes
/** A claim older than this is "stale" for patrol (same-holder recovery window). */
export const PATROL_STALE_MS = CLAIM_STALE_SAME_MS;

const TRUE_WORDS = new Set(["yes", "true", "1", "y", "on"]);
const FALSE_WORDS = new Set(["no", "false", "0", "n", "off"]);

/**
 * Quote one argv element for a shell command line. The continue prompt embeds
 * the deterministic entries' argv, so a path with a space must survive a copy
 * into a shell unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function quoteArg(value) {
  const text = String(value ?? "");
  if (text !== "" && /^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse a yes/no-ish string into a boolean, or `null` when it says nothing.
 * @param {unknown} value
 * @returns {boolean|null}
 */
export function parseYesNo(value) {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/**
 * Parse a `KEY=value` env file the installer writes (comment and blank lines
 * ignored, `export ` prefix and matching quotes stripped).
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

/**
 * The effective `claim_unassigned` policy.
 *
 * Precedence is **flag > environment > installer's host config file > default
 * on** — the operator's most explicit statement wins, and the installer's saved
 * choice is only a default. An unrecognised value is ignored (never an error):
 * a stray `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=maybe` must not wedge the poll.
 *
 * @param {{flag?: unknown, env?: unknown, file?: Record<string, string>|null}} [input]
 * @returns {boolean}
 */
export function resolveClaimUnassigned(input = {}) {
  const fromFlag = parseYesNo(input.flag);
  if (fromFlag !== null) return fromFlag;
  const fromEnv = parseYesNo(input.env);
  if (fromEnv !== null) return fromEnv;
  const file = input.file ?? null;
  // legacy-name-compat: a host config written before the rename carries the old key.
  const fromFile = parseYesNo(
    file === null
      ? undefined
      : (file.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED ?? file.TASKPANEL_CLAIM_UNASSIGNED),
  );
  if (fromFile !== null) return fromFile;
  return true;
}

/**
 * The effective stale-recovery policy.
 *
 * A stale `in_progress` card (heartbeat past the same-holder bound, or past the
 * six-hour takeover bound) is offered by `issue candidates --stale` and claimed
 * through `issue claim`. Like the public pool, it is an opt-out: a supervisor
 * that should never take over somebody else's card runs with `no`.
 *
 * Precedence is the same as `resolveClaimUnassigned`: **flag > environment >
 * installer's host config > default on**.
 *
 * @param {{flag?: unknown, env?: unknown, file?: Record<string, string>|null}} [input]
 * @returns {boolean}
 */
export function resolveRecoverStale(input = {}) {
  const fromFlag = parseYesNo(input.flag);
  if (fromFlag !== null) return fromFlag;
  const fromEnv = parseYesNo(input.env);
  if (fromEnv !== null) return fromEnv;
  const file = input.file ?? null;
  const fromFile = parseYesNo(file === null ? undefined : file.MEERKAT_TASKPANEL_RECOVER_STALE);
  if (fromFile !== null) return fromFile;
  return true;
}

/**
 * Whether the scheduler wakes the host's periodic judgment turn.
 *
 * Precedence is the same as `resolveClaimUnassigned`: **flag > environment >
 * installer's host config > default on**. Turning it off leaves the ping clock
 * running (worker liveness) but discovers no new work until a human runs the
 * poll entry.
 *
 * @param {{flag?: unknown, env?: unknown, file?: Record<string, string>|null}} [input]
 * @returns {boolean}
 */
export function resolveContinueEnabled(input = {}) {
  const fromFlag = parseYesNo(input.flag);
  if (fromFlag !== null) return fromFlag;
  const fromEnv = parseYesNo(input.env);
  if (fromEnv !== null) return fromEnv;
  const file = input.file ?? null;
  const fromFile = parseYesNo(file === null ? undefined : file.MEERKAT_TASKPANEL_CONTINUE);
  if (fromFile !== null) return fromFile;
  return true;
}

/**
 * A positive cadence in seconds. `file` is the *value* read from the host
 * config (not the whole map); invalid values are ignored rather than allowed
 * to wedge a clock.
 *
 * @param {{flag?: unknown, env?: unknown, file?: unknown, fallback?: number}} [input]
 * @returns {number}
 */
export function resolveIntervalSeconds(input = {}) {
  const fallback =
    Number.isInteger(input.fallback) && input.fallback > 0 ? input.fallback : DEFAULT_CONTINUE_SECONDS;
  for (const value of [input.flag, input.env, input.file]) {
    if (value === undefined || value === null || value === "") continue;
    const number = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return fallback;
}

/** Default cap on writes one workflow pass may perform. */
export const DEFAULT_WORKFLOW_MAX_ACTIONS = 20;
/** Default age, in minutes, before a silent review card is reported. */
export const DEFAULT_REVIEW_AGING_MINUTES = 60;

/**
 * The workflow sub-pass's configuration.
 *
 * Same precedence as `resolveClaimUnassigned` — **flag > environment > host
 * config file > default** — and the same tolerance: an unrecognised yes/no word
 * is ignored rather than treated as `false`, so a stray value cannot silently
 * disable the channel. The two booleans mean different things:
 *
 *   * `workflow` is the whole channel. Off means the loop writes no card at all.
 *   * `autoAcceptReviews` gates **only** the review card's own
 *     `in_review → done`. With it off the loop still applies the verdict to the
 *     original card and leaves the review card for a human to accept — the
 *     documented escape hatch back to manual acceptance.
 *
 * An empty reviewer is "not configured", not an empty name: review dispatch is
 * skipped and the rest of the channel (reconcile + outcomes) still runs, so a
 * deployment that later drops its reviewer can still finish the reviews already
 * in flight.
 *
 * @param {{flags?: object, env?: object, file?: Record<string, string>|null}} [input]
 * @returns {{workflow: boolean, reviewer: string|null, autoAcceptReviews: boolean, maxActions: number, reviewAgingMs: number}}
 */
export function resolveWorkflowConfig(input = {}) {
  const flags = input.flags ?? {};
  const env = input.env ?? {};
  const file = input.file ?? {};

  const firstYesNo = (...values) => {
    for (const value of values) {
      const parsed = parseYesNo(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const firstText = (...values) => {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed !== "") return trimmed;
    }
    return null;
  };
  const firstPositive = (...values) => {
    for (const value of values) {
      const number = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
      if (Number.isInteger(number) && number > 0) return number;
    }
    return null;
  };

  return {
    workflow:
      firstYesNo(flags.workflow, env.MEERKAT_TASKPANEL_WORKFLOW, file.MEERKAT_TASKPANEL_WORKFLOW) ?? true,
    reviewer: firstText(
      flags.reviewer,
      env.MEERKAT_TASKPANEL_REVIEWER,
      file.MEERKAT_TASKPANEL_REVIEWER,
    ),
    autoAcceptReviews:
      firstYesNo(
        flags.autoAcceptReviews,
        env.MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS,
        file.MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS,
      ) ?? true,
    maxActions:
      firstPositive(
        flags.workflowMaxActions,
        env.MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS,
        file.MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS,
      ) ?? DEFAULT_WORKFLOW_MAX_ACTIONS,
    reviewAgingMs:
      (firstPositive(
        flags.reviewAgingMinutes,
        env.MEERKAT_TASKPANEL_REVIEW_AGING_MINUTES,
        file.MEERKAT_TASKPANEL_REVIEW_AGING_MINUTES,
      ) ?? DEFAULT_REVIEW_AGING_MINUTES) * 60_000,
  };
}

/**
 * Classify a stored `heartbeat_at`.
 *
 * Returns a *reason* rather than `null` for a heartbeat that is absent or
 * unreadable, because patrol must report that case — a claim whose heartbeat
 * cannot be read is exactly the state that used to vanish silently.
 *
 * @param {unknown} value
 * @returns {{ok: true, at: number} | {ok: false, reason: "missing"|"unreadable", value?: unknown}}
 */
export function parseHeartbeat(value) {
  if (value === null || value === undefined || value === "") return { ok: false, reason: "missing" };
  if (typeof value !== "string") return { ok: false, reason: "unreadable", value };
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return { ok: false, reason: "unreadable", value };
  return { ok: true, at };
}

/**
 * Heartbeat age in milliseconds at `now`, or `null` when the heartbeat cannot
 * be read. A future-dated heartbeat clamps to `null` (not stale) — the same
 * strict `>` window the board's `staleReason` uses.
 *
 * @param {unknown} value
 * @param {string|number} now
 * @returns {number|null}
 */
export function heartbeatAge(value, now) {
  const parsed = parseHeartbeat(value);
  if (!parsed.ok) return null;
  const age = new Date(now).getTime() - parsed.at;
  if (!Number.isFinite(age) || age < 0) return null;
  return age;
}

/** The number of cards a registry currently records as running. */
function runningCount(registry) {
  const running = registry?.running;
  return running && typeof running === "object" ? Object.keys(running).length : 0;
}

/**
 * Decide one poll tick.
 *
 * @param {{candidates?: object[], registry?: object, config?: {maxConcurrency?: number}}} input
 * @returns {Array<{type: "wake"|"skip", identifier: string, agent: string, reason?: string, why?: string}>}
 *   an ordered action list; an empty candidate list yields `[]`, so an empty
 *   scan can never reach the worker spawn.
 */
export function planTick(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const registry = input.registry ?? { running: {} };
  const maxConcurrency = Number.isFinite(input.config?.maxConcurrency)
    ? input.config.maxConcurrency
    : DEFAULT_MAX_CONCURRENCY;

  const running = registry.running ?? {};
  const seen = new Set(Object.keys(running));
  const slots = Math.max(0, maxConcurrency - runningCount(registry));

  const actions = [];
  let started = 0;
  for (const candidate of candidates) {
    const identifier = String(candidate?.identifier ?? "");
    const agent = String(candidate?.agent ?? "");
    if (identifier === "") continue;
    if (seen.has(identifier)) {
      // Already running (this tick or a previous one) — never wake it twice.
      actions.push({ type: "skip", identifier, agent, why: running[identifier] === undefined ? "duplicate" : "running" });
      continue;
    }
    if (started >= slots) {
      actions.push({ type: "skip", identifier, agent, why: "cap" });
      continue;
    }
    seen.add(identifier);
    started += 1;
    actions.push({ type: "wake", identifier, agent, reason: String(candidate.reason ?? "ready") });
  }
  return actions;
}

/**
 * Decide a patrol pass over the board's `in_progress` cards. Pure and
 * LLM-free by construction: the only outputs are alerts, so "no LLM turn by
 * default" is a property of the plan, not a flag the runner must remember.
 *
 * @param {{tasks?: object[], now: string|number}} input
 * @returns {Array<{type: "stale"|"heartbeat-unreadable", identifier: string, agent: string|null, heartbeatAt?: unknown, ageMs?: number, value?: unknown, reason?: string}>}
 */
export function planPatrol(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const now = input.now;
  const alerts = [];
  for (const task of tasks) {
    if (task?.status !== "in_progress") continue;
    const identifier = String(task?.identifier ?? "");
    if (identifier === "") continue;
    // Who holds the card, as a person: `claimed_by` is an actor **id** since 0020,
    // so the name comes off the wire's `claimed_by_actor` ref (the same one the
    // board renders). The fallbacks keep an older/board-less projection readable.
    const agent = task?.claimed_by_actor?.display_name ?? task?.assignee?.display_name ?? null;
    const parsed = parseHeartbeat(task?.heartbeat_at);
    if (!parsed.ok) {
      alerts.push({
        type: "heartbeat-unreadable",
        identifier,
        agent,
        heartbeatAt: task?.heartbeat_at ?? null,
        reason: parsed.reason,
        ...(parsed.reason === "unreadable" ? { value: parsed.value } : {}),
      });
      continue;
    }
    const age = new Date(now).getTime() - parsed.at;
    if (Number.isFinite(age) && age > PATROL_STALE_MS) {
      alerts.push({ type: "stale", identifier, agent, heartbeatAt: task.heartbeat_at, ageMs: age });
    }
  }
  return alerts;
}

/**
 * Drop registry entries whose process is gone, so a crashed worker does not
 * pin a concurrency slot forever. An entry with no pid is kept (a hand-written
 * or legacy record has nothing to check).
 *
 * @param {{running?: Record<string, {pid?: number}>}} registry
 * @param {(pid: number) => boolean} isAlive
 * @returns {object} a new registry
 */
export function pruneRegistry(registry, isAlive) {
  const running = registry?.running ?? {};
  const kept = {};
  for (const [identifier, entry] of Object.entries(running)) {
    const pid = entry?.pid;
    if (pid === undefined || pid === null || isAlive(pid)) kept[identifier] = entry;
  }
  return { ...(registry ?? {}), running: kept };
}

/**
 * The `taskctl issue candidates` argv for one agent.
 *
 * `--include-unassigned` asks the board for the public pool (unassigned,
 * claimable cards) as well as the agent's own; `--stale` asks for the recovery
 * pool (in_progress cards whose heartbeat is past the holder bound, or past the
 * six-hour takeover bound for anyone). Each is a read flag — the *claim* is
 * still the board's decision, via `issue claim`.
 *
 * @param {string} agent
 * @param {boolean} claimUnassigned
 * @param {boolean} [recoverStale]
 * @returns {string[]}
 */
export function candidateArgs(agent, claimUnassigned, recoverStale = false) {
  const args = ["issue", "candidates", "--assignee", String(agent)];
  if (claimUnassigned) args.push("--include-unassigned");
  if (recoverStale) args.push("--stale");
  return args;
}

/**
 * The wake argv for a host. Claude, Codex and Pi have no timers, so the loop
 * lives outside them, waking each host's own **headless** entry point — and,
 * when a session id is known, that host's own **resume** form:
 *
 *   * **claude** — `claude -p <prompt>`; resume with `--resume <sid>`.
 *   * **codex**  — `codex exec <prompt>`; resume the thread with
 *     `codex exec resume <sid> <prompt>` (`codex exec resume [OPTIONS]
 *     [SESSION_ID] [PROMPT]`).
 *   * **pi**     — `pi --print <prompt>` (`--print` is pi's non-interactive
 *     mode; pi has no `run` subcommand); resume a specific session with
 *     `pi --print --session <sid> <prompt>` (`--session <path|id>`).
 *
 * These shapes are the ones verified against the real CLIs — the per-host
 * capability matrix in `scripts/verify/host-resume-matrix.mjs`. An explicit
 * `wakeCommand` override lets an installer or a user plug in their own glue.
 *
 * @param {{host?: string, prompt: string, resumeSid?: string|null, wakeCommand?: string|null}} input
 * @returns {{command: string, args: string[]}}
 */
export function wakeCommand(input = {}) {
  const prompt = String(input.prompt ?? "");
  const resumeSid = input.resumeSid ?? null;
  if (input.wakeCommand) {
    return { command: String(input.wakeCommand), args: resumeSid ? [prompt, "--resume", String(resumeSid)] : [prompt] };
  }
  switch (input.host) {
    case "claude":
      return { command: "claude", args: resumeSid ? ["-p", prompt, "--resume", String(resumeSid)] : ["-p", prompt] };
    case "codex":
      return resumeSid
        ? { command: "codex", args: ["exec", "resume", String(resumeSid), prompt] }
        : { command: "codex", args: ["exec", prompt] };
    case "pi":
      return resumeSid
        ? { command: "pi", args: ["--print", "--session", String(resumeSid), prompt] }
        : { command: "pi", args: ["--print", prompt] };
    default:
      throw new DomainError("VALIDATION_FAILED", {
        message: `unknown host '${input.host}'`,
        details: { field: "host", value: input.host },
        hint: { fix: "--host claude|codex|pi" },
      });
  }
}

/**
 * What the supervisor actually spawns to wake a card — and *where*.
 *
 * The supervisor knows a card's board **project identity** and nothing about
 * directories: the board holds none (O3). So the directory is not decided here.
 * It is decided by the host's own wake glue, which reads the host-local
 * `projects.json` and `cd`s into the directory it names for the card's project —
 * `local_path`, else `run_dir` — before exec'ing the host CLI (R1).
 *
 * Three shapes follow from that, in the order an operator's intent wins:
 *
 *   * **an explicit wake command** (`--wake-command`) — the operator's own glue,
 *     used verbatim: `<cmd> <handoff> [sid]`. It is the documented escape hatch
 *     for a host this repo does not wire, so nothing here second-guesses it.
 *   * **glue installed** — spawn `bash <glue> <handoff> [sid]`, handing the
 *     project identity along in the environment (`TP_PROJECT`). The glue sets
 *     the working directory; if it cannot, it refuses the wake and the card
 *     stays unwoken rather than running in the wrong checkout.
 *   * **no glue** — the supervisor falls back to the host CLI directly, pinned
 *     to `cwd` (the `--repo` root) and flagged with an explicit `warning`: the
 *     honest "no target directory was resolved for this wake" case, never a
 *     silent one.
 *
 * @param {{
 *   host: string,
 *   prompt: string,
 *   resumeSid?: string|null,
 *   wakeCommand?: string|null,
 *   gluePath?: string|null,
 *   glueInstalled?: boolean,
 *   project?: string|null,
 *   projectsJson?: string|null,
 *   nodePath?: string|null,
 *   cwd?: string|null,
 * }} input
 * @returns {{command: string, args: string[], env: Record<string,string>, cwd: string|null, via: "glue"|"override"|"direct", warning?: string}}
 */
export function planWakeInvocation(input = {}) {
  const prompt = String(input.prompt ?? "");
  const resumeSid = input.resumeSid ?? null;
  const cwd = input.cwd ?? null;

  // The identity travels in the environment, not in argv: the glue's argv is a
  // fixed `[handoff, sid?]` shape the host-resume matrix already pins.
  const env = {};
  if (input.project !== undefined && input.project !== null && String(input.project) !== "") {
    env.TP_PROJECT = String(input.project);
  }
  if (input.projectsJson !== undefined && input.projectsJson !== null && String(input.projectsJson) !== "") {
    env.TP_PROJECTS_JSON = String(input.projectsJson);
  }
  // The glue shell has to run a node to resolve the directory, and under cron /
  // launchd `PATH` is minimal — so hand it the interpreter this supervisor is
  // already running on rather than betting on `node` being findable.
  if (input.nodePath !== undefined && input.nodePath !== null && String(input.nodePath) !== "") {
    env.TP_NODE = String(input.nodePath);
  }

  // The operator's own wake command comes first: an explicit choice is never
  // overridden by a default, and it is never second-guessed with a warning.
  if (input.wakeCommand) {
    const override = wakeCommand({ host: input.host, prompt, resumeSid, wakeCommand: input.wakeCommand });
    return { ...override, env, cwd, via: "override" };
  }

  const glue = input.gluePath ?? null;
  if (glue !== null && input.glueInstalled === true) {
    return {
      command: "bash",
      args: [glue, prompt, ...(resumeSid === null ? [] : [String(resumeSid)])],
      env,
      cwd,
      via: "glue",
    };
  }

  return {
    ...wakeCommand({ host: input.host, prompt, resumeSid }),
    env,
    cwd,
    via: "direct",
    warning:
      `no wake glue at ${glue ?? "(unset)"} — the worker runs in ${cwd ?? "the supervisor's working directory"} ` +
      "without a resolved project target directory",
  };
}

/**
 * What the scheduler spawns for one **continue** turn.
 *
 * A continue turn is not a card wake: it has no card, no project identity and
 * no session to resume. So it always takes the host's built-in headless form
 * and never the wake glue — the glue exists to resolve a card's project target
 * directory, and `wake-cwd.mjs` refuses an empty project rather than guessing
 * one. `TP_NODE` is still carried so a nested glue (started by the workers the
 * turn wakes) finds the interpreter this scheduler is running on.
 *
 * @param {{host: string, prompt: string, cwd?: string|null, nodePath?: string|null}} input
 * @returns {{command: string, args: string[], env: Record<string,string>, cwd: string|null, via: "direct"}}
 */
export function planContinueInvocation(input = {}) {
  const prompt = String(input.prompt ?? "");
  const cwd = input.cwd ?? null;
  const env = {};
  if (input.nodePath !== undefined && input.nodePath !== null && String(input.nodePath) !== "") {
    env.TP_NODE = String(input.nodePath);
  }
  return { ...wakeCommand({ host: input.host, prompt }), env, cwd, via: "direct" };
}

/**
 * The fresh handoff handed to a woken worker — bounded so a wake never carries
 * an unbounded context. It names the card, the attribution flags every write
 * should carry, and the compliant next step (triage, read, work, report).
 *
 * **Step 0 is the epic-triage decision**, and it lives in the handoff rather
 * than in a separate planner process: the worker is the only process that has
 * already read the card when the answer is cheap, and the claim→wake path is
 * the one place the loop can afford to ask. A card with several independent
 * deliverables is promoted to `epic` and split into children *before* any work
 * starts; a card with one deliverable proceeds untouched.
 *
 * The handoff names no workspace (O3): a card carries no board-owned directory,
 * so the wake must not hand one to the worker.
 *
 * @param {{card?: object, agent: string, host: string, sessionId?: string|null, review?: boolean}} input
 * @returns {string}
 */
export function buildHandoff(input) {
  const card = input.card ?? {};
  const title = String(card.title ?? "").slice(0, 300);
  const ref = card.identifier;
  const project = card.project ?? "<project id>";
  const attribution = [`--agent ${input.agent}`, `--actor-kind ${input.host}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const flags = attribution.join(" ");
  const acceptanceRule = input.review === true
    ? "stop at in_review — the loop dispatches an independent reviewer; do not move it to done yourself."
    : "stop at in_review — a human accepts to done.";
  return [
    `You have been woken by the Meerkat TaskPanel supervisor to work one card: ${ref}.`,
    `Title: ${title}`,
    "",
    "Step 0 — before working, decide whether this card is a container:",
    `  taskctl issue get ${ref} ${flags}    # read the description and the acceptance list`,
    "  If it contains several independent deliverables, promote it and split it FIRST:",
    `    taskctl issue update ${ref} --kind epic ${flags}`,
    `    taskctl issue move ${ref} todo ${flags}      # an epic is never claimed; release this wake's claim`,
    `    taskctl comment add ${ref} --kind change --body "split into: ..." ${flags}`,
    `    taskctl issue create --project ${project} --title "..." --acceptance "..." --target "<piece>" ${flags}`,
    `    taskctl relation add ${ref} --type parent --target <child> ${flags}`,
    `    taskctl issue move <child> in_progress ${flags}    # claim ONE piece and work that`,
    "    Give every child its own --target: the create guard dedupes on kind+assignee+source+target.",
    "    meta.epic_triage=off means do not promote; if you split, record the plan in a change comment.",
    "  If there is one deliverable, work this card as it is (the epic is then never claimed).",
    "",
    `Read it first:  taskctl issue get ${ref} ${flags}`,
    `Keep the claim alive:  taskctl issue heartbeat ${ref} ${flags}`,
    `Deliver with a report:  taskctl issue deliver ${ref} --report-file - ${flags}`,
    "",
    "Rules: the supervisor already claimed this card for you; after a split, the heartbeat and",
    "the delivery apply to the claimed CHILD, not to the epic. Keep the heartbeat fresh",
    "(<=10 minutes) with the pulse command above; deliver with a report for the current round;",
    `${acceptanceRule} Carry the attribution flags above on every write.`,
  ].join("\n");
}

/**
 * The handoff handed to a **reviewer** woken for a review card.
 *
 * A reviewer is an independent agent, not the card's worker: it reads the
 * original, the delivery report, the comment trail and the container's children,
 * and delivers exactly one thing — a verdict report on the review card. It moves
 * nothing: the loop is the acceptor (`autoAcceptReviews` is the escape hatch
 * back to a human). The `review_not_ready` check is first because the board may
 * have moved between the dispatch and the wake, and a verdict on a card that is
 * no longer delivered is worse than no verdict at all.
 *
 * @param {{card?: object, agent: string, host: string, sessionId?: string|null}} input
 * @returns {string}
 */
export function buildReviewHandoff(input) {
  const card = input.card ?? {};
  const ref = card.identifier;
  const original = card.review_of ?? "<card under review>";
  const round = card.review_round ?? "the round recorded on the review card";
  const attribution = [`--agent ${input.agent}`, `--actor-kind ${input.host}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const flags = attribution.join(" ");
  return [
    `You have been woken by the Meerkat TaskPanel supervisor to review one delivered card.`,
    `Review card: ${ref}`,
    `Card under review: ${original} (round ${round})`,
    "",
    "Step 0 — the review_not_ready check; do it before reading anything else:",
    `  taskctl issue get ${original} ${flags}`,
    "  If its status is not in_review, or its delivery_round is not the round above:",
    `    taskctl comment add ${ref} --kind note --body "review target is no longer in_review / the round changed" ${flags}`,
    "    and stop. Do not deliver a verdict; the loop will close this review card.",
    "",
    "Read:",
    `  taskctl issue get ${ref} ${flags}`,
    `  taskctl report list ${original} ${flags}`,
    `  taskctl comment list ${original} --limit 200 ${flags}`,
    `  taskctl relation list ${original} ${flags}     # an epic's children`,
    "Audit the description, every acceptance item, the delivery report for this round and its",
    "evidence, the comment trail (unresolved decision/defect entries), and — for an epic — the",
    "rollup report and each child's state.",
    "",
    "Deliver:",
    `  taskctl report template ${ref}   # fill it in, then:`,
    `  taskctl issue deliver ${ref} --report-file - ${flags}`,
    "The report's FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.",
    "Put the findings after that line and in `leftovers`.",
    "",
    "Rules: claim and heartbeat only this review card, never the card under review. Do not move",
    "the card under review and do not move this review card: the loop applies the verdict and",
    "closes this card. Carry the attribution flags above on every write.",
  ].join("\n");
}

/**
 * The bounded prompt for the scheduler's periodic **continue** turn.
 *
 * The loop's deterministic work is no longer scheduled as its own units: this
 * turn is where poll, patrol and workflow are invoked. The prompt is therefore
 * self-contained — absolute entry paths, the order to run them in, and the
 * board rules that must not be broken — because a headless host may run it
 * without the loop skill loaded.
 *
 * Order is **patrol → workflow → poll**: the workflow pass dispatches a review
 * card, and the poll that follows in the same turn can claim and wake its
 * reviewer immediately; polling first would delay that review by a whole
 * cadence.
 *
 * It names no card and no project directory on purpose. A continue turn is
 * not a worker wake, and the board holds no project directory to name.
 *
 * @param {{
 *   host?: string,
 *   agent?: string,
 *   nodePath?: string|null,
 *   scripts?: {poll?: string, patrol?: string, workflow?: string},
 *   commonArgs?: string[],
 *   continueIntervalSeconds?: number,
 * }} [input]
 * @returns {string}
 */
export function buildContinuePrompt(input = {}) {
  const node = quoteArg(input.nodePath ?? "node");
  const agent = String(input.agent ?? "agent");
  const host = String(input.host ?? "claude");
  const scripts = input.scripts ?? {};
  const common = (input.commonArgs ?? []).map(quoteArg).join(" ");
  const minutes = Math.max(
    1,
    Math.round((input.continueIntervalSeconds ?? DEFAULT_CONTINUE_SECONDS) / 60),
  );
  const run = (script) => `${node} ${quoteArg(script)}${common === "" ? "" : ` ${common}`}`;

  return [
    "继续 — Meerkat TaskPanel loop, judgment turn.",
    "No card and no project directory: this is the loop's periodic turn, not a worker wake.",
    "",
    "Run in order, each one pass:",
    `  1) ${run(scripts.patrol)}   # notify-only SLA; never moves a card`,
    `  2) ${run(scripts.workflow)}   # reconcile / review dispatch / verdicts (system)`,
    `  3) ${run(scripts.poll)}   # scan → atomic claim → wake a worker`,
    "",
    `You may claim a ready card yourself (\`taskctl issue claim <ref> --agent ${agent}\`)`,
    "when judgment says it must start now; never claim work you will not start.",
    "",
    "Rules:",
    "- Never move a card to done. in_review → done is the workflow entry's system acceptance.",
    "- A reviewer moves nothing; it delivers a VERDICT report on its review card.",
    "- Stop work at in_review: deliver a report, do not self-accept.",
    "- Keep this turn bounded: start workers and return; do not wait for them.",
    "- At the concurrency cap, leave the card for the next turn.",
    `- Host: ${host}. This turn repeats every ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  ].join("\n");
}
