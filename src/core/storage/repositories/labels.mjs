/**
 * The `labels` table — the registry behind the display names on `tasks.labels`.
 *
 * A label row is created the first time a task names it, coloured once, then
 * counted. `use_count` is the number of **non-archived** tasks currently naming
 * it (F5-B): `addUse` bumps it and refreshes `last_seen_at`, `removeUse` drops it
 * (floored at 0) and leaves the timestamp alone, and archiving a task removes one
 * use per label it carried. That is what lets an unused label eventually reach
 * the GC's `use_count = 0` precondition.
 *
 * The reference *scan* (`referenceCount`) reads `tasks.labels`, which stores
 * display-name strings (F3-B). The comparison is by `norm`, so it is done in JS —
 * SQLite's `lower()` is ASCII-only and cannot reproduce NFKC or whitespace
 * removal, and getting it wrong would silently under-count and mis-archive.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { newId } from "../../../shared/ids.mjs";
import { LABEL_COLUMNS, labelFromRow, normalizeLabelName } from "../../domain/labels.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

/** Parse a `tasks.labels` JSON array into display names; junk reads as empty. */
function decodeLabels(text) {
  if (text === null || text === undefined || text === "") return [];
  let parsed = text;
  if (typeof text === "string") {
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.map((name) => String(name)) : [];
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createLabelsRepository(db) {
  const SELECT_LIST = LABEL_COLUMNS.join(", ");
  const selectById = db.prepare(`SELECT ${SELECT_LIST} FROM labels WHERE id = ?`);
  const selectByNorm = db.prepare(`SELECT ${SELECT_LIST} FROM labels WHERE project_id = ? AND norm = ?`);

  return {
    /**
     * Register a label. The identity is `(project_id, norm)` and the unique index
     * counts archived rows too, so a label whose spelling comes back after GC
     * **resurrects** its old row — same id, same colour, same first-seen display
     * name — rather than creating a second one.
     *
     * @param {{projectId: string, norm: string, displayName: string, color: string, now: string, id?: string}} input
     * @returns {{action: "created"|"reused"|"resurrected", entry: object}}
     */
    upsert(input) {
      const { projectId, norm, displayName, color, now } = input;
      const id = input.id ?? newId();
      try {
        const existing = selectByNorm.get(projectId, norm);
        if (existing === undefined) {
          db.prepare(
            `INSERT INTO labels(id, project_id, norm, display_name, color, use_count, first_seen_at, last_seen_at, archived_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
          ).run(id, projectId, norm, displayName, color, now, now);
          return { action: "created", entry: labelFromRow(selectById.get(id)) };
        }
        if (existing.archived_at !== null) {
          db.prepare("UPDATE labels SET archived_at = NULL WHERE id = ?").run(existing.id);
          return { action: "resurrected", entry: labelFromRow(selectById.get(existing.id)) };
        }
        // Reuse keeps the dictionary's own spelling and colour: first-seen wins.
        return { action: "reused", entry: labelFromRow(existing) };
      } catch (err) {
        throw mapSqliteError(err, { op: "labels.upsert", table: "labels" });
      }
    },

    /** @param {string} projectId @param {string} norm */
    getByNorm(projectId, norm) {
      return labelFromRow(selectByNorm.get(projectId, norm));
    },

    /** @param {string} id */
    getById(id) {
      return labelFromRow(selectById.get(id));
    },

    /**
     * @param {{projectId?: string, q?: string, limit?: number, includeArchived?: boolean}} [filter]
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (filter.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(filter.projectId);
      }
      if (!filter.includeArchived) clauses.push("archived_at IS NULL");
      const q = typeof filter.q === "string" ? filter.q.trim() : "";
      if (q !== "") {
        clauses.push("(display_name LIKE ? OR norm LIKE ?)");
        values.push(`%${q}%`, `%${q.toLowerCase()}%`);
      }
      const limit = Number.isInteger(filter.limit) ? filter.limit : 200;
      const sql = `SELECT ${SELECT_LIST} FROM labels
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   ORDER BY use_count DESC, display_name ASC, project_id ASC
                   LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(labelFromRow);
    },

    /**
     * Every colour a project's **non-archived** labels currently use — the input
     * to `nextColor`.
     * @param {string} projectId
     * @returns {string[]}
     */
    usedColors(projectId) {
      return db
        .prepare("SELECT color FROM labels WHERE project_id = ? AND archived_at IS NULL")
        .all(projectId)
        .map((row) => String(row.color));
    },

    /**
     * How many **non-archived** tasks of a project currently name this label.
     *
     * This is the live reference scan the GC reconciles `use_count` against
     * before archiving (F3-B). It must agree with `use_count`; when it does not,
     * the GC skips the archive rather than risk dropping a label a card shows.
     *
     * @param {string} projectId
     * @param {string} norm
     * @returns {number}
     */
    referenceCount(projectId, norm) {
      const rows = db
        .prepare("SELECT labels FROM tasks WHERE project_id = ? AND archived_at IS NULL")
        .all(projectId);
      let count = 0;
      for (const row of rows) {
        let hit = false;
        for (const name of decodeLabels(row.labels)) {
          try {
            if (normalizeLabelName(name) === norm) {
              hit = true;
              break;
            }
          } catch {
            /* a stored label that cannot be normalised simply does not match */
          }
        }
        if (hit) count += 1;
      }
      return count;
    },

    /**
     * Record one more live reference: `use_count + 1`, and — only here — refresh
     * `last_seen_at` (F5-B: a remove must not extend a label's life).
     * @param {string} id @param {string} now
     */
    addUse(id, now) {
      const info = db
        .prepare("UPDATE labels SET use_count = use_count + 1, last_seen_at = ? WHERE id = ?")
        .run(now, id);
      if (Number(info.changes) === 0) {
        throw new DomainError("NOT_FOUND", { message: `no label ${id}`, details: { labelId: id } });
      }
      return labelFromRow(selectById.get(id));
    },

    /**
     * Drop one live reference, floored at 0. `last_seen_at` is untouched on
     * purpose: removing a use must not keep the label alive.
     * @param {string} id
     */
    removeUse(id) {
      const info = db
        .prepare("UPDATE labels SET use_count = MAX(use_count - 1, 0) WHERE id = ?")
        .run(id);
      if (Number(info.changes) === 0) {
        throw new DomainError("NOT_FOUND", { message: `no label ${id}`, details: { labelId: id } });
      }
      return labelFromRow(selectById.get(id));
    },

    /**
     * Soft-delete: set `archived_at`. There is no physical delete anywhere (§4.4).
     * @param {string} id @param {string} now
     * @returns {boolean} whether a row moved (false = already archived/absent)
     */
    archive(id, now) {
      try {
        const info = db
          .prepare("UPDATE labels SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
          .run(now, id);
        return Number(info.changes) === 1;
      } catch (err) {
        throw mapSqliteError(err, { op: "labels.archive", table: "labels" });
      }
    },

    /**
     * The GC's cheapest candidate set: active labels nothing currently counts as
     * used. The TTL check and the reference-scan reconciliation are applied
     * afterwards, by the command.
     * @returns {object[]}
     */
    listUnusedActive() {
      return db
        .prepare(
          `SELECT ${SELECT_LIST} FROM labels
            WHERE use_count = 0 AND archived_at IS NULL
            ORDER BY last_seen_at ASC, id ASC`,
        )
        .all()
        .map(labelFromRow);
    },
  };
}
