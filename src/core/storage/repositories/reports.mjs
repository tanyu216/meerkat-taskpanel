/**
 * Reports — append-only, one per (task, round).
 *
 * No update, no delete (A6): a wrong report is superseded by the next round's
 * report or by a `change` comment, never edited. `insert` takes a prepared
 * report (see `domain/report.mjs#normalizeReportCreate`).
 */

import { REPORT_COLUMNS, reportFromRow } from "../../domain/report.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";

const SELECT_LIST = REPORT_COLUMNS.join(", ");

/** @param {object} report a prepared report (from `normalizeReportCreate`) */
function toRow(report) {
  return {
    id: report.id ?? null,
    task_id: report.taskId,
    round: report.round,
    seg: report.seg ?? null,
    session_id: report.sessionId ?? null,
    conclusion: report.conclusion,
    acceptance_json: report.acceptanceJson ?? JSON.stringify(report.acceptance ?? []),
    evidence_json: report.evidenceJson ?? JSON.stringify(report.evidence?.items ?? report.evidence ?? []),
    leftovers: report.leftovers ?? null,
    author_kind: report.authorKind,
    author_id: report.authorId,
    source_seq: report.sourceSeq ?? null,
    created_at: report.createdAt,
    // Rows predating 0008 (and any prepared report that does not say) are a
    // delivery — the column's own DEFAULT, restated so the repository never
    // depends on it silently.
    origin: report.origin ?? "delivery",
  };
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function createReportsRepository(db) {
  return {
    /**
     * @param {object} report
     * @returns {object} the stored report DTO (with its assigned id)
     */
    insert(report) {
      const row = toRow(report);
      try {
        const info = db
          .prepare(
            `INSERT INTO task_reports(${REPORT_COLUMNS.filter((c) => c !== "id").join(", ")})
             VALUES (${REPORT_COLUMNS.filter((c) => c !== "id").map(() => "?").join(", ")})`,
          )
          .run(
            ...REPORT_COLUMNS.filter((column) => column !== "id").map((column) => row[column] ?? null),
          );
        return reportFromRow(
          db.prepare(`SELECT ${SELECT_LIST} FROM task_reports WHERE id = ?`).get(Number(info.lastInsertRowid)),
        );
      } catch (err) {
        throw mapSqliteError(err, { op: "reports.insert", table: "task_reports" });
      }
    },

    /** @param {number} id */
    get(id) {
      return reportFromRow(db.prepare(`SELECT ${SELECT_LIST} FROM task_reports WHERE id = ?`).get(id));
    },

    /** @param {string} taskId */
    listByTask(taskId) {
      return db
        .prepare(`SELECT ${SELECT_LIST} FROM task_reports WHERE task_id = ? ORDER BY round ASC`)
        .all(taskId)
        .map(reportFromRow);
    },

    /**
     * The round a delivery is being judged against.
     * @param {string} taskId @param {number} round
     */
    latestForRound(taskId, round) {
      return reportFromRow(
        db
          .prepare(`SELECT ${SELECT_LIST} FROM task_reports WHERE task_id = ? AND round = ?`)
          .get(taskId, round),
      );
    },

    /**
     * Just the round numbers — what the gate needs, and nothing more.
     * @param {string} taskId
     * @returns {number[]}
     */
    listRounds(taskId) {
      return db
        .prepare("SELECT round FROM task_reports WHERE task_id = ? ORDER BY round ASC")
        .all(taskId)
        .map((row) => Number(row.round));
    },

    /**
     * Every report row's round **and** origin — what the delivery gate needs.
     *
     * Deliberately unfiltered: the gate (domain) decides which origins count, so
     * the importer's history rows stay visible to it rather than being hidden by
     * the query. A caller that only wants delivery rounds filters on `origin`.
     *
     * @param {string} taskId
     * @returns {{round: number, origin: string}[]}
     */
    listGateReports(taskId) {
      return db
        .prepare("SELECT round, origin FROM task_reports WHERE task_id = ? ORDER BY round ASC")
        .all(taskId)
        .map((row) => ({ round: Number(row.round), origin: String(row.origin) }));
    },

    /** @param {string} taskId */
    count(taskId) {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM task_reports WHERE task_id = ?").get(taskId).n);
    },

    /** Highest round on file, or 0. @param {string} taskId */
    latestRound(taskId) {
      const row = db.prepare("SELECT MAX(round) AS r FROM task_reports WHERE task_id = ?").get(taskId);
      return row.r === null ? 0 : Number(row.r);
    },
  };
}
