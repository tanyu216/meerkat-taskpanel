/**
 * 0026 — a parent may not be delivered or accepted while a child is in flight.
 *
 * The automatic rollup always refused this; the manual path did not. The
 * trigger is what makes the rule hold for a writer that bypasses the command
 * layer (raw SQL, an external tool), so the cases below all write raw SQL:
 *
 *   * `in_review` and `done` are both guarded;
 *   * `done` and `canceled` children do not block, every other status does;
 *   * a child added *after* the parent reached `in_review` holds the acceptance
 *     shut until it too is terminal;
 *   * INSERT stays outside the trigger — importing history is a different act,
 *     and it is the same boundary the delivery gate has drawn since 0008.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  insertProject,
  insertReport,
  insertTask,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";
import { copyFileSync } from "node:fs";
import { makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A board at the head of the shipped set. */
async function headBoard() {
  const board = await createTempBoard();
  insertProject(board.db, { id: "proj" });
  return board;
}

/**
 * `epic` (kind = epic) with the given children.
 *
 * The epic is inserted directly in `epicStatus` because INSERT is outside every
 * BEFORE-UPDATE guard (the same boundary the importer uses) — which is what lets
 * a case start from `in_review` and test the `done` leg.
 */
function epicWithChildren(db, children, epicStatus = "todo") {
  insertTask(db, { id: "epic", identifier: "PROJ-0001", kind: "epic", status: epicStatus });
  // 0033 — the epic `done` guard and the children guard both fire on the same
  // UPDATE. Seed the round's rollup so these cases keep measuring 0026's rule
  // rather than the rollup refusal.
  if (epicStatus === "in_review") {
    insertReport(db, { task_id: "epic", round: 1, is_rollup: 1 });
  }
  children.forEach((status, index) => {
    const id = `child-${index}`;
    insertTask(db, { id, identifier: `PROJ-000${index + 2}`, status });
    db.prepare(
      "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, origin, created_at) VALUES ('parent', 'epic', ?, NULL, ?)",
    ).run(id, TS);
  });
}

const move = (db, id, to) =>
  reasonCode(() => db.prepare("UPDATE tasks SET status = ?, status_changed_at = ? WHERE id = ?").run(to, TS, id));

/**
 * Satisfy the delivery gate for round 1 with the audited waiver, so a raw
 * `in_review` move is refused by the *children* guard and not by
 * `REPORT_REQUIRED` (the two triggers compete for the same UPDATE).
 */
const waive = (db) =>
  db
    .prepare("UPDATE tasks SET delivery_round = 1, report_waiver_round = 1, report_waiver_reason = ? WHERE id = 'epic'")
    .run("raw SQL test: no report, an audited waiver");

describe("storage/migrations — 0026 guards a parent's delivery and acceptance", () => {
  it("refuses in_review and done while any child is non-terminal", async () => {
    for (const open of ["backlog", "todo", "in_progress", "awaiting", "in_review", "blocked"]) {
      const delivery = await headBoard();
      const acceptance = await headBoard();
      try {
        // Delivery: `todo → in_review` is the epic's own pair (0024).
        epicWithChildren(delivery.db, [open], "todo");
        waive(delivery.db);
        assert.equal(move(delivery.db, "epic", "in_review"), "CHILDREN_OPEN", `in_review with a ${open} child`);
        // Acceptance: only reachable from `in_review`, so the board starts there.
        epicWithChildren(acceptance.db, [open], "in_review");
        assert.equal(move(acceptance.db, "epic", "done"), "CHILDREN_OPEN", `done with a ${open} child`);
      } finally {
        delivery.close();
        acceptance.close();
      }
    }
  });

  it("allows both when every child is done or canceled", async () => {
    for (const [statuses, target] of [
      [["done"], "in_review"],
      [["canceled"], "in_review"],
      [["done", "canceled"], "in_review"],
      [["done"], "done"],
      [["done", "canceled"], "done"],
    ]) {
      const board = await headBoard();
      try {
        epicWithChildren(board.db, statuses, target === "done" ? "in_review" : "todo");
        if (target === "in_review") waive(board.db);
        assert.equal(move(board.db, "epic", target), "NO_ERROR", `${target} with children [${statuses.join(", ")}]`);
      } finally {
        board.close();
      }
    }
  });

  it("re-checks at acceptance: a child added to an in_review epic closes the door again", async () => {
    const board = await headBoard();
    try {
      epicWithChildren(board.db, ["done"]);
      waive(board.db);
      assert.equal(move(board.db, "epic", "in_review"), "NO_ERROR");
      // 0033 — the done guard needs a current-round rollup; its *coverage* is the
      // command layer's, so a bare row is enough to keep this test on 0026.
      insertReport(board.db, { task_id: "epic", round: 1, is_rollup: 1 });

      insertTask(board.db, { id: "late", identifier: "PROJ-0009", status: "todo" });
      board.db
        .prepare(
          "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, origin, created_at) VALUES ('parent', 'epic', 'late', NULL, ?)",
        )
        .run(TS);

      assert.equal(move(board.db, "epic", "done"), "CHILDREN_OPEN", "the new child holds acceptance shut");
      assert.equal(move(board.db, "late", "canceled"), "NO_ERROR");
      assert.equal(move(board.db, "epic", "done"), "NO_ERROR", "a terminal child releases it");
    } finally {
      board.close();
    }
  });

  it("does not guard a leaf card, and does not fire when the status does not change", async () => {
    const board = await headBoard();
    try {
      insertTask(board.db, { id: "leaf", identifier: "PROJ-0001" });
      assert.equal(move(board.db, "leaf", "backlog"), "NO_ERROR");
      // An unrelated UPDATE of a card already in `in_review` is not a delivery.
      insertTask(board.db, { id: "reviewed", identifier: "PROJ-0002", status: "in_review" });
      assert.equal(move(board.db, "reviewed", "in_review"), "NO_ERROR");
    } finally {
      board.close();
    }
  });

  it("is an INSERT-time boundary: importing a half-finished container is not blocked", async () => {
    const board = await headBoard();
    try {
      insertTask(board.db, { id: "epic", identifier: "PROJ-0001", kind: "epic", status: "in_review" });
      insertTask(board.db, { id: "child", identifier: "PROJ-0002", status: "todo" });
      board.db
        .prepare(
          "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, origin, created_at) VALUES ('parent', 'epic', 'child', NULL, ?)",
        )
        .run(TS);
      assert.equal(
        board.db.prepare("SELECT status FROM tasks WHERE id = 'epic'").get().status,
        "in_review",
        "the importer writes history; the next UPDATE is what the guard sees",
      );
      assert.equal(move(board.db, "epic", "in_progress"), "NO_ERROR", "the escape hatch stays open");
    } finally {
      board.close();
    }
  });

  it("lands the trigger on both an upgrade and a fresh board", async () => {
    const dir = makeTempDir("meerkat-taskpanel-pre0026-");
    for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0026")) {
      copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
    }
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir });
      applyMigrations(upgraded.db);
      const sql = (db) =>
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_tasks_children_terminal'").get()?.sql;
      assert.ok(sql(fresh.db));
      assert.equal(sql(upgraded.db).replace(/\s+/g, " ").trim(), sql(fresh.db).replace(/\s+/g, " ").trim());
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
