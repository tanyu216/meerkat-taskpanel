/**
 * Cross-process interrupt requests for card turns (TP-0125 · ADR 0017).
 *
 * A card can leave its claim cycle in a process that does not own the turn —
 * the subscriber sees the `task_moved`, the workflow pass cancels a review
 * card, a human moves a card between two ticks. Killing that turn needs the
 * **pool** process, so the fact travels through the state directory:
 *
 *   subscriber / workflow / pulse   write `interrupts/<key>.json`
 *   the resident pool               reads the directory on its own 1 s clock
 *
 * The file is a *request*, never an order: the board is the only authority for
 * the card's status, and every step is retryable. A request is unlinked only
 * after the row it matched has reached a terminal queue state (or the card is
 * terminal already); an unmatched request is a tombstone for 30 s and is pruned
 * absolutely after 10 min.
 *
 * **Matching is `task_id` first, then the card identifier, plus a timestamp
 * guard** (`row.enqueuedAt <= request.requestedAt`). It is deliberately not a
 * round match: a marker names "the handoff that was already in the queue when
 * the move happened", and a handoff enqueued afterwards must never be killed by
 * a stale tombstone. `round` is carried for diagnosis only.
 *
 * **Layering.** `src/orchestrator/**` does not import `src/core/**`, so this
 * module keeps its own {@link CLAIM_HOLDING}; `test/contract/state-machine`
 * holds the copy equal to `domain/status.mjs#holdsClaim` pair for pair.
 *
 * Node builtins only; no network, no dependencies.
 */

import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { STATE_FILES } from "../foundation/loop-state.mjs";

/** The statuses in which a card keeps its execution claim (see `status.mjs`). */
export const CLAIM_HOLDING = Object.freeze(["in_progress", "awaiting", "in_review", "blocked"]);

/** An unmatched request is kept this long to catch a late first read. */
export const INTERRUPT_TOMBSTONE_MS = 30_000;

/** No request outlives this, matched or not. */
export const INTERRUPT_PRUNE_MS = 10 * 60_000;

/** The on-disk request version. */
export const INTERRUPT_REQUEST_VERSION = 1;

/**
 * Does a card in this status keep its execution claim?
 * @param {unknown} status
 * @returns {boolean}
 */
export function holdsClaim(status) {
  return CLAIM_HOLDING.includes(/** @type {string} */ (status));
}

/**
 * Does moving `from → to` take the card out of its claim cycle?
 * @param {unknown} from @param {unknown} to
 * @returns {boolean}
 */
export function leavesClaimCycle(from, to) {
  return holdsClaim(from) && !holdsClaim(to);
}

/** @param {string} stateDir */
export function interruptsDir(stateDir) {
  return join(String(stateDir), STATE_FILES.interrupts);
}

/** An ISO timestamp, or `null` when the value is not a time. */
function isoOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const at = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * The one file for one request target. The task UUID is preferred; the card
 * identifier is the fallback a workflow action has in hand.
 *
 * @param {{taskId?: unknown, card?: unknown}} request
 * @returns {string|null}
 */
function requestFile(request) {
  const taskId = typeof request?.taskId === "string" ? request.taskId : "";
  if (taskId !== "") return `${encodeURIComponent(taskId)}.json`;
  const card = typeof request?.card === "string" ? request.card : "";
  if (card !== "") return `card:${encodeURIComponent(card)}.json`;
  return null;
}

/** @param {object} request @returns {object|null} the normalised on-disk shape */
function normaliseRequest(request) {
  const taskId = typeof request?.taskId === "string" && request.taskId !== "" ? request.taskId : null;
  const card = typeof request?.card === "string" && request.card !== "" ? request.card : null;
  const requestedAt = isoOf(request?.requestedAt ?? request?.requested_at);
  if (requestedAt === null) return null;
  if (taskId === null && card === null) return null;
  const round = Number(request?.round);
  return {
    version: INTERRUPT_REQUEST_VERSION,
    task_id: taskId,
    card,
    from: typeof request?.from === "string" ? request.from : null,
    to: typeof request?.to === "string" ? request.to : null,
    round: Number.isInteger(round) && round > 0 ? round : null,
    reason: typeof request?.reason === "string" ? request.reason : null,
    requested_by: typeof request?.requestedBy === "string" ? request.requestedBy : null,
    requested_at: requestedAt,
  };
}

/**
 * Write one request atomically. Same target = same file, so a duplicate writer
 * overwrites rather than accumulating.
 *
 * @param {string} stateDir
 * @param {{
 *   taskId?: string|null, card?: string|null, from?: string|null, to?: string|null,
 *   round?: number|null, reason?: string|null, requestedBy?: string|null,
 *   requestedAt?: string|number|null,
 * }} request
 * @returns {{ok: boolean, file: string|null, error: string|null}}
 */
export function requestInterrupt(stateDir, request = {}) {
  const name = requestFile(request);
  if (name === null) return { ok: false, file: null, error: "an interrupt request names no card" };
  const normalised = normaliseRequest(request);
  if (normalised === null) {
    return { ok: false, file: null, error: "an interrupt request needs a parsable requested_at" };
  }
  const dir = interruptsDir(stateDir);
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(normalised, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { ok: true, file, error: null };
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A stale temp file must not hide the real write error.
    }
    return { ok: false, file: null, error: `${file}: ${err.message}` };
  }
}

/**
 * Read the whole request directory once.
 *
 * A corrupt file is removed and reported — it can never match a row, and
 * keeping it would make every later read pay for it. The caller owns the log.
 *
 * @param {string} stateDir
 * @returns {{
 *   byTask: Map<string, object[]>, byCard: Map<string, object[]>,
 *   files: string[], corrupt: string[],
 * }}
 */
export function readInterruptRequestIndex(stateDir) {
  const index = { byTask: new Map(), byCard: new Map(), files: [], corrupt: [] };
  const dir = interruptsDir(stateDir);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return index;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const file = join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      rmSync(file, { force: true });
      index.corrupt.push(file);
      continue;
    }
    const request = normaliseRequest({
      taskId: raw?.task_id,
      card: raw?.card,
      from: raw?.from,
      to: raw?.to,
      round: raw?.round,
      reason: raw?.reason,
      requestedBy: raw?.requested_by,
      requestedAt: raw?.requested_at,
    });
    if (request === null) {
      rmSync(file, { force: true });
      index.corrupt.push(file);
      continue;
    }
    const entry = { ...request, file };
    index.files.push(file);
    if (entry.task_id !== null) {
      const list = index.byTask.get(entry.task_id) ?? [];
      list.push(entry);
      index.byTask.set(entry.task_id, list);
    }
    if (entry.card !== null) {
      const list = index.byCard.get(entry.card) ?? [];
      list.push(entry);
      index.byCard.set(entry.card, list);
    }
  }
  return index;
}

/**
 * Every request that applies to one queue row, earliest first.
 *
 * Both keys are consulted because the two writers know different facts: the
 * subscriber has the event's UUID, the workflow pass has the identifier. A
 * request carried by both keys is returned once. The timestamp guard is the
 * load-bearing half: a handoff enqueued after the move is a *new* attempt and
 * must not be killed by a tombstone.
 *
 * @param {{byTask: Map<string, object[]>, byCard: Map<string, object[]>}} index
 * @param {{task_id?: unknown, card?: unknown, enqueuedAt?: unknown}} row
 * @returns {object[]}
 */
export function interruptRequestsForRow(index, row) {
  const enqueuedAt = Date.parse(String(row?.enqueuedAt ?? ""));
  if (!Number.isFinite(enqueuedAt)) return [];
  const candidates = [];
  const seen = new Set();
  const taskId = typeof row?.task_id === "string" ? row.task_id : "";
  const card = typeof row?.card === "string" ? row.card : "";
  for (const request of [
    ...(taskId === "" ? [] : index.byTask?.get(taskId) ?? []),
    ...(card === "" ? [] : index.byCard?.get(card) ?? []),
  ]) {
    if (seen.has(request.file)) continue;
    seen.add(request.file);
    const requestedAt = Date.parse(String(request.requested_at ?? ""));
    if (Number.isFinite(requestedAt) && enqueuedAt <= requestedAt) candidates.push(request);
  }
  candidates.sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at));
  return candidates;
}

/**
 * The earliest request that applies to one queue row, or `null`.
 *
 * @param {{byTask: Map<string, object[]>, byCard: Map<string, object[]>}} index
 * @param {{task_id?: unknown, card?: unknown, enqueuedAt?: unknown}} row
 * @returns {object|null}
 */
export function interruptRequestForRow(index, row) {
  return interruptRequestsForRow(index, row)[0] ?? null;
}

/** Remove one request (idempotent). @param {object|string} requestOrFile */
export function removeInterruptRequest(requestOrFile) {
  const file = typeof requestOrFile === "string" ? requestOrFile : requestOrFile?.file;
  if (typeof file !== "string" || file === "") return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop requests past their absolute lifetime, and any whose `requested_at` is
 * unreadable. Returns the number removed.
 *
 * @param {string} stateDir
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {{removed: number, corrupt: number}}
 */
export function pruneInterruptRequests(stateDir, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlMs = Number(options.ttlMs ?? INTERRUPT_PRUNE_MS);
  const dir = interruptsDir(stateDir);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0, corrupt: 0 };
  }
  let removed = 0;
  let corrupt = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let at = Number.NaN;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      at = Date.parse(String(raw?.requested_at ?? ""));
      if (!Number.isFinite(at)) corrupt += 1;
    } catch {
      corrupt += 1;
    }
    if (Number.isFinite(at) && now - at <= ttlMs) continue;
    try {
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      // A request that cannot be removed is retried on the next pass.
    }
  }
  return { removed, corrupt };
}

/** Is this activity the moment a card left its claim cycle? */
export function isInterruptActivity(activity) {
  const event = String(activity?.event ?? "");
  if (event !== "task_moved" && event !== "task_resumed") return false;
  const changes = activity?.changes;
  if (changes === null || typeof changes !== "object") return false;
  return leavesClaimCycle(changes.from, changes.to);
}
