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
export const DEFAULT_CARD_MAX_ATTEMPTS = 3;

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
 * @returns {{continuePending: string, continueProcessing: string, cards: string, ledger: string, sessions: string}}
 */
export function queuePaths(stateDir) {
  const dir = String(stateDir);
  return {
    continuePending: join(dir, QUEUE_FILES.continuePending),
    continueProcessing: join(dir, QUEUE_FILES.continueProcessing),
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

/**
 * Enqueue (or coalesce) one continue turn.
 *
 * @param {string} stateDir
 * @param {{requestedAt?: string, reason?: string, [key: string]: unknown}} request
 * @returns {{ok: boolean, coalesced: boolean, error: string|null}}
 */
export function enqueueContinue(stateDir, request = {}) {
  const paths = queuePaths(stateDir);
  const current = readJsonFile(paths.continuePending, null);
  if (current.error !== null) return { ok: false, coalesced: false, error: current.error };
  const next = {
    version: 1,
    requestedAt: request.requestedAt ?? new Date().toISOString(),
    reason: request.reason ?? "timer",
    ...request,
  };
  const written = writeJsonFile(paths.continuePending, next);
  return { ok: written.ok, coalesced: current.value !== null, error: written.error };
}

/**
 * Claim the pending continue turn by moving it to the processing slot. A
 * processing file already present means another executor owns the turn; the
 * caller recovers it explicitly when it is stale.
 *
 * @param {string} stateDir
 * @returns {{ok: boolean, request: object|null, error: string|null}}
 */
export function claimContinue(stateDir) {
  const paths = queuePaths(stateDir);
  if (existsSync(paths.continueProcessing)) return { ok: true, request: null, error: null };
  const pending = readJsonFile(paths.continuePending, null);
  if (pending.error !== null) return { ok: false, request: null, error: pending.error };
  if (pending.value === null) return { ok: true, request: null, error: null };
  try {
    renameSync(paths.continuePending, paths.continueProcessing);
    return { ok: true, request: pending.value, error: null };
  } catch (err) {
    return { ok: false, request: null, error: `${paths.continuePending}: ${err.message}` };
  }
}

/** @param {string} stateDir */
export function completeContinue(stateDir) {
  try {
    rmSync(queuePaths(stateDir).continueProcessing, { force: true });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Return a claimed continue turn to pending. A newer pending request wins: the
 * claimed one is dropped rather than stacked, because both rebuild the same
 * prompt from current state.
 *
 * @param {string} stateDir
 * @param {{incrementAttempts?: boolean}} [options]
 * @returns {{ok: boolean, requeued: boolean, superseded: boolean, error: string|null}}
 */
export function requeueContinue(stateDir, options = {}) {
  const paths = queuePaths(stateDir);
  if (!existsSync(paths.continueProcessing)) {
    return { ok: true, requeued: false, superseded: false, error: null };
  }
  if (existsSync(paths.continuePending)) {
    try {
      rmSync(paths.continueProcessing, { force: true });
      return { ok: true, requeued: false, superseded: true, error: null };
    } catch (err) {
      return { ok: false, requeued: false, superseded: false, error: err.message };
    }
  }
  const claimed = readJsonFile(paths.continueProcessing, null);
  if (claimed.error !== null) return { ok: false, requeued: false, superseded: false, error: claimed.error };
  const next = {
    ...(claimed.value ?? {}),
    attempts: options.incrementAttempts === false ? Number(claimed.value?.attempts ?? 0) : Number(claimed.value?.attempts ?? 0) + 1,
  };
  const written = writeJsonFile(paths.continuePending, next);
  if (!written.ok) return { ok: false, requeued: false, superseded: false, error: written.error };
  try {
    rmSync(paths.continueProcessing, { force: true });
  } catch (err) {
    return { ok: false, requeued: false, superseded: false, error: err.message };
  }
  return { ok: true, requeued: true, superseded: false, error: null };
}

/** @param {string} stateDir */
export function readContinue(stateDir) {
  const paths = queuePaths(stateDir);
  const pending = readJsonFile(paths.continuePending, null);
  const processing = readJsonFile(paths.continueProcessing, null);
  return {
    pending: pending.value,
    processing: processing.value,
    errors: [pending.error, processing.error].filter(Boolean),
  };
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
export function cardKey(card) {
  // The question lane is keyed by the question, not by the card: one card may
  // ask twice, and each question deserves its own answer.
  if (String(card?.queue_kind ?? "") === "question") {
    return `q\u0000${String(card.card ?? "")}\u0000${String(card.question_id ?? "")}`;
  }
  return `${String(card.card ?? card.id ?? "")}\u0000${String(card.role ?? "worker")}`;
}

/**
 * Add one card handoff. A pending/processing entry for the same (card, role)
 * is idempotent, not duplicated.
 *
 * @param {string} stateDir
 * @param {{card: string, role?: string, [key: string]: unknown}} card
 * @returns {{ok: boolean, coalesced: boolean, error: string|null}}
 */
export function enqueueCard(stateDir, card) {
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, coalesced: false, error: read.error };
  const value = read.value;
  const key = cardKey(card);
  const existing = value.cards.find(
    (entry) => cardKey(entry) === key && (entry.status === "pending" || entry.status === "processing"),
  );
  if (existing !== undefined) return { ok: true, coalesced: true, error: null };
  // A queue row's discriminator is `queue_kind` (`handoff`|`question`). The
  // card's board `kind` (`task`|`epic`) is never copied onto a row: the two
  // vocabularies must not be confused, and a caller that passes a candidate
  // projection would otherwise smuggle one in.
  const { kind: _boardKind, ...row } = card ?? {};
  value.cards.push({
    version: 1,
    ...row,
    id: row.id ?? `${row.card}-${row.role ?? "worker"}`,
    queue_kind: row.queue_kind ?? "handoff",
    role: row.role ?? "worker",
    // The board identity selected for this handoff (Jobs/Linus/Turing). It is
    // additive metadata: the dedupe key stays (card, role).
    agent_role: row.agent_role ?? null,
    // The subscriber maps an event's UUID back to this row; keep the shape
    // stable even for a legacy caller that knows no UUID.
    task_id: row.task_id ?? null,
    review_of: row.review_of ?? null,
    review_round: row.review_round ?? null,
    status: "pending",
    enqueuedAt: row.enqueuedAt ?? new Date().toISOString(),
    claimedAt: null,
    claimedBy: null,
    attempts: Number(row.attempts ?? 0),
    lastError: null,
  });
  const written = writeCards(stateDir, value);
  return { ok: written.ok, coalesced: false, error: written.error };
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
 * How many question rows a question id has produced, in any status.
 *
 * The retry bound counts dispatches, not open rows: a completed row whose answer
 * did not settle the question must not be retried forever.
 *
 * @param {string} stateDir
 * @param {string} questionId
 * @returns {number}
 */
export function questionDispatches(stateDir, questionId) {
  const read = readCards(stateDir);
  if (read.error !== null) return 0;
  return read.value.cards.filter(
    (card) =>
      String(card.queue_kind ?? "") === "question" &&
      String(card.question_id ?? "") === String(questionId ?? ""),
  ).length;
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
export const CARD_RETENTION_MS = 24 * 60 * 60 * 1000;

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
 * @param {{maxAttempts?: number, error?: string|null}} [options]
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
 * @param {{isAlive?: (pid: number) => boolean, now?: number, maxAgeMs?: number, maxAttempts?: number}} [options]
 * @returns {{ok: boolean, recovered: number, failed: number, error: string|null}}
 */
export function recoverStaleCards(stateDir, options = {}) {
  const isAlive = options.isAlive ?? (() => true);
  const now = options.now ?? Date.now();
  const maxAgeMs = Number(options.maxAgeMs ?? 2 * 60 * 60 * 1000);
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_CARD_MAX_ATTEMPTS);
  const read = readCards(stateDir);
  if (read.error !== null) return { ok: false, recovered: 0, failed: 0, error: read.error };
  const value = read.value;
  const stale = [];
  for (const entry of value.cards) {
    if (entry.status !== "processing") continue;
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
