/**
 * 0041 — the review-only invariants the app already enforced move into SQL.
 *
 * Three rules were app-only before this migration:
 *
 *   1. a review card cannot be reopened (the terminal trigger allowed
 *      `done|canceled → todo` for every card);
 *   2. a review card cannot be a parent or a child (`assertParentEdgeHasNoReviewCard`);
 *   3. a review cannot itself be reviewed (`resolveReviewMarker`).
 *
 * The app still refuses them first, with richer messages. This suite is the
 * raw-SQL backstop: a writer that bypasses the command layer must not be able to
 * mint an exempt card, orphan a review, or chain a review of a review.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { migrationsThrough } from "../../helpers/migration-shapes.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  insertProject,
  insertTask,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set through 0040 — a board as the previous build left it. */
const through0040 = migrationsThrough("0040");

/** A board at the previous build's head, with the rows the migration must keep. */
async function upgradedBoard() {
  const board = await createTempBoard({ migrate: false });
  applyMigrations(board.db, { dir: through0040() });
  seed(board.db);
  const up = applyMigrations(board.db);
  return { board, up };
}

function seed(db) {
  insertProject(db, { id: "p" });
  // Two ordinary cards: a finished one (the reopen control) and a child.
  insertTask(db, { id: "done-task", identifier: "P-0001", project_id: "p", status: "done" });
  insertTask(db, { id: "child", identifier: "P-0002", project_id: "p", status: "todo" });
  // An original under review, and a review card that audits it.
  insertTask(db, { id: "original", identifier: "P-0003", project_id: "p", status: "in_review", acceptance_mode: "agent" });
  insertTask(db, {
    id: "review",
    identifier: "P-0004",
    project_id: "p",
    status: "done",
    acceptance_mode: "off",
    review_of_id: "original",
    review_round: 1,
  });
  // An epic, so a parent edge has a legal source.
  insertTask(db, { id: "epic", identifier: "P-0005", project_id: "p", status: "todo", kind: "epic" });
}

describe("storage/migrations — 0041 review invariants", () => {
  it("applies only 0041 and keeps the ordinary reopen edge", async () => {
    const { board, up } = await upgradedBoard();
    try {
      assert.deepEqual(up.applied.map((m) => m.version), ["0041", "0042"]);
      assert.equal(
        reasonCode(() =>
          board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = 'done-task'").run(),
        ),
        "NO_ERROR",
        "an ordinary done card still reopens",
      );
    } finally {
      board.close();
    }
  });

  it("refuses to reopen a review card", async () => {
    const { board } = await upgradedBoard();
    try {
      assert.equal(
        reasonCode(() =>
          board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = 'review'").run(),
        ),
        "INVALID_TRANSITION",
      );
    } finally {
      board.close();
    }
  });

  it("refuses a review card as a parent or a child", async () => {
    const { board } = await upgradedBoard();
    try {
      const edge = (source, target) =>
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO task_relations(source_task_id, target_task_id, relation_type, created_at)
               VALUES (?, ?, 'parent', ?)`,
            )
            .run(source, target, TS),
        );
      assert.equal(edge("epic", "child"), "NO_ERROR", "an ordinary parent edge is untouched");
      assert.equal(edge("review", "child"), "VALIDATION_FAILED", "a review card cannot be a parent");
      assert.equal(edge("epic", "review"), "VALIDATION_FAILED", "a review card cannot be a child");
    } finally {
      board.close();
    }
  });

  it("refuses a review of a review", async () => {
    const { board } = await upgradedBoard();
    try {
      assert.equal(
        reasonCode(() =>
          insertTask(board.db, {
            id: "review-of-review",
            identifier: "P-0006",
            project_id: "p",
            status: "todo",
            acceptance_mode: "off",
            review_of_id: "review",
            review_round: 1,
          }),
        ),
        "VALIDATION_FAILED",
      );
    } finally {
      board.close();
    }
  });

  it("leaves an upgraded board structurally identical to a fresh one", async () => {
    const { board } = await upgradedBoard();
    const fresh = await createTempBoard();
    try {
      const triggers = (db) =>
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all()
          .map((row) => row.name);
      assert.deepEqual(triggers(board.db), triggers(fresh.db));
    } finally {
      board.close();
      fresh.close();
    }
  });

  it("is a no-op the second time", async () => {
    const { board } = await upgradedBoard();
    try {
      const second = applyMigrations(board.db);
      assert.deepEqual(second.applied, []);
      assert.equal(second.skipped.includes("0041"), true);
    } finally {
      board.close();
    }
  });
});
