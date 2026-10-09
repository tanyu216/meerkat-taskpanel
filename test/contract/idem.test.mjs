/**
 * The creation idempotency key's database half (T-20261009-175500-idem-meerkat-taskpanel).
 *
 * The command layer's guard is a *read*; the guarantee is the partial unique
 * index `ux_tasks_idem_active` (0009). This file drives the rule straight into
 * SQL — no service layer — so the two halves are proven to be the same rule,
 * not merely two implementations that happen to agree today:
 *
 *   * a second non-terminal row for a key is refused with `IDEM_EXISTS`;
 *   * a terminal row releases the key;
 *   * a `NULL` key never collides (`--allow-dup`).
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

/** Insert a raw task carrying `idem`, with a given status. */
function insertWithIdem(db, { id, identifier, idem, status = "todo" }) {
  return insertTask(db, { id, identifier, idem, status });
}

describe("contract/idem — partial unique index", () => {
  it("exists on tasks(idem), and only over non-terminal rows", async () => {
    const board = await createTempBoard();
    try {
      const index = board.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name = 'ux_tasks_idem_active'")
        .get();
      assert.ok(index, "ux_tasks_idem_active must exist");

      const indexed = board.db.prepare("SELECT name FROM pragma_index_info('ux_tasks_idem_active')").all();
      assert.deepEqual(indexed.map((row) => row.name), ["idem"]);

      // The predicate is the contract: NULL and terminal rows are excluded.
      assert.match(index.sql, /WHERE\s+idem\s+IS\s+NOT\s+NULL/i);
      assert.match(index.sql, /NOT\s+IN\s*\(\s*'done'\s*,\s*'canceled'\s*\)/i);
    } finally {
      board.close();
    }
  });

  it("refuses a second non-terminal row for a key, but a terminal row does not occupy it", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertWithIdem(board.db, { id: "t1", identifier: "PROJ-0001", idem: "task | a |  | X" });

      // Same key, non-terminal ⇒ the index is the machine guarantee. The raw
      // INSERT is used on purpose: this is the schema's rule, not the command's.
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, priority, kind, labels, sort_order, idem, version, created_at, updated_at, status_changed_at)
               VALUES ('t2','PROJ-0002','proj','x','todo','medium','task','[]',0,'task | a |  | X',1,?,?,?)`,
            )
            .run(TS, TS, TS),
        ),
        "IDEM_EXISTS",
      );
      assert.equal(countRows(board.db, "tasks"), 1);

      // A terminal row carrying the same key is *not* indexed, so it neither
      // collides with anything nor holds the key — which is what "the key is
      // released" means at the schema level.
      insertWithIdem(board.db, { id: "t3", identifier: "PROJ-0003", idem: "task | a |  | X", status: "canceled" });
      insertWithIdem(board.db, { id: "t4", identifier: "PROJ-0004", idem: "task | a |  | X", status: "done" });
      assert.equal(countRows(board.db, "tasks"), 3);
    } finally {
      board.close();
    }
  });

  it("treats NULL keys as distinct, so --allow-dup rows never collide", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertWithIdem(board.db, { id: "t1", identifier: "PROJ-0001", idem: null });
      insertWithIdem(board.db, { id: "t2", identifier: "PROJ-0002", idem: null });
      assert.equal(countRows(board.db, "tasks"), 2);
    } finally {
      board.close();
    }
  });
});
