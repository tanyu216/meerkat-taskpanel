/**
 * The one write that produces a **delivery** report row.
 *
 * `writeReport`, `deliver` and the epic rollup (`commands/rollup.mjs`) each
 * prepare a payload and then do exactly the same four things: pin it to the
 * card, set `origin: "delivery"`, carry the session stamp, and insert. The gate
 * (0008, `domain/delivery-gate.mjs`) accepts a row because of that `origin`, so
 * the field is not an implementation detail of one command — it belongs in one
 * place.
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
  return ctx.repos.reports.insert({ ...prepared, taskId, origin: "delivery", seg, sessionId, isRollup });
}
