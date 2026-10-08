/**
 * How the CLI turns a failure into an exit code and a message (§F-C2).
 *
 * Every failure is a `DomainError` with a code, so the rule is one line: a usage
 * problem exits 2, anything else exits 1, and `export --md --check` with
 * differences exits 3 (the same contract `migrate-cli check` already uses).
 *
 * The rendered error is `DomainError.toJSON()` passed straight through — the CLI
 * adds no vocabulary of its own, which is what makes `--json` errors stable for
 * scripts. Everything is funneled through `redactDeep`, so a token can never
 * reach a terminal or a log even if it got into a message.
 */

import { CLI_EXIT } from "../shared/constants.mjs";
import { DomainError, toErrorPayload } from "../shared/errors.mjs";
import { redactDeep } from "../shared/redact.mjs";

/**
 * "You typed it wrong." Always exits 2.
 * @param {string} message
 * @param {{details?: object, hint?: object}} [options]
 */
export function usageError(message, options = {}) {
  return new DomainError("CLI_USAGE", { message, ...options });
}

/**
 * "The board could not be reached (or its answer made no sense)." Exits 1.
 * @param {string} message
 * @param {{details?: object, hint?: object, cause?: unknown}} [options]
 */
export function ioError(message, options = {}) {
  return new DomainError("CLI_IO", { message, ...options });
}

/** @param {unknown} err */
export function exitCodeFor(err) {
  if (err instanceof DomainError && err.code === "CLI_USAGE") return CLI_EXIT.USAGE;
  return CLI_EXIT.ERROR;
}

/** The `error` half of the `--json` envelope: exactly `DomainError.toJSON()`. */
export function errorPayload(err) {
  return redactDeep(toErrorPayload(err));
}

/**
 * The human rendering. `REPORT_REQUIRED` is the shape this is designed around:
 *
 *   REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 …
 *   try: taskctl issue deliver PROJ-0007 --report-file -
 *     or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why>"
 *
 * @param {unknown} err
 * @returns {string}
 */
export function renderErrorText(err) {
  const payload = errorPayload(err);
  const lines = [`${payload.code}: ${payload.message}`];

  const issues = payload.details?.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      lines.push(`  - ${issue?.path ?? ""}: ${issue?.message ?? ""}`);
    }
  }

  const hint = payload.hint ?? {};
  if (typeof hint.command === "string") lines.push(`try: ${hint.command}`);
  if (typeof hint.alternative === "string") lines.push(`  or: ${hint.alternative}`);
  if (typeof hint.fix === "string") lines.push(`fix: ${hint.fix}`);
  // A `note` explains the rule; it is only worth a line when nothing actionable
  // was printed above it.
  if (typeof hint.note === "string" && hint.command === undefined && hint.fix === undefined) {
    lines.push(`note: ${hint.note}`);
  }
  return lines.join("\n");
}
