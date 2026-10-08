/**
 * The one rule about a report's *content* that a delivery warns about.
 *
 * `report template` fills in a document whose every line starts with `TODO:` so
 * that an unfilled template is obviously unfilled. Delivering one anyway is
 * legal — the gate asks whether a report exists for the round, not whether it is
 * good — but it deserves a warning, and both the CLI and the MCP server owe the
 * caller the same sentence.
 *
 * It lives in `shared` because both surfaces need it and neither may import the
 * other (plan G4). Pure: no `node:` specifiers.
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
