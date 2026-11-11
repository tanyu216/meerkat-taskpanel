/**
 * `intake_requests` — a human's free-text work request before any card exists.
 *
 * The table is the request's state (`pending` → `consumed` | `failed`); the
 * activity row written by the command in the same transaction is the signal a
 * consumer reacts to. Neither this repository nor its callers read state out of
 * `changes_json`.
 *
 * The two terminal writes are compare-and-set (`UPDATE … WHERE status =
 * 'pending'`). The pool, the director lane and a second host may all reach the
 * same request; the first writer settles it and every other caller re-reads the
 * row it now holds. `complete`/`fail` return `{row, changed}` so the command
 * layer can converge without a second SELECT and without a lost update.
 */

import { newId } from "../../../foundation/ids.mjs";
import { assertIsoMillis } from "../../domain/task.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const CAMEL = {
  id: "id",
  project_id: "projectId",
  text: "text",
  status: "status",
  idem: "idem",
  created_by: "createdBy",
  created_kind: "createdKind",
  created_at: "createdAt",
  settled_at: "settledAt",
  settled_by: "settledBy",
  settled_by_kind: "settledByKind",
  created_refs_json: "createdRefs",
  last_error: "lastError",
};

function decodeRefs(value) {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {object} row */
export function intakeFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  out.createdRefs = decodeRefs(row.created_refs_json);
  return out;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createIntakeRepository(db) {
  const selectById = db.prepare("SELECT * FROM intake_requests WHERE id = ?");
  const selectByProjectIdem = db.prepare(
    "SELECT * FROM intake_requests WHERE project_id = ? AND idem = ?",
  );

  return {
    /**
     * Insert one pending request. `status`, `settled_*` and `last_error` are
     * left at their defaults; the row's state machine starts at `pending`.
     *
     * @param {{id?: string, projectId: string, text: string, idem?: string|null,
     *   createdBy: string, createdKind: string, now: string}} input
     */
    insert(input) {
      assertIsoMillis(input.now, "now");
      const id = input.id ?? newId();
      try {
        db.prepare(
          `INSERT INTO intake_requests(
             id, project_id, text, status, idem, created_by, created_kind, created_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        ).run(
          id,
          input.projectId,
          input.text,
          input.idem ?? null,
          input.createdBy,
          input.createdKind,
          input.now,
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "intake.insert", table: "intake_requests" });
      }
      return intakeFromRow(selectById.get(id));
    },

    /** @param {string} id */
    get(id) {
      return intakeFromRow(selectById.get(id));
    },

    /**
     * The request that already claimed a client's idempotency key, whatever its
     * status: a settled request still answers a retried submit.
     *
     * @param {string} projectId
     * @param {string} idem
     */
    findByProjectIdem(projectId, idem) {
      return intakeFromRow(selectByProjectIdem.get(projectId, idem));
    },

    /**
     * The supervisor's read: oldest first, bounded.
     *
     * @param {{status?: string|null, projectId?: string|null, limit?: number}} [options]
     */
    list(options = {}) {
      const where = [];
      const values = [];
      if (options.status !== undefined && options.status !== null) {
        where.push("status = ?");
        values.push(options.status);
      }
      if (options.projectId !== undefined && options.projectId !== null) {
        where.push("project_id = ?");
        values.push(options.projectId);
      }
      const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
      const sql =
        "SELECT * FROM intake_requests" +
        (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
        " ORDER BY created_at, rowid LIMIT ?";
      return db.prepare(sql).all(...values, limit).map(intakeFromRow);
    },

    /**
     * `pending → consumed`, recording the refs the lane created.
     *
     * @param {string} id
     * @param {{refs: string[], settledBy: string, settledByKind: string, now: string}} input
     * @returns {{row: object|null, changed: boolean}}
     */
    complete(id, input) {
      assertIsoMillis(input.now, "now");
      const info = db
        .prepare(
          `UPDATE intake_requests
              SET status = 'consumed',
                  settled_at = ?,
                  settled_by = ?,
                  settled_by_kind = ?,
                  created_refs_json = ?,
                  last_error = NULL
            WHERE id = ? AND status = 'pending'`,
        )
        .run(
          input.now,
          input.settledBy,
          input.settledByKind,
          JSON.stringify(input.refs),
          id,
        );
      return { row: intakeFromRow(selectById.get(id)), changed: Number(info.changes) > 0 };
    },

    /**
     * `pending → failed`, recording who declined and why.
     *
     * @param {string} id
     * @param {{reason: string, settledBy: string, settledByKind: string, now: string}} input
     * @returns {{row: object|null, changed: boolean}}
     */
    fail(id, input) {
      assertIsoMillis(input.now, "now");
      const info = db
        .prepare(
          `UPDATE intake_requests
              SET status = 'failed',
                  settled_at = ?,
                  settled_by = ?,
                  settled_by_kind = ?,
                  last_error = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(input.now, input.settledBy, input.settledByKind, input.reason, id);
      return { row: intakeFromRow(selectById.get(id)), changed: Number(info.changes) > 0 };
    },
  };
}
