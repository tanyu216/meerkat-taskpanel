/**
 * Comments — append and read. Deliberately nothing else: the table refuses
 * UPDATE and DELETE (I4), so exposing either here would only be a trap.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { COMMENT_COLUMNS, commentFromRow, commentToRow } from "../../domain/comment.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const SELECT_LIST = COMMENT_COLUMNS.join(", ");

/** @param {import('node:sqlite').DatabaseSync} db */
export function createCommentsRepository(db) {
  return {
    /** @param {object} comment a Comment DTO */
    append(comment) {
      const row = commentToRow(comment);
      try {
        db.prepare(
          `INSERT INTO comments(${COMMENT_COLUMNS.join(", ")})
           VALUES (${COMMENT_COLUMNS.map(() => "?").join(", ")})`,
        ).run(...COMMENT_COLUMNS.map((column) => row[column] ?? null));
      } catch (err) {
        throw mapSqliteError(err, { op: "comments.append", table: "comments" });
      }
      return commentFromRow(db.prepare(`SELECT ${SELECT_LIST} FROM comments WHERE id = ?`).get(comment.id));
    },

    /** @param {string} id */
    get(id) {
      return commentFromRow(db.prepare(`SELECT ${SELECT_LIST} FROM comments WHERE id = ?`).get(id));
    },

    /**
     * @param {{taskId?: string, limit?: number, after?: string, kind?: string}} [filter]
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (filter.taskId !== undefined) {
        clauses.push("task_id = ?");
        values.push(filter.taskId);
      }
      if (filter.kind !== undefined) {
        clauses.push("kind = ?");
        values.push(filter.kind);
      }
      if (filter.after !== undefined) {
        clauses.push("created_at > ?");
        values.push(filter.after);
      }
      const limit = Number.isInteger(filter.limit) ? filter.limit : 500;
      const sql = `SELECT ${SELECT_LIST} FROM comments
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   ORDER BY created_at ASC, id ASC LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(commentFromRow);
    },

    /**
     * The import idempotency key: has this card's Nth comment already landed?
     * @param {string} taskId @param {number} sourceSeq
     */
    getBySourceSeq(taskId, sourceSeq) {
      return commentFromRow(
        db
          .prepare(`SELECT ${SELECT_LIST} FROM comments WHERE task_id = ? AND source_seq = ?`)
          .get(taskId, sourceSeq),
      );
    },

    /** @param {string} taskId */
    count(taskId) {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(taskId).n);
    },

    /**
     * The human decisions on a task, newest last (I5).
     * @param {string} taskId
     */
    listDecisions(taskId) {
      return db
        .prepare(
          `SELECT ${SELECT_LIST} FROM comments
            WHERE task_id = ? AND author_kind = 'human' AND kind IN ('decision','confirm','change')
            ORDER BY created_at ASC, id ASC`,
        )
        .all(taskId)
        .map(commentFromRow);
    },
  };
}

/** Never implemented, on purpose — kept next to the repository as a signpost. */
export function updateComment() {
  throw new DomainError("COMMENT_APPEND_ONLY", {
    message: "comments are append-only; add a new comment of kind 'change'",
    details: {},
  });
}
