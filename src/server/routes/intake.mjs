/**
 * Intake requests — the web's one-description create surface.
 *
 * `POST /api/v1/intake` is what the composer submits. It writes the request and
 * its `intake_requested` activity in one transaction; the supervisor's
 * subscriber turns that activity into a continue turn, and the decision lane
 * later answers with `complete` (the cards it filed) or `fail` (why not).
 *
 * The reads exist for two consumers that cannot share a process: `GET /intake`
 * is the supervisor's pending scan (through `taskctl`), and `GET /intake/:id` is
 * how the board, the pool and the CLI re-read one request after a signal instead
 * of trusting the event payload.
 */

import { intakeToWire } from "../../foundation/wire.mjs";
import { arr, intOrUndefined, shape, str } from "../requests.mjs";

// Declared request schemas — the shape the contract snapshot freezes. See
// `src/server/requests.mjs` for the "declared, not enforced" stance.

const CREATE_BODY = shape({ project_id: str(), text: str(), idem: str() }, ["project_id", "text"]);
const LIST_QUERY = shape({ status: str(), project_id: str(), limit: str() });
const COMPLETE_BODY = shape({ created: arr(str()) }, ["created"]);
const FAIL_BODY = shape({ reason: str() }, ["reason"]);

/** @param {object} router @param {{board: object}} surface */
export function registerIntakeRoutes(router, surface) {
  const { commands } = surface.board;

  router.get("/api/v1/intake", ({ query }) => ({
    requests: commands
      .listIntake({
        status: query.get("status"),
        projectId: query.get("project_id"),
        limit: intOrUndefined(query.get("limit")),
      })
      .map(intakeToWire),
  }), { query: LIST_QUERY });

  router.get("/api/v1/intake/:id", ({ params }) => ({
    request: intakeToWire(commands.getIntake({ id: params.id })),
  }));

  router.post("/api/v1/intake", ({ body, actor }) => ({
    request: intakeToWire(
      commands.createIntake({
        projectId: body.project_id,
        text: body.text,
        idem: body.idem,
        actor,
      }),
    ),
  }), { body: CREATE_BODY });

  router.post("/api/v1/intake/:id/complete", ({ params, body, actor }) => ({
    request: intakeToWire(
      commands.completeIntake({ id: params.id, refs: body.created, actor }),
    ),
  }), { body: COMPLETE_BODY });

  router.post("/api/v1/intake/:id/fail", ({ params, body, actor }) => ({
    request: intakeToWire(
      commands.failIntake({ id: params.id, reason: body.reason, actor }),
    ),
  }), { body: FAIL_BODY });
}
