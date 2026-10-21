/**
 * 0028 — an agent session carries the one-sentence goal it registered for.
 *
 * The column is additive and `NOT NULL DEFAULT ''`, so every pre-0028 row reads
 * back as "no goal" without a backfill, and an upgrade lands the same shape as
 * a fresh install.
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
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const columnOf = (db, table, name) =>
  db.prepare("SELECT * FROM pragma_table_info(?) WHERE name = ?").get(table, name);

async function headBoard() {
  const board = await createTempBoard();
  insertProject(board.db, { id: "proj" });
  return board;
}

describe("storage/migrations — 0028 gives an agent session a goal", () => {
  it("adds a NOT NULL goal with an empty default", async () => {
    const board = await headBoard();
    try {
      const goal = columnOf(board.db, "agent_sessions", "goal");
      assert.ok(goal, "agent_sessions.goal exists");
      assert.equal(goal.type, "TEXT");
      assert.equal(goal.notnull, 1);
      assert.equal(goal.dflt_value, "''");

      insertTask(board.db, { id: "t1", identifier: "PROJ-0001" });
      board.db
        .prepare(
          "INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, status, ts) VALUES ('s1','t1','seg1','linus','claude','sid','running',?)",
        )
        .run(TS);
      assert.equal(
        board.db.prepare("SELECT goal FROM agent_sessions WHERE id='s1'").get().goal,
        "",
        "a row that names no goal reads back as the empty sentence",
      );

      assert.throws(
        () =>
          board.db
            .prepare(
              "INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, status, ts, goal) VALUES ('s2','t1','seg2','linus','claude','sid2','running',?,NULL)",
            )
            .run(TS),
        /NOT NULL/,
      );

      const sql = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
        .get().sql;
      assert.match(sql, /STRICT/, "the table stays STRICT");
    } finally {
      board.close();
    }
  });

  it("lands the same column on an upgrade and a fresh board", async () => {
    const dir = makeTempDir("meerkat-taskpanel-pre0028-");
    for (const name of readdirSync(defaultMigrationsDir()).filter(
      (n) => n.endsWith(".sql") && n.slice(0, 4) < "0028",
    )) {
      copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
    }
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir });
      // A session that existed before 0028 must survive the upgrade and read
      // back as "no goal" — the column is added, never rebuilt.
      insertProject(upgraded.db, { id: "proj" });
      insertTask(upgraded.db, { id: "t1", identifier: "PROJ-0001" });
      upgraded.db
        .prepare(
          "INSERT INTO agent_sessions(id, task_id, seg, owner, backend, session_id, status, ts) VALUES ('s1','t1','seg1','linus','claude','sid','running',?)",
        )
        .run(TS);
      applyMigrations(upgraded.db);

      const upgradedColumn = columnOf(upgraded.db, "agent_sessions", "goal");
      const freshColumn = columnOf(fresh.db, "agent_sessions", "goal");
      assert.deepEqual(
        {
          type: upgradedColumn.type,
          notnull: upgradedColumn.notnull,
          dflt: upgradedColumn.dflt_value,
        },
        {
          type: freshColumn.type,
          notnull: freshColumn.notnull,
          dflt: freshColumn.dflt_value,
        },
        "the upgrade and a fresh board agree on the column",
      );
      assert.equal(
        upgraded.db.prepare("SELECT goal FROM agent_sessions WHERE id='s1'").get().goal,
        "",
        "the pre-0028 row survives with the empty default",
      );
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
