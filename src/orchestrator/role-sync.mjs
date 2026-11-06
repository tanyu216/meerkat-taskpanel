/**
 * Publish the discovered role set to the local role catalog through `taskctl`.
 *
 * The supervisor is the discovery authority: it has already run `loadRoles` and
 * holds the exact set it will route with. It passes **that** set rather than
 * asking `taskctl` to re-scan — a second discovery could see a different
 * `--home`, kind order or tree, and the assignee range would stop describing
 * what the loop actually claims.
 *
 * The write path is `taskctl role sync --file -` over **stdin**: the CLI is the
 * single writer/normalizer of the local file (the same shape `comment add
 * --file -` already uses), so there is no temp file to clean up and no
 * partial-read window. `taskctl` and `taskd` stay separate: this file is
 * host-local and the board never learns roles.
 *
 * The sync is idempotent by content (`role sync` leaves `updated_at` alone when
 * nothing changed) and is called on every poll, including a poll that returns
 * early for a missing resident pool: one small CLI spawn per tick buys
 * self-healing after a deleted or hand-broken catalog. A failure is logged and
 * never blocks a claim, because routing never depends on this projection.
 */

import { BOARD_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
import { buildRoleCatalog } from "../foundation/role-catalog.mjs";

import { runCli } from "./runtime.mjs";

/**
 * The document a sync publishes. Pure, so the shape can be asserted without a
 * child process.
 *
 * @param {object} roleSet the result of `loadRoles`
 * @param {Date} [now]
 * @returns {object}
 */
export function roleCatalogPayload(roleSet, now = new Date()) {
  return buildRoleCatalog({ roleSet, now });
}

/**
 * Write the discovered set through `taskctl role sync`.
 *
 * @param {{
 *   opts: object,
 *   roleSet: object,
 *   log?: (line: string) => void,
 *   run?: typeof runCli,
 *   now?: Date,
 * }} input
 * @returns {{ok: boolean, skipped?: string, data?: object, error?: string}}
 */
export function syncRoleCatalog({ opts, roleSet, log = () => {}, run = runCli, now = new Date() }) {
  if (opts?.dryRun === true) return { ok: true, skipped: "dry-run" };

  const payload = roleCatalogPayload(roleSet, now);
  const result = run(
    opts,
    BOARD_ACTOR_ID,
    ["role", "sync", "--file", "-"],
    { input: JSON.stringify(payload), actorKind: SYSTEM_KIND },
  );
  if (!result.ok) {
    log(`role catalog: sync failed (${result.error ?? "unknown"})`);
    return { ok: false, error: result.error ?? "unknown" };
  }
  return { ok: true, data: result.data };
}
