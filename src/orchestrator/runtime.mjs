#!/usr/bin/env node
/**
 * The loop's local runtime primitives.
 *
 * These are the things a one-shot entry and the scheduler both need: the
 * process-liveness probe, the worker registry, the log, the `taskctl` shell-out,
 * the SLA ledger / liveness marker, and the continue lock. None of it decides
 * anything — the decisions live in `src/foundation/`.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { CLI_TIMEOUT_MS, EVENT_STREAM_LINE } from "../foundation/constants.mjs";
import { pidMatches, processStartToken } from "../foundation/daemon-state.mjs";
import { markerMatches } from "../foundation/handoff-round.mjs";
import { STOP_DRAIN_MS, wedgeKillAction } from "../foundation/loop-state.mjs";
import {
  createFileSink,
  createLogger as createFoundationLogger,
  levelFromEnv,
  stderrSink,
} from "../foundation/log.mjs";
import { pruneRegistry } from "../foundation/scheduling.mjs";
import { emptySlaLedger } from "../foundation/sla-patrol.mjs";
import {
  classifyQuestionOutcome,
  isHumanComment,
  isQuestionComment,
  newestQuestion,
} from "./questions.mjs";

// ---------------------------------------------------------------------------
// Registry (crash survival) + process liveness
// ---------------------------------------------------------------------------

/**
 * Wait for an in-flight pass to settle, but never longer than `timeoutMs`.
 *
 * The daemon's SIGTERM handler and `runSession.stop()` both need the same
 * bound: a restart must not be held hostage by a pass that will not finish.
 * A rejected or absent pass counts as drained — its outcome is already the
 * caller's concern.
 *
 * @param {Promise<unknown>|null|undefined} pending
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when it settled, false at the bound
 */
export async function drainInFlight(pending, timeoutMs = STOP_DRAIN_MS) {
  if (pending === null || pending === undefined) return true;
  // An explicit 0 means "do not wait" (a test seam); an invalid value falls
  // back to the shared bound.
  const requested = Number(timeoutMs);
  const bound = Number.isFinite(requested) && requested >= 0 ? requested : STOP_DRAIN_MS;
  let timer = null;
  const timeout = new Promise((resolveTimeout) => {
    // The bound must keep the event loop alive for its own duration: when the
    // in-flight pass holds no handle of its own, an unref'd timer lets the
    // process exit before the bound can fire, so the drain (and its
    // stop_drain_timeout record) never happens.
    timer = setTimeout(() => resolveTimeout(false), bound);
  });
  try {
    return await Promise.race([
      Promise.resolve(pending).then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

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

/**
 * Persist the running registry.
 *
 * Temp + rename, because ping (a separate process, every minute) and poll both
 * read-modify-write this file. A torn write would read as "no workers" and let
 * the concurrency gate over-admit.
 */
export function saveRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Event-subscriber liveness (`--supervisor=status` reads this)
// ---------------------------------------------------------------------------

/** Where the subscriber publishes its connection facts, beside the other loop state. */
export function subscribeStatePath(stateDir) {
  return join(stateDir, "subscribe.state.json");
}

/** Read the subscriber's state; a missing/corrupt file is `null`, never a crash. */
export function loadSubscribeState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.version === 1) return parsed;
  } catch {
    // Missing or unreadable — status says "not running".
  }
  return null;
}

/**
 * Publish the subscriber's state. Temp + rename, like the registry: `status` runs
 * in another process and must never read a torn file.
 */
export function saveSubscribeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Run the taskctl CLI and parse its `--json` envelope. Returns `{ok, data|error}`.
 *
 * The CLI requires an identity on every call: reads and claims use the agent kind
 * (`claude`/`codex`/`pi`), workflow writes pass `system` so an automated
 * acceptance is attributable. `--env-file` and `--url` are forwarded; the token
 * rides in the child environment, never argv.
 */
/**
 * The argv and environment for one `taskctl` call.
 *
 * Identity is required on every CLI call: the loop's actor kind (claude/codex/pi) is
 * the platform for its agent actions; the board's own workflow pass names
 * `system` explicitly. A caller that forgot gets the agent kind, never `human`.
 * A token never goes on argv (it would be visible in `ps`).
 */
export function cliInvocation(opts, agent, args, { actorKind = null } = {}) {
  const kind = actorKind ?? opts.actorKind ?? "system";
  const argv = [
    opts.cli,
    "--json",
    "--agent",
    agent,
    "--actor-kind",
    kind,
    ...(opts.envFile ? ["--env-file", opts.envFile] : []),
    ...(opts.url ? ["--url", opts.url] : []),
    ...args,
  ];
  // `cliEnv` is the caller's own additions (never a CLI flag): the doctor uses it
  // to forbid autostart, so an inspection cannot start a board as a side effect.
  // The token is applied last — a caller may not shadow it by accident.
  const env = { ...process.env, ...(opts.cliEnv ?? {}) };
  if (opts.token) env.TASKD_TOKEN = opts.token;
  return { argv, env };
}

/**
 * Parse one `taskctl --json` envelope. Shared by the blocking and async callers
 * so their shapes cannot drift: `{ok, data}` on success, `{ok:false, error}`
 * plus the board's `code`/`details`/`hint` on a refusal.
 *
 * @param {string|null|undefined} stdout
 * @param {string|null|undefined} stderr
 * @param {number|null} status
 * @returns {{ok: boolean, data?: object, error?: string, code?: string, details?: *, hint?: *}}
 */
function parseCliResult(stdout, stderr, status) {
  try {
    const parsed = JSON.parse(stdout ?? "");
    if (parsed?.ok === true) return { ok: true, data: parsed.data ?? {} };
    // The board's code is what lets the loop classify a refusal (a re-plan next
    // tick vs. a state no tick can fix). `error` stays the readable message.
    const error = parsed?.error ?? null;
    return {
      ok: false,
      error: error?.message ?? `exit ${status}`,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
      ...(error?.details === undefined ? {} : { details: error.details }),
      ...(error?.hint === undefined ? {} : { hint: error.hint }),
    };
  } catch {
    return { ok: false, error: (stderr ?? "").trim() || `exit ${status}` };
  }
}

export function runCli(opts, agent, args, { input = null, actorKind = null } = {}) {
  const { argv, env } = cliInvocation(opts, agent, args, { actorKind });
  // A bound on the child, not on the board call it makes: a `taskctl` that
  // hangs before or after its 30 s HTTP call would otherwise hold the tick (and
  // its continue lock) until the two-hour staleness bound.
  const run = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    input,
    env,
    timeout: Number(opts.cliTimeoutMs ?? CLI_TIMEOUT_MS),
    killSignal: "SIGKILL",
  });
  if (run.error) {
    if (run.error.code === "ETIMEDOUT") {
      return { ok: false, error: `taskctl timed out after ${opts.cliTimeoutMs ?? CLI_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: run.error.message };
  }
  return parseCliResult(run.stdout, run.stderr, run.status);
}

/**
 * The same `taskctl` call without blocking the event loop.
 *
 * `spawnSync` holds the pool for up to a minute; the card heartbeat pulses
 * *during* a turn, so it must not stop the turn's own timers or the pool's
 * heartbeat while it runs. Same argv, same environment, same result shape as
 * `runCli`; the bound SIGKILLs the child and returns the timeout as a failure.
 *
 * @param {object} opts
 * @param {string} agent
 * @param {string[]} args
 * @param {{actorKind?: string|null, timeoutMs?: number|null}} [options]
 * @returns {Promise<ReturnType<typeof parseCliResult>>}
 */
export function runCliAsync(opts, agent, args, { actorKind = null, timeoutMs = null } = {}) {
  const { argv, env } = cliInvocation(opts, agent, args, { actorKind });
  const bound = Number(timeoutMs ?? opts.cliTimeoutMs ?? CLI_TIMEOUT_MS);
  return new Promise((resolveRun) => {
    let settled = false;
    let timer = null;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolveRun(result);
    };
    let child;
    try {
      child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (err) {
      finish({ ok: false, error: err.message });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      finish(parseCliResult(stdout, stderr, code));
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; the close handler still settles the promise.
      }
      finish({ ok: false, error: `taskctl timed out after ${bound}ms` });
    }, Math.max(1, bound));
    timer.unref?.();
  });
}

/**
 * The live status of one card, for a retry that must not re-dispatch work the
 * worker already delivered.
 *
 * A failed read is returned, never thrown: the caller decides between requeueing
 * and waiting. This lives beside `runCli` rather than in `board.mjs` so the pool
 * can read it without importing the board module (which imports the runners,
 * which import the pool).
 *
 * @param {object} opts
 * @param {string} ref
 * @param {(message: string) => void} [log]
 * @param {Function} [run] the `runCli` seam, injectable for tests
 * @returns {{ok: boolean, status: string|null, error: string|null}}
 */
export function readCardForRedispatch(opts, ref, log = () => {}, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, status: null, error: "no agent configured" };
  const read = run(opts, agent, ["issue", "get", String(ref)]);
  if (!read.ok) {
    log(`redispatch check for ${ref} failed: ${read.error}`);
    return { ok: false, status: null, error: read.error };
  }
  const status = read.data?.task?.status;
  return { ok: true, status: typeof status === "string" ? status : null, error: null };
}

/**
 * Did the director actually settle an unowned card?
 *
 * A route row's turn can exit 0 without assigning anybody. The settle rule is
 * the board's, not the turn's: the card left `todo`, or it now has an assignee.
 * A failed read is returned, never thrown, so the caller can decide (it is
 * treated as unsettled — the next poll re-enqueues only if the card is still
 * unowned, which the read would have shown).
 *
 * @param {object} opts
 * @param {string} ref
 * @param {(line: string) => void} [log]
 * @param {Function} [run]
 * @returns {{ok: boolean, settled?: boolean, status?: string|null, assigned?: string|null, error: string|null}}
 */
export function readRouteOutcome(opts, ref, log = () => {}, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, error: "no agent configured" };
  const read = run(opts, agent, ["issue", "get", String(ref), "--json"]);
  if (!read.ok) {
    log(`route check for ${ref} failed: ${read.error}`);
    return { ok: false, error: read.error };
  }
  const task = read.data?.task ?? {};
  const assignee = task.assignee ?? {};
  const assigned =
    (typeof assignee.id === "string" && assignee.id !== "" ? assignee.id : null) ??
    (typeof assignee.display_name === "string" && assignee.display_name !== "" ? assignee.display_name : null);
  const status = typeof task.status === "string" ? task.status : null;
  return {
    ok: true,
    settled: status !== "todo" || assigned !== null,
    status,
    assigned,
    error: null,
  };
}

/**
 * Did the director consume an accepted card's required handoff?
 *
 * The decision is the marker on the producer, not the children: a producer may
 * already have children (an epic), and a crash after creating one child must be
 * recoverable by the next turn. The round is compared numerically because
 * `delivery_round` is a number and `--meta` stores strings.
 *
 * A producer that moved off `done` or past this round is stale: the row has
 * nothing left to decide and must be completed without any write.
 *
 * @param {object} opts
 * @param {string} ref
 * @param {number} round
 * @param {(line: string) => void} [log]
 * @param {Function} [run]
 * @returns {{ok: boolean, settled?: boolean, stale?: boolean, consumed?: boolean, declined?: boolean, error: string|null}}
 */
export function readTriageOutcome(opts, ref, round, log = () => {}, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, error: "no agent configured" };
  const read = run(opts, agent, ["issue", "get", String(ref), "--json"]);
  if (!read.ok) {
    log(`triage check for ${ref} failed: ${read.error}`);
    return { ok: false, error: read.error };
  }
  const task = read.data?.task ?? {};
  const status = typeof task.status === "string" ? task.status : null;
  const liveRound = Number(task.delivery_round);
  if (status !== "done" || !Number.isFinite(liveRound) || liveRound !== Number(round)) {
    return { ok: true, settled: false, stale: true, error: null };
  }
  const meta = task.meta ?? {};
  const consumed = markerMatches(meta.handoff_consumed_round, round);
  const declined = markerMatches(meta.handoff_declined_round, round);
  return { ok: true, settled: consumed || declined, stale: false, consumed, declined, error: null };
}

/**
 * The human/project answer that caused a same-round re-dispatch.
 *
 * Any **human** comment newer than the latest agent question counts, whatever
 * its kind; the director's `note` counts too. The text is
 * bounded because it goes into a resume prompt.
 *
 * @param {object} opts
 * @param {string} ref
 * @param {(line: string) => void} [log]
 * @param {Function} [run]
 * @returns {{ok: boolean, status: string|null, answer: string|null, error: string|null}}
 */
export function readRedispatchContext(opts, ref, log = () => {}, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, status: null, answer: null, error: "no agent configured" };
  const read = run(opts, agent, [
    "issue",
    "get",
    String(ref),
    "--json",
    "--include",
    "comments",
    "--limit",
    "50",
  ]);
  if (!read.ok) {
    log(`re-dispatch context for ${ref} failed: ${read.error}`);
    return { ok: false, status: null, answer: null, error: read.error };
  }
  const task = read.data?.task ?? {};
  const status = typeof task.status === "string" ? task.status : null;
  const comments = Array.isArray(read.data?.comments) ? read.data.comments : [];
  const question = newestQuestion(comments);
  let newer;
  if (question !== null) {
    const index = comments.indexOf(question);
    newer = comments
      .slice(0, index)
      .filter((comment) => isHumanComment(comment) || !isQuestionComment(comment));
  } else {
    newer = comments.filter((comment) => !isQuestionComment(comment)).slice(0, 2);
  }
  const answer = newer
    .slice()
    .reverse()
    .map((comment) => {
      const text = String(comment?.body ?? "").trim();
      return `${isHumanComment(comment) ? "[human]" : "[agent]"} ${text}`;
    })
    .filter((line) => line.trim() !== "[human]" && line.trim() !== "[agent]")
    .join("\n");
  return { ok: true, status, answer: answer.slice(0, 2000), error: null };
}

/**
 * Did the director's turn actually settle the question?
 *
 * A director turn can exit 0 without releasing the card (it wrote a `note` and
 * forgot the move, or re-read a stale card). The question lane and the retry
 * must judge the **board**, not the process exit. The rule is release-only: the
 * card left `in_progress` (or changed status after the question). A note alone
 * is not a settle.
 *
 * The read is bounded like `readRedispatchContext`; a failed read is returned,
 * never thrown — the caller decides whether to retry.
 *
 * @param {object} opts
 * @param {string} ref
 * @param {string|number|null} questionId
 * @param {(line: string) => void} [log]
 * @param {Function} [run]
 * @returns {{ok: boolean, settled?: boolean, answered?: boolean, released?: boolean, escalated?: boolean, status?: string|null, error?: string|null}}
 */
export function readQuestionOutcome(opts, ref, questionId, log = () => {}, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, error: "no agent configured" };
  const read = run(opts, agent, [
    "issue",
    "get",
    String(ref),
    "--json",
    "--include",
    "comments",
    "--limit",
    "50",
  ]);
  if (!read.ok) {
    log(`question outcome for ${ref} failed: ${read.error}`);
    return { ok: false, error: read.error };
  }
  const task = read.data?.task ?? {};
  const comments = Array.isArray(read.data?.comments) ? read.data.comments : [];
  return { ok: true, ...classifyQuestionOutcome({ task, comments, questionId }) };
}

/**
 * Run a streaming `taskctl` command (`events follow`) and consume its NDJSON.
 *
 * The child is a normal `taskctl` process: it resolves the board, the token and
 * `.env` itself, so the loop carries no transport code. `TASKD_NO_AUTOSTART=1`
 * keeps the subscriber's old semantics — a missing board is a reason to
 * reconnect, not to start `taskd` from a timer.
 *
 * The returned reason is one of `open|eof|shutdown|idle|aborted|error`; the
 * caller owns the reconnect ladder. A failure *before* the stream opens arrives
 * as a multi-line `{ok:false,error}` document, which cannot be line-parsed — it
 * is recovered from the whole stdout tail on close.
 *
 * @param {object} opts
 * @param {string} agent
 * @param {string[]} args
 * @param {{
 *   signal?: AbortSignal|null,
 *   onOpen?: (() => void)|null,
 *   onEvent?: ((event: {id: number|null, data: object}) => void)|null,
 *   spawnFn?: Function,
 *   killGraceMs?: number,
 *   maxLineBytes?: number,
 *   log?: (line: string) => void,
 * }} [hooks]
 * @returns {Promise<{reason: string, error?: object|Error|null, data?: object|null,
 *   exitCode: number|null, stderr: string}>}
 */
export function streamCli(opts, agent, args, hooks = {}) {
  const {
    signal = null,
    onOpen = null,
    onEvent = null,
    spawnFn = spawn,
    killGraceMs = 2_000,
    maxLineBytes = 1024 * 1024,
    log = () => {},
  } = hooks;

  const { argv, env } = cliInvocation(opts, agent, args);
  env.TASKD_NO_AUTOSTART = "1";

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      resolve({ reason: "error", error, exitCode: null, stderr: "" });
      return;
    }

    let pending = "";
    let stdoutTail = "";
    let stderrTail = "";
    let terminal = null;
    let settled = false;
    let killTimer = null;

    function onAbort() {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, killGraceMs));
      if (typeof killTimer.unref === "function") killTimer.unref();
    }

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const handleLine = (line) => {
      if (line.trim() === "") return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A pre-open failure's pretty-printed envelope is not NDJSON; the close
        // handler recovers its message from the whole stdout tail.
        return;
      }
      switch (record?.type) {
        case EVENT_STREAM_LINE.OPEN:
          onOpen?.();
          break;
        case EVENT_STREAM_LINE.EVENT:
          onEvent?.({ id: Number.isFinite(record.id) ? record.id : null, data: record.data });
          break;
        case EVENT_STREAM_LINE.SHUTDOWN:
          terminal = { reason: "shutdown", data: record.data ?? null };
          break;
        case EVENT_STREAM_LINE.IDLE:
          terminal = { reason: "idle", data: record.data ?? null };
          break;
        case EVENT_STREAM_LINE.EOF:
          terminal = { reason: "eof", data: null };
          break;
        case EVENT_STREAM_LINE.ERROR:
          terminal = { reason: "error", error: record.data ?? null };
          break;
        default:
          log(`stream: ignoring an unknown line type ${JSON.stringify(record?.type)}`);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      pending += chunk;
      stdoutTail = `${stdoutTail}${chunk}`.slice(-65_536);
      if (pending.length > maxLineBytes) {
        terminal = {
          reason: "error",
          error: { code: "CLI_IO", message: `a stream line exceeded ${maxLineBytes} bytes` },
        };
        pending = "";
        child.kill("SIGTERM");
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        handleLine(line);
        newline = pending.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      finish({ reason: "error", error, exitCode: null, stderr: stderrTail });
    });

    child.on("close", (code) => {
      if (pending.trim() !== "") handleLine(pending.replace(/\r$/, ""));
      pending = "";
      if (signal?.aborted) {
        finish({ reason: "aborted", exitCode: code, stderr: stderrTail });
        return;
      }
      if (terminal !== null) {
        finish({
          reason: terminal.reason,
          error: terminal.error ?? null,
          data: terminal.data ?? null,
          exitCode: code,
          stderr: stderrTail,
        });
        return;
      }
      if (code === 0) {
        finish({ reason: "eof", error: null, data: null, exitCode: 0, stderr: stderrTail });
        return;
      }
      let message = null;
      try {
        const document = JSON.parse(stdoutTail.trim());
        if (document?.ok === false) message = document.error?.message ?? null;
      } catch {
        // Not the envelope either; fall back to stderr.
      }
      finish({
        reason: "error",
        error: new Error(message ?? (stderrTail.trim() || `taskctl exited ${code}`)),
        exitCode: code,
        stderr: stderrTail,
      });
    });
  });
}

/** An append fd for the log, or `null` when it cannot be opened. Never throws. */
function openAppendFd(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, "a");
  } catch {
    return null;
  }
}

/**
 * The SLA de-duplication ledger — a file beside the state, not a card.
 *
 * Fail-soft: an unreadable ledger reads as empty, so the pass notifies rather
 * than suppresses. A duplicate is admissible; a lost alert is not.
 */
export function loadSlaLedger(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.seen && typeof parsed.seen === "object") {
      return { version: 1, seen: parsed.seen };
    }
  } catch {
    // Missing or unreadable — start clean and notify (never suppress on a failed read).
  }
  return emptySlaLedger();
}

/** Persist the ledger. A failure here can only cost a duplicate, never an alert. */
export function saveSlaLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * The liveness watchdog's marker: `{mechanism, last_ok, …}`, written atomically
 * so a reader never sees half a file. An unreadable peer marker reads as null;
 * interpreting that is the decision half's job.
 */
export function saveLastOk(path, { mechanism, at, actor = null, periodSeconds = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ mechanism, last_ok: at, mechanism_actor: actor, cadence_period_min: periodSeconds === null ? null : periodSeconds / 60 }, null, 2)}\n`,
  );
  renameSync(tmp, path);
}

/** The peer's last-successful-run marker, with the cadence it declares. */
export function readPeerMarker(path) {
  if (path === null || path === undefined) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const value = parsed?.last_ok ?? parsed?.lastOk ?? null;
    if (typeof value !== "string" || value === "") return null;
    const cadence = parsed?.cadence_period_min ?? parsed?.cadencePeriodMin ?? null;
    const periodMinutes =
      typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0 ? cadence : null;
    return { lastOk: value, periodMinutes };
  } catch {
    // Absent, unreadable or malformed all mean the same thing here: the peer has
    // not published a usable marker. Whether that is an alarm or a dependency is
    // decided above this line.
    return null;
  }
}

/** The peer's last-successful-run marker's `last_ok`, or `null` when unreadable. */
export function readPeerLastOk(path) {
  return readPeerMarker(path)?.lastOk ?? null;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * One process's log sink: stderr always, the loop log unless this is a dry run.
 *
 * The formatter, the level filter, the rotation and the redaction all come from
 * `foundation/log.mjs`; this wrapper only keeps the loop's calling convention —
 * `log(line)` — and its `supervisor: ` prefix, which the loop's own tests read.
 * A failure site may mark its line with a second argument
 * (`log(line, { level: "warn" })`); an injected plain function ignores it.
 *
 * Logging must never take the loop down: a failed write is swallowed by the
 * sinks, and the file is rotated rather than growing without bound.
 *
 * @param {{log: string, dryRun?: boolean, logLevel?: string, actorKind?: string}} opts
 * @returns {((line: string, meta?: {level?: string}) => void) & {close: () => void}}
 */
export function createLogger(opts) {
  const level = opts.logLevel ?? levelFromEnv(process.env).level;
  const file = opts.dryRun ? null : createFileSink({ path: opts.log });
  const base = createFoundationLogger({
    level,
    component: "supervisor",
    // One file holds every actor kind's lines, so each line names its kind.
    // `unknown` keeps the field shaped for a caller that has no parsed opts.
    meta: { actor_kind: opts.actorKind ?? "unknown" },
    ...(file === null ? {} : { sinks: [stderrSink, file] }),
  });

  // The line logger keeps its `(line, fields)` shape; an `event` a caller names
  // (e.g. `pool_start_failed`) is carried into the record, not dropped.
  const log = (line, meta) =>
    base({
      level: meta?.level ?? "info",
      ...(typeof meta?.event === "string" && meta.event !== "" ? { event: meta.event } : {}),
      message: String(line),
    });
  log.close = () => base.close();
  return log;
}

// ---------------------------------------------------------------------------
// Ping — the liveness clock
// ---------------------------------------------------------------------------

/**
 * The ping's only enforcement: stop a pool whose phase has outlived its
 * deadline plus the one-minute grace.
 *
 * This is the **single kill authority** in the loop. It runs in the ping
 * process, so it still works when the pool's event loop is blocked and no
 * in-process timer can fire. The pure decision (`wedgeKillAction`) owns the
 * thresholds and the once-per-wedge identity; this function signals, records
 * the marker and logs. A failed signal logs one `error` and leaves the marker
 * unwritten, so the next ping retries; a failed marker write costs a repeated
 * SIGTERM, never a second process.
 *
 * @param {{
 *   state?: object|null,
 *   marker?: object|null,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 *   kill?: (pid: number, signal: string) => void,
 *   saveMarker?: (marker: object) => void,
 *   log?: (line: string, meta?: object) => void,
 * }} [input]
 * @returns {{acted: boolean, action: string, signal?: string, poolPid?: number, phase?: string, ageMs?: number, reason?: string, error?: string}}
 */
export function killWedgedPool(input = {}) {
  const {
    state = null,
    marker = null,
    now = Date.now,
    isAlive = isProcessAlive,
    kill = (pid, signal) => process.kill(pid, signal),
    saveMarker = () => {},
    log = () => {},
  } = input;
  const decision = wedgeKillAction({
    ...(state !== null && typeof state === "object" ? state : {}),
    marker,
    now,
    isAlive,
  });
  if (decision.action === "none") {
    return { acted: false, action: "none", reason: decision.reason };
  }
  const signal = decision.action === "sigterm" ? "SIGTERM" : "SIGKILL";
  try {
    kill(decision.poolPid, signal);
  } catch (err) {
    log(`ping: could not stop wedged pool ${decision.poolPid} with ${signal}: ${err.message}`, {
      level: "error",
      event: "pool_killed",
    });
    return {
      acted: false,
      action: decision.action,
      signal,
      poolPid: decision.poolPid,
      error: err.message,
    };
  }
  try {
    saveMarker(decision.marker);
  } catch (err) {
    log(`ping: could not record the wedge for pid ${decision.poolPid}: ${err.message}`, {
      level: "error",
      event: "pool_killed",
    });
  }
  log(
    decision.action === "sigterm"
      ? `ping: pool pid ${decision.poolPid} is wedged (${decision.reason}) — ` +
          "sent SIGTERM; the service manager restarts it"
      : `ping: pool pid ${decision.poolPid} survived SIGTERM (${decision.reason}) — sent SIGKILL`,
    { level: "error", event: "pool_killed", phase: decision.phase, age_ms: decision.ageMs },
  );
  return {
    acted: true,
    action: decision.action,
    signal,
    poolPid: decision.poolPid,
    phase: decision.phase,
    ageMs: decision.ageMs,
  };
}

/**
 * One ping pass: drop registry entries whose worker pid is gone.
 *
 * Ping reads and writes one small file — no board read, no claim, no LLM. A
 * reused pid is not distinguishable portably, so liveness is all it checks.
 *
 * @param {{
 *   registry?: object,
 *   isAlive?: (pid: number) => boolean,
 *   save?: (registry: object) => void,
 *   dryRun?: boolean,
 *   log?: (line: string) => void,
 * }} [input]
 * @returns {{pruned: number, live: number, saved: boolean}}
 */
export function runPingTick(input = {}) {
  const {
    registry = { version: 1, running: {} },
    isAlive = isProcessAlive,
    save = () => {},
    dryRun = false,
    log = () => {},
  } = input;
  const before = registry?.running && typeof registry.running === "object" ? registry.running : {};
  const next = pruneRegistry({ version: registry?.version ?? 1, ...registry, running: before }, isAlive);
  const pruned = Object.keys(before).filter((identifier) => !(identifier in next.running));
  const live = Object.keys(next.running).length;

  if (dryRun) {
    for (const identifier of pruned) {
      log(`ping: would prune ${identifier} (pid ${before[identifier]?.pid} not alive)`);
    }
    log(`ping: would keep ${live} of ${Object.keys(before).length} entry(s)`);
    return { pruned: pruned.length, live, saved: false };
  }
  if (pruned.length === 0) {
    log(`ping: ${live} live, no write`);
    return { pruned: 0, live, saved: false };
  }
  save(next);
  for (const identifier of pruned) {
    log(`ping: pruned ${identifier} (pid ${before[identifier]?.pid} not alive)`);
  }
  log(`ping: ${live} live, ${pruned.length} pruned`);
  return { pruned: pruned.length, live, saved: true };
}

// ---------------------------------------------------------------------------
// The tick's lock
// ---------------------------------------------------------------------------

/** The continue lock's contents, or `null` when absent/unreadable. */
export function loadContinueLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing, empty or half-written — treated as "not yet readable".
  }
  return null;
}

function lockAgeMs(path, now) {
  try {
    return Math.max(0, now() - statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Take the continue lock atomically (`wx`, so two units cannot both start a
 * turn). The caller later rewrites it with the child's pid. A lock is
 * reclaimable when its pid is gone, when it outlived `maxAgeMs`, or when it is
 * an unreadable file older than a minute.
 *
 * @param {string} path
 * @param {{isAlive?: (pid:number)=>boolean, now?: ()=>number, maxAgeMs?: number}} [options]
 * @returns {{acquired: boolean, holder: object|null, reason?: string}}
 */
/** The owners this process holds, so a rewritten pid is still released by us. */
const continueLockTokens = new Map();

export function acquireContinueLock(path, options = {}) {
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 0;

  const claim = () => {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx");
    const holder = {
      version: 1,
      pid: process.pid,
      pidStart: processStartToken(process.pid),
      token: randomUUID(),
      startedAt: new Date(now()).toISOString(),
    };
    writeFileSync(fd, `${JSON.stringify(holder, null, 2)}\n`);
    closeSync(fd);
    return holder;
  };

  const take = () => {
    const holder = claim();
    continueLockTokens.set(path, holder.token);
    return holder;
  };

  try {
    return { acquired: true, holder: take() };
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  const existing = loadContinueLock(path);
  if (existing === null) {
    const age = lockAgeMs(path, now);
    if (age !== null && age < 60_000) return { acquired: false, holder: null, reason: "starting" };
    try {
      unlinkSync(path);
      return { acquired: true, holder: take() };
    } catch {
      return { acquired: false, holder: null, reason: "raced" };
    }
  }

  const started = Date.parse(String(existing.startedAt ?? ""));
  const elapsed = Number.isFinite(started) ? now() - started : null;
  const alive = pidMatches(existing.pid, existing.pidStart, { isAlive });
  const tooOld = maxAgeMs > 0 && (elapsed === null || elapsed >= maxAgeMs);
  if (alive && !tooOld) return { acquired: false, holder: existing, reason: "running" };

  try {
    unlinkSync(path);
    return { acquired: true, holder: take() };
  } catch {
    return { acquired: false, holder: existing, reason: "raced" };
  }
}

/** Rewrite the lock with the running turn's pid, atomically. */
export function recordContinuePid(path, pid, startedAt, token = null) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const existing = loadContinueLock(path);
  const holder = { version: 1, pid, pidStart: processStartToken(pid), startedAt };
  // The owner token survives the pid rewrite, so the acquiring process can
  // still prove it is the holder when it releases.
  const owner = token ?? existing?.token ?? null;
  if (owner !== null) holder.token = owner;
  writeFileSync(tmp, `${JSON.stringify(holder, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Drop the lock after a failed spawn or a finished tick.
 *
 * Release is owner-checked: a slow ex-holder whose lock was reclaimed by the
 * next tick must not delete the new holder's file. Without a token the pid is
 * the ownership proof (the common case); a rewritten child pid is released by
 * passing it explicitly.
 *
 * @param {string} path
 * @param {{token?: string, pid?: number}} [options]
 * @returns {{released: boolean, holder?: object|null, foreign?: boolean}}
 */
export function releaseContinueLock(path, options = {}) {
  const holder = loadContinueLock(path);
  // An explicit token wins; otherwise the token this process acquired (which
  // survives `recordContinuePid`'s pid rewrite) is the proof.
  const token =
    typeof options.token === "string"
      ? options.token
      : continueLockTokens.get(path) ?? null;
  if (holder !== null) {
    const heldPid = Number(holder.pid);
    const owned =
      token !== null
        ? holder.token === token
        : heldPid === process.pid ||
          (Number.isInteger(options.pid) && heldPid === Number(options.pid));
    if (!owned) {
      continueLockTokens.delete(path);
      return { released: false, holder, foreign: true };
    }
  }
  continueLockTokens.delete(path);
  try {
    unlinkSync(path);
    return { released: true, holder };
  } catch {
    // Already gone is success.
    return { released: true, holder };
  }
}
