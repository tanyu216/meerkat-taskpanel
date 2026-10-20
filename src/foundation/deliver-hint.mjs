/**
 * The single place that knows how to tell an agent to deliver a card.
 *
 * The gate refuses `→ in_review` without a current-round report, and the refusal
 * has to say *what to type instead*. That text lives here so a rename is a
 * one-line change, and so tests assert a shape rather than a hard-coded string.
 *
 * M2 added the second line. The compliant path (`issue deliver`) stays first and
 * is what the hint leads with; the audited waiver is offered as the alternative,
 * because a refusal that hides the escape hatch just teaches people to reach for
 * the database. `test/core/shared.test.mjs` pins that the compliant line comes
 * first.
 *
 * Pure: no `node:` specifiers.
 */

/**
 * @param {string} identifier human-readable task identifier (`PROJ-0007`)
 * @returns {{command: string, alternative: string, note: string}}
 */
export function deliverCommandHint(identifier) {
  return {
    command: `taskctl issue deliver ${identifier} --report-file -`,
    alternative: `taskctl issue move ${identifier} in_review --no-report --reason "<why this is audited>"`,
    note:
      "deliver writes the report and moves the task to in_review in one transaction; " +
      "write the report JSON to stdin (or a file) and retry. " +
      "--no-report is recorded as a report_waived event and needs a reason of at least 8 characters.",
  };
}
