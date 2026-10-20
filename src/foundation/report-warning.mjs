/**
 * The one rule about a report's *content* that a delivery warns about.
 *
 * `report template` fills in a document whose every line starts with `TODO:` so
 * that an unfilled template is obviously unfilled. Delivering one anyway is
 * legal — the gate asks whether a report exists for the round, not whether it is
 * good — but it deserves a warning, and the writer and the checker owe the
 * caller the same sentence.
 *
 * It lives in `foundation` so the template writer (`cli/commands/report.mjs`) and
 * the delivery checker (`cli/commands/issue.mjs`) read one rule rather than two
 * copies of it. Pure: no `node:` specifiers.
 */

/** What an unfilled template says; the string `reportWarnings` looks for. */
export const TODO_PLACEHOLDER = "TODO: say what is left";

/** The substring that marks any line as still-a-placeholder. */
export const TODO_MARKER = "TODO:";

/**
 * Warnings for a report about to be delivered.
 *
 * @param {{leftovers?: unknown}|null|undefined} report
 * @returns {string[]} usually empty; never `null`
 */
export function reportWarnings(report) {
  const warnings = [];
  const leftovers = report?.leftovers;
  if (typeof leftovers === "string" && leftovers.includes(TODO_MARKER)) {
    warnings.push("delivering a template that still contains TODO placeholders");
  }
  return warnings;
}
