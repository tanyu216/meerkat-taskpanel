/**
 * Comment use-cases. Append and read — there is no edit path anywhere in core,
 * which is what makes the human decision trail trustworthy (I4/I5).
 */

import { DomainError } from "../../foundation/errors.mjs";
import { resumeDecision } from "../domain/awaiting.mjs";
import { normalizeCommentCreate } from "../domain/comment.mjs";
import { STATUS } from "../domain/enums.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";
import { resolveActorId } from "./dictionary.mjs";

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

      // `comments.author_id` is an actor **id** since 0020 (not the `--agent`
      // name): resolve the author first. The audit row below keeps the name —
      // `task_activities.actor_id` is deliberately a free string.
      const authorId = resolveActorId({ repos: ctx.repos, now }, { name: actor.id, actorKind: actor.kind });
      const comment = normalizeCommentCreate(
        {
          body: input.body,
          kind: input.kind,
          author: { kind: actor.kind, id: authorId },
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

      // 0034 — a human's answer ends an `awaiting` episode. Any human comment
      // is an answer, whatever its kind: the board does not read the text and
      // does not judge whether it is a complete decision (the resumed worker
      // does). The card moves back to the **queue** in this same transaction:
      // the asking worker is a one-shot subagent, already gone, so only `todo`
      // gets it dispatched again. The comment is passed directly rather than
      // re-read, so a `created_at` tie cannot pick the wrong "newest".
      if (task.status === STATUS.AWAITING) {
        const decision = resumeDecision({ task, newest: stored });
        if (decision.resume) {
          const moved = ctx.repos.tasks.moveCas({
            id: task.id,
            ifVersion: task.version,
            to: STATUS.TODO,
            now,
          });
          ctx.repos.activities.append({
            taskId: task.id,
            actorKind: actor.kind,
            actorId: actor.id,
            event: "task_resumed",
            changes: { commentId: stored.id, from: STATUS.AWAITING, to: moved.status },
            createdAt: now,
          });
        }
      }
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
