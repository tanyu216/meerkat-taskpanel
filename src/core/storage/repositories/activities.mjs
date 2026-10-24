/**
 * `task_activities` — the audit trail every write command leaves behind.
 *
 * Each row carries the global revision its own insert produced (see
 * `unit-of-work.mjs#recordActivity`), so the stream's cursor is a plain
 * `revision > ?` range. A command may write more than one row (`updateTask` can
 * record a review override, an acceptance change and the patch's own
 * `task_updated`), and each is a separate increment.
 */

import { recordActivity } from "../unit-of-work.mjs";

const CAMEL = {
  id: "id",
  task_id: "taskId",
  actor_kind: "actorKind",
  actor_id: "actorId",
  event: "event",
  changes_json: "changes",
  revision: "revision",
  created_at: "createdAt",
};

/** @param {object} row */
export function activityFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  out.changes = decode(row.changes_json);
  return out;
}

function decode(value) {
  if (typeof value !== "string" || value === "") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createActivitiesRepository(db) {
  return {
    /** @param {object} activity see `unit-of-work.mjs#recordActivity` */
    append(activity) {
      const id = recordActivity(db, activity);
      return activityFromRow(db.prepare("SELECT * FROM task_activities WHERE id = ?").get(id));
    },

    /**
     * @param {{taskId?: string, afterRevision?: number, limit?: number, order?: "asc"|"desc"|"revision"}} [filter]
     *
     * `order: "desc"` is the drawer's read (newest first, paired with `limit` so
     * the newest N are returned). `order: "revision"` orders by the cursor
     * column itself (`revision ASC, id ASC`) — the SSE stream's read, which the
     * `ix_activities_revision` index satisfies without a sort. The default is
     * `id ASC`, matching the per-task route.
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (filter.taskId !== undefined) {
        clauses.push("task_id = ?");
        values.push(filter.taskId);
      }
      if (filter.afterRevision !== undefined) {
        clauses.push("revision > ?");
        values.push(filter.afterRevision);
      }
      const limit = Number.isInteger(filter.limit) ? filter.limit : 500;
      const direction =
        filter.order === "desc" ? "id DESC" : filter.order === "revision" ? "revision ASC, id ASC" : "id ASC";
      const sql = `SELECT * FROM task_activities
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   ORDER BY ${direction} LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(activityFromRow);
    },
  };
}
