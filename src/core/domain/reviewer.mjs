/**
 * The project's reviewer override.
 *
 * A project may name the agent that reviews its cards; when it names none, the
 * deployment-level reviewer applies. The board does not model an agent
 * dictionary it could validate a reviewer against, so a name is trimmed and
 * stored verbatim — the only refusal is a value that is not a string.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../foundation/errors.mjs";

/**
 * Normalize a project's reviewer override. `null`/absent/blank all mean "use
 * the deployment reviewer"; a non-blank name is trimmed and stored verbatim.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string|null}
 */
export function normalizeReviewer(value, field = "reviewer") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `reviewer must be a string (got ${JSON.stringify(value)})`,
      details: { field, received: value },
    });
  }
  const text = value.trim();
  return text === "" ? null : text;
}
