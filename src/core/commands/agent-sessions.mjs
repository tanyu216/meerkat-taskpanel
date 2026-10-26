/**
 * Agent session use-cases — the "which conversation was working on this card"
 * trail, and the resume key (§4.1).
 */

import { DomainError } from "../../foundation/errors.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { BOARD_ACTOR, actorOf } from "./context.mjs";

/**
 * @param {object} ctx
 * @param {{taskId: string, seg: string, owner?: string, actor?: object, ownerKind: string, sessionId: string, phase?: string|null, pid?: number|null, status?: string, goal?: string, meta?: object}} input
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
        // The same rule for meta: an omitted object keeps the recorded keys, a
        // supplied one merges into them.
        meta: input.meta,
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
 * Close a session by its row id, or by its natural key `(task, seg, owner)`.
 *
 * The natural key is the one a caller can derive before it has listed anything
 * (`session id` returns the deterministic id; the key is what produced it), so
 * a resumed conversation can close itself without a read first.
 *
 * @param {object} ctx
 * @param {{sessionId?: string, taskId?: string, seg?: string, owner?: string, actor?: object, status?: "closed"|"failed"}} input
 */
export function closeSession(ctx, input) {
  const actor = actorOf(input.actor ?? BOARD_ACTOR);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const session = input.sessionId !== undefined
        ? ctx.repos.sessions.close(input.sessionId, { ts: now, status: input.status ?? "closed" })
        : ctx.repos.sessions.closeByNaturalKey(input.taskId, input.seg, input.owner, {
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

/**
 * A card's sessions, or the board's sessions across cards.
 *
 * `taskId` selects the per-card read (oldest first). Without it, the global read
 * requires at least one filter — an unfiltered scan of every session on the
 * board is not a useful answer and would grow without bound.
 *
 * @param {object} ctx
 * @param {{taskId?: string, owner?: string, ownerKind?: string, status?: string, limit?: number}} [input]
 */
export function listSessions(ctx, input = {}) {
  if (input.taskId !== undefined) return ctx.repos.sessions.listByTask(input.taskId);
  if (
    (input.owner === undefined || input.owner === "") &&
    (input.ownerKind === undefined || input.ownerKind === "") &&
    (input.status === undefined || input.status === "")
  ) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a board-wide session read needs --owner, --owner-kind or --status",
      details: { fields: ["owner", "ownerKind", "status"] },
      hint: { fix: "pass --owner <name> (or --status running) to bound the read" },
    });
  }
  return ctx.repos.sessions.list(input);
}
