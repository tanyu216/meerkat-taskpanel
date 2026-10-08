/**
 * Agent session use-cases — the "which conversation was working on this card"
 * trail, and the resume key (§4.1).
 */

import { DomainError } from "../../shared/errors.mjs";
import { sessionId as deriveSessionId } from "../../shared/ids.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/** The deterministic session id for a (task, owner, seg) triple. */
export const sessionId = deriveSessionId;

/**
 * @param {object} ctx
 * @param {{taskId: string, seg: string, owner?: string, actor?: object, backend: string, sessionId: string, phase?: string|null, pid?: number|null, status?: string}} input
 */
export function registerSession(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "agent", id: input.owner ?? "unknown" });
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const task = ctx.repos.tasks.get(input.taskId) ?? ctx.repos.tasks.findByIdentifierAnyProject(input.taskId);
      if (task === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.taskId}`, details: { taskId: input.taskId } });
      }
      const session = ctx.repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: input.seg,
        owner: input.owner ?? actor.id,
        backend: input.backend,
        sessionId: input.sessionId,
        phase: input.phase ?? null,
        pid: input.pid ?? null,
        status: input.status ?? "running",
        ts: now,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "session_registered",
        changes: { sessionId: session.id, seg: session.seg, backend: session.backend, phase: session.phase },
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
  const actor = actorOf(input.actor ?? { kind: "system", id: "taskd" });
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
