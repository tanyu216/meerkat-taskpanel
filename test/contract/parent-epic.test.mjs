/**
 * Contract: a `parent` edge may only point at an epic (ARCHITECTURE §4.1).
 *
 * The domain half of this rule is `assertParentIsEpic` (a read, checked by
 * `relation.mjs`); the guarantee is the trigger `tr_rel_parent_epic` (0010).
 * This file drives the rule straight into SQL — no service layer — so the two
 * halves are proven to be the same rule, not merely two implementations that
 * happen to agree today:
 *
 *   * a `task → task` parent edge is refused with `VALIDATION_FAILED`, the same
 *     code `assertParentIsEpic` raises;
 *   * dropping the trigger lets that exact write through (the red half of the
 *     red→green counter-proof: before 0010 the schema had no such guard);
 *   * an `epic → task` edge still passes, and so does `epic → epic`;
 *   * the guard stays disjoint from the 0002 guards (self-reference, cross-
 *     project, missing endpoints).
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import {
  TS,
  cleanupTempDirs,
  countRows,
  createTempBoard,
  insertProject,
  insertTask,
  reasonCode,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** Insert a raw `parent` edge and report its reason code. */
const addParent = (db, source, target) =>
  reasonCode(() =>
    db
      .prepare(
        "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent', ?, ?, ?)",
      )
      .run(source, target, TS),
  );

describe("contract/parent-epic — the parent-kind guard (0010)", () => {
  it("installs a BEFORE INSERT trigger on task_relations", async () => {
    const board = await createTempBoard();
    try {
      const trigger = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_rel_parent_epic'")
        .get();
      assert.ok(trigger, "tr_rel_parent_epic must exist");
      assert.match(trigger.sql, /BEFORE INSERT ON task_relations/);
      assert.match(trigger.sql, /kind/i);
    } finally {
      board.close();
    }
  });

  it("refuses a task → task parent edge with the domain's VALIDATION_FAILED", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "a", identifier: "PROJ-A" });
      insertTask(board.db, { id: "b", identifier: "PROJ-B" });

      assert.equal(addParent(board.db, "a", "b"), "VALIDATION_FAILED");
      assert.equal(countRows(board.db, "task_relations"), 0, "nothing was written");
    } finally {
      board.close();
    }
  });

  it("is the thing that blocks it: with the trigger dropped, the same write succeeds (red)", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "a", identifier: "PROJ-A" });
      insertTask(board.db, { id: "b", identifier: "PROJ-B" });

      assert.equal(addParent(board.db, "a", "b"), "VALIDATION_FAILED", "green: the guard fires");
      board.db.prepare("DROP TRIGGER tr_rel_parent_epic").run();
      assert.equal(addParent(board.db, "a", "b"), "NO_ERROR", "red: without 0010 the schema allows it");
      assert.equal(countRows(board.db, "task_relations"), 1);
    } finally {
      board.close();
    }
  });

  it("still lets an epic parent a task, and an epic parent another epic", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });
      insertTask(board.db, { id: "t", identifier: "PROJ-T" });
      insertTask(board.db, { id: "epic2", identifier: "PROJ-EPIC2", kind: "epic" });

      assert.equal(addParent(board.db, "epic", "t"), "NO_ERROR");
      assert.equal(addParent(board.db, "epic2", "epic"), "NO_ERROR");
      assert.equal(countRows(board.db, "task_relations"), 2);
    } finally {
      board.close();
    }
  });

  it("stays disjoint from the 0002 guards", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertProject(board.db, { id: "other" });
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });
      insertTask(board.db, { id: "z", identifier: "OTHER-Z", project_id: "other" });

      assert.equal(addParent(board.db, "epic", "epic"), "SELF_REFERENCE");
      assert.equal(addParent(board.db, "epic", "z"), "CROSS_PROJECT_RELATION");
      assert.equal(addParent(board.db, "epic", "missing"), "NOT_FOUND", "missing target is a foreign-key problem");
      assert.equal(addParent(board.db, "missing", "epic"), "NOT_FOUND", "missing parent is a foreign-key problem");
      assert.equal(addParent(board.db, "ghost1", "ghost2"), "NOT_FOUND", "a pair of missing ids is still NOT_FOUND");
    } finally {
      board.close();
    }
  });
});
