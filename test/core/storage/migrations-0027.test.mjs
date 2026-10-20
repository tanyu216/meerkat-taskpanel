/**
 * 0027 — a done/canceled card reopens to `todo`, and only to `todo`.
 *
 * The cases below write raw SQL on purpose: the trigger is what makes the rule
 * hold for a writer that bypasses the command layer:
 *
 *   * `done`/`canceled → todo` is the one exit; every other destination is
 *     still `TERMINAL_STATE`;
 *   * the reopen starts a new delivery round, clears `archived_at`, and releases
 *     `idem` (the finished row had already released it);
 *   * the idem clear happens **before** `ux_tasks_idem_active` checks the row —
 *     the collision case is the reason the trigger is BEFORE, not AFTER;
 *   * an upgrade lands the same trigger text as a fresh install.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  insertProject,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A board at the head of the shipped set. */
async function headBoard() {
  const board = await createTempBoard();
  insertProject(board.db, { id: "proj" });
  return board;
}

const move = (db, id, to) =>
  reasonCode(() =>
    db
      .prepare("UPDATE tasks SET status = ?, status_changed_at = ?, version = version + 1 WHERE id = ?")
      .run(to, TS, id),
  );

describe("storage/migrations — 0027 reopens a terminal card only to todo", () => {
  it("leaves done/canceled for todo and refuses every other exit", async () => {
    const board = await headBoard();
    try {
      insertTask(board.db, { id: "done", identifier: "PROJ-0001", status: "done" });
      insertTask(board.db, { id: "canceled", identifier: "PROJ-0002", status: "canceled" });
      for (const from of ["done", "canceled"]) {
        const forbidden = [
          "backlog",
          "in_progress",
          "in_review",
          "blocked",
          "awaiting",
          from === "done" ? "canceled" : "done",
        ];
        for (const to of forbidden) {
          assert.equal(move(board.db, from, to), "TERMINAL_STATE", `${from} → ${to} must be refused`);
        }
        assert.equal(move(board.db, from, "todo"), "NO_ERROR", `${from} → todo is the reopen edge`);
      }
      assert.equal(board.db.prepare("SELECT status FROM tasks WHERE id='done'").get().status, "todo");
    } finally {
      board.close();
    }
  });

  it("bumps the delivery round, clears archived_at, and releases idem", async () => {
    const board = await headBoard();
    try {
      insertTask(board.db, {
        id: "t",
        identifier: "PROJ-0001",
        status: "done",
        archived_at: TS,
        idem: "task | linus | | wire it",
      });
      board.db.prepare("UPDATE tasks SET delivery_round = 3 WHERE id='t'").run();

      assert.equal(move(board.db, "t", "todo"), "NO_ERROR");
      const row = board.db
        .prepare("SELECT status, delivery_round, archived_at, idem FROM tasks WHERE id='t'")
        .get();
      assert.equal(row.status, "todo");
      assert.equal(row.delivery_round, 4, "a reopen starts a new delivery round");
      assert.equal(row.archived_at, null, "the card returns to the board");
      assert.equal(row.idem, null, "the finished row's key is released");
    } finally {
      board.close();
    }
  });

  it("releases the idempotency key before the unique index sees the row", async () => {
    // Another *active* card holds the same key — legal, because the partial
    // index excludes terminal rows. An AFTER trigger would run too late: the
    // outer UPDATE would hit UNIQUE before the key could be cleared.
    const board = await headBoard();
    try {
      insertTask(board.db, { id: "active", identifier: "PROJ-0001", status: "todo", idem: "shared | key | | " });
      insertTask(board.db, { id: "done", identifier: "PROJ-0002", status: "done", idem: "shared | key | | " });

      assert.equal(move(board.db, "done", "todo"), "NO_ERROR");
      assert.equal(board.db.prepare("SELECT idem FROM tasks WHERE id='done'").get().idem, null);
    } finally {
      board.close();
    }
  });

  it("lands the same trigger text on an upgrade and a fresh board", async () => {
    const dir = makeTempDir("meerkat-taskpanel-pre0027-");
    for (const name of readdirSync(defaultMigrationsDir()).filter(
      (n) => n.endsWith(".sql") && n.slice(0, 4) < "0027",
    )) {
      copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
    }
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir });
      applyMigrations(upgraded.db);
      const sql = (db, name) =>
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get(name)
          ?.sql.replace(/\s+/g, " ")
          .trim();
      for (const name of ["tr_tasks_terminal", "tr_tasks_reopen_state", "tr_tasks_round_bump"]) {
        assert.ok(sql(fresh.db, name), `${name} exists on a fresh board`);
        assert.equal(sql(upgraded.db, name), sql(fresh.db, name), `${name} has the same text after the upgrade`);
      }
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
