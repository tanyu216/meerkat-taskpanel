/**
 * The scheduling policy — the *decision* half of the external supervisor.
 *
 * A supervisor tick has two halves that must not be tangled: what to do (this
 * file, pure) and doing it (spawning `claude -p` / `codex exec`, reading the
 * board — `src/orchestrator/`, I/O). Keeping the decision pure means the
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
 * Layers: `foundation` imports nothing from `src/`; only `constants.mjs` and
 * `errors.mjs` (both pure) are used here.
 */

import { cardDirRel, cardFileRel } from "./card-brief.mjs";
import {
  CLAIM_STALE_SAME_MS,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_REVIEW_AGING_MS,
  DEFAULT_WORKFLOW_MAX_ACTIONS,
} from "./constants.mjs";
import { parseEnvBool, parseEnvText } from "./env-file.mjs";
import { DomainError } from "./errors.mjs";
import { isContainer } from "./task-kind.mjs";
import {
  renderDecisionPolicySummary,
  renderDecisionRoundPrinciples,
  renderOwnershipSummary,
  renderReviewerProtocol,
  renderRoleDecision,
  renderRoleLayerOne,
  renderRoleSelfCheck,
  renderRoleWorkflow,
} from "./role-prompt.mjs";

/**
 * Default cap on concurrently running subagents — workers and reviewers share it.
 * The loop reserves no slots per role: demand decides the split (at 8 the nominal
 * steady state is 6 workers + 2 reviewers, not a guarantee).
 */
export const DEFAULT_MAX_CONCURRENCY = 8;
/**
 * The SLA measurement period, seconds — no longer a scheduling cadence.
 * Defined once in `constants.mjs` (the board's SLA config reads it too) and
 * re-exported here so the loop's existing import path keeps working.
 */
export { DEFAULT_PATROL_SECONDS };
/**
 * Default ping cadence, seconds — the scheduler's liveness clock. Ping only
 * prunes dead worker pids from the registry; it never reads the board.
 */
export const DEFAULT_PING_SECONDS = 60;
/**
 * Default continue cadence, seconds — the scheduler's judgment clock. A
 * continue turn wakes the agent with a bounded prompt; that turn runs the
 * deterministic poll, patrol and workflow entries.
 */
export const DEFAULT_CONTINUE_SECONDS = 600; // 10 minutes

/**
 * The command-only loop skill's slash command. A continue turn starts with it,
 * so an agent kind that expands slash commands loads `meerkat-loop` before the model
 * runs; the rest of the prompt is the turn's instruction. Kept beside the
 * prompt builder so a skill rename cannot drift from the command.
 */
export const LOOP_SKILL_COMMAND = "/meerkat-loop";
/** A claim older than this is "stale" for patrol (same-holder recovery window). */
export const PATROL_STALE_MS = CLAIM_STALE_SAME_MS;

/**
 * 0034 — how long a live ledger row survives after its card has left the work
 * state. The reconcile pass reaps it at this age.
 *
 * It is the upper bound of the **time contract**: a turn must finish before the
 * bookkeeping that describes it is reclaimed (`sessionTurnTimeoutMs <
 * LEDGER_STALE_MS`), or a long turn outlives its own slot. One fact source: the
 * ledger imports this rather than spelling `2h` a second time.
 */
export const LEDGER_STALE_MS = 2 * 60 * 60 * 1000;


/**
 * Quote one argv element for a shell command line. The continue prompt embeds
 * the deterministic passes' argv, so a path with a space must survive a copy
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
  return parseEnvBool(value, { shortForms: true });
}

/**
 * Parse a `KEY=value` env file the installer writes (comment and blank lines
 * ignored, `export ` prefix and matching quotes stripped).
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  return Object.fromEntries(parseEnvText(text, { quoteMinLength: 2, skipEmptyKey: true }));
}

/**
 * The effective `claim_unassigned` policy.
 *
 * Precedence is **flag > environment > installer's per-kind config file > default
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
  const fromFile = parseYesNo(file === null ? undefined : file.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED);
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
 * installer's per-kind config > default on**.
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
 * Whether the scheduler wakes the agent's periodic judgment turn.
 *
 * Precedence is the same as `resolveClaimUnassigned`: **flag > environment >
 * installer's per-kind config > default on**. Turning it off leaves the ping clock
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
 * A positive cadence in seconds. `file` is the *value* read from the per-kind config
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

// The workflow defaults are shared with the board's planner: one number, both
// sides. Re-exported here because the loop's config resolver has always named
// them, and the minute form is derived rather than kept as a second copy.
export { DEFAULT_WORKFLOW_MAX_ACTIONS };

/** Default age, in minutes, before a silent review card is reported. */
export const DEFAULT_REVIEW_AGING_MINUTES = DEFAULT_REVIEW_AGING_MS / 60_000;

/**
 * The workflow sub-pass's configuration.
 *
 * Same precedence as `resolveClaimUnassigned` — **flag > environment > per-kind config
 * config file > default** — and the same tolerance: an unrecognised yes/no word
 * is ignored rather than treated as `false`, so a stray value cannot silently
 * disable the channel. `workflow` is the whole channel: off means the loop
 * writes no card at all.
 *
 * An empty reviewer is "not configured", not an empty name: review dispatch is
 * skipped and the rest of the channel (reconcile + outcomes) still runs, so a
 * deployment that later drops its reviewer can still finish the reviews already
 * in flight.
 *
 * @param {{flags?: object, env?: object, file?: Record<string, string>|null}} [input]
 * @returns {{workflow: boolean, reviewer: string|null, maxActions: number, reviewAgingMs: number}}
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
    // 0038 — the card's own acceptance mode is the whole decision; the loop no
    // longer carries an advisory copy of a board policy or a review-close flag.
    reviewer: firstText(
      flags.reviewer,
      env.MEERKAT_TASKPANEL_REVIEWER,
      file.MEERKAT_TASKPANEL_REVIEWER,
    ),
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
    // A container's `in_progress` is the board's design (never claimed, never
    // pulsed), so there is no worker whose heartbeat could be late.
    if (isContainer(task)) continue;
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

/** A `todo` card older than this with no one to claim it is a finding. */
export const STRANDED_TODO_AGING_MS = 30 * 60 * 1000;

/**
 * The stranded-`todo` findings the workflow pass reports.
 *
 * Two ways a `todo` card has no one to claim it, and they are not the same gate:
 *
 *   * **assigned to an agent name outside the scan set** — always a finding: no
 *     scan will ever claim it (`MEERKAT_TASKPANEL_AGENTS` is the claim authority).
 *     A card owned by a **human** is not: a person is the owner, not a missed route.
 *     An epic is not: it never carries work.
 *   * **unassigned** — a finding only when this loop will not take the public pool
 *     (`claim_unassigned: no`); with the pool on, an unassigned card is the normal
 *     path, not a defect.
 *
 * The caller supplies the reads: `todoTasks` (every `todo` card) and
 * `unassignedPool` (the `issue candidates --include-unassigned` pool, already
 * blocker-filtered). Pure: no I/O, no clock — `now` and `agingMs` are arguments.
 *
 * @param {{todoTasks?: object[], unassignedPool?: object[], agents?: string[], reviewer?: string|null, claimUnassigned?: boolean, now?: number, agingMs?: number}} [input]
 * @returns {{type: string, reason: string, original: string, assignee?: string, dedupKey: string}[]}
 */
export function planStrandedTodoAlerts(input = {}) {
  const todoTasks = Array.isArray(input.todoTasks) ? input.todoTasks : [];
  const unassignedPool = Array.isArray(input.unassignedPool) ? input.unassignedPool : [];
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const reviewer = typeof input.reviewer === "string" && input.reviewer.trim() !== ""
    ? input.reviewer.trim()
    : null;
  const claimUnassigned = input.claimUnassigned !== false;
  const now = typeof input.now === "number" ? input.now : Date.now();
  const agingMs = typeof input.agingMs === "number" && input.agingMs >= 0
    ? input.agingMs
    : STRANDED_TODO_AGING_MS;
  const scanned = new Set(
    [...agents, reviewer]
      .filter((name) => typeof name === "string" && name.trim() !== "")
      .map((name) => name.trim().toLowerCase()),
  );
  const ageOf = (task) => {
    const raw = task?.status_changed_at ?? task?.created_at ?? null;
    if (typeof raw !== "string" || raw === "") return null;
    const since = Date.parse(raw);
    return Number.isNaN(since) ? null : now - since;
  };
  const isOld = (task) => {
    const age = ageOf(task);
    return age !== null && age > agingMs;
  };

  const alerts = [];
  for (const task of todoTasks) {
    if (isContainer(task)) continue;
    const ref = task?.assignee ?? null;
    const name = typeof ref === "string" ? ref : ref?.display_name ?? ref?.id ?? null;
    if (name === null) continue;
    const kind = typeof ref === "object" && ref !== null ? ref.kind ?? null : null;
    if (kind === "human") continue;
    if (scanned.has(String(name).toLowerCase())) continue;
    if (!isOld(task)) continue;
    alerts.push({
      type: "unowned_todo",
      reason: "assignee_not_scanned",
      original: String(task.identifier ?? ""),
      assignee: String(name),
      dedupKey: `unowned_todo|${task.identifier}|assignee|${name}`,
    });
  }
  if (claimUnassigned === false) {
    for (const task of unassignedPool) {
      if (task?.reason !== "unassigned") continue;
      if (!isOld(task)) continue;
      alerts.push({
        type: "unowned_todo",
        reason: "unassigned",
        original: String(task.identifier ?? ""),
        dedupKey: `unowned_todo|${task.identifier}|unassigned`,
      });
    }
  }
  return alerts;
}

/**
 * The wake argv for an agent kind. Claude, Codex and Pi have no timers, so the loop
 * lives outside them, waking each agent kind's own **headless** entry point — and,
 * when a session id is known, that agent kind's own **resume** form:
 *
 *   * **claude** — `claude -p <prompt>`; resume with `--resume <sid>`.
 *   * **codex**  — `codex exec <prompt>`; resume the thread with
 *     `codex exec resume <sid> <prompt>` (`codex exec resume [OPTIONS]
 *     [SESSION_ID] [PROMPT]`).
 *   * **pi**     — `pi --print <prompt>` (`--print` is pi's non-interactive
 *     mode; pi has no `run` subcommand); resume a specific session with
 *     `pi --print --session <sid> <prompt>` (`--session <path|id>`).
 *
 * These shapes are the ones verified against the real CLIs — the per-agent-kind
 * capability matrix in `scripts/verify/kind-resume-matrix.mjs`.
 *
 * @param {{actorKind?: string, prompt: string, resumeSid?: string|null}} input
 * @returns {{command: string, args: string[]}}
 */
export function wakeCommand(input = {}) {
  const prompt = String(input.prompt ?? "");
  const resumeSid = input.resumeSid ?? null;
  switch (input.actorKind) {
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
        message: `unknown agent kind '${input.actorKind}'`,
        details: { field: "actorKind", value: input.actorKind },
        hint: { fix: "--actor-kind claude|codex|pi" },
      });
  }
}

/**
 * What the scheduler spawns for one **continue** turn.
 *
 * A continue turn is not a card wake: it has no card, no project identity and
 * no session to resume. So it always takes the agent kind's built-in headless form.
 * `TP_NODE` is carried so a process this turn starts finds the interpreter the
 * scheduler is running on, rather than betting on `node` being on a minimal
 * launchd/cron `PATH`.
 *
 * @param {{actorKind: string, prompt: string, cwd?: string|null, nodePath?: string|null}} input
 * @returns {{command: string, args: string[], env: Record<string,string>, cwd: string|null, via: "direct"}}
 */
export function planContinueInvocation(input = {}) {
  const prompt = String(input.prompt ?? "");
  const cwd = input.cwd ?? null;
  const env = {};
  if (input.nodePath !== undefined && input.nodePath !== null && String(input.nodePath) !== "") {
    env.TP_NODE = String(input.nodePath);
  }
  return { ...wakeCommand({ actorKind: input.actorKind, prompt }), env, cwd, via: "direct" };
}

/**
 * The fresh handoff handed to a woken worker — bounded so a wake never carries
 * an unbounded context. It names the card, the attribution flags every write
 * should carry, and the compliant next step (triage, read, work, report).
 *
 * **Step 0 is the epic-triage check**, and it lives in the handoff rather than
 * in a separate planner process: the worker is the only process that has
 * already read the card when the answer is cheap. The worker does **not**
 * promote or split: a card with several independent deliverables becomes an
 * agent `question` comment to the project session, which decides the split
 * (a scope expansion is E1 for the human). A card with one deliverable
 * proceeds untouched.
 *
 * The handoff names the task's **process directory** (`.meerkat/<identifier>/`),
 * relative to the project session's cwd. `card.md` is the loop's authoritative
 * export of the card; it is read-only, and every other process file — notes,
 * logs, evidence, downloaded attachments — belongs in the same directory. The
 * board still owns no directory (O3): this is the loop's convention under the
 * worker's own cwd, resolved locally.
 *
 * Optional team-role fields (`role`, `roleWorkflowPath`, `selfCheckPath`,
 * `decisionPolicyPath`) append the role layer; without them the text is the
 * pre-roles handoff, byte for byte.
 *
 * @param {{card?: object, agent: string, actorKind: string, sessionId?: string|null, review?: boolean, role?: object|null, roleWorkflowPath?: string|null, selfCheckPath?: string|null, decisionPolicyPath?: string|null}} input
 * @returns {string}
 */
export function buildHandoff(input) {
  const card = input.card ?? {};
  const title = String(card.title ?? "").slice(0, 300);
  const ref = card.identifier;
  const project = card.project ?? "<project id>";
  const attribution = [`--agent ${input.agent}`, `--actor-kind ${input.actorKind}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const flags = attribution.join(" ");
  // 0038 — the card's own mode is the closing rule. An unreadable mode (a
  // payload that predates the field) falls back to `agent`: every unresolved
  // card is reviewed, so review is the only honest guess.
  const declaredMode = String(card.acceptance_mode ?? card.acceptanceMode ?? "")
    .trim()
    .toLowerCase();
  const acceptanceMode = ["off", "agent", "human"].includes(declaredMode)
    ? declaredMode
    : "agent";
  const acceptanceRule =
    acceptanceMode === "off"
      ? "stop at in_review — the loop auto-accepts an off card."
      : acceptanceMode === "agent"
        ? "stop at in_review — the loop dispatches an independent reviewer; do not move it to done yourself."
        : "stop at in_review — the loop dispatches an independent reviewer and a human accepts to done.";
  const brief = cardFileRel(ref);
  const processDir = cardDirRel(ref);
  const lines = [
    `You are a worker subagent of the ${project} project session — one card: ${ref}.`,
    `Title: ${title}`,
    `Task brief: ${brief} — exported by the loop; read it first, it is authoritative for this card.`,
    "The brief was exported just before the claim, so its status/assignee may lag one step; the loop already holds the claim.",
    `Never edit ${brief}: the loop overwrites it from the board. Put your process files (notes, logs, evidence, report drafts) under ${processDir}/.`,
    `Download attachments into that directory: taskctl attachment list ${ref} --json, then taskctl attachment download <attachment-id> --out ${processDir}/<filename>.`,
    `Your working directory is this project's directory; never touch another project's paths.`,
    "The loop already claimed this card for you: do not claim it again — heartbeat it to keep the claim.",
    "",
    `Flags (substitute <flags>): ${flags}`,
    "",
    "Step 0 — container check. Read the brief first, then the live card:",
    `  ${brief}    # description, acceptance, comments, sessions, attachments, report`,
    `  taskctl issue get ${ref} --json <flags>    # live status, version, acceptance snapshot, meta`,
    "  Several deliverables? Do not promote or split yourself. Add an agent question",
    "  comment describing the pieces, keep the card in_progress, and stop. The project",
    "  session decides whether to split (scope expansion is E1 and goes to the human).",
    "    taskctl comment add ${ref} --kind question --body \"...\" <flags>",
    "    meta.epic_triage=off: do not promote; record the split question in a comment.",
    "",
    `Step 1 — acceptance list, on the card you work (<card> = ${ref}):`,
    "  `acceptance` in issue get --json is the FROZEN baseline; meta.acceptance is only",
    "  the seed it was copied from. Work to the snapshot; append, never replace or remove.",
    "  Snapshot and meta both empty (not an epic): a mechanical derivation may be",
    "  pre-authorized by the project session. If it was not, add an agent question",
    "  comment and stop. Changing an existing acceptance item is E2 and goes to the",
    "  project session/human.",
    `    taskctl issue update <card> --acceptance "..." --acceptance "..." --meta acceptance_derived=yes <flags>`,
    `    taskctl comment add <card> --kind note --body "acceptance list derived at claim (pre-authorized): 1) ..." <flags>`,
    `  Comments: taskctl comment list <card> --limit 200 --json <flags>`,
    "  Too thin to yield checkable items, or blocked on a decision? Do not enter awaiting",
    "  yourself: add an agent question comment on the card, keep it in_progress, and stop.",
    "  The loop hands it to the project session, which answers or escalates E1-E5.",
    `    taskctl comment add <card> --kind question --body "Decision needed: ..." <flags>`,
    "  Then stop. On re-claim read every comment after your last question — a human",
    "  comment, or the project session's `decision:` note. Any human comment auto-resumes",
    "  awaiting; approve/reject is its content, not its kind. An incomplete answer is not",
    "  consent — ask again. A rejection means revise or stop; never re-submit it.",
    "  Review asks for more: append, never replace. Ask the project session, do not migrate.",
    "",
    `Keep the claim alive (<=10 minutes): taskctl issue heartbeat <card> <flags>`,
    `Deliver with a report (a draft may live under ${processDir}/report.md): taskctl issue deliver <card> --report-file - <flags>`,
    "Rules: after a split, the heartbeat and delivery apply to the claimed CHILD, not the epic.",
    `On resume, re-read ${brief} before acting; never edit it.`,
    `${acceptanceRule} Carry the flags above on every write.`,
  ];
  if (input.role) {
    lines.push("", ...renderRoleLayerOne(input.role));
    lines.push(
      "",
      "## Plan file",
      `Write and maintain ${processDir}/plan.md before you start; update it as you learn.`,
      "Append an evidence row the moment you observe it — item → command+exit / path+check —",
      "then project the table into the delivery report; a row written at delivery is memory.",
      "The reviewer reads it. Do not edit card.md.",
    );
    if (input.roleWorkflowPath) lines.push("", ...renderRoleWorkflow(input.role, input.roleWorkflowPath));
    if (input.selfCheckPath) lines.push("", ...renderRoleSelfCheck(input.role, input.selfCheckPath));
    lines.push("", ...renderRoleDecision(input.role, input.decisionPolicyPath ?? null));
  }
  return lines.join("\n");
}

/**
 * The handoff handed to a **reviewer** woken for a review card.
 *
 * A reviewer is an independent agent, not the card's worker: it reads the
 * original, the delivery report, the comment trail and the container's children,
 * and delivers exactly one thing — a verdict report on the review card. It moves
 * nothing: the loop applies the verdict and closes the review card (the loop
 * accepts an `agent` original; a person closes a `human` one). The
 * `review_not_ready` check is first because the board may
 * have moved between the dispatch and the wake, and a verdict on a card that is
 * no longer delivered is worse than no verdict at all.
 *
 * @param {{card?: object, agent: string, actorKind: string, sessionId?: string|null}} input
 * @returns {string}
 */
export function buildReviewHandoff(input) {
  const card = input.card ?? {};
  const ref = card.identifier;
  const original = card.review_of ?? "<card under review>";
  const round = card.review_round ?? "the round recorded on the review card";
  const project = card.project ?? "<project id>";
  const attribution = [`--agent ${input.agent}`, `--actor-kind ${input.actorKind}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const flags = attribution.join(" ");
  const brief = cardFileRel(ref);
  const originalRef = typeof card.review_of === "string" && card.review_of.trim() !== ""
    ? card.review_of.trim()
    : null;
  const originalBrief = originalRef === null ? null : cardFileRel(originalRef);
  const lines = [
    `You are a reviewer subagent of the ${project} project session — one delivered card.`,
    `Review card: ${ref}`,
    `Card under review: ${original} (round ${round})`,
    `Review brief: ${brief} — exported by the loop; read it after the live check, it is authoritative.`,
    ...(originalBrief === null ? [] : [`Original brief: ${originalBrief} (when present; also authoritative).`]),
    `Never edit a card.md: the loop overwrites it from the board. This lane has no Write: deliver the verdict as the report and keep evidence where the board can read it (a report item or a comment), not in a file.`,
    `Your working directory is this project's directory; never touch another project's paths.`,
    "The loop already claimed this review card for you: do not claim it again.",
    "",
    "Step 0 — the review_not_ready check; do it before reading anything else:",
    `  taskctl issue get ${original} --json ${flags}`,
    "  If its status is not in_review, or its delivery_round is not the round above:",
    `    taskctl comment add ${ref} --kind note --body "review target is no longer in_review / the round changed" ${flags}`,
    "    and stop. Do not deliver a verdict; the loop will close this review card.",
    "",
    `Read (start with ${brief}; taskctl is the live view):`,
    `  taskctl issue get ${ref} --json ${flags}`,
    `  taskctl report list ${original} ${flags}`,
    `  taskctl comment list ${original} --limit 200 --json ${flags}`,
    `  taskctl relation list ${original} ${flags}     # an epic's children`,
    "Audit the description, every acceptance item, the delivery report for this round and its",
    "evidence, the comment trail (unresolved decision/defect entries), and — for an epic — the",
    "rollup report and each child's state.",
    "If the original's meta.acceptance_derived is `yes`, its acceptance list was derived by the",
    "worker at claim: check it covers every requirement in the description and comments — a list",
    "that narrows the card is grounds for `VERDICT: REJECT`. For an epic, check the children cover",
    "the epic's description.",
    "Verify what was delivered, not the live tree: take this round's report `commit` anchor and",
    "read it with `git -C <project dir> show <sha>:<path>` / `git diff <sha> -- <path>`. A claim",
    "visible only in the working tree is unverified; if the tree has moved, say so in the report.",
    "The original's baseline already carries every earlier round's findings — answer each one.",
    "",
    "Deliver:",
    `  taskctl report template ${ref}   # fill it in, then:`,
    `  taskctl issue deliver ${ref} --report-file - ${flags}`,
    "The report's FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.",
    "Put the findings after that line and in `leftovers`.",
    "",
    `On resume, re-read ${brief} before acting; never edit it.`,
    "Rules: heartbeat only this review card, never the card under review. Do not move",
    "the card under review and do not move this review card: the loop applies the verdict and",
    "closes this card. You cannot enter awaiting — a review must end in a verdict; if the",
    "evidence is insufficient, REJECT and write the findings. Carry the attribution flags",
    "above on every write.",
  ];
  if (input.reviewerPrompt || input.reviewerPromptPath) {
    const block = renderReviewerProtocol(input.reviewerPrompt ?? null, input.reviewerPromptPath ?? null);
    if (block.length > 0) {
      const at = lines.findIndex((line) => line.startsWith("Step 0 —"));
      lines.splice(at === -1 ? lines.length : at, 0, ...block, "");
    }
  }
  if (input.role) {
    lines.push("", ...renderRoleLayerOne(input.role));
    if (input.roleWorkflowPath) lines.push("", ...renderRoleWorkflow(input.role, input.roleWorkflowPath));
    const originalDir = originalRef === null ? "<original>" : cardDirRel(originalRef);
    lines.push(
      "",
      "## Reference material",
      `  ${originalDir}/plan.md — the worker's plan (if it exists)`,
      `  ${originalDir}/ — notes, evidence, report drafts, attachments`,
      "Omission check: every requirement in the description, comments and plan must map to",
      "an acceptance item and evidence, or be explicitly deferred. A narrowed acceptance list,",
      "an unexplained deviation from the plan, or a missing requirement is grounds for",
      "`VERDICT: REJECT`. If plan.md does not exist, say so and fall back to the description",
      "and acceptance snapshot; absence alone is not a reject.",
    );
    if (input.decisionPolicyPath) lines.push("", `Decision policy: ${input.decisionPolicyPath}`);
  }
  return lines.join("\n");
}

/**
 * The prompt the project session gets for the **question lane**.
 *
 * A worker that cannot decide writes an agent `question` comment and stops, and
 * the loop hands the question here. The project session answers with a `note` and
 * releases the card to the queue, or escalates E1–E5 to the human. It never
 * spawns a subagent for this row and never moves a card to `done`.
 *
 * `rows` carry the queue row's fields: `card` (the ref), `project`,
 * `target_dir`, `agent`, `question_id`, `question`, `asked_at`.
 *
 * @param {object[]} rows
 * @param {{actorKind?: string, decisionPolicyPath?: string|null}} [input]
 * @returns {string}
 */
export function buildQuestionPrompt(rows, input = {}) {
  const actorKind = String(input.actorKind ?? "claude");
  const first = rows[0] ?? {};
  const project = String(first.project ?? "the project");
  const dir = String(first.target_dir ?? "");
  const lines = [
    `You are the project session for ${project} at ${dir}.`,
    "A worker stopped and asked a question. Answer it here — do not spawn a subagent for this row.",
    "",
  ];
  rows.forEach((row, index) => {
    const flags = `--agent ${row.agent} --actor-kind ${actorKind}`;
    const asked = row.asked_at ? ` (asked ${row.asked_at})` : "";
    lines.push(`${index + 1}) ${row.card} — question ${row.question_id}${asked}:`);
    for (const line of String(row.question ?? "").split("\n")) lines.push(`   ${line}`);
    lines.push(
      `   Re-read the card first: taskctl issue get ${row.card} --json ${flags}`,
      "   If its status is not `in_progress` (delivered, moved, canceled, or already",
      "   waiting on a human), do nothing — the question is no longer this lane's.",
      `   Then re-read the trail: taskctl comment list ${row.card} --limit 20 --json ${flags}`,
      "   If a later comment already answers it, do nothing.",
      `   Answer you can decide: taskctl comment add ${row.card} --kind note --body "decision: ..." ${flags}`,
      `   then release the card to the queue: taskctl issue move ${row.card} todo ${flags}`,
      `   Cannot decide (E1-E5, or a reserved matter): taskctl issue move ${row.card} awaiting --awaiting-reason <E1..E5> --question "..." ${flags}`,
      "",
    );
  });
  lines.push(
    "Never write a decision/confirm/change kind and never use --as-human for your own",
    "decision. Never move a card to done. The worker's question is the record; your note",
    "is the answer.",
  );
  if (typeof input.decisionPolicyPath === "string" && input.decisionPolicyPath !== "") {
    lines.push("", `Decision policy: ${input.decisionPolicyPath}`);
  }
  return lines.join("\n");
}

/**
 * The bounded prompt for the scheduler's periodic **continue** turn.
 *
 * The loop's deterministic work is no longer scheduled as its own units: this
 * turn is where poll, patrol and workflow are invoked. The prompt is therefore
 * self-contained — absolute entry paths, the order to run them in, and the
 * board rules that must not be broken — because a headless agent may run it
 * without the loop skill loaded.
 *
 * The prompt begins with `/meerkat-loop`, the loop skill's command-only slash
 * command (`disable-model-invocation: true`). An agent kind that expands slash commands
 * loads the skill first; one that does not still receives the whole turn,
 * because the body stays self-contained. There is no subcommand and no
 * `$ARGUMENTS` placeholder.
 *
 * Order is **patrol → workflow → poll**: the workflow pass dispatches a review
 * card, and the poll that follows in the same turn can enqueue its reviewer
 * immediately; polling first would delay that review by a whole cadence.
 *
 * Poll only **claims and enqueues**. The handoff is taken from the queue by a
 * resident *project session* — one per target directory — which spawns the
 * worker/reviewer subagent with the project directory as cwd. The control turn
 * never spawns a subagent and never works a card itself.
 *
 * When no session pool is resident, `includePoll: false` yields the fallback:
 * patrol and workflow only, no claim, dispatch paused. It names no card and no
 * project directory either way — a continue turn is not a worker wake, and the
 * board holds no project directory to name.
 *
 * @param {{
 *   actorKind?: string,
 *   agent?: string,
 *   cliCommand?: string,
 *   continueIntervalSeconds?: number,
 *   includePoll?: boolean,
 *   openedBy?: "human"|"supervisor",
 *   decisionPolicy?: {path?: string|null, text?: string|null}|null,
 *   ownership?: {path?: string|null, text?: string|null}|null,
 *   owners?: string[],
 * }} [input]
 * @returns {string}
 */
export function buildContinuePrompt(input = {}) {
  const agent = String(input.agent ?? "agent");
  const actorKind = String(input.actorKind ?? "claude");
  const includePoll = input.includePoll !== false;
  // The one control-turn template, two drivers. `supervised` is the headless
  // scheduler (the human reads the board); `manual` is the live session (the
  // human is in the conversation, so the question front-end is in-chat while the
  // board comment remains the record).
  const mode = input.mode === "manual" ? "manual" : "supervised";
  const minutes = Math.max(
    1,
    Math.round((input.continueIntervalSeconds ?? DEFAULT_CONTINUE_SECONDS) / 60),
  );
  // The loop ships with the toolkit now; the turn names the command, not a script
  // path inside a copied body. A caller that knows the runtime tree passes a
  // `cliCommand` (interpreter + CLI entry + the loop's state flags), so a headless
  // turn does not depend on `taskctl` happening to be on the unit's PATH. The
  // interpreter must be the bare name `node`: the control lane's allowlist
  // (`Bash(node *)`, `Bash(taskctl *)`) matches the first token, so an absolute
  // interpreter path would be refused and every pass would fail unrun.
  const command = typeof input.cliCommand === "string" && input.cliCommand.trim() !== ""
    ? input.cliCommand.trim()
    : "taskctl";
  // Board reads and writes need a *different* prefix: the pass command carries the
  // loop's own flags (`--log`, `--state`, …), which `issue`/`comment`/`relation` do
  // not accept. A caller that knows the runtime tree says what that prefix is.
  const board = typeof input.boardCommand === "string" && input.boardCommand.trim() !== ""
    ? input.boardCommand.trim()
    : "taskctl";
  const run = (pass) => `${command} loop ${pass}`;

  const lines = [
    `${LOOP_SKILL_COMMAND} Continue — Meerkat TaskPanel loop, judgment turn (mode: ${mode}).`,
    "No card and no project directory: this is the loop's periodic turn, not a worker wake.",
    "",
    "Run in order, each one pass:",
    `  1) ${run("patrol")}   # notify-only SLA; never moves a card`,
    `  2) ${run("workflow")}   # apply the board's workflow plan (issue reconcile --workflow)`,
  ];

  // The bounded routing fallback. Creation routes a team card, but a card that
  // still lands unowned (a role-less create, a human's card, a role name outside
  // the scan set) must not sit forever. The control turn names the roles here
  // because it cannot read the guide: its lane allows `taskctl` and `node`, not
  // `Read`. Only a card past the window is touched — a fresh one is still the
  // creator's to route.
  const owners = Array.isArray(input.owners)
    ? input.owners
        .filter((name) => typeof name === "string" && name.trim() !== "")
        .map((name) => name.trim())
    : [];
  const routePool = includePoll && input.ownership != null && owners.length > 0;
  if (routePool) {
    lines.push(
      `  3) ${board} issue list --status todo --json   # route a card left unowned`,
      `     A card with no assignee over 30 minutes: assign the role the guide names —`,
      `     one of ${owners.join(", ")} — with ${board} issue assign <ref> --assignee <role>.`,
      "     Not a claim; leave a fresh or ambiguous card. Never invent a role name.",
    );
  }
  if (includePoll) {
    lines.push(
      `  ${routePool ? "4" : "3"}) ${run("poll")}   # scan → atomic claim (as ${agent}) → enqueue the handoff`,
      "",
      "Poll only claims and enqueues: it never spawns a worker or reviewer. A resident",
      "project session takes the handoff from the queue and spawns the subagent in the",
      "project directory. Do not claim a card outside poll, and do not work one yourself.",
      "With a resident pool, poll also enqueues each unanswered agent question to the",
      "project session (the question lane). Do not answer it again in this turn.",
    );
  } else {
    lines.push(
      "",
      "No resident session pool is running, so this turn claims no card: poll is skipped",
      "and worker/reviewer dispatch is paused. Let review cards accumulate — the pool",
      "claims them once it is back.",
    );
  }

  // The decision ladder. A subagent never decides an unauthorized question: it
  // records an agent `question` comment on an in_progress card and stops. The
  // main session decides what it can (operational or plan/acceptance-internal)
  // with a note, or escalates E1-E5 to the human via `awaiting`. Any human
  // comment resumes an awaiting card; the board does not read it, and whether it
  // is a complete decision is judged from its content by the resumed worker. The
  // loop's own answer is never a decision kind and never `--as-human` (except
  // when recording what the human said in a human-opened conversation).
  const openedBy = input.openedBy === "human" ? "human" : "supervisor";
  const inChat = mode === "manual" || openedBy === "human";
  lines.push(
    "",
    "Questions and decision rights (before poll):",
    "  Subagents never decide an unauthorized question: they write an agent `question`",
    "  comment on an in_progress card and stop. Read those first:",
    `    ${board} issue list --status in_progress --json`,
    `    ${board} comment list <ref> --kind question --json`,
    `    ${board} comment list <ref> --limit 20 --json   # a later human comment is the answer`,
    "  Then read human questions:",
    `    ${board} issue list --status awaiting --json`,
    `    ${board} comment list <ref> --kind question --json`,
    "  For an agent question you can decide (operational or within the plan/acceptance):",
    `    ${board} comment add <ref> --kind note --body "decision: ... (why)"`,
    `    ${board} issue move <ref> todo        # re-claim with the answer in the trail`,
    "  Your own note does NOT resume an awaiting card; the move does.",
    "  A HUMAN comment of any kind resumes it automatically — the board does not read it.",
    "  For E1-E5 (scope, acceptance, design/aesthetic, security/data, architecture) or",
    "  anything you cannot decide, do not answer: escalate with the question format:",
    `    ${board} issue move <ref> awaiting --awaiting-reason E1..E5 --question "Decision needed: ...; Options: ...; Recommendation: ...; Why the main session cannot decide: ..."`,
    "  Decision rounds — one round per card:",
    ...renderDecisionRoundPrinciples().map((line) => `  ${line}`),
    '  Answer every authorized item in ONE note ("decision: Q1 ...; Q2 ..."), then move the',
    "  card once. Escalate only E1-E5 items in ONE new awaiting question string, numbered, with",
    "  its E-code, recommendation and `Verified already:` evidence.",
    "  An incomplete answer is not consent: ask the next round as one new string. Only a human comment resumes awaiting.",
    "  Nothing acts while any frontier item is open.",
    "  Never write decision/confirm/change for your own decision.",
    "  Approve/reject/direction come from the human comment's content. A rejection is an",
    "  answer: apply its direction; never re-dispatch the rejected work unchanged.",
    "  If the answer is incomplete or ambiguous, the resumed worker asks; move the card",
    "  back to awaiting with a NEW question (QUESTION_REQUIRED forces one).",
    inChat
      ? "  When the human answers in this conversation, record it with --as-human; any kind re-queues the card."
      : "  The human answers on the board with a comment; any kind re-queues it automatically.",
    ...(mode === "manual"
      ? [
          "  You are the live control session. Ask the human here when a question needs a",
          `  decision, then record their answer with \`${board} comment add <ref> --as-human\`.`,
          "  The board comment is authoritative; the in-session question is only the front-end.",
          "  Ask every waiting card in one message — one numbered block per card; each block is one question string.",
          "  Recompute after the answers and ask only the newly unblocked round.",
        ]
      : []),
    "  A human comment after an agent question on an in_progress card is an answer too:",
    "  act on it and move the card to todo (or reattach a live worker).",
    "  Do not answer a question a later human comment already answered.",
    ...(input.decisionPolicy ? ["", ...renderDecisionPolicySummary(input.decisionPolicy)] : []),
    ...(input.ownership ? ["", ...renderOwnershipSummary(input.ownership)] : []),
    "",
    "Rules:",
    "- Never move a card to done. in_review → done is the board's acceptance, applied by the loop as taskd.",
    "- A reviewer moves nothing; it delivers a VERDICT report on its review card.",
    "- Stop work at in_review: deliver a report, do not self-accept.",
    "- Keep this turn bounded: hand off and return; do not wait for a worker.",
    "- At the concurrency cap, leave the card for the next turn.",
    `- Actor kind: ${actorKind}. This turn repeats every ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}
