/**
 * The loop's admission-deferral ledger.
 *
 * A card that cannot be admitted used to be a log line and nothing else: the
 * same failure retried every pass for hours with no counter, no alert and no
 * doctor row. This file keeps one entry per card — how many consecutive times
 * admission failed, for which code — and escalates once per (streak, code) with
 * one board-visible comment by `Orchestrator`.
 *
 * Only *card-scoped* admission failures are counted. Claim-budget exhaustion,
 * no-pool and a per-project concurrency cap are backpressure, not a stuck card;
 * the caller says which is which (`accounted` on the admission result).
 *
 * Node builtins only; the file lives beside the other loop state files.
 */

import { existsSync } from "node:fs";

import { TERMINAL_STATUSES } from "../foundation/sla-patrol.mjs";
import { statePathsForDir } from "../foundation/loop-state.mjs";
import { readJsonFile, writeJsonFile } from "./queue.mjs";

export const DEFERRAL_LEDGER_VERSION = 1;

/** Failed admission attempts that make a card "looping" rather than unlucky. */
export const DEFERRAL_THRESHOLD = 3;

/** An entry older than this is dropped; a still-failing card re-escalates later. */
export const DEFERRAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** git stderr can be long; the ledger and the comment keep a bounded copy. */
export const DEFERRAL_REASON_MAX = 500;

/** @param {string} stateDir */
export function deferralLedgerPath(stateDir) {
  return statePathsForDir(stateDir).deferrals;
}

export function emptyDeferralLedger() {
  return { version: DEFERRAL_LEDGER_VERSION, cards: {} };
}

/**
 * Read the ledger.
 *
 * A missing file is the fresh-install state and is **not** an error — a fresh
 * state directory must not turn `loop doctor` red. Only an unreadable or
 * malformed file is reported.
 *
 * @param {string} stateDir
 * @returns {{value: {version: number, cards: object}, error: string|null}}
 */
export function readDeferralLedger(stateDir) {
  const path = deferralLedgerPath(stateDir);
  if (!existsSync(path)) return { value: emptyDeferralLedger(), error: null };
  const read = readJsonFile(path, null);
  if (read.error !== null) return { value: emptyDeferralLedger(), error: read.error };
  const value = read.value;
  const cards = value?.cards;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (cards !== undefined &&
      (cards === null || typeof cards !== "object" || Array.isArray(cards)))
  ) {
    return {
      value: emptyDeferralLedger(),
      error: `${path}: not a deferral ledger`,
    };
  }
  return {
    value: { version: DEFERRAL_LEDGER_VERSION, cards: cards ?? {} },
    error: null,
  };
}

/** @param {string} stateDir @param {{version: number, cards: object}} ledger */
export function writeDeferralLedger(stateDir, ledger) {
  return writeJsonFile(deferralLedgerPath(stateDir), {
    version: DEFERRAL_LEDGER_VERSION,
    cards: ledger?.cards ?? {},
  });
}

/**
 * Add one failed admission attempt and return the updated entry.
 *
 * `first_at` anchors the streak; `count` is consecutive until the caller clears
 * it on a successful admission. A changed `code` is a new cause: the escalation
 * gate compares it to `alerted_code`, so it is surfaced even though the streak
 * continues.
 *
 * @param {string} stateDir
 * @param {{identifier: string, code: string, reason: string, round?: number, now?: string}} input
 */
export function recordCardDeferral(stateDir, { identifier, code, reason, round, now }) {
  const id = String(identifier ?? "").trim();
  if (id === "") return { ok: false, entry: null, error: "no card identifier" };
  const at = typeof now === "string" && now !== "" ? now : new Date().toISOString();
  const failureCode = String(code ?? "ADMISSION_FAILED");
  const text = String(reason ?? "").slice(0, DEFERRAL_REASON_MAX);
  const { value, error } = readDeferralLedger(stateDir);
  const previous = value.cards[id];
  const entry =
    previous !== null && typeof previous === "object"
      ? {
          ...previous,
          round: Number(round ?? previous.round ?? 1),
          count: Number(previous.count ?? 0) + 1,
          last_at: at,
          code: failureCode,
          reason: text,
        }
      : {
          identifier: id,
          round: Number(round ?? 1),
          count: 1,
          first_at: at,
          last_at: at,
          code: failureCode,
          reason: text,
          alerted_code: null,
          alerted_at: null,
        };
  value.cards[id] = entry;
  const written = writeDeferralLedger(stateDir, value);
  return { ok: written.ok, entry, error: written.error ?? error ?? null };
}

/**
 * Forget a card's streak. A successful admission means the card is no longer
 * deferred; nothing is written when there was no entry.
 *
 * @param {string} stateDir @param {string} identifier
 */
export function clearCardDeferral(stateDir, identifier) {
  const id = String(identifier ?? "").trim();
  if (id === "") return { ok: true, cleared: false, error: null };
  const { value } = readDeferralLedger(stateDir);
  if (value.cards[id] === undefined) return { ok: true, cleared: false, error: null };
  delete value.cards[id];
  const written = writeDeferralLedger(stateDir, value);
  return { ok: written.ok, cleared: true, error: written.error };
}

/**
 * Record that this (streak, code) has been escalated.
 *
 * @param {string} stateDir @param {string} identifier @param {string} code @param {string} now
 */
export function markDeferralAlerted(stateDir, identifier, code, now) {
  const id = String(identifier ?? "").trim();
  const { value } = readDeferralLedger(stateDir);
  const entry = value.cards[id];
  if (entry === undefined || entry === null) return { ok: true, marked: false, error: null };
  entry.alerted_code = String(code ?? entry.code ?? "");
  entry.alerted_at = typeof now === "string" && now !== "" ? now : new Date().toISOString();
  const written = writeDeferralLedger(stateDir, value);
  return { ok: written.ok, marked: true, error: written.error };
}

/**
 * Drop entries that can no longer be useful: the card is terminal, or the
 * streak is past retention. A card missing from the board snapshot is kept —
 * an unavailable board must not erase the evidence it could not check.
 *
 * @param {{version: number, cards: object}} ledger
 * @param {{tasks?: object[]|null, nowMs?: number, retentionMs?: number}} [input]
 */
export function pruneDeferrals(
  ledger,
  { tasks = null, nowMs = Date.now(), retentionMs = DEFERRAL_RETENTION_MS } = {},
) {
  const byRef = new Map((tasks ?? []).map((task) => [task?.identifier, task]));
  const dropped = [];
  const cards = {};
  for (const [ref, entry] of Object.entries(ledger?.cards ?? {})) {
    const task = byRef.get(ref);
    if (task !== undefined && TERMINAL_STATUSES.includes(String(task?.status ?? ""))) {
      dropped.push({ identifier: ref, why: "terminal" });
      continue;
    }
    const at = Date.parse(String(entry?.last_at ?? ""));
    if (Number.isFinite(at) && nowMs - at > retentionMs) {
      dropped.push({ identifier: ref, why: "stale" });
      continue;
    }
    cards[ref] = entry;
  }
  return { ledger: { version: DEFERRAL_LEDGER_VERSION, cards }, dropped };
}

/** The one-shot alert object, shaped like the loop's other notify payloads. */
export function deferralAlert(entry) {
  return {
    kind: "deferral",
    severity: "error",
    card: entry.identifier,
    round: entry.round,
    count: entry.count,
    code: entry.code,
    reason: entry.reason,
    first_at: entry.first_at,
    last_at: entry.last_at,
    at: new Date().toISOString(),
  };
}

/** The bounded card comment a human sees on the board. */
export function deferralCommentBody(entry) {
  return [
    `The loop has deferred this card ${entry.count} consecutive times and cannot repair it itself.`,
    "",
    `- failure: ${entry.code}`,
    `- reason: ${entry.reason}`,
    `- round: ${entry.round}`,
    `- first seen: ${entry.first_at}`,
    `- last seen: ${entry.last_at}`,
    "",
    "It keeps retrying every pass. Check the lane branch and the loop's workspaces.json record; " +
      "`taskctl loop doctor` reports the same card under `looping`.",
  ].join("\n");
}

/**
 * Escalate a streak once per (streak, code).
 *
 * The comment is the human-visible half; the log is the always-available half.
 * A failed comment leaves `alerted_code` untouched so the next deferral retries
 * it. `notify` is the optional external push channel (a no-op when unset).
 *
 * @param {{
 *   entry: object,
 *   threshold?: number,
 *   postComment: (ref: string, body: string) => {ok: boolean, error?: string},
 *   markAlerted: (ref: string, code: string) => unknown,
 *   notify?: (alert: object) => void,
 *   log?: (line: string, options?: object) => void,
 * }} input
 */
export function escalateDeferral({
  entry,
  threshold = DEFERRAL_THRESHOLD,
  postComment,
  markAlerted,
  notify = () => {},
  log = () => {},
}) {
  if (entry === null || typeof entry !== "object") return { alerted: false };
  if (Number(entry.count ?? 0) < threshold) return { alerted: false };
  if (entry.alerted_code === entry.code) return { alerted: false };

  log(
    `deferral: ${entry.identifier} deferred ${entry.count}x — ${entry.code}: ${entry.reason}`,
    { level: "error" },
  );

  let posted;
  try {
    posted = postComment(entry.identifier, deferralCommentBody(entry));
  } catch (err) {
    posted = { ok: false, error: err?.message ?? String(err) };
  }
  if (posted?.ok !== true) {
    log(
      `deferral: could not comment on ${entry.identifier}: ${posted?.error ?? "unknown error"}`,
      { level: "warn" },
    );
    return { alerted: false, error: posted?.error ?? "comment failed" };
  }

  markAlerted(entry.identifier, entry.code);
  notify(deferralAlert(entry));
  return { alerted: true };
}

/**
 * One owner for the record/clear pair both admission sites use.
 *
 * `postComment` is the only board write: the poll and patrol passes build it
 * from `runCli` as `Orchestrator`. A dry run gets no-op functions, so it writes
 * neither the ledger nor the board.
 *
 * @param {{
 *   stateDir: string,
 *   postComment: (ref: string, body: string) => {ok: boolean, error?: string},
 *   notify?: (alert: object) => void,
 *   log?: (line: string, options?: object) => void,
 *   now?: () => string,
 *   dryRun?: boolean,
 * }} input
 */
export function createDeferralRecorder({
  stateDir,
  postComment,
  notify = () => {},
  log = () => {},
  now = () => new Date().toISOString(),
  dryRun = false,
}) {
  if (dryRun === true) {
    return { record: () => null, clear: () => ({ ok: true, cleared: false }) };
  }
  return {
    record(identifier, { code, reason, round }) {
      const written = recordCardDeferral(stateDir, {
        identifier,
        code,
        reason,
        round,
        now: now(),
      });
      if (written.ok !== true) {
        log(`deferral: could not record ${identifier}: ${written.error}`, { level: "warn" });
        return null;
      }
      escalateDeferral({
        entry: written.entry,
        postComment,
        markAlerted: (ref, alertedCode) => markDeferralAlerted(stateDir, ref, alertedCode, now()),
        notify,
        log,
      });
      return written.entry;
    },
    clear(identifier) {
      const cleared = clearCardDeferral(stateDir, identifier);
      if (cleared.ok !== true) {
        log(`deferral: could not clear ${identifier}: ${cleared.error}`, { level: "warn" });
      }
      return cleared;
    },
  };
}
