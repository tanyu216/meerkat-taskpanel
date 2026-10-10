/**
 * Agent-session routes — "which conversation was working on this card" (§4.1).
 *
 * The session id is deterministic from `(task, owner, seg)` (`shared/ids.mjs`),
 * so a resumed conversation keeps its id without a lookup; the CLI derives it
 * when `--session-id` is omitted.
 */

import { sessionToWire } from "../../shared/wire.mjs";
import { int, REQUEST, shape, str } from "../requests.mjs";
import { resolveTask } from "./tasks.mjs";

// Declared request schemas, frozen by the contract snapshot (`routes[].request`)
// — see `src/server/requests.mjs` for the vocabulary.

/** `POST /api/v1/tasks/:ref/sessions` — register (or resume) a conversation. */
const REGISTER_BODY = shape({
  seg: str(),
  owner: str(),
  backend: str(),
  session_id: str(),
  phase: str(),
  pid: int(),
  status: REQUEST.sessionStatus,
});

/** `POST /api/v1/tasks/:ref/sessions/:sessionId/close` — `status` defaults to `closed`. */
const CLOSE_BODY = shape({ status: REQUEST.sessionStatus });

/** @param {object} router @param {{board: object}} surface */
export function registerSessionRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks/:ref/sessions", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    return { sessions: commands.listSessions({ taskId: task.id }).map(sessionToWire) };
  });

  router.post("/api/v1/tasks/:ref/sessions", ({ params, body, actor, session, seg }) => {
    const task = resolveTask(repos, params.ref);
    const registered = commands.registerSession({
      taskId: task.id,
      seg: body.seg ?? seg,
      owner: body.owner,
      backend: body.backend,
      sessionId: body.session_id ?? session,
      phase: body.phase,
      pid: body.pid,
      status: body.status,
      actor,
    });
    return { session: sessionToWire(registered) };
  }, { body: REGISTER_BODY });

  router.post("/api/v1/tasks/:ref/sessions/:sessionId/close", ({ params, body, actor }) => {
    resolveTask(repos, params.ref);
    const closed = commands.closeSession({
      sessionId: params.sessionId,
      status: body.status,
      actor,
    });
    return { session: sessionToWire(closed) };
  }, { body: CLOSE_BODY });
}
