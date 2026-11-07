/**
 * One-time relocation of the loop state directory.
 *
 * The loop's state used to live at `<home>/<agent-dir>/meerkat-taskpanel`; it now
 * lives at `<config root>/loop`. The move is deliberately conservative:
 *
 *   * only a **quiescent** source is moved. A live pool, subscriber, continue
 *     tick or queue lock refuses the move — a running process writes by path and
 *     would recreate the old directory after the rename;
 *   * stale pid/lock artifacts are **not** copied (`supervisor.session.json`,
 *     `subscribe.state.json`, `*.lock`, `continue.state.json`): `loop status
 *     --stop` signals the pid it reads, and a recycled pid must not be signalled;
 *   * the source directory is renamed to `<legacy>.migrated-<timestamp>`, never
 *     deleted, so an operator can roll back;
 *   * a partial copy is staged in `<to>.tmp-<pid>` and renamed only after the
 *     copy succeeds.
 *
 * Node builtins only. The installer imports this module; the pool reads the
 * `legacy-loop-ids.json` marker it writes and closes the old loop's board rows.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { pidAlive, pidMatches } from "../../../src/foundation/daemon-state.mjs";
import { QUEUE_FILES, STATE_FILES } from "../../../src/foundation/loop-state.mjs";
import { hasLoopState } from "../../../src/foundation/state-dir.mjs";

/** Files that are loop state, not logs or stale liveness artifacts. */
const SUBSTANTIVE = Object.freeze([
  STATE_FILES.supervisor,
  QUEUE_FILES.cards,
  QUEUE_FILES.sessions,
  QUEUE_FILES.ledger,
  QUEUE_FILES.workspaces,
  STATE_FILES.continueState,
  STATE_FILES.deferrals,
  STATE_FILES.slaLedger,
  STATE_FILES.workflowLedger,
]);

/** Files that must never be copied: a recycled pid would be a signal hazard. */
const STALE = Object.freeze([
  STATE_FILES.log,
  STATE_FILES.sessionRecord,
  STATE_FILES.subscribe,
  STATE_FILES.sessionLock,
  STATE_FILES.runLock,
  STATE_FILES.continueState,
  `${QUEUE_FILES.cards}.lock`,
]);

/** @param {string} name */
function isLog(name) {
  return name === STATE_FILES.log || name.startsWith(`${STATE_FILES.log}.`);
}

/** @param {string} name */
function isStale(name) {
  return STALE.includes(name) || isLog(name);
}

/**
 * Whether a directory holds substantive loop state (a log alone does not count).
 * @param {string} dir
 * @returns {boolean}
 */
export function hasLegacyState(dir) {
  if (typeof dir !== "string" || !existsSync(dir)) return false;
  return SUBSTANTIVE.some((name) => existsSync(join(dir, name)));
}

/**
 * Pick the one legacy directory to migrate.
 *
 * The state is board-level now, so an old install may have left a directory
 * under any actor kind. Exactly one directory with substantive state is the
 * answer; two is an ambiguity the operator must resolve, never a merge (a merged
 * queue would duplicate dispatches and the ledger would double-count).
 *
 * @param {{
 *   candidates: Array<{kind: string, dir: string}>,
 *   loadedKinds?: string[],
 *   explicitDir?: string|null,
 *   hasState?: (dir: string) => boolean,
 * }} input
 * @returns {{ok: true, dir: string|null, kind: string|null} | {ok: false, reason: string, candidates: string[]}}
 */
export function selectLegacySource(input = {}) {
  const hasState = input.hasState ?? hasLegacyState;
  if (typeof input.explicitDir === "string" && input.explicitDir !== "") {
    const dir = resolve(input.explicitDir);
    return hasState(dir)
      ? { ok: true, dir, kind: null }
      : { ok: false, reason: `no loop state at ${dir}`, candidates: [] };
  }

  const candidates = (input.candidates ?? [])
    .filter((entry) => typeof entry?.dir === "string" && hasState(entry.dir))
    .map((entry) => ({ kind: String(entry.kind ?? ""), dir: resolve(entry.dir) }));
  if (candidates.length === 0) return { ok: true, dir: null, kind: null };
  if (candidates.length === 1) return { ok: true, ...candidates[0] };

  // A loaded unit names its own directory: that is the live loop, not a leftover.
  const loaded = new Set(input.loadedKinds ?? []);
  const live = candidates.filter((entry) => loaded.has(entry.kind));
  if (live.length === 1) return { ok: true, ...live[0] };

  return {
    ok: false,
    reason:
      `several loop state directories exist (${candidates.map((entry) => entry.dir).join(", ")}); ` +
      "keep the one that belongs to this board and archive the others, then re-run " +
      "install.sh --supervisor=enable",
    candidates: candidates.map((entry) => entry.dir),
  };
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {number|null} */
function pidOf(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/**
 * Why the source directory is not safe to move, if it is not.
 *
 * A missing pid or lock is not stale: an unknown holder is treated as absent,
 * because a crash leaves the files behind and the migration is the recovery.
 *
 * @param {string} dir
 * @param {{isAlive?: (pid: number) => boolean}} [options]
 * @returns {string[]} one reason per live holder
 */
export function liveHolders(dir, options = {}) {
  const isAlive = options.isAlive ?? pidAlive;
  const reasons = [];
  const sessions = readJson(join(dir, QUEUE_FILES.sessions));
  const poolPid = pidOf(sessions?.poolPid);
  if (poolPid !== null && pidMatches(poolPid, sessions?.poolPidStart ?? null, { isAlive })) {
    reasons.push(`pool pid ${poolPid} is alive`);
  }
  const subscribe = readJson(join(dir, STATE_FILES.subscribe));
  const subscribePid = pidOf(subscribe?.pid);
  if (subscribePid !== null && isAlive(subscribePid)) reasons.push(`subscriber pid ${subscribePid} is alive`);
  for (const [name, label] of [
    [STATE_FILES.sessionLock, "session lock"],
    [`${QUEUE_FILES.cards}.lock`, "queue lock"],
    [STATE_FILES.runLock, "run lock"],
  ]) {
    const record = readJson(join(dir, name));
    const pid = pidOf(record?.pid);
    if (pid !== null && pidMatches(pid, record?.pidStart ?? null, { isAlive })) {
      reasons.push(`${label} is held by pid ${pid}`);
    }
  }
  const cont = readJson(join(dir, STATE_FILES.continueState));
  const contPid = pidOf(cont?.pid);
  if (contPid !== null && isAlive(contPid)) reasons.push(`continue tick pid ${contPid} is alive`);
  return reasons;
}

/** @param {string} from @param {string} to @param {string} name */
function copyEntry(from, to, name) {
  const source = join(from, name);
  const dest = join(to, name);
  const info = lstatSync(source);
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to migrate symlink ${source}`);
  }
  if (info.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const child of readdirSync(source)) {
      if (isStale(child)) continue;
      copyEntry(source, dest, child);
    }
    return;
  }
  if (!info.isFile()) return;
  copyFileSync(source, dest);
  chmodSync(dest, 0o600);
}

/**
 * Sanitize a moved `sessions.state.json`: keep the durable worker records,
 * forget the dead pool's liveness facts.
 *
 * @param {string} file
 */
function sanitizeSessions(file) {
  if (!existsSync(file)) return;
  const value = readJson(file);
  if (value === null || typeof value !== "object") return;
  for (const key of [
    "poolPid",
    "poolPidStart",
    "phase",
    "heartbeatAt",
    "tickStartedAt",
    "startStartedAt",
    "lastTickOkAt",
    "tickTimeoutMs",
  ]) {
    delete value[key];
  }
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Move one legacy state directory to the new location.
 *
 * @param {{from: string, to: string, dryRun?: boolean, now?: () => number, log?: (line: string) => void, isAlive?: (pid: number) => boolean}} input
 * @returns {{ok: boolean, moved: boolean, reason: string|null, backup: string|null}}
 */
export function migrateLoopState(input) {
  const from = resolve(input.from);
  const to = resolve(input.to);
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;

  if (from === to) return { ok: true, moved: false, reason: "source and target are the same", backup: null };
  if (!hasLegacyState(from)) return { ok: true, moved: false, reason: "no legacy loop state", backup: null };
  if (from.startsWith(`${to}${"/"}`) || to.startsWith(`${from}${"/"}`)) {
    return { ok: false, moved: false, reason: "source and target are nested", backup: null };
  }
  const live = liveHolders(from, { isAlive: input.isAlive });
  if (live.length > 0) {
    return { ok: false, moved: false, reason: `not quiescent: ${live.join("; ")}`, backup: null };
  }
  // An existing target with state is a conflict; an empty one (a partial
  // install) is treated as absent and replaced.
  if (hasLoopState(to) && to !== from) {
    return { ok: false, moved: false, reason: `target already holds loop state: ${to}`, backup: null };
  }

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const backup = `${from}.migrated-${stamp}`;
  const tmp = `${to}.tmp-${process.pid}`;

  if (input.dryRun === true) {
    log(`relocate-state: would move ${from} -> ${to} (backup ${backup})`);
    return { ok: true, moved: false, reason: "dry-run", backup };
  }

  try {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(to)) {
      // Only an empty target is safe to replace; its existence was checked above
      // for state, so this removes the freshly-created empty directory.
      rmSync(to, { recursive: true, force: true });
    }
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(from)) {
      if (isStale(name)) continue;
      copyEntry(from, tmp, name);
    }
    sanitizeSessions(join(tmp, QUEUE_FILES.sessions));
    const idFile = join(tmp, STATE_FILES.loopId);
    if (!existsSync(idFile)) writeFileSync(idFile, `${randomUUID()}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, to);
    // Keep the old directory as a rollback copy; the source path disappears only
    // after the copy is committed.
    renameSync(from, backup);
    log(`relocate-state: moved ${from} -> ${to}; backup at ${backup}`);
    return { ok: true, moved: true, reason: null, backup };
  } catch (error) {
    // Leave the staged copy and the source for the operator; never delete the
    // only copy on a partial failure.
    log(`relocate-state: failed — ${error.message}`);
    return { ok: false, moved: false, reason: error.message, backup: null };
  }
}

/**
 * Write the old loop ids into the new state directory so the pool's first
 * reconcile can close their `running` board rows, then drop the marker.
 *
 * @param {string[]} dirs
 * @param {string} stateDir
 */
export function recordLegacyLoopIds(dirs, stateDir) {
  const ids = [...new Set(dirs.filter((dir) => typeof dir === "string" && dir !== ""))];
  if (ids.length === 0) return;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, STATE_FILES.legacyLoopIds), `${JSON.stringify(ids, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
