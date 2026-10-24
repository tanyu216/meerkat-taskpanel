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
import {
  appendFileSync,
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

import { EVENT_STREAM_LINE } from "../../src/foundation/constants.mjs";
import { pruneRegistry } from "../../src/foundation/scheduling.mjs";
import { emptySlaLedger } from "../../src/foundation/sla-patrol.mjs";

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
  const env = { ...process.env };
  if (opts.token) env.TASKD_TOKEN = opts.token;
  return { argv, env };
}

export function runCli(opts, agent, args, { input = null, actorKind = null } = {}) {
  const { argv, env } = cliInvocation(opts, agent, args, { actorKind });
  const run = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    input,
    env,
  });
  if (run.error) return { ok: false, error: run.error.message };
  try {
    const parsed = JSON.parse(run.stdout ?? "");
    return parsed?.ok === true ? { ok: true, data: parsed.data ?? {} } : { ok: false, error: parsed?.error?.message ?? `exit ${run.status}` };
  } catch {
    return { ok: false, error: (run.stderr ?? "").trim() || `exit ${run.status}` };
  }
}

/**
 * Run a streaming `taskctl` command (`events tail`) and consume its NDJSON.
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
export function openAppendFd(path) {
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
 * Logging must never take the loop down, so a failed append is swallowed.
 *
 * @param {{log: string, dryRun?: boolean}} opts
 * @returns {(line: string) => void}
 */
export function createLogger(opts) {
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`supervisor: ${line}\n`);
    if (!opts.dryRun) {
      try {
        mkdirSync(dirname(opts.log), { recursive: true });
        appendFileSync(opts.log, `${stamped}\n`);
      } catch {
        // A full disk must not stop the tick.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Ping — the liveness clock
// ---------------------------------------------------------------------------

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
// The continue turn's lock
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
export function acquireContinueLock(path, options = {}) {
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 0;

  const claim = () => {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx");
    const holder = { version: 1, pid: process.pid, startedAt: new Date(now()).toISOString() };
    writeFileSync(fd, `${JSON.stringify(holder, null, 2)}\n`);
    closeSync(fd);
    return holder;
  };

  try {
    return { acquired: true, holder: claim() };
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  const existing = loadContinueLock(path);
  if (existing === null) {
    const age = lockAgeMs(path, now);
    if (age !== null && age < 60_000) return { acquired: false, holder: null, reason: "starting" };
    try {
      unlinkSync(path);
      return { acquired: true, holder: claim() };
    } catch {
      return { acquired: false, holder: null, reason: "raced" };
    }
  }

  const started = Date.parse(String(existing.startedAt ?? ""));
  const elapsed = Number.isFinite(started) ? now() - started : null;
  const alive = Number.isInteger(existing.pid) && isAlive(existing.pid);
  const tooOld = maxAgeMs > 0 && (elapsed === null || elapsed >= maxAgeMs);
  if (alive && !tooOld) return { acquired: false, holder: existing, reason: "running" };

  try {
    unlinkSync(path);
    return { acquired: true, holder: claim() };
  } catch {
    return { acquired: false, holder: existing, reason: "raced" };
  }
}

/** Rewrite the lock with the running turn's pid, atomically. */
export function recordContinuePid(path, pid, startedAt) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, pid, startedAt }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Drop the lock after a failed spawn. */
export function releaseContinueLock(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone is success.
  }
}
