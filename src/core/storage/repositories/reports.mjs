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
    // 0033 — only an epic's delivery report is a rollup; the writer sets this
    // from the card's kind, never from a caller-supplied payload field.
    is_rollup: report.isRollup === true ? 1 : 0,
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
     * Every report row's round **and** rollup marker — what the delivery gate
     * needs.
     *
     * A light projection rather than full rows: the gate only asks whether the
     * current round has one (and, for an epic, whether it is the rollup). 0035
     * removed the provenance filter, so there is no origin to carry.
     *
     * @param {string} taskId
     * @returns {{round: number, isRollup: boolean}[]}
     */
    listGateReports(taskId) {
      return db
        .prepare("SELECT round, is_rollup FROM task_reports WHERE task_id = ? ORDER BY round ASC")
        .all(taskId)
        .map((row) => ({
          round: Number(row.round),
          isRollup: Number(row.is_rollup ?? 0) === 1,
        }));
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
