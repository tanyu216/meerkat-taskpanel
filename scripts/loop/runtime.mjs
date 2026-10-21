#!/usr/bin/env node
/**
 * The loop's host-local runtime primitives.
 *
 * These are the things a one-shot entry and the scheduler both need: the
 * process-liveness probe, the worker registry, the log, the `taskctl` shell-out,
 * the SLA ledger / liveness marker, and the continue lock. None of it decides
 * anything — the decisions live in `src/foundation/`.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
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
import { dirname } from "node:path";

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

/**
 * Run the taskctl CLI and parse its `--json` envelope. Returns `{ok, data|error}`.
 *
 * The CLI requires an identity on every call: reads and claims use the host
 * (`claude`/`codex`/`pi`), workflow writes pass `system` so an automated
 * acceptance is attributable. `--env-file` and `--url` are forwarded; the token
 * rides in the child environment, never argv.
 */
export function runCli(opts, agent, args, { input = null, actorKind = null } = {}) {
  // Identity is required on every CLI call now. The loop's host (claude/codex/pi)
  // is the platform for its agent actions; the board's own workflow pass names
  // `system` explicitly. A caller that forgot gets the host, never `human`.
  const kind = actorKind ?? opts.host ?? "system";
  const globals = [
    "--json",
    "--agent",
    agent,
    "--actor-kind",
    kind,
    ...(opts.envFile ? ["--env-file", opts.envFile] : []),
    ...(opts.url ? ["--url", opts.url] : []),
  ];
  // A token never goes on argv (it would be visible in `ps`); the child reads
  // it from its environment.
  const childEnv = { ...process.env };
  if (opts.token) childEnv.TASKD_TOKEN = opts.token;
  const run = spawnSync(process.execPath, [opts.cli, ...globals, ...args], {
    encoding: "utf8",
    input,
    env: childEnv,
  });
  if (run.error) return { ok: false, error: run.error.message };
  try {
    const parsed = JSON.parse(run.stdout ?? "");
    return parsed?.ok === true ? { ok: true, data: parsed.data ?? {} } : { ok: false, error: parsed?.error?.message ?? `exit ${run.status}` };
  } catch {
    return { ok: false, error: (run.stderr ?? "").trim() || `exit ${run.status}` };
  }
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
export function saveLastOk(path, { mechanism, at, host = null, periodSeconds = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ mechanism, last_ok: at, mechanism_host: host, cadence_period_min: periodSeconds === null ? null : periodSeconds / 60 }, null, 2)}\n`,
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
