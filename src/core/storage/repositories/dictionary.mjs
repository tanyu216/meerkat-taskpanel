/**
 * The dictionary tables — upsert and read.
 *
 * `remove` exists for the reference-protection trigger to be testable and is
 * deliberately *not* wired into any command: there is no management surface
 * (§4.4). Nothing else here is exported upward.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { newId } from "../../../shared/ids.mjs";
import { dictionaryEntryFromRow } from "../../domain/dictionary.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

/** kind → table. A whitelist, because the table name cannot be a bound parameter. */
export const DICTIONARY_TABLES = Object.freeze({
  assignee: "assignees",
  reporter: "reporters",
  assignees: "assignees",
  reporters: "reporters",
});

/** @param {unknown} kind */
export function dictionaryTable(kind) {
  const table = DICTIONARY_TABLES[/** @type {string} */ (kind)];
  if (table === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown dictionary kind ${JSON.stringify(kind)}`,
      details: { field: "kind", received: kind, allowed: ["assignee", "reporter"] },
    });
  }
  return table;
}

/** Which `tasks` column references this dictionary kind. */
const REFERENCE_COLUMN = { assignees: "assignee_id", reporters: "reporter_id" };

/** @param {import('node:sqlite').DatabaseSync} db */
export function createDictionaryRepository(db) {
  return {
    /**
     * Insert-or-touch. The same normalised name never creates a second row, and
     * a repeat visit only moves `last_seen_at`/`use_count` — the display name
     * the dictionary already agreed on is kept.
     *
     * `kind` selects the *table* (assignee vs reporter); `actorKind` is the
     * `agent|human` value stored in the row. They are different axes and it is
     * worth being explicit about it.
     *
     * @param {{kind: "assignee"|"reporter", actorKind: "agent"|"human", normalizedName: string, displayName: string, platform?: string|null, now: string, id?: string}} input
     * @returns {{action: "created"|"reused", entry: object}}
     */
    upsert(input) {
      const table = dictionaryTable(input.kind);
      if (!["agent", "human"].includes(input.actorKind)) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `actorKind must be agent or human, got ${JSON.stringify(input.actorKind)}`,
          details: { field: "actorKind", received: input.actorKind, allowed: ["agent", "human"] },
        });
      }
      const id = input.id ?? newId();
      try {
        const existing = db
          .prepare(`SELECT * FROM ${table} WHERE normalized_name = ? AND kind = ?`)
          .get(input.normalizedName, input.actorKind);

        if (existing === undefined) {
          db.prepare(
            `INSERT INTO ${table}(id, kind, display_name, normalized_name, platform, first_seen_at, last_seen_at, use_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            id,
            input.actorKind,
            input.displayName,
            input.normalizedName,
            input.platform ?? null,
            input.now,
            input.now,
          );
          return {
            action: "created",
            entry: dictionaryEntryFromRow(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)),
          };
        }

        db.prepare(
          `UPDATE ${table} SET last_seen_at = ?, use_count = use_count + 1 WHERE id = ?`,
        ).run(input.now, existing.id);
        return {
          action: "reused",
          entry: dictionaryEntryFromRow(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id)),
        };
      } catch (err) {
        throw mapSqliteError(err, { op: "dictionary.upsert", table });
      }
    },

    /** @param {"assignee"|"reporter"} kind @param {string} id */
    getById(kind, id) {
      const table = dictionaryTable(kind);
      return dictionaryEntryFromRow(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
    },

    /**
     * Substring search, for autocomplete (§4.4).
     * @param {"assignee"|"reporter"} kind
     * @param {{q?: string, limit?: number}} [options]
     */
    search(kind, options = {}) {
      const table = dictionaryTable(kind);
      const q = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
      const limit = Number.isInteger(options.limit) ? options.limit : 20;
      const sql = q === ""
        ? `SELECT * FROM ${table} ORDER BY use_count DESC, display_name ASC LIMIT ?`
        : `SELECT * FROM ${table} WHERE normalized_name LIKE ? OR display_name LIKE ? ORDER BY use_count DESC, display_name ASC LIMIT ?`;
      const rows = q === ""
        ? db.prepare(sql).all(limit)
        : db.prepare(sql).all(`%${q}%`, `%${options.q.trim()}%`, limit);
      return rows.map(dictionaryEntryFromRow);
    },

    /**
     * Every entry of a kind — what the resolver matches against.
     * @param {"assignee"|"reporter"} kind
     */
    list(kind) {
      const table = dictionaryTable(kind);
      return db.prepare(`SELECT * FROM ${table} ORDER BY display_name ASC`).all().map(dictionaryEntryFromRow);
    },

    /**
     * How many tasks point at this entry (0 means it is safe to delete).
     * @param {"assignee"|"reporter"} kind @param {string} id
     */
    refCount(kind, id) {
      const table = dictionaryTable(kind);
      const column = REFERENCE_COLUMN[table];
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${column} = ?`).get(id).n);
    },

    /**
     * Delete an entry. Refused by the database while a task references it
     * (`tr_dict_*_delete` → DICTIONARY_ENTRY_IN_USE). Not exposed as a command.
     * @param {"assignee"|"reporter"} kind @param {string} id
     */
    remove(kind, id) {
      const table = dictionaryTable(kind);
      try {
        return Number(db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes) === 1;
      } catch (err) {
        throw mapSqliteError(err, { op: "dictionary.remove", table });
      }
    },
  };
}
