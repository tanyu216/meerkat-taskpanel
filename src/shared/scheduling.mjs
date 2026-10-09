/**
 * The scheduling policy — the *decision* half of the host-external supervisor.
 *
 * A supervisor tick has two halves that must not be tangled: what to do (this
 * file, pure) and doing it (spawning `claude -p` / `codex exec`, reading the
 * board — `scripts/supervisor.mjs`, I/O). Keeping the decision pure means the
 * load-bearing rules are decided without a clock, a process or a database:
 *
 *   * **fire-only.** A scan with no candidates plans no work, so no worker is
 *     ever started for an empty tick — the whole point of the cheap 1-minute poll.
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
/** Default poll cadence, seconds — the cheap 1-minute scan. */
export const DEFAULT_POLL_SECONDS = 60;
/** Default patrol cadence, seconds — the 5-minute fallback. */
export const DEFAULT_PATROL_SECONDS = 300;
/** A claim older than this is "stale" for patrol (same-holder recovery window). */
export const PATROL_STALE_MS = CLAIM_STALE_SAME_MS;

const TRUE_WORDS = new Set(["yes", "true", "1", "y", "on"]);
const FALSE_WORDS = new Set(["no", "false", "0", "n", "off"]);

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
 * a stray `TASKPANEL_CLAIM_UNASSIGNED=maybe` must not wedge the poll.
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
  const fromFile = parseYesNo(file === null ? undefined : file.TASKPANEL_CLAIM_UNASSIGNED);
  if (fromFile !== null) return fromFile;
  return true;
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
    const agent = task?.claimed_by ?? task?.assignee?.display_name ?? null;
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
 * The `taskctl issue candidates` argv for one agent. `--include-unassigned`
 * asks the board for the public pool (unassigned, claimable cards) as well as
 * the agent's own — the same read, one process, no extra policy here.
 *
 * @param {string} agent
 * @param {boolean} claimUnassigned
 * @returns {string[]}
 */
export function candidateArgs(agent, claimUnassigned) {
  const args = ["issue", "candidates", "--assignee", String(agent)];
  if (claimUnassigned) args.push("--include-unassigned");
  return args;
}

/**
 * The wake argv for a host. Claude and Codex have no timers, so the loop lives
 * outside them: a headless `claude -p` (with `--resume <sid>` when continuity is
 * known) or a `codex exec`. Pi's headless command is `pi run`; an explicit
 * `wakeCommand` override lets an installer or a user plug their own glue.
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
      return { command: "codex", args: ["exec", prompt] };
    case "pi":
      return { command: "pi", args: ["run", prompt] };
    default:
      throw new DomainError("VALIDATION_FAILED", {
        message: `unknown host '${input.host}'`,
        details: { field: "host", value: input.host },
        hint: { fix: "--host claude|codex|pi" },
      });
  }
}

/**
 * The fresh handoff handed to a woken worker — bounded so a wake never carries
 * an unbounded context. It names the card, the attribution flags every write
 * should carry, and the compliant next step (read, work, report).
 *
 * @param {{card?: object, agent: string, host: string, sessionId?: string|null}} input
 * @returns {string}
 */
export function buildHandoff(input) {
  const card = input.card ?? {};
  const title = String(card.title ?? "").slice(0, 300);
  const attribution = [`--agent ${input.agent}`, `--agent-platform ${input.host}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const where = card.target ? ` (workspace ${card.target})` : "";
  return [
    `You have been woken by the Task Panel supervisor to work one card: ${card.identifier}${where}.`,
    `Title: ${title}`,
    "",
    `Read it first:  taskctl issue get ${card.identifier} ${attribution.join(" ")}`,
    `Work it, then deliver with a report:  taskctl issue deliver ${card.identifier} --report-file - ${attribution.join(" ")}`,
    "",
    "Rules: claim first (the supervisor already claimed this card for you); keep the heartbeat",
    "fresh (<=10 minutes); deliver with a report for the current round; stop at in_review — a",
    "human accepts to done. Carry the attribution flags above on every write.",
  ].join("\n");
}
