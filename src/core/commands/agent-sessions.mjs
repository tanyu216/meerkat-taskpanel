/**
 * Agent session use-cases — the "which conversation was working on this card"
 * trail, and the resume key (§4.1).
 */

import { transaction } from "../storage/unit-of-work.mjs";
import { BOARD_ACTOR, actorOf } from "./context.mjs";

/**
 * @param {object} ctx
 * @param {{taskId: string, seg: string, owner?: string, actor?: object, ownerKind: string, sessionId: string, phase?: string|null, pid?: number|null, status?: string, goal?: string}} input
 */
export function registerSession(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: BOARD_ACTOR.kind, id: input.owner ?? BOARD_ACTOR.id });
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const task = ctx.repos.tasks.requireAnyRef(input.taskId);
      const session = ctx.repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: input.seg,
        owner: input.owner ?? actor.id,
        ownerKind: input.ownerKind,
        sessionId: input.sessionId,
        phase: input.phase ?? null,
        pid: input.pid ?? null,
        status: input.status ?? "running",
        ts: now,
        // Pass `undefined` through: the repository keeps the recorded goal on a
        // re-registration that does not mention it.
        goal: input.goal,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "session_registered",
        changes: { sessionId: session.id, seg: session.seg, ownerKind: session.ownerKind, phase: session.phase },
        createdAt: now,
      });
      return session;
    },
    { op: "sessions.register" },
  );
}

/**
 * @param {object} ctx
 * @param {{sessionId: string, actor?: object, status?: "closed"|"failed"}} input
 */
export function closeSession(ctx, input) {
  const actor = actorOf(input.actor ?? BOARD_ACTOR);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const session = ctx.repos.sessions.close(input.sessionId, {
        ts: now,
        status: input.status ?? "closed",
      });
      ctx.repos.activities.append({
        taskId: session.taskId,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "session_closed",
        changes: { sessionId: session.id, status: session.status },
        createdAt: now,
      });
      return session;
    },
    { op: "sessions.close" },
  );
}

/** @param {object} ctx @param {{taskId: string}} input */
export function listSessions(ctx, input) {
  return ctx.repos.sessions.listByTask(input.taskId);
}
