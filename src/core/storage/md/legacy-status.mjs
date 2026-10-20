/**
 * The status word written into an exported card.
 *
 * The database stores the seven canonical states; a card may have carried a v1
 * word (`ready` / `failed`), and the original goes back out so a rewrite reads
 * the way its author wrote it.
 */

import { exportStatusValue } from "../../../foundation/status-alias.mjs";

/**
 * @param {string} status canonical status
 * @param {string|null|undefined} legacyStatus
 */
export function statusForExport(status, legacyStatus) {
  return exportStatusValue(status, legacyStatus ?? null);
}
