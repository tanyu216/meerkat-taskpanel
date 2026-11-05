/**
 * The execution hold: the one board write that stops a card the loop cannot
 * advance. A card that reaches a retry bound is parked for a human, never
 * cancelled and never silently dropped (ADR 0009). The card's holder is not
 * asked to move it again: the bound is the loop's own decision.
 *
 * Two lanes park cards (a worker session that cannot be restored, a handoff
 * turn whose attempt budget is exhausted), so the write lives here once.
 */

import { ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";

import { runCli } from "./runtime.mjs";

/**
 * @param {object} opts
 * @param {(line: string, meta?: object) => void} log
 * @param {string} ref card identifier
 * @param {{code?: string, reason?: string, blockedReason?: string, body?: string|null}} [options]
 * @returns {{ok: boolean, dryRun?: boolean, error?: string|null}}
 */
export function holdCard(opts, log, ref, options = {}) {
  const card = String(ref ?? "");
  if (card === "") return { ok: false, error: "no card to hold" };
  if (opts?.dryRun) return { ok: true, dryRun: true };
  const code = typeof options.code === "string" && options.code !== "" ? options.code : "DISPATCH_FAILED";
  const blockedReason =
    typeof options.blockedReason === "string" && options.blockedReason !== ""
      ? options.blockedReason
      : "resource";
  const body =
    typeof options.body === "string" && options.body !== ""
      ? options.body
      : [
          `The loop stopped dispatching this card after repeated \`${code}\` failures.`,
          "",
          String(options.reason ?? "").slice(0, 500),
          "",
          "It will not be retried automatically. Fix the cause, then move this card back to `todo` (or `in_progress`).",
        ].join("\n");
  const commented = runCli(
    opts,
    ORCHESTRATOR_ACTOR_ID,
    ["comment", "add", card, "--kind", "question", "--body", body],
    { actorKind: SYSTEM_KIND },
  );
  if (!commented.ok) log(`hold ${card}: comment failed: ${commented.error}`, { level: "warn" });
  const moved = runCli(
    opts,
    ORCHESTRATOR_ACTOR_ID,
    [
      "issue",
      "move",
      card,
      "blocked",
      "--blocked-reason",
      blockedReason,
      "--reason",
      "the loop stopped dispatching after repeated failures",
    ],
    { actorKind: SYSTEM_KIND },
  );
  if (moved.ok !== true) {
    log(`hold ${card}: move failed: ${moved.error ?? "unknown error"}`, { level: "warn" });
  }
  return moved.ok ? { ok: true } : { ok: false, error: moved.error ?? "unknown error" };
}

/**
 * Release a card the loop gave up on a **transient** failure.
 *
 * The mirror image of `holdCard`: the card goes back to `todo` for a later
 * re-dispatch, with a `note` explaining the loop-side timeout. The **move comes
 * first, deliberately**: an open-question scan reads `in_progress` cards without
 * an author filter, so a comment written first would be routed to the director
 * as a question. A note after the move only feeds the normal poll.
 *
 * @param {object} opts
 * @param {(line: string, meta?: object) => void} log
 * @param {string} ref card identifier
 * @param {{reason?: string, body?: string|null}} [options]
 * @returns {{ok: boolean, dryRun?: boolean, error?: string|null}}
 */
export function releaseCard(opts, log, ref, options = {}) {
  const card = String(ref ?? "");
  if (card === "") return { ok: false, error: "no card to release" };
  if (opts?.dryRun) return { ok: true, dryRun: true };
  const reason =
    typeof options.reason === "string" && options.reason !== ""
      ? options.reason
      : "turn timed out; returned to the queue";
  const moved = runCli(
    opts,
    ORCHESTRATOR_ACTOR_ID,
    ["issue", "move", card, "todo", "--reason", reason],
    { actorKind: SYSTEM_KIND },
  );
  if (moved.ok !== true) {
    log(`release ${card}: move failed: ${moved.error ?? "unknown error"}`, { level: "warn" });
    return { ok: false, error: moved.error ?? "unknown error" };
  }
  const body =
    typeof options.body === "string" && options.body !== ""
      ? options.body
      : [
          reason,
          "",
          "The loop stopped dispatching this turn on a transient timeout. The card will be dispatched again on a later poll.",
        ].join("\n");
  const commented = runCli(
    opts,
    ORCHESTRATOR_ACTOR_ID,
    ["comment", "add", card, "--kind", "note", "--body", body],
    { actorKind: SYSTEM_KIND },
  );
  if (!commented.ok) log(`release ${card}: note failed: ${commented.error}`, { level: "warn" });
  return { ok: true };
}
