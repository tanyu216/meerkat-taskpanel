/**
 * The single place that knows how to tell an agent to deliver a card.
 *
 * The gate refuses `→ in_review` without a current-round report, and the
 * refusal has to say *what to type instead*. That text lives here so M2 can
 * rename the CLI command by editing one line, and so tests assert a shape
 * rather than a hard-coded string.
 *
 * NOTE (controlled forward reference): the command below is implemented by M2.
 * M1 ships the core runner (`src/core/storage/md/migrate-cli.mjs`) and the
 * `commands.reports.deliver` primitive the command will call. Tests assert the
 * hint interpolates the identifier — not that the CLI exists yet.
 *
 * Pure: no `node:` specifiers.
 */

/**
 * @param {string} identifier human-readable task identifier (`PROJ-0007`)
 * @returns {{command: string, note: string}}
 */
export function deliverCommandHint(identifier) {
  return {
    command: `taskctl issue deliver ${identifier} --report-file -`,
    note:
      "deliver writes the report and moves the task to in_review in one transaction; " +
      "write the report JSON to stdin (or a file) and retry.",
  };
}
