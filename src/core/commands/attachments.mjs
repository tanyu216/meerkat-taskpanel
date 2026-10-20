/**
 * The attachment use-cases — the write half of the surface in §5.1.
 *
 * These used to live in `server/routes/attachments.mjs`, which made that one
 * HTTP adapter the only place in the codebase that opened its own transaction,
 * read the wall clock directly and appended its own audit row. Every other
 * write goes through a command, so the three responsibilities that a command
 * owns — clock, transaction boundary, audit — now sit here and the route is an
 * adapter again: it decodes the request, applies the size/type policy, and
 * streams.
 *
 * The ordering comments below are load-bearing; they are carried over verbatim
 * from the route because the *reason* the bytes and the row stay in step is the
 * reason this module exists.
 *
 * Bytes live at `<dataDir>/attachments/<id>`, beside the database; `path` is
 * always computed by the caller (`server/routes/attachments.mjs`), which refuses
 * an id that is not a safe file name before it ever joins anything.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { DomainError } from "../../foundation/errors.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/**
 * Mint an attachment row and record it in the card's trail.
 *
 * The row and its audit row land together: an attachment that streams to a
 * client must also appear in the trail. `size` is the *declared* size (0 when
 * the caller did not state one) — the byte half corrects it in
 * `storeAttachmentContent`.
 *
 * @param {object} ctx
 * @param {{taskId: string, commentId?: string|null, filename: string, contentType?: string|null, size?: number, actor: object}} input
 * @returns {{attachment: object}}
 */
export function addAttachment(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      // Resolved (not merely referenced) so a missing card is the ordinary
      // `NOT_FOUND` rather than a foreign-key failure dressed as a database bug.
      const task = ctx.repos.tasks.requireAnyRef(input.taskId);
      const attachment = ctx.repos.attachments.insert({
        id: ctx.newId(),
        taskId: task.id,
        commentId: input.commentId ?? null,
        filename: String(input.filename),
        contentType: input.contentType ?? null,
        size: input.size ?? 0,
        kind: "attachment",
        createdAt: now,
      });
      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "attachment_added",
        changes: {
          attachmentId: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType ?? null,
          size: attachment.size ?? 0,
        },
        createdAt: now,
      });
      return { attachment };
    },
    { op: "attachments.create" },
  );
}

/**
 * Put the bytes and the row on disk together, and **take the write lock first**
 * (T-20261013-014304).
 *
 * The order is the whole point. This used to `writeFile` first and take the
 * lock second, so a PUT that lost the contention race answered 503 *after* its
 * payload had already replaced the stored file: bytes nobody would ever read, on
 * top of a row whose `size` now described a file that was no longer there. GET
 * kept serving the truth — it goes by `stat`, not by the row — so the damage was
 * quiet: disk growth and a listing that lied.
 *
 * Now the payload is written *inside* the transaction that holds the lock, to a
 * staging name beside the attachment, and only a body that has already updated
 * the row swaps it into place. Every way this write can be refused therefore
 * leaves the board exactly as it was: nothing stored, nothing staged, and a
 * `size` that still matches the bytes on disk.
 *
 * Three things are load-bearing:
 *
 *   * the body is **synchronous** on purpose. An `await` between `BEGIN
 *     IMMEDIATE` and `COMMIT` would let another request run; the unit of work
 *     turns a nested call into a SAVEPOINT, so that request would be enrolled in
 *     *this* transaction and rolled back with it — after it was answered.
 *   * the bytes go to a **staging file**, and `path` is only ever replaced by a
 *     rename. A payload that fails halfway (a full disk, say) can therefore
 *     truncate a staging file, never the attachment that is already stored.
 *   * one window is left open and it is deliberately not a contention window: if
 *     `COMMIT` itself fails *after* the body ran, the rollback restores the row
 *     while the file keeps the new bytes. The retry re-runs the body and heals
 *     that; only a budget exhausted by repeated COMMIT failures would leave the
 *     row and the disk disagreeing — and then with no bytes leaked, which is the
 *     failure this ordering exists to prevent.
 *
 * @param {object} ctx
 * @param {{attachment: object, path: string, body: Buffer, actor: object}} input
 */
export function storeAttachmentContent(ctx, { attachment, path, body, actor: rawActor }) {
  const actor = actorOf(rawActor);
  const staged = `${path}.${ctx.newId()}.part`;
  const now = ctx.now();
  try {
    transaction(
      ctx.db,
      () => {
        writeFileSync(staged, body);
        // Keeping the row's `size` honest so a listing can render it without a
        // stat is a write like any other. The `global_revision` trigger alone
        // produces no SSE frame (the stream is a cursor over `task_activities`),
        // so the size change gets its own audit row.
        ctx.repos.attachments.setSize(attachment.id, body.length);
        ctx.repos.activities.append({
          taskId: attachment.taskId,
          actorKind: actor.kind,
          actorId: actor.id,
          event: "attachment_updated",
          changes: {
            attachmentId: attachment.id,
            filename: attachment.filename,
            content_type: attachment.contentType ?? null,
            size: body.length,
          },
          createdAt: now,
        });
        renameSync(staged, path);
      },
      { op: "attachments.setSize" },
    );
  } catch (err) {
    // A refused write leaves nothing of its own behind — the staged bytes go
    // with it. (`path` is untouched unless the swap itself succeeded.)
    //
    // The cleanup must never *replace* the failure it is cleaning up after: a
    // `DB_BUSY` that reached the client as a filesystem error would be the R2
    // bug wearing a different hat, so a cleanup that cannot run is swallowed
    // and the original error is what propagates.
    try {
      rmSync(staged, { force: true });
    } catch {
      /* the staging file is the lesser problem */
    }
    throw err;
  }
}

/**
 * Remove an attachment **for good**: its bytes and its row, in one act.
 *
 * The order is the whole point, and it is the mirror of `storeAttachmentContent`'s.
 * The bytes are renamed to a staging name and the row is deleted inside a single
 * transaction that holds the write lock; the staged file is discarded only after
 * that transaction committed. So:
 *
 *   * a refused write (a `DB_BUSY` that exhausts the retry budget, a row that
 *     vanished under us) leaves the board exactly as it was — the catch puts the
 *     bytes back, and the rollback restores the row;
 *   * a **retry** re-runs the body. The rename is the one step that is not
 *     idempotent, so it is guarded by `existsSync`: on the second pass the bytes
 *     are already staged and there is nothing left to move, which is exactly the
 *     state the commit wants;
 *   * a row with no stored bytes (the `PUT` never arrived) is the ordinary case,
 *     not an error — there is nothing to rename and the row still goes.
 *
 * A file that could not be discarded after the commit is swallowed on purpose: a
 * leftover `.part` is garbage, while a throw here would report a delete that
 * *did* happen as a failure.
 *
 * @param {object} ctx
 * @param {{attachment: object, path: string, actor: object}} input
 */
export function removeAttachment(ctx, { attachment, path, actor: rawActor }) {
  const actor = actorOf(rawActor);
  const staged = `${path}.${ctx.newId()}.part`;
  let stagedBytes = false;
  const now = ctx.now();
  try {
    transaction(
      ctx.db,
      () => {
        if (!stagedBytes && existsSync(path)) {
          renameSync(path, staged);
          stagedBytes = true;
        }
        if (!ctx.repos.attachments.remove(attachment.id)) {
          throw new DomainError("NOT_FOUND", {
            message: `no attachment ${attachment.id}`,
            details: { attachmentId: attachment.id },
          });
        }
        ctx.repos.activities.append({
          taskId: attachment.taskId,
          actorKind: actor.kind,
          actorId: actor.id,
          event: "attachment_removed",
          changes: {
            attachmentId: attachment.id,
            filename: attachment.filename,
            content_type: attachment.contentType ?? null,
            size: attachment.size ?? 0,
          },
          createdAt: now,
        });
      },
      { op: "attachments.remove" },
    );
  } catch (err) {
    if (stagedBytes) {
      try {
        renameSync(staged, path);
      } catch {
        /* the row is intact; the bytes' exact name matters less than the throw */
      }
    }
    throw err;
  }
  if (stagedBytes) {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* the staged bytes are the lesser problem */
    }
  }
}
