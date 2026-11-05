/**
 * The **one** reader for a card's handoff-round marker.
 *
 * `meta.handoff_consumed_round` / `meta.handoff_declined_round` answer "has the
 * director settled this producer's delivery round?". The loop's own triage
 * prompt tells the director to record the created refs *in the value*, so a
 * legitimate marker reads `3 (TP-0082)`. Every reader used to run
 * `Number(value)`, which is `NaN` for that spelling: the triage lane re-proposed
 * an already-consumed handoff, `runtime` never settled the row, and the doctor
 * reported `handoff_unconsumed` forever. One spelling per layer was the same
 * four-way disagreement the review-identity reader closed.
 *
 * The rule is narrow on purpose: the value must **start** with the round, and
 * that integer must not be the prefix of a longer number or a decimal (`13` is
 * round thirteen, `3.5` and `3x` are no round). Everything after it is
 * annotation and never parsed. An unreadable value is `null`, so a card with a
 * malformed marker stays visibly unconsumed instead of silently matching.
 *
 * Pure: no `node:` specifiers, no clock, no I/O.
 */

/** The round must start the value and end as a whole token: `3`, `3 (TP-1)`. */
const LEADING_ROUND = /^(\d+)(?=$|[^\d.\w])/;

/**
 * The round a marker value carries, or `null` when it carries none.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function markerRound(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = LEADING_ROUND.exec(value.trim());
  return match === null ? null : Number.parseInt(match[1], 10);
}

/**
 * Whether a marker value settles `round`.
 *
 * @param {unknown} value the marker as stored (`3`, `"3"`, `"3 (TP-0082)"`)
 * @param {unknown} round the delivery round being asked about
 * @returns {boolean}
 */
export function markerMatches(value, round) {
  const expected = markerRound(round);
  if (expected === null) return false;
  return markerRound(value) === expected;
}
