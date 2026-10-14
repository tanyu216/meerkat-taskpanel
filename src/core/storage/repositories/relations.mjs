/**
 * Relations — add, remove, and the graph walks.
 *
 * Direction is normalised by `domain/relation.mjs` before anything reaches
 * here, and the invariants (single parent, no cycles, chain/fan-in caps,
 * cross-project, immutability) are triggers. This repository therefore never
 * re-implements a rule; it just reads and writes edges.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { normalizeRelation } from "../../domain/relation.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const CAMEL = {
  id: "id",
  relation_type: "type",
  source_task_id: "source",
  target_task_id: "target",
  origin: "origin",
  created_at: "createdAt",
};

/** @param {object} row */
export function relationFromRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    out[field] = row[column] === undefined ? null : row[column];
  }
  return out;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createRelationsRepository(db) {
  return {
    /**
     * @param {{type: string, source: string, target: string, origin?: string, now: string}} input
     * @returns {object} the stored relation, with the direction it was stored in
     */
    insert(input) {
      const edge = normalizeRelation({ type: input.type, source: input.source, target: input.target });
      try {
        const info = db
          .prepare(
            "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, origin, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(edge.type, edge.source, edge.target, input.origin ?? null, input.now);
        return relationFromRow(
          db.prepare("SELECT * FROM task_relations WHERE id = ?").get(Number(info.lastInsertRowid)),
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "relations.insert", table: "task_relations" });
      }
    },

    /** @param {number} id */
    get(id) {
      return relationFromRow(db.prepare("SELECT * FROM task_relations WHERE id = ?").get(id));
    },

    /** @param {{type: string, source: string, target: string}} edge */
    find(edge) {
      const normalized = normalizeRelation(edge);
      return relationFromRow(
        db
          .prepare(
            "SELECT * FROM task_relations WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?",
          )
          .get(normalized.type, normalized.source, normalized.target),
      );
    },

    /** @param {number} id @returns {boolean} */
    remove(id) {
      const info = db.prepare("DELETE FROM task_relations WHERE id = ?").run(id);
      return Number(info.changes) === 1;
    },

    /** @param {string} taskId */
    listByTask(taskId) {
      return db
        .prepare(
          "SELECT * FROM task_relations WHERE source_task_id = ? OR target_task_id = ? ORDER BY id",
        )
        .all(taskId, taskId)
        .map(relationFromRow);
    },

    /**
     * Children of `parentId` — `parent` edges pointing away from it.
     * @param {string} parentId
     */
    listChildren(parentId) {
      return db
        .prepare("SELECT * FROM task_relations WHERE relation_type = 'parent' AND source_task_id = ? ORDER BY id")
        .all(parentId)
        .map(relationFromRow);
    },

    /**
     * The single parent of `childId`, if it has one.
     * @param {string} childId
     */
    getParent(childId) {
      return relationFromRow(
        db
          .prepare("SELECT * FROM task_relations WHERE relation_type = 'parent' AND target_task_id = ?")
          .get(childId),
      );
    },

    /**
     * Ancestors via a recursive CTE — the same walk the cycle guard uses, so a
     * service-level answer matches the trigger's.
     * @param {string} taskId
     */
    listAncestors(taskId) {
      return db
        .prepare(
          `WITH RECURSIVE anc(id, relation_id, depth) AS (
             SELECT t.id, NULL, 0 FROM tasks t WHERE t.id = ?
             UNION ALL
             SELECT r.source_task_id, r.id, anc.depth + 1
               FROM task_relations r JOIN anc ON r.target_task_id = anc.id
              WHERE r.relation_type = 'parent' AND anc.depth < 64
           )
           SELECT t.* FROM anc JOIN tasks t ON t.id = anc.id WHERE anc.depth > 0 ORDER BY anc.depth`,
        )
        .all(taskId)
        .map((row) => ({
          id: String(row.id),
          identifier: String(row.identifier),
          title: String(row.title),
          status: String(row.status),
          kind: String(row.kind),
        }));
    },

    /**
     * Who blocks `taskId` directly.
     * @param {string} taskId
     */
    listBlockerOf(taskId) {
      return db
        .prepare("SELECT * FROM task_relations WHERE relation_type = 'blocks' AND target_task_id = ? ORDER BY id")
        .all(taskId)
        .map(relationFromRow);
    },

    /** Everything `taskId` blocks. @param {string} taskId */
    listBlockedBy(taskId) {
      return db
        .prepare("SELECT * FROM task_relations WHERE relation_type = 'blocks' AND source_task_id = ? ORDER BY id")
        .all(taskId)
        .map(relationFromRow);
    },

    /**
     * The batched form of `listBlockedBy` / `listBlockerOf` over a whole scope.
     *
     * The weight order needs, per card, how many open `blocks` edges point *at*
     * it (does a dependency still hold it up?) and how many point *away* from it
     * (how much does finishing it unlock?). Asking card by card is an N+1 — one
     * query per candidate, on every poll — so this reads every edge touching the
     * scope in **one** statement and joins both endpoints' status, letting the
     * caller count without a second read.
     *
     * "Open" means the other end is not `done`: a finished card neither blocks
     * nor is worth unlocking. A missing row in the result means "no edges", so a
     * caller defaults to `{blockersOpen: 0, unblocksOpen: 0}` — never `undefined`,
     * which would flow into the score as a `NaN`.
     *
     * @param {string[]} taskIds
     * @returns {Map<string, {blockersOpen: number, unblocksOpen: number}>}
     */
    openEdgeCounts(taskIds) {
      const ids = [...new Set((taskIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
      const counts = new Map(ids.map((id) => [id, { blockersOpen: 0, unblocksOpen: 0 }]));
      if (ids.length === 0) return counts;

      const marks = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT r.source_task_id AS source, r.target_task_id AS target,
                  src.status AS source_status, dst.status AS target_status
             FROM task_relations r
             JOIN tasks src ON src.id = r.source_task_id
             JOIN tasks dst ON dst.id = r.target_task_id
            WHERE r.relation_type = 'blocks'
              AND (r.source_task_id IN (${marks}) OR r.target_task_id IN (${marks}))`,
        )
        .all(...ids, ...ids);

      for (const row of rows) {
        if (row.target_status !== "done") {
          const source = counts.get(row.source);
          if (source !== undefined) source.unblocksOpen += 1;
        }
        if (row.source_status !== "done") {
          const target = counts.get(row.target);
          if (target !== undefined) target.blockersOpen += 1;
        }
      }
      return counts;
    },

    /** @param {string} [projectId] all `parent` edges (for the pure validators) */
    listParentEdges(projectId) {
      const sql =
        projectId === undefined
          ? "SELECT * FROM task_relations WHERE relation_type = 'parent' ORDER BY id"
          : `SELECT r.* FROM task_relations r JOIN tasks t ON t.id = r.source_task_id
             WHERE r.relation_type = 'parent' AND t.project_id = ? ORDER BY r.id`;
      const rows = projectId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(projectId);
      return rows.map(relationFromRow).map(({ source, target }) => ({ source, target }));
    },

    /**
     * Every `blocks` edge, as `{source, target}` pairs (source = the blocker).
     *
     * The dependency graph is a DAG — `README.md` §3 says so and a cycle is a
     * scheduling deadlock — and this is the read the pure cycle check walks
     * (`domain/relation.mjs#wouldCreateBlockCycle`). It is deliberately the whole
     * table rather than a per-task read: a cycle is a property of the graph, so
     * the check needs the graph, exactly as `listParentEdges` does for the parent
     * one.
     */
    listBlockEdges() {
      return db
        .prepare("SELECT * FROM task_relations WHERE relation_type = 'blocks' ORDER BY id")
        .all()
        .map(relationFromRow)
        .map(({ source, target }) => ({ source, target }));
    },

    /**
     * Relation counts per task, for the board rollup.
     * @param {string} taskId
     */
    countByTask(taskId) {
      const row = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_relations WHERE relation_type = 'parent' AND source_task_id = ?) AS children,
             (SELECT COUNT(*) FROM task_relations WHERE relation_type = 'blocks' AND target_task_id = ?) AS blockers`,
        )
        .get(taskId, taskId);
      return { children: Number(row.children), blockers: Number(row.blockers) };
    },
  };
}

/** Guard for callers that only have a task id and a type. */
export function assertRelationType(type) {
  if (!["parent", "blocks", "related"].includes(type)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown relation type ${JSON.stringify(type)}`,
      details: { field: "type", received: type },
    });
  }
  return type;
}
