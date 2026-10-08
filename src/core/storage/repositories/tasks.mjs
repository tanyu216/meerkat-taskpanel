/**
 * Tasks — reads, and every write as a compare-and-swap.
 *
 * There is no `save(task)`: a blind write would race. Every mutation states the
 * version it expects, and a 0-row result is turned into the *reason* it lost
 * (version conflict vs. claim lost vs. gone) by re-reading inside the same
 * transaction. That is I1/I3/D4 in one place.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { TASK_COLUMNS, taskFromRow, taskToRow } from "../../domain/task.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";
import { transaction } from "../unit-of-work.mjs";

/** Columns a caller may patch through `updateCas` (camelCase). */
const PATCHABLE = [
  "title",
  "description",
  "priority",
  "kind",
  "labels",
  "sortOrder",
  "assigneeKind",
  "assigneeId",
  "reporterId",
  "agentSession",
  "threadId",
  "threadSource",
  "sourceHash",
  "meta",
];

const SELECT_LIST = TASK_COLUMNS.join(", ");

/** @param {import('node:sqlite').DatabaseSync} db */
export function createTasksRepository(db) {
  const selectById = db.prepare(`SELECT ${SELECT_LIST} FROM tasks WHERE id = ?`);
  const selectByIdentifier = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks WHERE project_id = ? AND identifier = ?`,
  );

  /** @param {string} id */
  const requireTask = (id) => {
    const task = taskFromRow(selectById.get(id));
    if (task === null) {
      throw new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
    }
    return task;
  };

  return {
    /** @param {object} task a Task DTO */
    insert(task) {
      const row = taskToRow(task);
      try {
        db.prepare(
          `INSERT INTO tasks(${TASK_COLUMNS.join(", ")})
           VALUES (${TASK_COLUMNS.map(() => "?").join(", ")})`,
        ).run(...TASK_COLUMNS.map((column) => row[column] ?? null));
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.insert", table: "tasks" });
      }
      return requireTask(task.id);
    },

    get(id) {
      return taskFromRow(selectById.get(id));
    },

    getByIdentifier(projectId, identifier) {
      return taskFromRow(selectByIdentifier.get(projectId, identifier));
    },

    /**
     * Identifier across projects — what an agent has in hand when it types
     * `taskctl issue get PROJ-0007`. Identifiers are only unique per project, so
     * an ambiguous one is refused rather than guessed.
     * @param {string} identifier
     */
    findByIdentifierAnyProject(identifier) {
      const rows = db
        .prepare(`SELECT ${SELECT_LIST} FROM tasks WHERE identifier = ? ORDER BY created_at ASC, project_id ASC LIMIT 2`)
        .all(identifier);
      if (rows.length > 1) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `identifier ${identifier} exists in more than one project — pass the project id`,
          details: { identifier, candidates: rows.length },
        });
      }
      return taskFromRow(rows[0]);
    },

    /** Either id or identifier — whichever the caller has. */
    resolve(projectId, idOrIdentifier) {
      return (
        taskFromRow(selectById.get(idOrIdentifier)) ??
        taskFromRow(selectByIdentifier.get(projectId, idOrIdentifier))
      );
    },

    /**
     * @param {{projectId?: string, status?: string|string[], assigneeId?: string, includeArchived?: boolean, limit?: number, offset?: number}} [filter]
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (filter.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(filter.projectId);
      }
      if (filter.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      }
      if (filter.assigneeId !== undefined) {
        clauses.push("assignee_id = ?");
        values.push(filter.assigneeId);
      }
      if (!filter.includeArchived) clauses.push("archived_at IS NULL");

      const limit = Number.isInteger(filter.limit) ? filter.limit : 200;
      const offset = Number.isInteger(filter.offset) ? filter.offset : 0;
      const sql = `SELECT ${SELECT_LIST} FROM tasks
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   -- Deterministic: two tasks created in the same millisecond
                   -- must not come back in a random order (exports depend on it).
                   ORDER BY sort_order ASC, created_at ASC, project_id ASC, identifier ASC
                   LIMIT ? OFFSET ?`;
      return db
        .prepare(sql)
        .all(...values, limit, offset)
        .map(taskFromRow);
    },

    /**
     * Patch a task if it is still at `ifVersion`.
     *
     * @param {{id: string, ifVersion?: number, patch: object, now: string}} input
     * @returns {object} the updated Task DTO
     */
    updateCas(input) {
      const { id, ifVersion, patch, now } = input;
      const unknown = Object.keys(patch).filter((field) => !PATCHABLE.includes(field));
      if (unknown.length > 0) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `not patchable: ${unknown.join(", ")}`,
          details: { fields: unknown, allowed: PATCHABLE },
        });
      }

      return transaction(
        db,
        () => {
          const row = taskToRow(patch, Object.keys(patch));
          const sets = Object.keys(row).map((column) => `${column} = ?`);
          const values = Object.values(row);
          sets.push("version = version + 1", "updated_at = ?");
          values.push(now);

          const where = ["id = ?"];
          const whereValues = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            whereValues.push(ifVersion);
          }

          let info;
          try {
            info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...values, ...whereValues);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.updateCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.updateCas" },
      );
    },

    /**
     * Claim a `todo` task. Returns `{claimed: false}` when the CAS found nothing
     * — the caller decides why, via `domain/claim.mjs#explainLostClaim`.
     *
     * @param {{id: string, ifVersion?: number, actor: string, now: string}} input
     * @returns {{claimed: boolean, task: object|null}}
     */
    claimCas(input) {
      const { id, ifVersion, actor, now } = input;
      const where = ["id = ?", "status = 'todo'"];
      const values = [id];
      if (ifVersion !== undefined) {
        where.push("version = ?");
        values.push(ifVersion);
      }

      return transaction(
        db,
        () => {
          let info;
          try {
            info = db
              .prepare(
                `UPDATE tasks
                    SET status = 'in_progress', claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
                        status_changed_at = ?, version = version + 1, updated_at = ?
                  WHERE ${where.join(" AND ")}`,
              )
              .run(actor, now, now, now, now, ...values);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.claimCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) return { claimed: false, task: taskFromRow(selectById.get(id)) };
          return { claimed: true, task: requireTask(id) };
        },
        { op: "tasks.claimCas" },
      );
    },

    /**
     * Move a task's status. The delivery gate and the round bump are triggers,
     * so this method passes no policy — only the CAS.
     *
     * `waiver` (F-B1) stamps the three `report_waiver_*` columns in the *same*
     * UPDATE as the status change. That is what makes the trigger's waiver
     * branch see them, and what keeps a waived delivery to one revision.
     *
     * @param {{id: string, ifVersion?: number, to: string, now: string, reportLatestId?: number|null, waiver?: {round: number, reason: string}|null}} input
     */
    moveCas(input) {
      const { id, ifVersion, to, now, reportLatestId, waiver } = input;
      return transaction(
        db,
        () => {
          const sets = ["status = ?", "status_changed_at = ?", "version = version + 1", "updated_at = ?"];
          const values = [to, now, now];
          if (to === "blocked") {
            sets.push("blocked_at = ?");
            values.push(now);
          }
          if (reportLatestId !== undefined) {
            sets.push("report_latest_id = ?");
            values.push(reportLatestId);
          }
          if (waiver !== undefined && waiver !== null) {
            sets.push("report_waiver_round = ?", "report_waiver_reason = ?", "report_waived_at = ?");
            values.push(waiver.round, waiver.reason, waiver.at ?? now);
          }
          const where = ["id = ?"];
          const whereValues = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            whereValues.push(ifVersion);
          }

          let info;
          try {
            info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...values, ...whereValues);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.moveCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.moveCas" },
      );
    },

    /**
     * Take over a task that is `in_progress` but whose claim went stale — the
     * one deliberate exception to "claims only start from todo".
     */
    stealStaleClaim(input) {
      const { id, ifVersion, actor, now } = input;
      return transaction(
        db,
        () => {
          const where = ["id = ?", "status = 'in_progress'"];
          const values = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            values.push(ifVersion);
          }
          const info = db
            .prepare(
              `UPDATE tasks
                  SET claimed_by = ?, claimed_at = ?, heartbeat_at = ?, version = version + 1, updated_at = ?
                WHERE ${where.join(" AND ")}`,
            )
            .run(actor, now, now, now, ...values);
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.stealStaleClaim" },
      );
    },

    /**
     * Refresh the heartbeat. Does not touch `status` or `claimed_by`, so it can
     * never resurrect a task somebody else moved.
     * @param {{id: string, actor: string, now: string}} input
     */
    setHeartbeat(input) {
      const { id, actor, now } = input;
      try {
        const info = db
          .prepare(
            `UPDATE tasks SET heartbeat_at = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND status = 'in_progress' AND claimed_by = ?`,
          )
          .run(now, now, id, actor);
        if (Number(info.changes) === 0) {
          const current = taskFromRow(selectById.get(id));
          if (current === null) {
            throw new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
          }
          throw new DomainError(current.claimedBy === actor ? "INVALID_TRANSITION" : "EXECUTION_ACTIVE", {
            message:
              current.claimedBy === actor
                ? `task ${current.identifier} is ${current.status}, not in_progress — nothing to pulse`
                : `task ${current.identifier} is held by ${current.claimedBy}`,
            details: { taskId: id, status: current.status, claimedBy: current.claimedBy, actor },
          });
        }
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.setHeartbeat", table: "tasks" });
      }
      return requireTask(id);
    },

    /**
     * Point `report_latest_id` at a report. The "it belongs to this task" rule
     * is a trigger (`tr_latest_report_belongs`) — not repeated here.
     *
     * `updated_at` is deliberately untouched: pointing at a report is
     * bookkeeping, not an edit of the card, and bumping the timestamp would
     * make a pure export/import round trip look like a modification.
     * @param {{id: string, reportId: number}} input
     */
    setReportLatest(input) {
      try {
        const info = db
          .prepare("UPDATE tasks SET report_latest_id = ? WHERE id = ?")
          .run(input.reportId, input.id);
        if (Number(info.changes) === 0) {
          throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
        }
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.setReportLatest", table: "tasks" });
      }
      return requireTask(input.id);
    },

    /**
     * Archive a finished task. Status is never touched (I6) — the trigger
     * refuses anything non-terminal, and the waiting period is policy applied by
     * the caller.
     * @param {{id: string, ifVersion?: number, now: string}} input
     */
    archive(input) {
      const { id, ifVersion, now } = input;
      return transaction(
        db,
        () => {
          const where = ["id = ?"];
          const values = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            values.push(ifVersion);
          }
          let info;
          try {
            info = db
              .prepare(`UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ? WHERE ${where.join(" AND ")}`)
              .run(now, now, ...values);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.archive", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.archive" },
      );
    },
  };
}

/**
 * A CAS that matched nothing: say why, from inside the same transaction so the
 * answer cannot itself be stale.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {number|undefined} ifVersion
 */
function lostUpdate(db, id, ifVersion) {
  const current = db.prepare("SELECT id, version FROM tasks WHERE id = ?").get(id);
  if (current === undefined) {
    return new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
  }
  if (ifVersion !== undefined && Number(current.version) !== ifVersion) {
    return new DomainError("VERSION_CONFLICT", {
      message: `task ${id} is at version ${current.version}, expected ${ifVersion} — re-read and retry once`,
      details: { taskId: id, currentVersion: Number(current.version), expectedVersion: ifVersion },
    });
  }
  return new DomainError("VALIDATION_FAILED", {
    message: `task ${id} could not be updated`,
    details: { taskId: id, expectedVersion: ifVersion ?? null, currentVersion: Number(current.version) },
  });
}
