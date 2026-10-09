/**
 * Contract: an epic with children may not be downgraded (ARCHITECTURE §4.1).
 *
 * 0010 (`tr_rel_parent_epic`) closes the INSERT side of "only an epic may be a
 * parent"; 0011 (`tr_tasks_kind_downgrade`) closes the UPDATE side the same way:
 * changing a parent's `kind` from `epic` to `task` would re-create the `task →
 * task` parent edge 0010 forbids, so the schema refuses it. This file drives the
 * rule straight into SQL — no service layer — so the two halves are proven to be
 * the same rule:
 *
 *   * downgrading an epic that still parents a child is refused with
 *     `VALIDATION_FAILED`, the same code the domain's `assertEpicDowngradeAllowed`
 *     raises;
 *   * dropping the trigger lets that exact write through (the red half of the
 *     red→green counter-proof: before 0011 the schema had no such guard);
 *   * a `task → epic` upgrade still passes, and so does a childless epic's
 *     downgrade;
 *   * only `parent` edges count: `blocks`/`related` neighbours do not block a
 *     downgrade (the guard stays specific, so it cannot collide with 0002).
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

/** Insert a raw `parent` edge (source = parent, target = child). */
const addParent = (db, source, target) =>
  db
    .prepare(
      "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent', ?, ?, ?)",
    )
    .run(source, target, TS);

/** Raw `kind` change, reporting its reason code. */
const setKind = (db, id, kind) =>
  reasonCode(() => db.prepare("UPDATE tasks SET kind = ? WHERE id = ?").run(kind, id));

const kindOf = (db, id) => db.prepare("SELECT kind FROM tasks WHERE id = ?").get(id).kind;

describe("contract/parent-kind-update — the epic-downgrade guard (0011)", () => {
  it("installs a BEFORE UPDATE OF kind trigger on tasks", async () => {
    const board = await createTempBoard();
    try {
      const trigger = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_tasks_kind_downgrade'")
        .get();
      assert.ok(trigger, "tr_tasks_kind_downgrade must exist");
      assert.match(trigger.sql, /BEFORE UPDATE OF kind ON tasks/);
      assert.match(trigger.sql, /source_task_id = OLD\.id/);
    } finally {
      board.close();
    }
  });

  it("refuses downgrading an epic that still parents a child, with VALIDATION_FAILED", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });
      insertTask(board.db, { id: "child", identifier: "PROJ-CHILD" });
      addParent(board.db, "epic", "child");

      assert.equal(setKind(board.db, "epic", "task"), "VALIDATION_FAILED");
      assert.equal(kindOf(board.db, "epic"), "epic", "the kind was not changed");
      assert.equal(countRows(board.db, "task_relations"), 1, "the parent edge survived");
    } finally {
      board.close();
    }
  });

  it("is the thing that blocks it: with the trigger dropped, the same write succeeds (red)", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });
      insertTask(board.db, { id: "child", identifier: "PROJ-CHILD" });
      addParent(board.db, "epic", "child");

      assert.equal(setKind(board.db, "epic", "task"), "VALIDATION_FAILED", "green: the guard fires");
      board.db.prepare("DROP TRIGGER tr_tasks_kind_downgrade").run();
      assert.equal(setKind(board.db, "epic", "task"), "NO_ERROR", "red: without 0011 the schema allows it");
      assert.equal(kindOf(board.db, "epic"), "task", "and the task → task parent edge is now on disk");
    } finally {
      board.close();
    }
  });

  it("still lets a task upgrade to epic, and a childless epic downgrade", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "task", identifier: "PROJ-TASK" });
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });

      assert.equal(setKind(board.db, "task", "epic"), "NO_ERROR");
      assert.equal(kindOf(board.db, "task"), "epic");

      assert.equal(setKind(board.db, "epic", "task"), "NO_ERROR", "no children: nothing to orphan");
      assert.equal(kindOf(board.db, "epic"), "task");
    } finally {
      board.close();
    }
  });

  it("only counts parent edges: blocks/related neighbours do not block a downgrade", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "epic", identifier: "PROJ-EPIC", kind: "epic" });
      insertTask(board.db, { id: "z", identifier: "PROJ-Z" });
      // `related` is stored source < target ("epic" < "z"), and neither edge is
      // a `parent`, so neither may hold up the downgrade.
      board.db
        .prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('blocks', ?, ?, ?)")
        .run("epic", "z", TS);
      board.db
        .prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('related', ?, ?, ?)")
        .run("epic", "z", TS);

      assert.equal(setKind(board.db, "epic", "task"), "NO_ERROR");
      assert.equal(kindOf(board.db, "epic"), "task");
    } finally {
      board.close();
    }
  });
});
