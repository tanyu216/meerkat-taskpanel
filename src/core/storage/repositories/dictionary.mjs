/**
 * The actor dictionary — upsert and read.
 *
 * Since `0019` there is **one** table, `actors`, keyed by `UNIQUE(normalized_name)`.
 * `assignee`/`reporter` survive only as **roles** — the name of the `tasks`
 * column a task fills (`assignee_id` / `reporter_id`) — so both role names map to
 * the same table. The role a caller names still selects *which column the delete
 * guard and `refCount` check*, which is why the reference column is keyed by role
 * (kind) rather than by table: the table can no longer tell them apart.
 *
 * `remove` exists for the reference-protection trigger to be testable and is
 * deliberately *not* wired into any command: there is no management surface
 * (§4.4). Nothing else here is exported upward.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { newId } from "../../../shared/ids.mjs";
import { dictionaryEntryFromRow } from "../../domain/dictionary.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

/**
 * name → table. Every role lives in `actors` now; the whitelist stays because the
 * table name cannot be a bound parameter and an unknown name must still be
 * refused rather than silently mapped. `actor`/`actors` name the role-less read —
 * the whole dictionary, which is what the merged `GET /api/v1/actors` asks for.
 */
export const DICTIONARY_TABLES = Object.freeze({
  actor: "actors",
  actors: "actors",
  assignee: "actors",
  reporter: "actors",
  assignees: "actors",
  reporters: "actors",
});

/** @param {unknown} kind */
export function dictionaryTable(kind) {
  const table = DICTIONARY_TABLES[/** @type {string} */ (kind)];
  if (table === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown dictionary kind ${JSON.stringify(kind)}`,
      details: { field: "kind", received: kind, allowed: ["assignee", "reporter", "actor"] },
    });
  }
  return table;
}

/**
 * Which `tasks` column references this **role** (kind). Keyed by role, not by
 * table, because one table now answers both columns — `actors` cannot say which
 * of `assignee_id` / `reporter_id` to look at.
 */
const REFERENCE_COLUMN = { assignee: "assignee_id", reporter: "reporter_id", assignees: "assignee_id", reporters: "reporter_id" };

/** @param {import('node:sqlite').DatabaseSync} db */
export function createDictionaryRepository(db) {
  return {
    /**
     * Insert-or-touch. The same normalised name never creates a second row, and
     * a repeat visit only moves `last_seen_at`/`use_count` — the display name
     * the dictionary already agreed on is kept.
     *
     * `kind` is the **role** (assignee vs reporter) and only decides which
     * `tasks` column a later `refCount`/delete-guard reads. The row itself is one
     * per `normalized_name`, whichever role asked for it — so a repeat visit
     * through the *other* role touches the same row rather than creating a twin.
     *
     * **The row holds no actor kind** (since `0023`): a kind describes an act, and
     * this table is one row per person. The caller records the kind on the
     * reference it is making — `tasks.assignee_kind`, `comments.author_kind`, …
     *
     * @param {{kind: "assignee"|"reporter", normalizedName: string, displayName: string, now: string, id?: string}} input
     * @returns {{action: "created"|"reused", entry: object}}
     */
    upsert(input) {
      const table = dictionaryTable(input.kind);
      const id = input.id ?? newId();
      try {
        const existing = db
          .prepare(`SELECT * FROM ${table} WHERE normalized_name = ?`)
          .get(input.normalizedName);

        if (existing === undefined) {
          db.prepare(
            `INSERT INTO ${table}(id, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
             VALUES (?, ?, ?, ?, ?, 1)`,
          ).run(id, input.displayName, input.normalizedName, input.now, input.now);
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
     *
     * The name defaults to the role-less read (`"actor"`): since both roles are
     * one table, the query is the same whichever name is given, and the merged
     * `GET /api/v1/actors` asks for the whole dictionary.
     *
     * @param {"assignee"|"reporter"|"actor"} [kind]
     * @param {{q?: string, limit?: number}} [options]
     */
    search(kind = "actor", options = {}) {
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
     * Every entry — what the resolver matches against. Role-agnostic (see
     * `search`): one table, one list.
     * @param {"assignee"|"reporter"|"actor"} [kind]
     */
    list(kind = "actor") {
      const table = dictionaryTable(kind);
      return db.prepare(`SELECT * FROM ${table} ORDER BY display_name ASC`).all().map(dictionaryEntryFromRow);
    },

    /**
     * How many tasks point at this entry (0 means it is safe to delete).
     * @param {"assignee"|"reporter"} kind @param {string} id
     */
    refCount(kind, id) {
      dictionaryTable(kind); // validate the role, then read its column
      const column = REFERENCE_COLUMN[kind];
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${column} = ?`).get(id).n);
    },

    /**
     * Delete an entry. Refused by the database while a task references it
     * (`tr_dict_actors_delete` → DICTIONARY_ENTRY_IN_USE). Not exposed as a command.
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
