/**
 * The loop's durable work queues.
 *
 * Two kinds of work travel through the scheduler:
 *
 *   * **continue** — the board-wide judgment turn. It is *coalesced*: a request
 *     that arrives while one is already pending replaces it, because the next
 *     turn rebuilds the same prompt from current state.
 *   * **card** — one claimed card's handoff for a project session. These are
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

// The names live in the shared foundation module now; re-exported because this
// module was their first home and the loop tests import them from here.
export { QUEUE_FILES } from "../foundation/loop-state.mjs";
import { QUEUE_FILES } from "../foundation/loop-state.mjs";

/** A card handoff's terminal failure threshold. */
const DEFAULT_CARD_MAX_ATTEMPTS = 3;

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
    // A worker row names its own session; a review row keeps the batch path.
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
 * Return processing rows to pending **without** counting an attempt. Worker
 * recovery uses this: a crash is not a delivery failure, and the next tick
 * resumes the stored session.
 *
 * @param {string} stateDir
 * @param {string[]} ids
 * @param {{error?: string|null}} [options]
 * @returns {{ok: boolean, resumed: number, error: string|null}}
 */
export function resumeCards(stateDir, ids, options = {}) {
  const wanted = new Set((ids ?? []).map(String));
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, resumed: 0, error: read.error };
  const value = read.value;
  let resumed = 0;
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (entry.status !== "processing") continue;
    entry.status = "pending";
    entry.claimedAt = null;
    entry.claimedBy = null;
    entry.claimedByPid = null;
    entry.lastError = options.error ?? null;
    resumed += 1;
  }
  if (resumed === 0) return { ok: true, resumed: 0, error: null };
  const written = writeCards(stateDir, value);
  return { ok: written.ok, resumed: written.ok ? resumed : 0, error: written.error };
}

/**
 * Claim up to `limit` pending handoffs for one project session.
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
  const read = readCards(stateDir);
  if (read.error !== null) return 0;
  let used = 0;
  for (const card of read.value.cards) {
    if (String(card.queue_kind ?? "") !== "question") continue;
    if (String(card.question_id ?? "") !== String(questionId ?? "")) continue;
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
 * @returns {{ok: boolean, requeued: number, failed: number, error: string|null}}
 */
export function requeueCards(stateDir, ids, options = {}) {
  const wanted = new Set(ids.map(String));
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_CARD_MAX_ATTEMPTS);
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, requeued: 0, failed: 0, error: read.error };
  const value = read.value;
  let requeued = 0;
  let failed = 0;
  for (const entry of value.cards) {
    if (!wanted.has(String(entry.id))) continue;
    if (isTerminalCard(entry)) continue;
    const attempts = Number(entry.attempts ?? 0) + 1;
    entry.attempts = attempts;
    entry.claimedAt = null;
    entry.claimedBy = null;
    entry.lastError = options.error ?? null;
    entry.retry_at = options.retryAt ?? null;
    if (attempts >= maxAttempts) {
      entry.status = "failed";
      failed += 1;
    } else {
      entry.status = "pending";
      requeued += 1;
    }
  }
  const written = writeCards(stateDir, value);
  return { ok: written.ok, requeued, failed, error: written.error };
}

/**
 * Recover handoffs whose owner is gone or whose claim is older than the bound.
 *
 * @param {string} stateDir
 * @param {{isAlive?: (pid: number) => boolean, now?: number, maxAgeMs?: number, maxAttempts?: number, isResumableWorker?: (row: object) => boolean}} [options]
 * @returns {{ok: boolean, recovered: number, failed: number, error: string|null}}
 */
export function recoverStaleCards(stateDir, options = {}) {
  const isAlive = options.isAlive ?? (() => true);
  const now = options.now ?? Date.now();
  const maxAgeMs = Number(options.maxAgeMs ?? 2 * 60 * 60 * 1000);
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_CARD_MAX_ATTEMPTS);
  const isResumableWorker =
    typeof options.isResumableWorker === "function" ? options.isResumableWorker : null;
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, recovered: 0, failed: 0, error: read.error };
  const value = read.value;
  const stale = [];
  for (const entry of value.cards) {
    if (entry.status !== "processing") continue;
    // A worker session with a durable record is recovered by `recoverWorkerSessions`,
    // which resumes the same conversation instead of putting a second worker on the card.
    if (entry.worker_key && isResumableWorker !== null && isResumableWorker(entry)) continue;
    const pid = Number(entry.claimedByPid);
    const claimedAt = Date.parse(String(entry.claimedAt ?? ""));
    const dead = Number.isInteger(pid) && pid > 0 && !isAlive(pid);
    const old = Number.isFinite(claimedAt) && now - claimedAt > maxAgeMs;
    if (dead || old) stale.push(String(entry.id));
  }
  if (stale.length === 0) return { ok: true, recovered: 0, failed: 0, error: null };
  const result = requeueCards(stateDir, stale, { maxAttempts, error: "stale claim recovered" });
  return { ok: result.ok, recovered: result.requeued, failed: result.failed, error: result.error };
}
