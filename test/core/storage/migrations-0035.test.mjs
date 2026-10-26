/**
 * 0035 — a report is a report.
 *
 * Four properties:
 *
 *   1. the `task_reports` rebuild keeps every row and drops `origin`;
 *   2. a row that a pre-0035 board called `import` is now the current round's
 *      report and opens the delivery gate — the semantic change is deliberate;
 *   3. the append-only, actor-guard and rollup triggers survive the rebuild;
 *   4. the scratch table is renamed away and foreign keys are back on.
 *
 * Raw SQL on purpose: the command layer's behaviour is exercised elsewhere; this
 * file pins the schema the command layer relies on.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  createTempBoard,
  ensureActor,
  insertProject,
  insertReport,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0035 — a board as the previous build left it. */
function before0035() {
  const dir = makeTempDir("meerkat-taskpanel-pre0035-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0035",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const columnsOf = (db, table) =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);

/** A row as the removed importer wrote it: origin='import'. */
function insertImportedReport(db, overrides = {}) {
  const authorId = ensureActor(db, overrides.author_id ?? "linus", overrides.author_kind ?? "agent");
  const info = db
    .prepare(
      `INSERT INTO task_reports(task_id, round, seg, session_id, conclusion, acceptance_json,
                                evidence_json, leftovers, author_kind, author_id, created_at, origin, is_rollup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.task_id ?? "task-1",
      overrides.round ?? 1,
      null,
      null,
      overrides.conclusion ?? "imported history",
      overrides.acceptance_json ?? "[]",
      overrides.evidence_json ?? "[]",
      null,
      overrides.author_kind ?? "agent",
      authorId,
      overrides.created_at ?? TS,
      overrides.origin ?? "import",
      overrides.is_rollup ?? 0,
    );
  return Number(info.lastInsertRowid);
}

const deliver = (db, taskId) =>
  reasonCode(() =>
    db
      .prepare("UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ? WHERE id = ?")
      .run(TS2, taskId),
  );

describe("storage/migrations — 0035 drops report origin", () => {
  it("keeps every row, drops the column, and lets the old import row open the gate", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0035() });
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001", status: "in_progress" });
      const reportId = insertImportedReport(board.db);

      assert.equal(columnsOf(board.db, "task_reports").includes("origin"), true, "precondition: origin exists");

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0035", "0036", "0037", "0038", "0039", "0040", "0041"]);

      assert.equal(columnsOf(board.db, "task_reports").includes("origin"), false);

      const row = board.db
        .prepare(
          "SELECT id, task_id, round, conclusion, author_id, created_at, is_rollup FROM task_reports WHERE id = ?",
        )
        .get(reportId);
      assert.equal(row.task_id, "task-1");
      assert.equal(row.round, 1);
      assert.equal(row.conclusion, "imported history");
      assert.equal(row.author_id, ensureActor(board.db, "linus"));
      assert.equal(row.created_at, TS);
      assert.equal(Number(row.is_rollup), 0);

      // 0035's whole point: the row the old board called history is now simply
      // "the current round's report", and the trigger accepts it.
      assert.equal(deliver(board.db, "task-1"), "NO_ERROR");

      assert.deepEqual(
        board.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_reports_%'")
          .all()
          .map((r) => r.name),
        [],
        "the scratch table must be renamed away",
      );
      assert.equal(Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      board.close();
    }
  });

  it("keeps the append-only and actor guards", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001", status: "in_progress" });
      const reportId = insertReport(board.db, { task_id: "task-1", round: 1 });

      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE task_reports SET conclusion = 'x' WHERE id = ?").run(reportId)),
        "REPORT_APPEND_ONLY",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("DELETE FROM task_reports WHERE id = ?").run(reportId)),
        "REPORT_APPEND_ONLY",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("DELETE FROM actors WHERE id = 'linus'").run()),
        "DICTIONARY_ENTRY_IN_USE",
      );
    } finally {
      board.close();
    }
  });

  it("keeps the rollup rule: only an epic may carry a rollup marker", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001", status: "in_progress" });
      insertTask(board.db, { id: "epic-1", identifier: "PROJ-0002", kind: "epic", status: "in_progress" });

      assert.equal(
        reasonCode(() => insertReport(board.db, { task_id: "task-1", is_rollup: 1 })),
        "ROLLUP_INVALID",
      );
      assert.equal(
        reasonCode(() => insertReport(board.db, { task_id: "epic-1", is_rollup: 1 })),
        "NO_ERROR",
      );
    } finally {
      board.close();
    }
  });
});
