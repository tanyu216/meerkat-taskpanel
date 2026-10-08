/**
 * `task_activities` — the audit trail every write command leaves behind.
 *
 * One row per command (asserted in the command tests), carrying the global
 * revision the command produced so a client holding a cursor can find it.
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
     * @param {{taskId?: string, afterRevision?: number, afterId?: number, limit?: number}} [filter]
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
      if (filter.afterId !== undefined) {
        clauses.push("id > ?");
        values.push(filter.afterId);
      }
      const limit = Number.isInteger(filter.limit) ? filter.limit : 500;
      const sql = `SELECT * FROM task_activities
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   ORDER BY id ASC LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(activityFromRow);
    },

    /** @param {string} taskId */
    count(taskId) {
      const row =
        taskId === undefined
          ? db.prepare("SELECT COUNT(*) AS n FROM task_activities").get()
          : db.prepare("SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ?").get(taskId);
      return Number(row.n);
    },
  };
}
