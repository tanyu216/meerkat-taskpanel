/**
 * The board's SLA read — the six card/board rows of `docs/sla.md`, computed
 * from the board's own facts and the effective `TASKD_SLA_*` table.
 *
 * `GET /api/v1/sla` is the surface; `taskctl sla list|get` is the CLI face and
 * the loop's transport. The decision itself is `planSlaPatrol` (pure); this
 * module owns the reads it needs:
 *
 *   * the board snapshot (the same projection `issue list` returns);
 *   * the comment trails the trail-derived rows read (bounded);
 *   * the effective configuration, re-read per call so a `.env` edit applies
 *     without restarting `taskd`.
 *
 * `inspector_liveness` is deliberately **not** computed here: it watches a
 * marker file on the loop's host, which the board cannot see. The loop adds it
 * from the `peer_*` values this response publishes.
 */

import { DEFAULT_BOARD_LIMIT, TASKD_KIND } from "../../foundation/constants.mjs";
import {
  DEFAULT_TRAIL_LIMIT,
  leaderAttributionWarning,
  planSlaPatrol,
  trailReadCandidates,
} from "../../foundation/sla-patrol.mjs";
import { commentToWire, taskToWire } from "../../foundation/wire.mjs";

/** How many comments of one card a trail read asks for (the loop's old cap). */
const COMMENTS_PER_CARD = 200;
/** How many cards one pass may ask for; a caller cannot widen this past reason. */
const MAX_BOARD_LIMIT = 5_000;
/** How many comment trails one pass may read. */
const MAX_TRAIL_CARDS = 2_000;

/** @param {unknown} value @param {number} fallback @param {number} max */
function clampLimit(value, fallback, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(0, Math.min(value, max));
}

/**
 * One SLA read over the board.
 *
 * @param {object} ctx the command context
 * @param {{
 *   now?: string, periodSeconds?: number, leaderId?: string|null,
 *   card?: string|null, limit?: number, trailLimit?: number,
 * }} [input]
 * @returns {{
 *   generated_at: string, board_truncated: boolean, trails_truncated: boolean,
 *   config: object, alerts: object[], warnings: string[],
 * }}
 */
export function slaSnapshot(ctx, input = {}) {
  const now = typeof input.now === "string" ? input.now : ctx.now();
  const config = ctx.slaConfig();
  const periodSeconds = Number.isInteger(input.periodSeconds) && input.periodSeconds > 0
    ? input.periodSeconds
    : config.periodSeconds;
  const limit = clampLimit(input.limit, DEFAULT_BOARD_LIMIT, MAX_BOARD_LIMIT);
  const trailLimit = clampLimit(input.trailLimit, DEFAULT_TRAIL_LIMIT, MAX_TRAIL_CARDS);
  const single = typeof input.card === "string" && input.card.trim() !== "";
  const lookup = (kind, id) => ctx.repos.dictionary.getById(kind, id);

  let tasks;
  let boardTruncated = false;
  if (single) {
    tasks = [ctx.repos.tasks.requireAnyRef(input.card.trim())];
  } else {
    tasks = ctx.repos.tasks.list({ limit });
    // A read exactly at the cap may have been cut off; the same heuristic the
    // loop used, and the reason one row's negative predicate can be undecidable.
    boardTruncated = tasks.length >= limit;
  }

  const cards = tasks.map((task) =>
    taskToWire(task, { lookup, parentId: null }),
  );
  /** identifier → the repository task whose comments the trail read needs. */
  const taskByIdentifier = new Map();
  for (let index = 0; index < cards.length; index += 1) {
    const id = String(cards[index].identifier ?? cards[index].id ?? "");
    if (id !== "" && !taskByIdentifier.has(id)) taskByIdentifier.set(id, tasks[index]);
  }

  // A single-card read always fetches the trail: the pre-emit re-check must be
  // able to see a gate that was answered regardless of elapsed time.
  const wanted = single
    ? cards.map((card) => String(card.identifier ?? card.id ?? "")).filter((id) => id !== "")
    : trailReadCandidates(cards, { now, periodSeconds, rows: config.rows });
  const selected = wanted.slice(0, trailLimit);
  const trails = {};
  for (const id of selected) {
    const task = taskByIdentifier.get(id);
    if (task === undefined) continue;
    trails[id] = ctx.repos.comments
      .list({ taskId: task.id, limit: COMMENTS_PER_CARD })
      .map((comment) => commentToWire(comment, { lookup }));
  }

  const result = planSlaPatrol({
    cards,
    trails,
    now,
    periodSeconds,
    rows: config.rows,
    mechanism: TASKD_KIND,
    mechanismHost: null,
    leaderId: input.leaderId ?? null,
    lookbackDays: config.leaderLookbackDays,
    boardTruncated,
    // The peer watchdog is the loop's local fact; the board never alarms on it.
    peerLastOkAt: null,
    peerRequired: false,
  });

  // The single-card surface answers "is this card's row still open?" — a
  // board-level row has no per-card answer and is filtered out.
  const alerts = single
    ? result.alerts.filter((alert) => alert.sla_row !== "leader_stalled")
    : result.alerts;

  const warning = leaderAttributionWarning(input.leaderId ?? null, cards, trails);
  return {
    generated_at: now,
    board_truncated: boardTruncated,
    trails_truncated: wanted.length > selected.length,
    config: { ...config, periodSeconds },
    alerts,
    warnings: warning === null ? [] : [warning],
  };
}
