/**
 * Status words on the way in and out of a card (F2).
 *
 * The seven canonical states are what the database stores; a card may say
 * `ready` or `failed`, and the original word goes back on export so a card the
 * migrator rewrote still reads the way its author wrote it.
 */

import { DomainError } from "../../../shared/errors.mjs";
import {
  CORE_TO_LEGACY_STATUS,
  LEGACY_TO_CORE_STATUS,
  exportStatusValue,
  resolveStatus,
} from "../../../shared/status-alias.mjs";

export { CORE_TO_LEGACY_STATUS, LEGACY_TO_CORE_STATUS, exportStatusValue };

/**
 * Resolve a card's `status:` value.
 *
 * @param {unknown} raw
 * @returns {{status: string, legacyStatus: string|null}}
 * @throws {DomainError} MD_PARSE_ERROR when the word is neither canonical nor a known alias
 */
export function statusForImport(raw) {
  const resolved = resolveStatus(raw);
  if (!resolved.ok) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `unknown status ${JSON.stringify(raw)} in card frontmatter`,
      details: {
        field: "status",
        received: raw,
        allowed: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"],
        aliases: Object.keys(LEGACY_TO_CORE_STATUS),
      },
    });
  }
  return { status: resolved.status, legacyStatus: resolved.legacyStatus };
}

/**
 * The word to write into a card. The legacy value wins when we have one.
 * @param {string} status canonical status
 * @param {string|null|undefined} legacyStatus
 */
export function statusForExport(status, legacyStatus) {
  return exportStatusValue(status, legacyStatus ?? null);
}
