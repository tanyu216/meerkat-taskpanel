/**
 * The loop's durable work queues.
 *
 * Two kinds of work travel through the scheduler:
 *
 *   * **continue** — the board-wide judgment turn. It is *coalesced*: a request
 *     that arrives while one is already pending replaces it, because the next
 *     turn rebuilds the same prompt from current state.
 *   * **card** — one claimed card's handoff for a lane session. These are
 *     *not* coalesced: every card is a distinct unit of work, and a retry must
 *     not silently swallow a second card.
 *
 * All writes are atomic (temp file + rename), so a crash leaves either the old
 * file or the new one, never a half-written queue. Reads are fail-soft: a
 * missing or corrupt queue is an empty queue, and the caller logs the reason.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquireFileLock, releaseFileLock } from "../foundation/file-lock.mjs";

// The names live in the shared foundation module now; re-exported because this
// module was their first home and the loop tests import them from here.
export { QUEUE_FILES } from "../foundation/loop-state.mjs";
import { LIVE_STATUSES, QUEUE_FILES } from "../foundation/loop-state.mjs";

/** A card handoff's terminal failure threshold. */
const DEFAULT_CARD_MAX_ATTEMPTS = 3;
/**
 * How many crash recoveries one worker row survives before it is stopped.
 *
 * A crash is not a delivery attempt, so it has its own counter; three in a row
 * means the same session cannot be restored and replaying it is the loop.
 */
const DEFAULT_RECOVERY_MAX = 3;

/**
 * Rows that are history, not work. A row's id is deterministic (`<card>-<role>`),
 * so once an old row is terminal a new handoff for the same card carries the
 * *same* id (`enqueueCard`). Every mutator must therefore skip terminal rows, or
 * one requeue inflates — and can resurrect — the retained history.
 */
const TERMINAL_CARD_STATUSES = new Set(["done", "failed"]);
const isTerminalCard = (entry) => TERMINAL_CARD_STATUSES.has(String(entry?.status ?? ""));

/**
 * @param {string} stateDir
 * @returns {{cards: string, ledger: string, sessions: string}}
 */
function queuePaths(stateDir) {
  const dir = String(stateDir);
  return {
    cards: join(dir, QUEUE_FILES.cards),
    ledger: join(dir, QUEUE_FILES.ledger),
    sessions: join(dir, QUEUE_FILES.sessions),
    workspaces: join(dir, QUEUE_FILES.workspaces),
  };
}

/** @param {string} dir */
export function ensureStateDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON state file, or `null` when it is missing or unreadable. A corrupt
 * file is reported through `status` so a caller can log it without throwing.
 *
 * @param {string} file
 * @param {*} [fallback]
 * @returns {{value: *, error: string|null}}
 */
export function readJsonFile(file, fallback = null) {
  try {
    if (!existsSync(file)) return { value: fallback, error: null };
    return { value: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (err) {
    return { value: fallback, error: `${file}: ${err.message}` };
  }
}

/**
 * Atomically replace `file` with `value`. The temp name carries the pid so two
 * writers cannot collide; the rename is the commit point.
 *
 * @param {string} file
 * @param {*} value
 * @returns {{ok: boolean, error: string|null}}
 */
export function writeJsonFile(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A stale temp file must not hide the real write error.
    }
    return { ok: false, error: `${file}: ${err.message}` };
  }
}

/** @param {string} stateDir */
export function readCards(stateDir) {
  const read = readJsonFile(queuePaths(stateDir).cards, { version: 1, cards: [] });
  if (read.error !== null) return { value: { version: 1, cards: [] }, error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : { version: 1, cards: [] };
  if (!Array.isArray(value.cards)) value.cards = [];
  return { value, error: null };
}

/** @param {string} stateDir @param {{version: number, cards: object[]}} value */
function writeCards(stateDir, value) {
  return writeJsonFile(queuePaths(stateDir).cards, value);
}

/** The interprocess lock beside the cards queue. */
function cardsLockPath(stateDir) {
  return `${queuePaths(stateDir).cards}.lock`;
}

/**
 * Run one queue mutation under the interprocess lock.
 *
 * The tick process enqueues while the pool process claims, requeues and
 * completes; the file write is atomic but the read-modify-write is not. A lock
 * that cannot be taken returns the caller's own "could not mutate" shape, so a
 * tick retries next pass instead of writing a lost update. Re-entry nests (see
 * `file-lock.mjs`), so a mutator may call another mutator.
 *
 * @template T
 * @param {string} stateDir
 * @param {T} busy the caller's failure value (its `error` is filled in)
 * @param {() => T} fn
 * @returns {T}
 */
function locked(stateDir, busy, fn) {
  const path = cardsLockPath(stateDir);
  const lock = acquireFileLock(path);
  if (!lock.acquired) {
    return { ...busy, error: `cards.queue is locked by another loop process (${lock.reason ?? "busy"})` };
  }
  try {
    return fn();
  } finally {
    releaseFileLock(path, lock.token);
  }
}

/** A card's dedupe key: one handoff per (card, role). */
function cardKey(card) {
  // The question lane is keyed by the question, not by the card: one card may
  // ask twice, and each question deserves its own answer.
  if (String(card?.queue_kind ?? "") === "question") {
    return `q\u0000${String(card.card ?? "")}\u0000${String(card.question_id ?? "")}`;
  }
  return `${String(card.card ?? card.id ?? "")}\u0000${String(card.role ?? "worker")}`;
}

/** A row's delivery round; older rows may only carry `delivery_round`. */
function rowRound(row) {
  const value = Number(row?.round ?? row?.delivery_round ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The canonical shape of one queue row. */
function normaliseRow(row, id = undefined) {
  return {
    version: 1,
    ...row,
    id: id ?? row.id ?? `${row.card}-${row.role ?? "worker"}`,
    queue_kind: row.queue_kind ?? "handoff",
    role: row.role ?? "worker",
    // The board identity selected for this handoff (Jobs/Linus/Turing). It is
    // additive metadata: the dedupe key stays (card, role).
    agent_role: row.agent_role ?? null,
    // The platform carrying the role this row dispatches to. Session keys are
    // (actor_kind, …): two kinds in one pool must never collide, and a role
    // migrated to another kind must never resume the old kind's native session.
    actor_kind: row.actor_kind ?? null,
    // Every handoff row names its own card session, review or worker.
    worker_key: row.worker_key ?? null,
    // The subscriber maps an event's UUID back to this row; keep the shape
    // stable even for a legacy caller that knows no UUID.
    task_id: row.task_id ?? null,
    review_of: row.review_of ?? null,
    review_round: row.review_round ?? null,
    status: "pending",
    enqueuedAt: row.enqueuedAt ?? new Date().toISOString(),
    claimedAt: null,
    claimedBy: null,
    claimedByPid: null,
    attempts: Number(row.attempts ?? 0),
    // Crash recoveries are not delivery attempts: a crash is not a failure, but
    // a card that crashes three times in a row is a loop and is stopped.
    recoveries: Number(row.recoveries ?? 0),
    // The attempt bound's key. A question row keys on its question id, a route
    // row on the row id; `question_id` is kept as the legacy spelling.
    dispatch_key: row.dispatch_key ?? row.question_id ?? null,
    lastError: null,
  };
}

/**
 * Add one card handoff. A pending/processing entry for the same (card, role,
 * round, target) is idempotent. A **different round or worktree** supersedes a
 * pending row in place; a processing row is left alone and reported as
 * `superseded` so the caller can retry after the in-flight turn.
 *
 * @param {string} stateDir
 * @param {{card: string, role?: string, round?: number, target_dir?: string, [key: string]: unknown}} card
 * @returns {{ok: boolean, coalesced: boolean, replaced?: boolean, superseded?: boolean, error: string|null}}
 */
export function enqueueCard(stateDir, card) {
  return locked(
    stateDir,
    { ok: false, coalesced: false, replaced: false, superseded: false, error: null },
    () => enqueueCardUnlocked(stateDir, card),
  );
}

function enqueueCardUnlocked(stateDir, card) {
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, coalesced: false, error: read.error };
  const value = read.value;
  const key = cardKey(card);
  const existing = value.cards.find(
    (entry) => cardKey(entry) === key && (entry.status === "pending" || entry.status === "processing"),
  );
  if (existing !== undefined) {
    const sameRound = rowRound(existing) === rowRound(card);
    const sameTarget = String(existing.target_dir ?? "") === String(card.target_dir ?? "");
    if (sameRound && sameTarget) {
      return { ok: true, coalesced: true, replaced: false, superseded: false, error: null };
    }
    if (existing.status === "processing") {
      return { ok: true, coalesced: true, replaced: false, superseded: true, error: null };
    }
    // A pending row for an older round/tree is superseded in place: one row per
    // (card, role), so the round bump cannot be swallowed by the coalescer.
    const index = value.cards.indexOf(existing);
    value.cards[index] = {
      ...normaliseRow(card, existing.id),
      attempts: 0,
      lastError: `superseded by round ${rowRound(card)}`,
    };
    const written = writeCards(stateDir, value);
    return { ok: written.ok, coalesced: false, replaced: true, superseded: false, error: written.error };
  }
  // A queue row's discriminator is `queue_kind` (`handoff`|`question`). The
  // card's board `kind` (`task`|`epic`) is never copied onto a row: the two
  // vocabularies must not be confused, and a caller that passes a candidate
  // projection would otherwise smuggle one in.
  const { kind: _boardKind, ...row } = card ?? {};
  value.cards.push(normaliseRow(row));
  const written = writeCards(stateDir, value);
  return { ok: written.ok, coalesced: false, replaced: false, superseded: false, error: written.error };
}

/**
 * Re-own processing rows after a restart. The previous pool's pid is dead, so
 * `recoverStaleCards` would requeue these; the worker recovery path takes them
 * first and keeps the same row/id for the resume.
 *
 * @param {string} stateDir
 * @param {string[]} ids
 * @param {{claimedBy?: string, claimedByPid?: number, now?: string}} [options]
 * @returns {{ok: boolean, cards: object[], error: string|null}}
 */
export function reownCards(stateDir, ids, options = {}) {
  return locked(stateDir, { ok: false, cards: [], error: null }, () =>
    reownCardsUnlocked(stateDir, ids, options),
  );
}

function reownCardsUnlocked(stateDir, ids, options = {}) {
  const wanted = new Set((ids ?? []).map(String));
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, cards: [], error: read.error };
  const value = read.value;
  const now = options.now ?? new Date().toISOString();
  const owned = [];
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (entry.status !== "processing") continue;
    entry.claimedBy = String(options.claimedBy ?? entry.claimedBy ?? "unknown");
    entry.claimedByPid = Number.isInteger(options.claimedByPid)
      ? options.claimedByPid
      : entry.claimedByPid ?? null;
    entry.claimedAt = now;
    owned.push(entry);
  }
  if (owned.length === 0) return { ok: true, cards: [], error: null };
  const written = writeCards(stateDir, value);
  return { ok: written.ok, cards: written.ok ? owned : [], error: written.error };
}

/**
 * Return processing rows to pending **without** counting a delivery attempt.
 * Worker recovery uses this: a crash is not a failure, and the next tick
 * resumes the stored session. Crashes have their own counter — after
 * `maxRecoveries` (3) the row is failed and returned in `failedIds`, so a card
 * that crashes every time cannot replay forever.
 *
 * @param {string} stateDir
 * @param {string[]} ids
 * @param {{error?: string|null, maxRecoveries?: number}} [options]
 * @returns {{ok: boolean, resumed: number, failed: number, failedIds: string[], error: string|null}}
 */
export function resumeCards(stateDir, ids, options = {}) {
  return locked(stateDir, { ok: false, resumed: 0, failed: 0, failedIds: [], error: null }, () =>
    resumeCardsUnlocked(stateDir, ids, options),
  );
}

function resumeCardsUnlocked(stateDir, ids, options = {}) {
  const wanted = new Set((ids ?? []).map(String));
  const maxRecoveries = Number(options.maxRecoveries ?? DEFAULT_RECOVERY_MAX);
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, resumed: 0, failed: 0, failedIds: [], error: read.error };
  const value = read.value;
  let resumed = 0;
  let failed = 0;
  const failedIds = [];
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (entry.status !== "processing") continue;
    const recoveries = Number(entry.recoveries ?? 0) + 1;
    entry.recoveries = recoveries;
    entry.claimedAt = null;
    entry.claimedBy = null;
    entry.claimedByPid = null;
    entry.lastError = options.error ?? null;
    if (recoveries >= maxRecoveries) {
      // A crash is not a delivery failure, but a card that crashes this many
      // times is a loop: stop replaying it and let the caller hold the card.
      entry.status = "failed";
      entry.lastError = `worker session recovery exhausted after ${recoveries} tries`;
      failed += 1;
      failedIds.push(String(entry.id));
    } else {
      entry.status = "pending";
      resumed += 1;
    }
  }
  if (resumed === 0 && failed === 0) {
    return { ok: true, resumed: 0, failed: 0, failedIds: [], error: null };
  }
  const written = writeCards(stateDir, value);
  return {
    ok: written.ok,
    resumed: written.ok ? resumed : 0,
    failed: written.ok ? failed : 0,
    failedIds: written.ok ? failedIds : [],
    error: written.error,
  };
}

/**
 * Claim up to `limit` pending handoffs for one lane session.
 *
 * `ids` scopes the claim to one directory's (or lane's) rows. The pool groups
 * pending handoffs before claiming, so a first-come-first-served scan would let
 * one group claim another directory's rows. `queueKind` separates handoffs from
 * the question lane (`queue_kind` absent means `handoff`).
 *
 * @param {string} stateDir
 * @param {{claimedBy: string, pid?: number, limit?: number, now?: string, ids?: string[], queueKind?: string}} options
 * @returns {{ok: boolean, cards: object[], error: string|null}}
 */
export function claimCards(stateDir, options = {}) {
  return locked(stateDir, { ok: false, cards: [], error: null }, () =>
    claimCardsUnlocked(stateDir, options),
  );
}

function claimCardsUnlocked(stateDir, options = {}) {
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, cards: [], error: read.error };
  const value = read.value;
  const limit = Math.max(0, Number(options.limit ?? 1));
  const claimedBy = String(options.claimedBy ?? "unknown");
  const now = options.now ?? new Date().toISOString();
  const wanted = Array.isArray(options.ids) ? new Set(options.ids.map(String)) : null;
  const queueKind = options.queueKind === undefined ? null : String(options.queueKind);
  const claimed = [];
  for (const entry of value.cards) {
    if (claimed.length >= limit) break;
    if (entry.status !== "pending") continue;
    if (wanted !== null && !wanted.has(String(entry.id))) continue;
    if (queueKind !== null && String(entry.queue_kind ?? "handoff") !== queueKind) continue;
    entry.status = "processing";
    entry.claimedBy = claimedBy;
    entry.claimedByPid = Number.isInteger(options.pid) ? options.pid : null;
    entry.claimedAt = now;
    claimed.push(entry);
  }
  if (claimed.length === 0) return { ok: true, cards: [], error: null };
  const written = writeCards(stateDir, value);
  return { ok: written.ok, cards: written.ok ? claimed : [], error: written.error };
}

/**
 * How many director turns a question id has used, in any status.
 *
 * The retry bound counts **attempts**, not open rows: one row can be requeued
 * for a retry turn, and a completed-then-re-enqueued row is a second dispatch.
 * A row that never went through `requeueCards` is still one dispatch, hence
 * `max(1, attempts)`.
 *
 * @param {string} stateDir
 * @param {string} questionId
 * @returns {number}
 */
export function questionDispatches(stateDir, questionId) {
  return rowDispatches(stateDir, questionId);
}

/**
 * How many director turns one dispatch key has used, in any status.
 *
 * The director lane has two row kinds — a worker's `question` and an unowned
 * card's `route` — and both need the same per-key attempt bound. The key is
 * `dispatch_key`; the older `question_id` spelling is still read so a queue
 * written by an earlier release does not restart its count.
 *
 * @param {string} stateDir
 * @param {string} key
 * @returns {number}
 */
export function rowDispatches(stateDir, key) {
  const read = readCards(stateDir);
  if (read.error !== null) return 0;
  let used = 0;
  for (const card of read.value.cards) {
    if (String(card.queue_kind ?? "") !== "question") continue;
    const rowKey = String(card.dispatch_key ?? card.question_id ?? "");
    if (rowKey !== String(key ?? "")) continue;
    used += Math.max(1, Number(card.attempts ?? 0));
  }
  return used;
}

/**
 * Convert rows left in the retired `dispatched` state to `done`.
 *
 * Background dispatch promised a per-subagent completion event no adapter
 * emits; a row left in that state is a finished handoff that would otherwise
 * sit in the work list forever. The conversion is one-way and idempotent.
 *
 * @param {string} stateDir
 * @returns {{ok: boolean, retired: number, error: string|null}}
 */
export function retireLegacyDispatched(stateDir) {
  return locked(stateDir, { ok: false, retired: 0, error: null }, () =>
    retireLegacyDispatchedUnlocked(stateDir),
  );
}

function retireLegacyDispatchedUnlocked(stateDir) {
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, retired: 0, error: read.error };
  const value = read.value;
  const now = new Date().toISOString();
  let retired = 0;
  for (const entry of value.cards) {
    if (entry.status !== "dispatched") continue;
    entry.status = "done";
    entry.lastError = "background dispatch retired";
    entry.completedAt = now;
    retired += 1;
  }
  if (retired === 0) return { ok: true, retired: 0, error: null };
  const written = writeCards(stateDir, value);
  return { ok: written.ok, retired: written.ok ? retired : 0, error: written.error };
}

/**
 * Finish claimed handoffs. `failed` entries stay visible for inspection; a
 * requeue is the caller's explicit next step.
 *
 * @param {string} stateDir
 * @param {string[]} ids
 * @param {{status?: "done"|"failed", error?: string|null}} [options]
 */
export function completeCards(stateDir, ids, options = {}) {
  return locked(stateDir, { ok: false, error: null }, () =>
    completeCardsUnlocked(stateDir, ids, options),
  );
}

function completeCardsUnlocked(stateDir, ids, options = {}) {
  const wanted = new Set(ids.map(String));
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, error: read.error };
  const value = read.value;
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (isTerminalCard(entry)) continue;
    entry.status = options.status ?? "done";
    entry.lastError = options.error ?? null;
    entry.completedAt = options.now ?? new Date().toISOString();
  }
  return writeCards(stateDir, value);
}

/** Terminal rows older than this are dropped; history lives on the board. */
const CARD_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Drop terminal card rows past their retention. The queue is a work list, not a
 * log: a `done` handoff has nothing left to dispatch, and the board's card is the
 * durable record.
 *
 * @param {string} stateDir
 * @param {{ttlMs?: number, now?: number}} [options]
 * @returns {{ok: boolean, dropped: number, error: string|null}}
 */
export function pruneCards(stateDir, options = {}) {
  return locked(stateDir, { ok: false, dropped: 0, error: null }, () =>
    pruneCardsUnlocked(stateDir, options),
  );
}

function pruneCardsUnlocked(stateDir, options = {}) {
  const ttlMs = Number(options.ttlMs ?? CARD_RETENTION_MS);
  const now = options.now ?? Date.now();
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, dropped: 0, error: read.error };
  const value = read.value;
  const kept = [];
  let dropped = 0;
  for (const entry of value.cards) {
    if (!isTerminalCard(entry)) {
      kept.push(entry);
      continue;
    }
    const at = Date.parse(String(entry.completedAt ?? entry.enqueuedAt ?? ""));
    if (Number.isFinite(at) && now - at > ttlMs) {
      dropped += 1;
      continue;
    }
    kept.push(entry);
  }
  if (dropped === 0) return { ok: true, dropped: 0, error: null };
  const written = writeCards(stateDir, { ...value, cards: kept });
  return { ok: written.ok, dropped, error: written.error };
}

/**
 * Return claimed handoffs to pending, or mark them failed past the attempt cap.
 *
 * @param {string} stateDir
 * @param {string[]} ids
 * @param {{maxAttempts?: number, error?: string|null, retryAt?: string|null}} [options]
 * @returns {{ok: boolean, requeued: number, failed: number, failedIds: string[], attempts: Record<string, number>, error: string|null}}
 */
export function requeueCards(stateDir, ids, options = {}) {
  return locked(
    stateDir,
    { ok: false, requeued: 0, failed: 0, failedIds: [], attempts: {}, error: null },
    () => requeueCardsUnlocked(stateDir, ids, options),
  );
}

function requeueCardsUnlocked(stateDir, ids, options = {}) {
  const wanted = new Set(ids.map(String));
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_CARD_MAX_ATTEMPTS);
  const read = readCards(stateDir);
  if (read.error !== null) {
    return {
      ok: false,
      requeued: 0,
      failed: 0,
      failedIds: [],
      attempts: {},
      error: read.error,
    };
  }
  const value = read.value;
  let requeued = 0;
  let failed = 0;
  const failedIds = [];
  const attemptsById = {};
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (isTerminalCard(entry)) continue;
    const attempts = Number(entry.attempts ?? 0) + 1;
    entry.attempts = attempts;
    attemptsById[String(entry.id)] = attempts;
    entry.claimedAt = null;
    entry.claimedBy = null;
    entry.lastError = options.error ?? null;
    entry.retry_at = options.retryAt ?? null;
    if (attempts >= maxAttempts) {
      entry.status = "failed";
      failed += 1;
      failedIds.push(String(entry.id));
    } else {
      entry.status = "pending";
      requeued += 1;
    }
  }
  const written = writeCards(stateDir, value);
  return {
    ok: written.ok,
    requeued,
    failed,
    failedIds: written.ok ? failedIds : [],
    attempts: written.ok ? attemptsById : {},
    error: written.error,
  };
}

/**
 * Recover handoffs whose owner is gone or whose claim is older than the bound.
 *
 * @param {string} stateDir
 * @param {{isAlive?: (pid: number) => boolean, now?: number, maxAgeMs?: number, maxAttempts?: number, isResumableWorker?: (row: object) => boolean}} [options]
 * @returns {{ok: boolean, recovered: number, failed: number, error: string|null}}
 */
export function recoverStaleCards(stateDir, options = {}) {
  return locked(stateDir, { ok: false, recovered: 0, failed: 0, error: null }, () =>
    recoverStaleCardsUnlocked(stateDir, options),
  );
}

/**
 * Directories whose agent child is still alive.
 *
 * A row's `claimedByPid` is the **pool manager** that claimed it. When the pool
 * is SIGKILLed its pid is gone, but the agent child it spawned can still be
 * working — and re-queueing that row would put a second worker on the card.
 * The session record is the durable proof: a live pid for the directory owns
 * the row, whichever process claimed it.
 *
 * @param {string} stateDir
 * @param {(pid: number) => boolean} isAlive
 * @returns {Set<string>}
 */
function liveOwnerDirs(stateDir, isAlive) {
  const live = new Set();
  const read = readJsonFile(queuePaths(stateDir).sessions, null);
  const projects =
    read.value?.projects && typeof read.value.projects === "object" ? read.value.projects : {};
  for (const [key, record] of Object.entries(projects)) {
    const pid = Number(record?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    live.add(String(key));
    if (typeof record?.cwd === "string" && record.cwd !== "") live.add(record.cwd);
    if (typeof record?.worktree === "string" && record.worktree !== "") live.add(record.worktree);
  }
  return live;
}

/**
 * Ledger rows an agent is still working. The ledger is the application-level
 * proof of in-flight subagent work; its status outlives a dead pid.
 *
 * @param {string} stateDir
 * @returns {object[]}
 */
function liveLedgerRows(stateDir) {
  const read = readJsonFile(queuePaths(stateDir).ledger, null);
  const rows = Array.isArray(read.value?.subagents) ? read.value.subagents : [];
  return rows.filter((entry) => LIVE_STATUSES.includes(String(entry?.status ?? "")));
}

/**
 * Does a ledger row own this queue row? `queueId` is the precise key; an older
 * row written before the id existed falls back to (card, role).
 */
function ledgerOwnsRow(ledgerRow, row) {
  const queueId = ledgerRow?.queueId;
  if (queueId !== undefined && queueId !== null && queueId !== "") {
    return String(queueId) === String(row.id);
  }
  return (
    typeof ledgerRow?.card === "string" &&
    ledgerRow.card === String(row.card ?? "") &&
    String(ledgerRow?.role ?? "worker") === String(row.role ?? "worker")
  );
}

function recoverStaleCardsUnlocked(stateDir, options = {}) {
  const isAlive = options.isAlive ?? (() => true);
  const now = options.now ?? Date.now();
  const maxAgeMs = Number(options.maxAgeMs ?? 2 * 60 * 60 * 1000);
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_CARD_MAX_ATTEMPTS);
  const poolPid = Number.isInteger(options.poolPid) ? options.poolPid : process.pid;
  const isResumableWorker =
    typeof options.isResumableWorker === "function" ? options.isResumableWorker : null;
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, recovered: 0, failed: 0, reowned: 0, error: read.error };
  const value = read.value;
  const liveDirs = liveOwnerDirs(stateDir, isAlive);
  const liveLedger = liveLedgerRows(stateDir);
  const stale = [];
  const orphaned = [];
  for (const entry of value.cards) {
    if (entry.status !== "processing") continue;
    // A live agent child still owns the work even when the pool that claimed it
    // is gone; re-queueing would start a second worker on the same card.
    const ownerIds = [entry.target_dir, entry.claimedBy, entry.worker_key]
      .filter((id) => typeof id === "string" && id !== "")
      .map(String);
    if (ownerIds.some((id) => liveDirs.has(id))) {
      // The ledger proves a subagent is still working this row (not merely that
      // a session process exists). Re-point the claim at this pool: the row is
      // owned by a live process again, so a later pass does not mistake the dead
      // claimant for a stale one. No queue field is added; the pids already in
      // `sessions.state.json` are the evidence.
      if (liveLedger.some((ledgerRow) => ledgerOwnsRow(ledgerRow, entry))) {
        orphaned.push(String(entry.id));
      }
      continue;
    }
    // A worker session with a durable record is recovered by `recoverWorkerSessions`,
    // which resumes the same conversation instead of putting a second worker on the card.
    if (entry.worker_key && isResumableWorker !== null && isResumableWorker(entry)) continue;
    const pid = Number(entry.claimedByPid);
    const claimedAt = Date.parse(String(entry.claimedAt ?? ""));
    const dead = Number.isInteger(pid) && pid > 0 && !isAlive(pid);
    const old = Number.isFinite(claimedAt) && now - claimedAt > maxAgeMs;
    if (dead || old) stale.push(String(entry.id));
  }
  const reowned = orphaned.length > 0
    ? reownCards(stateDir, orphaned, { claimedByPid: poolPid, now: new Date(now).toISOString() })
    : { ok: true, cards: [], error: null };
  if (stale.length === 0) {
    return {
      ok: reowned.ok,
      recovered: 0,
      failed: 0,
      reowned: reowned.cards.length,
      error: reowned.error,
    };
  }
  const result = requeueCards(stateDir, stale, { maxAttempts, error: "stale claim recovered" });
  return {
    ok: result.ok && reowned.ok,
    recovered: result.requeued,
    failed: result.failed,
    reowned: reowned.cards.length,
    error: result.error ?? reowned.error,
  };
}
