/**
 * Agent sessions — the resume trail (§4.1).
 *
 * The natural key is `(task, seg, owner)`; the primary key is the UUIDv5 of
 * those three, so a segmented agent that restarts lands on the same row instead
 * of inventing a second one.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { sessionId as deriveSessionId } from "../../../shared/ids.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const CAMEL = {
  id: "id",
  task_id: "taskId",
  seg: "seg",
  owner: "owner",
  backend: "backend",
  session_id: "sessionId",
  phase: "phase",
  pid: "pid",
  status: "status",
  ts: "ts",
};

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
  return out;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createAgentSessionsRepository(db) {
  return {
    /**
     * @param {{taskId: string, seg: string, owner: string, backend: string, sessionId: string, phase?: string|null, pid?: number|null, status?: string, ts: string}} input
     */
    upsertByNaturalKey(input) {
      for (const field of ["taskId", "seg", "owner", "backend", "sessionId"]) {
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
        for (const field of ["backend", "sessionId", "phase", "pid", "status"]) {
          if (merged[field] === undefined) merged[field] = current[toColumn(field)];
        }
      }
      input = merged;

      const status = input.status ?? "running";
      if (!["running", "closed", "failed"].includes(status)) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `unknown session status ${JSON.stringify(status)}`,
          details: { field: "status", allowed: ["running", "closed", "failed"] },
        });
      }
      try {
        db.prepare(
          `INSERT INTO agent_sessions(id, task_id, seg, owner, backend, session_id, phase, pid, status, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, seg, owner) DO UPDATE SET
             backend = excluded.backend,
             session_id = excluded.session_id,
             phase = excluded.phase,
             pid = excluded.pid,
             status = excluded.status,
             ts = excluded.ts`,
        ).run(
          id,
          input.taskId,
          input.seg,
          input.owner,
          input.backend,
          input.sessionId,
          input.phase ?? null,
          input.pid ?? null,
          status,
          input.ts,
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

    /** @param {string} taskId */
    listByTask(taskId) {
      return db
        .prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY ts ASC")
        .all(taskId)
        .map(agentSessionFromRow);
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
