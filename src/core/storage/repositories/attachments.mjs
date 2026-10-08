/**
 * Attachments — metadata only this milestone (ARCHITECTURE §13: the content
 * endpoint is M6). Kept minimal on purpose: the table exists so importing a
 * card with attachments does not lose the reference.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { newId } from "../../../shared/ids.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const CAMEL = {
  id: "id",
  task_id: "taskId",
  comment_id: "commentId",
  filename: "filename",
  content_type: "contentType",
  size: "size",
  kind: "kind",
  created_at: "createdAt",
};

/** @param {object} row */
export function attachmentFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  return out;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createAttachmentsRepository(db) {
  return {
    /**
     * @param {{taskId: string, commentId?: string|null, filename: string, contentType?: string|null, size?: number, kind?: "inline"|"attachment", createdAt: string, id?: string}} input
     */
    insert(input) {
      if (typeof input.filename !== "string" || input.filename.trim() === "") {
        throw new DomainError("VALIDATION_FAILED", {
          message: "attachment filename is required",
          details: { field: "filename" },
        });
      }
      const kind = input.kind ?? "attachment";
      if (!["inline", "attachment"].includes(kind)) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `unknown attachment kind ${JSON.stringify(kind)}`,
          details: { field: "kind", allowed: ["inline", "attachment"] },
        });
      }
      const id = input.id ?? newId();
      const size = Number.isInteger(input.size) ? input.size : 0;
      if (size < 0) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "attachment size cannot be negative",
          details: { field: "size", received: size },
        });
      }
      try {
        db.prepare(
          `INSERT INTO attachments(id, task_id, comment_id, filename, content_type, size, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.taskId,
          input.commentId ?? null,
          input.filename,
          input.contentType ?? null,
          size,
          kind,
          input.createdAt,
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "attachments.insert", table: "attachments" });
      }
      return attachmentFromRow(db.prepare("SELECT * FROM attachments WHERE id = ?").get(id));
    },

    /** @param {string} taskId */
    listByTask(taskId) {
      return db
        .prepare("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id")
        .all(taskId)
        .map(attachmentFromRow);
    },

    /** @param {string} id */
    get(id) {
      return attachmentFromRow(db.prepare("SELECT * FROM attachments WHERE id = ?").get(id));
    },
  };
}
