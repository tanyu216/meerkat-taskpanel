/**
 * `GET /api/v1/sla` — the board's SLA read.
 *
 * The six card/board rows of `docs/sla.md` are computed by
 * `commands/slaSnapshot` from the board's own facts and the effective
 * `TASKD_SLA_*` table. This route is the boundary: query parsing here, the
 * wire projection here, and nothing else. `taskctl sla list|get` is the CLI
 * face and the loop's transport.
 *
 * `?card=<ref>` is the pre-emit re-read: the loop asks for one card's rows
 * immediately before notifying, and a row it no longer finds is dropped with a
 * reason (§9.6). A board-level row (`leader_stalled`) has no per-card answer
 * and is omitted from that response.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { slaAlertToWire, slaConfigToWire } from "../../foundation/wire.mjs";
import { intOrUndefined, shape, str } from "../requests.mjs";

/** The measurement period's accepted range — mirrors `TASKD_SLA_PERIOD_SECONDS`. */
const MIN_PERIOD_SECONDS = 1;
const MAX_PERIOD_SECONDS = 86_400;

const SLA_QUERY = shape({
  card: str(),
  period: str(),
  leader: str(),
  limit: str(),
  trail_limit: str(),
});

/** @param {string|null} value */
function present(value) {
  return value !== null && value.trim() !== "" ? value.trim() : null;
}

/**
 * `?period=<sec>` is the loop's `--patrol-interval`. It is read only for this
 * request, so two inspectors with different cadences still share one `L`/`F`
 * table while each gets its own `warn = L − P`. A malformed value is refused
 * rather than ignored: silently reverting to the deployment default would hide
 * the typo that changes every warn lead.
 *
 * @param {string|null} raw
 * @returns {number|undefined}
 */
function periodOf(raw) {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw.trim() || parsed < MIN_PERIOD_SECONDS || parsed > MAX_PERIOD_SECONDS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `period must be an integer between ${MIN_PERIOD_SECONDS} and ${MAX_PERIOD_SECONDS} (got ${JSON.stringify(raw)})`,
      details: { field: "period", received: raw },
      hint: { fix: "pass --period <seconds>, or omit it to use the board's configured period" },
    });
  }
  return parsed;
}

/** @param {object} router @param {{board: object}} surface */
export function registerSlaRoutes(router, surface) {
  const { board } = surface;
  router.get(
    "/api/v1/sla",
    ({ query }) => {
      const card = query.get("card");
      const period = query.get("period");
      const leader = query.get("leader");
      const limit = query.get("limit");
      const trailLimit = query.get("trail_limit");
      const result = board.commands.slaSnapshot({
        card: present(card),
        periodSeconds: periodOf(period),
        leaderId: present(leader),
        limit: intOrUndefined(limit),
        trailLimit: intOrUndefined(trailLimit),
      });
      return {
        generated_at: result.generated_at,
        board_truncated: result.board_truncated,
        trails_truncated: result.trails_truncated,
        config: slaConfigToWire(result.config),
        alerts: result.alerts.map(slaAlertToWire),
        warnings: result.warnings,
      };
    },
    { query: SLA_QUERY },
  );
}
