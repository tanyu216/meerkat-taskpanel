/**
 * Projects — the workspace anchor every task hangs off.
 *
 * `allocateIdentifier` lives here because identifier allocation is a property of
 * the project row (`next_task_number`): taking it and using it must happen in
 * one transaction, or two concurrent creates hand out the same number.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { newId } from "../../../shared/ids.mjs";
import { identifierFor, normalizeWorkspacePath, assertIsoMillis } from "../../domain/task.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";
import { transaction } from "../unit-of-work.mjs";

const CAMEL = {
  id: "id",
  name: "name",
  workspace_path: "workspacePath",
  next_task_number: "nextTaskNumber",
  labels: "labels",
  meta_json: "meta",
  readme: "readme",
  archived_at: "archivedAt",
  created_at: "createdAt",
  updated_at: "updatedAt",
};

/** @param {object} row */
export function projectFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  out.labels = decodeJson(row.labels, []);
  out.meta = decodeJson(row.meta_json, {});
  return out;
}

function decodeJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createProjectsRepository(db) {
  const selectById = db.prepare("SELECT * FROM projects WHERE id = ?");
  const selectByWorkspace = db.prepare("SELECT * FROM projects WHERE workspace_path = ?");

  return {
    /** @param {{id?: string, name: string, workspacePath: string, labels?: unknown, meta?: object, readme?: string|null, now: string}} input */
    create(input) {
      const now = input.now;
      assertIsoMillis(now, "now");
      const id = input.id ?? newId();
      if (typeof input.name !== "string" || input.name.trim() === "") {
        throw new DomainError("VALIDATION_FAILED", { message: "project name is required", details: { field: "name" } });
      }
      const workspacePath = normalizeWorkspacePath(input.workspacePath);
      try {
        db.prepare(
          `INSERT INTO projects(id, name, workspace_path, next_task_number, labels, meta_json, readme, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.name.trim(),
          workspacePath,
          JSON.stringify(input.labels ?? []),
          JSON.stringify(input.meta ?? {}),
          input.readme ?? null,
          now,
          now,
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "projects.create", table: "projects" });
      }
      return projectFromRow(selectById.get(id));
    },

    /** @param {string} id */
    get(id) {
      return projectFromRow(selectById.get(id));
    },

    /** @param {string} workspacePath */
    getByWorkspace(workspacePath) {
      return projectFromRow(selectByWorkspace.get(workspacePath));
    },

    /**
     * Projects whose workspace path is a prefix of `path` — how the CLI decides
     * which project the current directory belongs to (§4.4, "自动归属").
     * @param {string} path
     */
    listForPath(path) {
      const rows = db
        .prepare("SELECT * FROM projects ORDER BY length(workspace_path) DESC")
        .all();
      return rows.map(projectFromRow).filter((project) => path === project.workspacePath || path.startsWith(`${project.workspacePath}/`));
    },

    /** @param {{includeArchived?: boolean}} [options] */
    list(options = {}) {
      const sql = options.includeArchived
        ? "SELECT * FROM projects ORDER BY name"
        : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name";
      return db.prepare(sql).all().map(projectFromRow);
    },

    /**
     * @param {string} id
     * @param {{name?: string, workspacePath?: string, labels?: unknown, meta?: object, readme?: string|null, now: string}} patch
     */
    update(id, patch) {
      assertIsoMillis(patch.now, "now");
      const sets = [];
      const values = [];
      if (patch.name !== undefined) {
        sets.push("name = ?");
        values.push(patch.name);
      }
      if (patch.workspacePath !== undefined) {
        sets.push("workspace_path = ?");
        values.push(normalizeWorkspacePath(patch.workspacePath));
      }
      if (patch.labels !== undefined) {
        sets.push("labels = ?");
        values.push(JSON.stringify(patch.labels));
      }
      if (patch.meta !== undefined) {
        sets.push("meta_json = ?");
        values.push(JSON.stringify(patch.meta));
      }
      if (patch.readme !== undefined) {
        sets.push("readme = ?");
        values.push(patch.readme);
      }
      if (sets.length === 0) {
        throw new DomainError("VALIDATION_FAILED", { message: "project patch is empty" });
      }
      sets.push("updated_at = ?");
      values.push(patch.now, id);
      try {
        const info = db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        if (Number(info.changes) === 0) {
          throw new DomainError("NOT_FOUND", { message: `no project ${id}`, details: { projectId: id } });
        }
      } catch (err) {
        throw mapSqliteError(err, { op: "projects.update", table: "projects" });
      }
      return projectFromRow(selectById.get(id));
    },

    /**
     * Reserve the next human-readable identifier. Must run inside the caller's
     * transaction (savepoint-aware) — the counter read and bump are two
     * statements.
     *
     * @param {string} projectId
     * @returns {{serial: number, identifier: string}}
     */
    allocateIdentifier(projectId) {
      return transaction(
        db,
        () => {
          const row = db.prepare("SELECT next_task_number, id FROM projects WHERE id = ?").get(projectId);
          if (row === undefined) {
            throw new DomainError("NOT_FOUND", { message: `no project ${projectId}`, details: { projectId } });
          }
          const serial = Number(row.next_task_number);
          db.prepare("UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ?").run(projectId);
          return { serial, identifier: identifierFor(projectId, serial) };
        },
        { op: "projects.allocateIdentifier" },
      );
    },

    /**
     * @param {string} projectId
     * @returns {Record<string, number>} status → count, archived tasks included
     */
    countByStatus(projectId) {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status")
        .all(projectId);
      return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
    },
  };
}
