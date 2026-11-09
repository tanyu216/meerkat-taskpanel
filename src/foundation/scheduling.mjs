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
  CLAIM_STALE_ANY_MS,
  CLAIM_STALE_SAME_MS,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_REVIEW_AGING_MS,
  DEFAULT_REWORK_MAX_ROUNDS,
  DEFAULT_WORKFLOW_MAX_ACTIONS,
  DIRECTOR_ACTOR_ID,
} from "./constants.mjs";
import { parseEnvBool, parseEnvText } from "./env-file.mjs";
import { DomainError } from "./errors.mjs";
import { resolveRolePlatform } from "./role-platforms.mjs";
import { selectRole, selectWorkerRole } from "./roles.mjs";
import { isContainer } from "./task-kind.mjs";
import { reviewIdentityOf } from "./review-identity.mjs";
import {
  renderReviewerProtocol,
  renderRoleDecision,
  renderRoleSelfCheck,
  renderRoleWorkflow,
} from "./role-prompt.mjs";

/**
 * Default cap on concurrently running card sessions — worker and review sessions
 * share it. The loop reserves no slots per role: demand decides the split (at 8
 * the nominal steady state is 6 workers + 2 reviews, not a guarantee).
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
 * tick runs the deterministic passes itself;
 * deterministic poll, patrol and workflow entries.
 */
export const DEFAULT_CONTINUE_SECONDS = 600; // 10 minutes

/** A claim older than this is "stale" for patrol (same-holder recovery window). */
export const PATROL_STALE_MS = CLAIM_STALE_SAME_MS;

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
 * Whether the liveness clock may stop a **wedged** resident pool.
 *
 * Only `wedged` qualifies — a live pid whose dispatch tick has outlived the
 * shared send deadline (turn + `POOL_WEDGE_MARGIN_MS`). `starting` and
 * `unresponsive` are not stopped: the first is
 * a legitimate startup and the second is a blocked event loop that may recover.
 * Stopping it is what lets launchd/systemd restart the pool; the orphaned agent
 * child is protected from re-dispatch by the queue's owner-liveness check.
 * Precedence is the usual flag > environment > per-kind config > default **on**.
 *
 * @param {{flag?: unknown, env?: unknown, file?: Record<string, string>|null}} [input]
 * @returns {boolean}
 */
export function resolveRecoverWedged(input = {}) {
  const fromFlag = parseYesNo(input.flag);
  if (fromFlag !== null) return fromFlag;
  const fromEnv = parseYesNo(input.env);
  if (fromEnv !== null) return fromEnv;
  const file = input.file ?? null;
  const fromFile = parseYesNo(file === null ? undefined : file.MEERKAT_TASKPANEL_RECOVER_WEDGED);
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
 * @returns {{workflow: boolean, maxActions: number, reviewAgingMs: number}}
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
    // The board's breaker bound, resolved on the loop side so both read one
    // number: a card is held once `delivery_round` exceeds this many rounds
    // since its last hold epoch.
    reworkMaxRounds:
      firstPositive(
        flags.reworkMaxRounds,
        env.MEERKAT_TASKPANEL_REWORK_MAX_ROUNDS,
        file.MEERKAT_TASKPANEL_REWORK_MAX_ROUNDS,
      ) ?? DEFAULT_REWORK_MAX_ROUNDS,
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

/** A non-blank string, or `null`. */
function nonBlank(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** The same person/role name under the board's identity rule. */
function sameName(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

/** Can a kind that carries this role actually start? */
function roleCanStart(role, input) {
  if (role === null || role === undefined) return false;
  // Older fixtures (and a caller that injected a hand-made role record) carry no
  // installation facts; the role is then assumed startable, exactly as the
  // pre-0015 scan treated it. A discovered role always states `installedOn`.
  if (!Array.isArray(role.installedOn) || role.installedOn.length === 0) return true;
  const platform = resolveRolePlatform(role, {
    primaryKind: input.primaryKind ?? null,
    order: input.kindOrder ?? null,
    available: input.kindAvailable ?? null,
  });
  return platform.effective !== null;
}

/** A deferred candidate: the loop leaves the card alone this tick. */
function defer(why) {
  return { kind: "defer", why };
}

/**
 * Who claims this candidate — and whether its route must change first.
 *
 * The board's route (`assignee`) decides the executor; the scanner is only the
 * reader that happened to see the card. This is the tail of ADR 0007's
 * "the card's assignee selects the executing role", which the board cannot
 * enforce for the stale-recovery pool because a rotted claim is visible to every
 * scanner (ADR 0013 keeps role knowledge out of the board).
 *
 * The decisions, in order:
 *
 *   1. no `assignee` field (an older projection / a hand-made test row): keep
 *      the pre-0015 scan identity;
 *   2. `assignee: null` — the public pool — is Worker (`defaultAgent`), else the
 *      scanner; an unassigned review card is deferred;
 *   2a. a `stale_same` card is holder-only on the board whether or not it has
 *      an assignee: when the pool's agent is not the scanning holder, the claim
 *      would be refused on every tick, so it is deferred like 5a;
 *   3. a `human` assignee is deferred: the loop never claims or reassigns it;
 *   4. a role that names the *other* lane is a misroute, deferred — never swapped;
 *   5. the assignee's role in this card's lane, when it can start, is the claim
 *      identity — **even when another agent scanned the card first**;
 *   5a. a `stale_same` claim is holder-only on the board. The candidate is
 *      offered only to the holder's scan; when the route moved off that holder
 *      (an audited override, or an `issue assign` of an `in_progress` card)
 *      claiming as the assignee is refused with EXECUTION_ACTIVE on every tick,
 *      so the card is **deferred** and the six-hour bound recovers it;
 *   6. a review card is never handed to Worker (that is how a card gets
 *      self-reviewed on the wrong lane);
 *   7. only a rotted stale (`reason: "stale_any"`) **work** card may be formally
 *      re-routed to Worker, and only when its assignee role is missing or
 *      cannot start; the plan carries the `reassign` write that must land
 *      before the claim;
 *   8. everything else defers (`ready` and `stale_same` never fall back: a live
 *      holder or a live route is not a recovery case).
 *
 * Pure: no clock, no I/O. `input.kindAvailable` is the caller's CLI probe.
 *
 * @param {object|null} candidate a candidate from `issue candidates`
 * @param {{roleSet?: object|null, primaryKind?: string|null, kindOrder?: string|string[]|null, kindAvailable?: ((kind: string) => boolean)|null, defaultAgent?: string|null, scanAgent?: string|null}} [input]
 * @returns {{kind: "claim", agent: string, reassign?: {from: string, to: string, reason: string}}|{kind: "defer", why: string}}
 */
export function planClaimIdentity(candidate, input = {}) {
  const scanAgent = nonBlank(candidate?.agent) ?? nonBlank(input.scanAgent);
  const defaultAgent = nonBlank(input.defaultAgent);
  const roleSet = input.roleSet ?? null;

  // 1. A projection from before the assignee facts existed. Keep the scan
  //    identity (and the public pool's explicit default) byte-for-byte.
  if (candidate === null || typeof candidate !== "object" || !Object.hasOwn(candidate, "assignee")) {
    const agent = candidate?.reason === "unassigned" ? (defaultAgent ?? scanAgent) : scanAgent;
    return agent === null ? defer("no claim identity") : { kind: "claim", agent };
  }

  const review = typeof candidate.review_of === "string" && candidate.review_of !== "";
  const assignee = nonBlank(candidate.assignee);

  // 2. The public pool: an unassigned card is Worker's, explicitly.
  if (assignee === null) {
    if (review) return defer("an unassigned review card has no reviewer to run it");
    const agent = defaultAgent ?? scanAgent;
    if (agent === null) return defer("no claim identity");
    // 2a. The holder-only window applies to the public pool too: inside
    //     10min–6h the board admits only the holder of an `in_progress` card,
    //     while the pool's designed executor is `defaultAgent` (Worker). When
    //     the holder that scanned it is somebody else, the claim is refused
    //     with EXECUTION_ACTIVE on every tick, so defer — claiming as the
    //     holder would make the scan order the executor, which is the very
    //     defect this decision removes. Past the bound `stale_any` frees it.
    if (candidate.reason === "stale_same" && scanAgent !== null && !sameName(agent, scanAgent)) {
      return defer(
        `stale_same: ${scanAgent} holds the live claim on this unassigned card, but the ` +
          `public pool claims as ${agent} (only the holder may re-claim it within 6 hours)`,
      );
    }
    return { kind: "claim", agent };
  }

  // 3. A person owns the card: the loop never claims or re-routes it.
  if (String(candidate.assignee_kind ?? "").trim().toLowerCase() === "human") {
    return defer(`assigned to a human (${assignee})`);
  }

  const lane = review ? "reviewer" : "worker";
  const otherLane = lane === "worker" ? "reviewer" : "worker";
  // 4. No role layer loaded (a test, or a caller that injected none): the
  //    assignee name is the only identity available.
  const role = roleSet === null ? null : selectRole(roleSet, assignee, lane);

  // 4a. The name is a role, just not the lane this card needs: a misroute is a
  //     deferral for the director, never a quiet swap to another role.
  if (roleSet !== null && role === null && selectRole(roleSet, assignee, otherLane) !== null) {
    return defer(`assignee ${assignee} is a ${otherLane}-lane role, not a ${lane}`);
  }

  // 5a. The board's holder-only window: only the holder may re-claim a
  //     `stale_same` card (10min–6h). The pool lists it for the holder's scan,
  //     so a claim as the assignee succeeds only while the route still names
  //     that holder. After an audited override or an `issue assign` of an
  //     in_progress card, claiming as the assignee is refused with
  //     EXECUTION_ACTIVE on every tick and the card waits for six hours
  //     anyway — so say so once and defer. Past the bound the route recovers it.
  const claimAgent = role === null ? assignee : role.agent;
  if (candidate.reason === "stale_same" && scanAgent !== null && !sameName(claimAgent, scanAgent)) {
    return defer(
      `stale_same: ${scanAgent} holds the live claim, but the card is assigned to ${assignee} ` +
        `(only the holder may re-claim it within 6 hours)`,
    );
  }

  if (roleSet === null) return { kind: "claim", agent: assignee };

  if (review) {
    // 6. A review is only ever run by its assigned reviewer role.
    if (role === null) {
      return defer(`review card assignee ${assignee} is not an installed reviewer-lane role`);
    }
    if (!roleCanStart(role, input)) {
      return defer(`reviewer role ${role.agent} is installed on no available kind`);
    }
    return { kind: "claim", agent: role.agent };
  }

  // 5. The assignee's own role, when it can start, is the executor.
  if (role !== null && roleCanStart(role, input)) return { kind: "claim", agent: role.agent };

  const why = role === null ? "not installed" : "installed on no available kind";

  // 8. Only a rotted stale work card is a recovery case that may be re-routed.
  if (candidate.reason !== "stale_any") {
    return defer(`assignee ${assignee} is ${why}`);
  }

  // 7. Worker is the explicit, audited fallback — a formal reassignment whose
  //    comment names the old assignee and why it could not run.
  const worker = selectWorkerRole(roleSet);
  if (worker === null) return defer("no Worker role is installed for the fallback");
  if (!roleCanStart(worker, input)) {
    return defer(`Worker role ${worker.agent} is installed on no available kind`);
  }
  if (sameName(worker.agent, assignee) || sameName(worker.id, assignee)) {
    return defer(`assignee ${assignee} has no available role and Worker is the assignee`);
  }
  return {
    kind: "claim",
    agent: worker.agent,
    reassign: {
      from: assignee,
      to: worker.agent,
      reason:
        `stale reclaim: assignee ${assignee} is ${why}; ` +
        `reassigned to ${worker.agent} and will be claimed as ${worker.agent}.`,
    },
  };
}

/**
 * The claim identity for a stale patrol alert.
 *
 * `planPatrol` alerts on an `in_progress` card whose heartbeat is older than the
 * same-holder window; the alert carries the holder and the measured age, not the
 * board's claim verdict. The patrol's LLM turn claims and dispatches, so it must
 * make the **same** identity decision the poll makes (ADR 0015). This maps the
 * wire Task DTO (`issue list` carries the assignee as an actor-ref object) onto
 * `planClaimIdentity`'s candidate shape and derives the reason bucket:
 *
 *   * past six hours the claim has rotted (`stale_any`) — the assignee recovers
 *     it, and only an unavailable assignee role falls back to Worker;
 *   * inside the six-hour window only the holder may re-claim (`stale_same`) —
 *     when the route names somebody else the patrol defers, exactly as rule 5a.
 *
 * `ageMs` is the alert's measured age. A missing/unreadable age is a deferral,
 * never a guess: the board's heartbeat window is the authority on the branch.
 *
 * @param {object} task a wire Task DTO from `issue list`
 * @param {{ageMs?: number, roleSet?: object|null, primaryKind?: string|null, kindOrder?: string|string[]|null, kindAvailable?: ((kind: string) => boolean)|null, defaultAgent?: string|null, scanAgent?: string|null}} [input]
 * @returns {{kind: "claim", agent: string, reassign?: {from: string, to: string, reason: string}}|{kind: "defer", why: string}}
 */
export function planPatrolClaim(task, input = {}) {
  const ageMs = Number(input.ageMs);
  if (!Number.isFinite(ageMs) || ageMs < 0) return defer("patrol heartbeat age is unreadable");
  return planClaimIdentity(
    {
      identifier: String(task?.identifier ?? ""),
      assignee: wireAssigneeName(task),
      assignee_id: wireAssigneeId(task),
      assignee_kind: wireAssigneeKind(task),
      review_of: typeof task?.review_of === "string" ? task.review_of : null,
      reason: ageMs > CLAIM_STALE_ANY_MS ? "stale_any" : "stale_same",
    },
    input,
  );
}

/** The assignee's readable name from a wire Task DTO (actor ref, string, or id). */
function wireAssigneeName(task) {
  const ref = task?.assignee;
  if (typeof ref === "string") return ref.trim() === "" ? null : ref;
  if (ref !== null && typeof ref === "object") {
    const name = ref.display_name;
    if (typeof name === "string" && name.trim() !== "") return name;
    const id = ref.id;
    if (typeof id === "string" && id.trim() !== "") return id;
  }
  return wireAssigneeId(task);
}

/** The assignee id from a wire Task DTO. */
function wireAssigneeId(task) {
  const id = task?.assignee_id;
  if (typeof id === "string" && id.trim() !== "") return id;
  const refId = task?.assignee?.id;
  return typeof refId === "string" && refId.trim() !== "" ? refId : null;
}

/** The kind the assignee reference records on a wire Task DTO. */
function wireAssigneeKind(task) {
  const kind = task?.assignee_kind;
  if (typeof kind === "string" && kind.trim() !== "") return kind;
  const refKind = task?.assignee?.kind;
  return typeof refKind === "string" && refKind.trim() !== "" ? refKind : null;
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
const STRANDED_TODO_AGING_MS = 30 * 60 * 1000;

/** How much of a worker's question the director prompt quotes. */
const QUESTION_PROMPT_BODY_MAX = 2000;

/**
 * The stranded-`todo` findings the workflow pass reports.
 *
 * Two ways a `todo` card has no one to claim it, and they are not the same gate:
 *
 *   * **assigned to an agent name outside the scan set** — always a finding: no
 *     scan will ever claim it (the discovered role set is the claim authority).
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
  // `workers` is the worker-capable set when the caller can tell it apart from
  // the scan set (a dedicated reviewer is scanned, but only for review cards).
  // Without it, keep the historical agents+reviewer behaviour.
  const workerNames = Array.isArray(input.workers) ? input.workers : [...agents, reviewer];
  const scanned = new Set(
    workerNames
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
    // A review card is assigned to the reviewer by design; it is not a
    // stranded work card.
    if (reviewIdentityOf(task).isReview) continue;
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
 * The fresh handoff handed to a woken worker — bounded so a wake never carries
 * an unbounded context. It names the card, the attribution flags every write
 * should carry, and the compliant next step (triage, read, work, report).
 *
 * **Step 0 is the epic-triage check**, and it lives in the handoff rather than
 * in a separate planner process: the worker is the only process that has
 * already read the card when the answer is cheap. The worker does **not**
 * promote or split: a card with several independent deliverables becomes an
 * agent `question` comment to the director, which decides the split
 * (a scope expansion is E1 for the human). A card with one deliverable
 * proceeds untouched.
 *
 * Sizing is by deliverable, not by layer: one change's core, CLI, web, docs and
 * fixture updates are one card. A child that needs a sibling's unmerged commit,
 * hands its red suite to a sibling, or owes a follow-up cleanup card is
 * mis-sized, and the director regroups it.
 *
 * The handoff names the task's **process directory** (`.meerkat/<identifier>/`),
 * relative to the project cwd. `card.md` is the loop's authoritative
 * export of the card; it is read-only, and every other process file — notes,
 * logs, evidence, downloaded attachments — belongs in the same directory. The
 * board still owns no directory (O3): this is the loop's convention under the
 * worker's own cwd, resolved locally.
 *
 * Optional team-role fields (`role`, `roleWorkflowPath`, `selfCheckPath`,
 * `decisionPolicyPath`) append the plan-file convention, the role skill and
 * self-check paths, and the decision policy — never the role's catalog fields.
 * Without them the text is the pre-roles handoff, byte for byte.
 *
 * @param {{card?: object, agent: string, actorKind: string, sessionId?: string|null, role?: object|null, roleWorkflowPath?: string|null, selfCheckPath?: string|null, decisionPolicyPath?: string|null}} input
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
  const acceptanceMode = ["off", "auto", "human"].includes(declaredMode)
    ? declaredMode
    : "auto";
  const acceptanceRule =
    acceptanceMode === "off"
      ? "stop at in_review — the loop auto-accepts an off card."
      : acceptanceMode === "auto"
        ? "stop at in_review — the loop dispatches an independent reviewer; after APPROVE it closes the card."
        : "stop at in_review — the loop dispatches an independent reviewer; a human accepts after APPROVE.";
  const brief = cardFileRel(ref);
  const processDir = cardDirRel(ref);
  const lines = [
    `You are the worker for the ${project} project — one card: ${ref}. This is the card's own worker session; the loop holds its claim.`,
    `Title: ${title}`,
    `Task brief: ${brief} — exported by the loop; read it first, it is authoritative for this card.`,
    "The brief was exported just before the claim, so its status/assignee may lag one step; the loop already holds the claim.",
    `Read ${brief} as the loop's export; it refreshes from the board. Put your process files (notes, logs, evidence, report drafts) under ${processDir}/.`,
    `Download attachments into that directory: taskctl attachment list ${ref} --json, then taskctl attachment download <attachment-id> --out ${processDir}/<filename>.`,
    "Your working directory is this card's workspace; other projects' paths stay untouched.",
    "The loop already claimed this card for you: keep the claim with a heartbeat.",
    "",
    `Flags (substitute <flags>): ${flags}`,
    "",
    "Step 0 — container check. Read the brief, then the live card:",
    `  ${brief}    # description, acceptance, comments, sessions, attachments, report`,
    `  taskctl issue get ${ref} --json <flags>    # live status, version, acceptance snapshot, meta`,
    "  Several deliverables, or layers of one change? Let the director promote or split.",
    "  Add an agent question naming the pieces, keep the card in_progress, and hold.",
    "  The director decides; a scope expansion is E1 and goes to the human.",
    `    taskctl comment add ${ref} --kind question --body "..." <flags>`,
    "    meta.epic_triage=off: the director promotes; record the split question in a comment.",
    "",
    `Step 1 — acceptance list, on the card you work (<card> = ${ref}):`,
    "  `acceptance` in issue get --json is the FROZEN baseline; meta.acceptance is only",
    "  the seed it was copied from. Work to the snapshot; append new items; keep the existing ones.",
    "  Snapshot and meta both empty (not an epic): a mechanical derivation may be",
    "  pre-authorized in this handoff. If it was not, add an agent question",
    "  comment and hold. Changing an existing acceptance item is E2 and goes to the",
    "  director/human.",
    `    taskctl issue update <card> --acceptance "..." --acceptance "..." --meta acceptance_derived=yes <flags>`,
    `    taskctl comment add <card> --kind note --body "acceptance list derived at claim (pre-authorized): 1) ..." <flags>`,
    `  Comments: taskctl comment list <card> --limit 200 --json <flags>`,
    "  Too thin to yield checkable items, or blocked on a decision? Route it to the director:",
    "  add an agent question comment on the card, keep it in_progress, and hold.",
    "  The director answers or escalates E1-E5.",
    `    taskctl comment add <card> --kind question --body "Decision needed: ..." <flags>`,
    `    taskctl issue wait <card> --question <id> <flags>   # hold for the answer`,
    "  On `answered` read the comments after your question — a human comment, or the",
    "  director's `note`; if the card is back in `todo`, claim it again first. An incomplete",
    "  answer is not consent — ask again. A rejection means revise or stop; bring a revised round.",
    "  Review asks for more: append the item. Ask the director; keep the card here.",
    "",
    `Keep the claim alive (<=10 minutes): taskctl issue heartbeat <card> <flags>`,
    `Deliver with a report (a draft may live under ${processDir}/report.md): taskctl issue deliver <card> --report-file - <flags>`,
    "Before you deliver, merge the project's integration branch into this lane and re-run the checks. Never merge the lane back, rebase or push — landing is the loop's.",
    "Rules: after a split, the heartbeat and delivery apply to the claimed CHILD, not the epic.",
    `On resume, re-read ${brief} before acting; the loop owns it.`,
    `${acceptanceRule} Carry the flags above on every write.`,
  ];
  if (input.role) {
    lines.push(
      "",
      "## Plan file",
      `Write and maintain ${processDir}/plan.md before you start; update it as you learn.`,
      "Append an evidence row the moment you observe it — item → command+exit / path+check —",
      "then project the table into the delivery report; a row written at delivery is memory.",
      "The reviewer reads it; the loop owns it.",
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
  const attribution = [`--agent ${input.agent}`, `--actor-kind ${input.actorKind}`];
  if (input.sessionId) attribution.push(`--session-id ${input.sessionId}`);
  const flags = attribution.join(" ");
  const brief = cardFileRel(ref);
  const originalRef = typeof card.review_of === "string" && card.review_of.trim() !== ""
    ? card.review_of.trim()
    : null;
  const originalBrief = originalRef === null ? null : cardFileRel(originalRef);
  const lines = [
    `Review card: ${ref}`,
    `Card under review: ${original} (round ${round})`,
    `Review brief: ${brief} — exported by the loop; read it after the live check, it is authoritative.`,
    ...(originalBrief === null ? [] : [`Original brief: ${originalBrief} (when present; also authoritative).`]),
    "Your working directory is this project's directory; stay inside it and leave other projects' paths untouched.",
    "The loop already claimed this review card for you: keep the claim with a heartbeat.",
    "",
    "Step 0 — the review_not_ready check; do it before reading anything else:",
    `  taskctl issue get ${original} --json ${flags}`,
    "  If its status is not in_review, or its delivery_round is not the round above:",
    `    taskctl comment add ${ref} --kind note --body "review target is no longer in_review / the round changed" ${flags}`,
    "    and stop before a verdict; the loop will close this review card.",
    "",
    `Read (start with ${brief}; taskctl is the live view):`,
    `  taskctl issue get ${ref} --json ${flags}`,
    `  taskctl report list ${original} ${flags}`,
    `  taskctl comment list ${original} --limit 200 --json ${flags}`,
    `  taskctl relation list ${original} ${flags}     # an epic's children`,
    "Audit the acceptance list, this round's report and evidence, and the comment trail; when",
    "meta.acceptance_derived=yes re-derive it — a narrowed acceptance list missing a requirement is a REJECT.",
    "Verify what was delivered, not the live tree: take this round's report `commit` anchor and",
    "read it with `git -C <project dir> show <sha>:<path>`; if the tree has moved, say so.",
    "The original's baseline already carries every earlier round's findings — answer each one.",
    "",
    "Deliver:",
    `  taskctl report template ${ref}   # fill it in, then:`,
    `  taskctl issue deliver ${ref} --report-file - ${flags}`,
    "The report's FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.",
    "Put the findings after that line and in `leftovers`.",
    `On resume, re-read ${brief}; the loop owns it.`,
    "Rules: heartbeat only this review card; the card under review keeps its own holder.",
    "Leave both cards where they are: the loop applies the verdict and closes this card.",
    "Stay in the review turn: insufficient evidence is a REJECT with the findings.",
  ];
  if (input.reviewerHandoff || input.reviewerHandoffPath) {
    const block = renderReviewerProtocol(input.reviewerHandoff ?? null, input.reviewerHandoffPath ?? null);
    if (block.length > 0) {
      const at = lines.findIndex((line) => line.startsWith("Step 0 —"));
      lines.splice(at === -1 ? lines.length : at, 0, ...block, "");
    }
  }
  if (input.role) {
    if (input.roleWorkflowPath) lines.push("", ...renderRoleWorkflow(input.role, input.roleWorkflowPath));
    const originalDir = originalRef === null ? "<original>" : cardDirRel(originalRef);
    lines.push(
      "",
      "## Reference material",
      `  ${originalDir}/plan.md — the worker's plan (if it exists)`,
      `  ${originalDir}/ — notes, evidence, report drafts, attachments`,
      "Omission check: every requirement, comment and plan step must map to an acceptance item and",
      "evidence, or be explicitly deferred; a narrowed acceptance list is a REJECT.",
    );
    if (input.decisionPolicyPath) lines.push("", `Decision policy: ${input.decisionPolicyPath}`);
  }
  return lines.join("\n");
}

/**
 * The lean task envelope for a resident role session. The role skill was loaded
 * when the session opened — by a `/<skill>` message or inside the adapter — so
 * this message carries only the card and the exact board moves, never the role
 * layer or the skill paths.
 *
 * `flags` is the attribution line for a lane whose skill was loaded inline: it
 * did not receive an opener message, so this envelope is the only place the
 * agent can learn the flags every write needs.
 *
 * @param {{card?: object, decisionPolicyPath?: string|null, flags?: string|null}} input
 * @returns {string}
 */
export function buildResidentEnvelope(input) {
  const card = input.card ?? {};
  const title = String(card.title ?? "").slice(0, 300);
  const ref = card.identifier;
  const project = card.project ?? "<project id>";
  const brief = cardFileRel(ref);
  const processDir = cardDirRel(ref);
  const flags = typeof input.flags === "string" && input.flags !== "" ? input.flags : null;
  const roundsPath =
    typeof input.decisionPolicyPath === "string" && input.decisionPolicyPath !== ""
      ? input.decisionPolicyPath.replace(/decision-policy\.md$/, "rounds.md")
      : null;
  return [
    `You are the worker for the ${project} project — one card: ${ref}.`,
    `Title: ${title}`,
    `Brief: ${brief} — the supervisor exported it; read it first, it is authoritative for this card.`,
    `Read ${brief} as the supervisor's export; the supervisor owns it and refreshes it from the board. Put your process files under ${processDir}/.`,
    `Plan: ${processDir}/plan.md (write and maintain it before you start).`,
    ...(flags === null
      ? ["Carry the session opener's Flags on every write."]
      : [`Flags: ${flags}`, "Carry these Flags on every write."]),
    "",
    "Board: heartbeat this card at least every 10 minutes; deliver at in_review with a report;",
    "the loop moves it to done and holds the claim for you.",
    `  taskctl issue heartbeat ${ref} <flags>`,
    `  taskctl issue deliver ${ref} --report-file - <flags>`,
    "Before you deliver, merge the project's integration branch into this lane and re-run the checks. Never merge the lane back, rebase or push — landing is the loop's.",
    "The frozen acceptance is in the brief; changing an existing item is E2. Route a question",
    "to the director:",
    `  taskctl comment add ${ref} --kind question --body "..." <flags>`,
    `  taskctl issue wait ${ref} --question <id> <flags>`,
    roundsPath === null
      ? "The round method is the meerkat-director skill's rounds.md. Your role skill is"
      : `The round method is ${roundsPath}. Your role skill is`,
    "already loaded; read the branch file it names once and follow it.",
  ].join("\n");
}

/**
 * The thin envelope for a **review** card's resident session. The card system
 * prompt was injected at session open and owns identity, briefs and Flags; the
 * role skill loaded there owns the audit floor. This message carries only the
 * concrete refs, Step 0, the board reads and the verdict format — the pieces
 * that change per card.
 *
 * @param {{card?: object}} input
 * @returns {string}
 */
export function buildReviewEnvelope(input) {
  const card = input.card ?? {};
  const ref = card.identifier;
  const reviewed =
    typeof card.review_of === "string" && card.review_of.trim() !== ""
      ? card.review_of.trim()
      : null;
  const original = reviewed ?? "<card under review>";
  const round = card.review_round ?? "the round recorded on the review card";
  return [
    `Review card: ${ref}; card under review: ${original} (round ${round}).`,
    "Step 0 — the review_not_ready check:",
    `  taskctl issue get ${original} --json <flags>`,
    `  If its status is not in_review, or its delivery_round is not the round above: note it on ${ref} and stop; the loop closes this card.`,
    "Board:",
    `  taskctl issue get ${ref} --json <flags>`,
    `  taskctl report list ${original} <flags>`,
    `  taskctl comment list ${original} --limit 200 --json <flags>`,
    `  taskctl relation list ${original} <flags>     # an epic's children`,
    "Deliver one verdict on this card: first line exactly `VERDICT: APPROVE` or `VERDICT: REJECT`;",
    "findings after it and in `leftovers`.",
    `  taskctl report template ${ref}`,
    `  taskctl issue deliver ${ref} --report-file - <flags>`,
    "Your loaded role skill owns the audit floor; follow the branch file it names.",
  ].join("\n");
}

/** A non-empty trimmed string, or null. */
function promptText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Path text without trailing separators, so a joined line never doubles one. */
function promptPath(value) {
  const text = promptText(value);
  return text === null ? null : text.replace(/[\\/]+$/, "");
}

/**
 * The static board text a worker-lane card session receives when its role.json
 * carries no `system_prompt` (an older install, or a role-less card).
 */
export const WORKER_SYSTEM_PROMPT_FALLBACK = [
  "Read the task card first; it is authoritative for this card. Write and maintain the plan in the process directory.",
  "The supervisor owns card.md and refreshes it from the board.",
  "Carry the Flags above on every write.",
  "Board: heartbeat this card at least every 10 minutes and deliver at in_review with a report;",
  "the loop holds the claim and closes the card at done.",
  "  taskctl issue heartbeat <ref> <flags>",
  "  taskctl issue deliver <ref> --report-file - <flags>",
  "For a question, route it to the director: leave a `question` comment and hold the card with `issue wait`.",
  '  taskctl comment add <ref> --kind question --body "..." <flags>',
  "  taskctl issue wait <ref> --question <id> <flags>",
].join("\n");

/** The reviewer-lane counterpart: the Step 0 validity check and the verdict form. */
export const REVIEWER_SYSTEM_PROMPT_FALLBACK = [
  "Read the task card first; it is authoritative. The supervisor owns card.md and keeps it fresh from the board.",
  "Carry the Flags above on every write.",
  "Board: heartbeat this review card; the card under review keeps its own holder. Deliver one",
  "verdict on this review card with a report; the loop applies the verdict and closes the card.",
  "Step 0 — before anything else: if the card under review is not in_review, or its delivery_round",
  "is not the round above, leave a note on the review card and stop; the loop closes the review card.",
  "  taskctl issue get <review-ref> --json <flags>",
  "  taskctl issue heartbeat <review-ref> <flags>",
  "  taskctl issue deliver <review-ref> --report-file - <flags>",
  "The report's first line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.",
  "A review ends in a verdict; insufficient evidence is REJECT with the findings.",
].join("\n");

/**
 * The system prompt a card session is opened with.
 *
 * The runtime half — who the agent is, the card, the plan, the flags, and for a
 * reviewer the card under review and its round — is formatted here from the
 * supervisor's row. The static half is `role.json`'s `system_prompt` verbatim
 * (or the lane fallback when the role carries none): it is never templated, so
 * a role file cannot silently rewrite the card's paths.
 *
 * Pure: paths arrive already resolved and this only joins text.
 *
 * @param {{staticPrompt?: string|null, fallbackPrompt?: string|null, lane?: string|null,
 *   agent?: string|null, project?: string|null, cardRef?: string|null,
 *   cardPath?: string|null, planPath?: string|null, processDir?: string|null,
 *   flags?: string|null, reviewRef?: string|null, reviewPath?: string|null,
 *   reviewPlanPath?: string|null, round?: number|string|null}} input
 * @returns {string}
 */
export function buildSessionSystemPrompt(input = {}) {
  const reviewer = String(input.lane ?? "worker") === "reviewer";
  const ref = promptText(input.cardRef) ?? "<card>";
  const project = promptText(input.project) ?? "<project id>";
  const lines = [];
  if (reviewer) {
    const original = promptText(input.reviewRef);
    const round =
      original !== null && promptText(input.round === null || input.round === undefined ? null : String(input.round)) !== null
        ? ` (round ${input.round})`
        : "";
    lines.push(`You are the reviewer for the ${project} project — one delivered card.`);
    lines.push(`Review card: ${ref}`);
    const brief = promptPath(input.cardPath);
    if (brief !== null) lines.push(`Review card brief: ${brief}`);
    lines.push(`Card under review: ${original ?? "not recorded"}${round}`);
    if (original !== null) {
      const originalBrief = promptPath(input.reviewPath);
      const originalPlan = promptPath(input.reviewPlanPath);
      if (originalBrief !== null) lines.push(`Original brief: ${originalBrief}`);
      if (originalPlan !== null) lines.push(`Original plan: ${originalPlan}`);
    }
  } else {
    lines.push(
      `You are ${promptText(input.agent) ?? "<agent>"} for the ${project} project — one card: ${ref}.`,
    );
    const card = promptPath(input.cardPath);
    const plan = promptPath(input.planPath);
    const processDir = promptPath(input.processDir);
    if (card !== null) lines.push(`Task card: ${card}`);
    if (plan !== null) lines.push(`Task plan: ${plan}`);
    if (processDir !== null) lines.push(`Process directory: ${processDir}`);
  }
  lines.push(`Flags: ${promptText(input.flags) ?? "<flags>"}`);
  const staticPrompt =
    promptText(input.staticPrompt) ?? promptText(input.fallbackPrompt) ?? "";
  if (staticPrompt !== "") lines.push("", staticPrompt);
  return lines.join("\n");
}

/**
 * The prompt the Director lane gets for the **question lane**.
 *
 * A worker that cannot decide writes an agent `question` comment and holds with
 * `taskctl issue wait`, and the loop hands the question here. The Director
 * answers with a `note` and releases the card to the queue, or escalates E1–E5
 * to the human. The release is what the worker waits for. It never spawns a
 * subagent for this row and never moves a card to `done`.
 *
 * Every row's `--agent` is `DIRECTOR_ACTOR_ID`: the lane signs its own writes,
 * exactly as a worker signs its card. A row's `agent` field is the asking
 * worker (its origin), not attribution. `input.actorKind` is the kind actually
 * running the lane, so a kind-fallback install names itself honestly.
 *
 * `rows` carry the queue row's fields: `card` (the ref), `project`,
 * `target_dir`, `agent`, `question_id`, `question`, `asked_at`.
 *
 * @param {object[]} rows
 * @param {{actorKind?: string, decisionPolicyPath?: string|null, routing?: string|null}} [input]
 * @returns {string}
 */
export function buildQuestionPrompt(rows, input = {}) {
  const actorKind = String(input.actorKind ?? "claude");
  const first = rows[0] ?? {};
  const project = String(first.project ?? "the project");
  const dir = String(first.target_dir ?? "");
  const lines = [
    `You are the Director for ${project} at ${dir}.`,
    "These rows need a decision. Answer or route them here — never spawn a subagent,",
    "never claim a card and never move one to done.",
    "",
  ];
  rows.forEach((row, index) => {
    const flags = `--agent ${DIRECTOR_ACTOR_ID} --actor-kind ${actorKind}`;
    if (row.triage === true) {
      const round = Number(row.round ?? row.delivery_round ?? 1);
      const title = row.title ? ` — ${row.title}` : "";
      const projectId = String(row.project ?? project);
      lines.push(
        `${index + 1}) ${row.card}${title} — accepted producer, required handoff (round ${round}):`,
        `   The card is done and must not be reopened or moved. Read its current delivery:`,
        `   taskctl issue get ${row.card} --json --include reports --include relations ${flags}`,
        `   Read only the report whose round is ${round}; its \`## Handoff\`, its \`leftovers\` and`,
        "   that round's review observations are the close-out ledger. Give every ledger item",
        "   one disposition — reuse, create, decline or escalate — before the marker.",
        `   Its review cards: taskctl issue list --review-of ${row.card} --json ${flags}`,
        `   (take the one whose review_round is ${round}; its report's \`leftovers\` are those observations),`,
        `   Resolve the project directory with \`taskctl project dir ${projectId} --json\`, then read`,
        "   `<dir>/docs/agents/epic-graphs.md` first. The project's canonical multi-role shape is",
        "   there: adopt this producer as its matching stage, reuse an existing instance, and create",
        "   only the missing epic, stages and edges with the graph's `Epic mode` and the meerkat",
        "   skill's epic recipe (`--parent <epic> --target <stage-id>`, the same idempotency",
        "   convention). When no graph matches, keep the per-deliverable behavior below.",
        `   Existing downstream cards for this handoff:`,
        `   taskctl issue list --project ${projectId} --meta handoff_of=${row.card}:r${round} --json ${flags}`,
        "   Reuse those; never create a duplicate. Create one card per deliverable with its",
        "   accountable role from the routing table:",
        `   taskctl issue create --project ${projectId} --title "..." --assignee <role>`,
        `     --target <scope-slug> --meta handoff_of=${row.card}:r${round}`,
        `     --idem "loop-handoff|${row.card}|r${round}|<n>" --acceptance "..."`,
        `     --description "<the handoff paths and constraints>" ${flags}`,
        "   Give each child its own --target (or --allow-dup when a target does not apply).",
        "   Seed 1-6 checkable acceptance items from the handoff's `Acceptance source`.",
        `   For an epic, create --kind epic first, then taskctl relation add <epic> --type parent --target <child>.`,
        "   For a task producer, record meta.origin=<producer> on the follow-up card instead.",
        `   When done: taskctl issue meta ${row.card} --if-version <v> --meta handoff_consumed_round=${round} ${flags}`,
        `   (record the created refs in the value); when the ledger declines every item:`,
        `   taskctl issue meta ${row.card} --if-version <v> --meta handoff_declined_round=${round} ${flags}`,
        "   and leave a note accounting for each declined item and its reason.",
        "   A proposed child that expands scope is E1:",
        "   escalate instead of creating it.",
        "   You may create cards; never claim or implement one, never move the producer,",
        "   and never use --as-human.",
        "",
      );
      return;
    }
    if (row.route === true) {
      const title = row.title ? ` — ${row.title}` : "";
      const since = row.updated_at ? ` (unowned since ${row.updated_at})` : "";
      lines.push(
        `${index + 1}) ${row.card}${title} — unowned todo${since}:`,
        `   Assign exactly one role from the routing table:`,
        `   taskctl issue assign ${row.card} --assignee <role> ${flags}`,
        "   A shape the table does not cover goes to the Worker role. Never invent a role",
        "   name, never claim the card, and leave a fresh or ambiguous card for its creator.",
        "",
      );
      return;
    }
    const asked = row.asked_at ? ` (asked ${row.asked_at})` : "";
    lines.push(`${index + 1}) ${row.card} — question ${row.question_id}${asked}:`);
    // A comment body can be up to 1 MiB; an unbounded question would make the
    // director's turn impossible to finish. Bound it like every other prompt.
    const question = String(row.question ?? "");
    const bounded = question.length > QUESTION_PROMPT_BODY_MAX
      ? `${question.slice(0, QUESTION_PROMPT_BODY_MAX)}\n[truncated]`
      : question;
    for (const line of bounded.split("\n")) lines.push(`   ${line}`);
    lines.push(
      `   Re-read the card first: taskctl issue get ${row.card} --json ${flags}`,
      "   If its status is not `in_progress` (delivered, moved, canceled, or already",
      "   waiting on a human), do nothing — the question is no longer this lane's.",
      `   Then re-read the trail: taskctl comment list ${row.card} --limit 20 --json ${flags}`,
      "   If a later comment already answers it and the card is still `in_progress`,",
      `   do NOT answer again — release the card: taskctl issue move ${row.card} todo ${flags}`,
      "   (A Director that writes a note without releasing leaves the question open and this",
      "   row is retried; the release is what the worker waits for.)",
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
  if (typeof input.routing === "string" && input.routing.trim() !== "") {
    lines.push("", "## Routing table", input.routing.trim());
  }
  return lines.join("\n");
}

