/**
 * Agent sessions — the resume trail (§4.1).
 *
 * The natural key is `(task, seg, owner)`; the primary key is the UUIDv5 of
 * those three, so a segmented agent that restarts lands on the same row instead
 * of inventing a second one.
 */

import { DomainError } from "../../../foundation/errors.mjs";
import { sessionId as deriveSessionId } from "../../../foundation/ids.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const CAMEL = {
  id: "id",
  task_id: "taskId",
  seg: "seg",
  owner: "owner",
  owner_kind: "ownerKind",
  session_id: "sessionId",
  phase: "phase",
  pid: "pid",
  status: "status",
  ts: "ts",
  goal: "goal",
  meta_json: "meta",
};

/**
 * A session's opaque metadata. A broken or non-object value reads as an empty
 * object, the same rule `tasks.meta_json` follows: a bad value must not break a
 * read.
 * @param {unknown} text
 */
function decodeMeta(text) {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** camelCase field → column, for the merge above. */
function toColumn(field) {
  return Object.entries(CAMEL).find(([, name]) => name === field)[0];
}

/** @param {object} row */
export function agentSessionFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  // `meta_json` is TEXT; the DTO carries the decoded object, never the string.
  out.meta = decodeMeta(row.meta_json);
  return out;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createAgentSessionsRepository(db) {
  return {
    /**
     * @param {{taskId: string, seg: string, owner: string, ownerKind: string, sessionId: string, phase?: string|null, pid?: number|null, status?: string, ts: string, goal?: string, meta?: object}} input
     */
    upsertByNaturalKey(input) {
      for (const field of ["taskId", "seg", "owner", "ownerKind", "sessionId"]) {
        if (typeof input[field] !== "string" || input[field].trim() === "") {
          throw new DomainError("VALIDATION_FAILED", {
            message: `agent session ${field} is required`,
            details: { field },
          });
        }
      }
      const id = deriveSessionId(input.taskId, input.owner, input.seg);
      // A re-registration may carry only what changed: fields the caller left
      // out keep their current value instead of being blanked.
      const current = db
        .prepare("SELECT * FROM agent_sessions WHERE task_id = ? AND seg = ? AND owner = ?")
        .get(input.taskId, input.seg, input.owner);
      const merged = { ...input };
      if (current !== undefined) {
        for (const field of ["ownerKind", "sessionId", "phase", "pid", "status", "goal"]) {
          if (merged[field] === undefined) merged[field] = current[toColumn(field)];
        }
      }
      input = merged;
      // `goal` is optional: a new session without one stores the empty sentence,
      // and a re-registration that omits it keeps the one already recorded.
      const goal = input.goal === undefined ? "" : String(input.goal).trim();

      // Metadata is opaque to the board but still a JSON object: a caller that
      // sends an array or a scalar has misunderstood the field. A re-registration
      // merges shallowly, so a harness can set one observation without restating
      // the others; an omitted `meta` keeps the recorded object.
      if (input.meta !== undefined && (input.meta === null || typeof input.meta !== "object" || Array.isArray(input.meta))) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "agent session meta must be an object",
          details: { field: "meta", received: input.meta === null ? "null" : typeof input.meta },
        });
      }
      const currentMeta = current === undefined ? {} : decodeMeta(current.meta_json);
      const meta = input.meta === undefined ? currentMeta : { ...currentMeta, ...input.meta };

      const status = input.status ?? "running";
      if (!["running", "closed", "failed"].includes(status)) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `unknown session status ${JSON.stringify(status)}`,
          details: { field: "status", allowed: ["running", "closed", "failed"] },
        });
      }
      try {
        db.prepare(
          `INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, phase, pid, status, ts, goal, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, seg, owner) DO UPDATE SET
             owner_kind = excluded.owner_kind,
             session_id = excluded.session_id,
             phase = excluded.phase,
             pid = excluded.pid,
             status = excluded.status,
             ts = excluded.ts,
             goal = excluded.goal,
             meta_json = excluded.meta_json`,
        ).run(
          id,
          input.taskId,
          input.seg,
          input.owner,
          input.ownerKind,
          input.sessionId,
          input.phase ?? null,
          input.pid ?? null,
          status,
          input.ts,
          goal,
          JSON.stringify(meta),
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "agentSessions.upsert", table: "agent_sessions" });
      }
      return agentSessionFromRow(db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id));
    },

    /** @param {string} id */
    get(id) {
      return agentSessionFromRow(db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id));
    },

    /** @param {string} id */
    close(id, { ts, status = "closed" } = {}) {
      const info = db
        .prepare("UPDATE agent_sessions SET status = ?, ts = ? WHERE id = ?")
        .run(status, ts, id);
      if (Number(info.changes) === 0) {
        throw new DomainError("NOT_FOUND", { message: `no agent session ${id}`, details: { id } });
      }
      return agentSessionFromRow(db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id));
    },

    /**
     * Close the session named by its natural key, or raise `NOT_FOUND`.
     * @param {string} taskId @param {string} seg @param {string} owner
     * @param {{ts: string, status?: string}} options
     */
    closeByNaturalKey(taskId, seg, owner, { ts, status = "closed" } = {}) {
      const row = db
        .prepare("SELECT id FROM agent_sessions WHERE task_id = ? AND seg = ? AND owner = ?")
        .get(taskId, seg, owner);
      if (row === undefined) {
        throw new DomainError("NOT_FOUND", {
          message: `no agent session for ${taskId}/${seg}/${owner}`,
          details: { taskId, seg, owner },
        });
      }
      return this.close(row.id, { ts, status });
    },

    /** @param {string} taskId */
    listByTask(taskId) {
      return db
        .prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY ts ASC")
        .all(taskId)
        .map(agentSessionFromRow);
    },

    /**
     * Sessions across cards, newest first — the global read. Filters are exact
     * matches; `limit` defaults to 200 (a non-positive value is treated as the
     * default, because SQLite reads a negative LIMIT as "no limit").
     *
     * @param {{owner?: string, ownerKind?: string, status?: string, limit?: number}} [filter]
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (typeof filter.owner === "string" && filter.owner !== "") {
        clauses.push("owner = ?");
        values.push(filter.owner);
      }
      if (typeof filter.ownerKind === "string" && filter.ownerKind !== "") {
        clauses.push("owner_kind = ?");
        values.push(filter.ownerKind);
      }
      if (typeof filter.status === "string" && filter.status !== "") {
        clauses.push("status = ?");
        values.push(filter.status);
      }
      const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
      const sql = `SELECT * FROM agent_sessions
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   ORDER BY ts DESC
                   LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(agentSessionFromRow);
    },

    /**
     * The running session for a (task, seg, owner) triple, if any.
     * @param {string} taskId @param {string} seg @param {string} owner
     */
    find(taskId, seg, owner) {
      return agentSessionFromRow(
        db
          .prepare("SELECT * FROM agent_sessions WHERE task_id = ? AND seg = ? AND owner = ?")
          .get(taskId, seg, owner),
      );
    },
  };
}
