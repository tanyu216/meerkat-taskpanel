/**
 * Comment use-cases. Append and read — there is no edit path anywhere in core,
 * which is what makes the human decision trail trustworthy (I4/I5).
 */

import { DomainError } from "../../shared/errors.mjs";
import { normalizeCommentCreate } from "../domain/comment.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/**
 * @param {object} ctx
 * @param {{taskId: string, body: string, kind?: string, actor: object, refs?: unknown, agentSession?: string|null, sourceSeq?: number|null, id?: string|null}} input
 */
export function addComment(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const task = ctx.repos.tasks.get(input.taskId);
      if (task === null) {
        throw new DomainError("NOT_FOUND", { message: `no task ${input.taskId}`, details: { taskId: input.taskId } });
      }

      const comment = normalizeCommentCreate(
        {
          body: input.body,
          kind: input.kind,
          author: actor,
          refs: input.refs,
          agentSession: input.agentSession,
          sourceSeq: input.sourceSeq,
        },
        { now, id: input.id ?? ctx.newId(), taskId: task.id, sourceSeq: input.sourceSeq ?? null },
      );
      const stored = ctx.repos.comments.append(comment);

      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "comment_added",
        changes: { commentId: stored.id, kind: stored.kind },
        createdAt: now,
      });
      return stored;
    },
    { op: "comments.add" },
  );
}

/** @param {object} ctx @param {{taskId?: string, kind?: string, limit?: number, after?: string}} [filter] */
export function listComments(ctx, filter = {}) {
  return ctx.repos.comments.list(filter);
}

/**
 * The decisions a human put on the record (I5). This is what a reviewer reads
 * before accepting a delivery.
 * @param {object} ctx @param {{taskId: string}} input
 */
export function listDecisions(ctx, input) {
  return ctx.repos.comments.listDecisions(input.taskId);
}
