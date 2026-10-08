/**
 * Agent-session routes — "which conversation was working on this card" (§4.1).
 *
 * The session id is deterministic from `(task, owner, seg)` (`shared/ids.mjs`),
 * so a resumed conversation keeps its id without a lookup; the CLI derives it
 * when `--session-id` is omitted.
 */

import { sessionToWire } from "../../shared/wire.mjs";
import { resolveTask } from "./tasks.mjs";

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
  });

  router.post("/api/v1/tasks/:ref/sessions/:sessionId/close", ({ params, body, actor }) => {
    resolveTask(repos, params.ref);
    const closed = commands.closeSession({
      sessionId: params.sessionId,
      status: body.status,
      actor,
    });
    return { session: sessionToWire(closed) };
  });
}
