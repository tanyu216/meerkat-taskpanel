/**
 * The one write that produces a report row on the delivery path.
 *
 * `writeReport`, `deliver` and the epic rollup (`commands/rollup.mjs`) each
 * prepare a payload and then do exactly the same three things: pin it to the
 * card, carry the session stamp, and insert. 0035 removed the `origin` marker,
 * so there is no longer a per-writer field to keep in one place — but the
 * payload/seg/session/isRollup shape is still shared, and still belongs here.
 *
 * It is a leaf rather than a helper inside `commands/reports.mjs` because
 * `reports.mjs` already imports `rollup.mjs`; the reverse import would close a
 * cycle. This module imports nothing.
 *
 * A `null` seg/session is a real answer, not a default: the rollup writes a
 * container's report with no working conversation behind it.
 *
 * @param {object} ctx
 * @param {{taskId: string, prepared: object, seg?: string|null, sessionId?: string|null, isRollup?: boolean}} input
 * @returns {object} the inserted report row
 */
export function insertDeliveryReport(
  ctx,
  { taskId, prepared, seg = null, sessionId = null, isRollup = false },
) {
  // 0033 — the marker is the writer's decision (the card's kind), never a field
  // read off the payload; `validateReport` does not recognise `is_rollup`.
  return ctx.repos.reports.insert({ ...prepared, taskId, seg, sessionId, isRollup });
}
