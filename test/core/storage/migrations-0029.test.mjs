/**
 * 0029 — the session's platform field is `owner_kind`, not `backend`.
 *
 * `RENAME COLUMN` is a schema edit: the value, the `NOT NULL` constraint, the
 * natural-key index and the revision triggers must all come through unchanged,
 * and the upgraded board must agree with a fresh install.
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

const columnsOf = (db) =>
  db.prepare("SELECT * FROM pragma_table_info('agent_sessions')").all();

const columnNamed = (db, name) => columnsOf(db).find((column) => column.name === name);

async function headBoard() {
  const board = await createTempBoard();
  insertProject(board.db, { id: "proj" });
  insertTask(board.db, { id: "t1", identifier: "PROJ-0001" });
  return board;
}

describe("storage/migrations — 0029 renames backend to owner_kind", () => {
  it("renames the column in place, keeping the value and the constraint", async () => {
    const board = await headBoard();
    try {
      assert.equal(columnNamed(board.db, "backend"), undefined, "the old spelling is gone");
      const ownerKind = columnNamed(board.db, "owner_kind");
      assert.ok(ownerKind, "agent_sessions.owner_kind exists");
      assert.equal(ownerKind.type, "TEXT");
      assert.equal(ownerKind.notnull, 1);

      board.db
        .prepare(
          "INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, status, ts) VALUES ('s1','t1','seg1','linus','claude','sid','running',?)",
        )
        .run(TS);
      assert.equal(
        board.db.prepare("SELECT owner_kind FROM agent_sessions WHERE id='s1'").get().owner_kind,
        "claude",
      );

      const sql = board.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
        .get().sql;
      assert.match(sql, /STRICT/, "the table stays STRICT");
      assert.match(sql, /owner_kind\s+TEXT NOT NULL/);
      assert.doesNotMatch(sql, /\bbackend\b/);
    } finally {
      board.close();
    }
  });

  it("lands the same column on an upgrade and a fresh board, preserving rows and the natural key", async () => {
    const dir = makeTempDir("meerkat-taskpanel-pre0029-");
    for (const name of readdirSync(defaultMigrationsDir()).filter(
      (n) => n.endsWith(".sql") && n.slice(0, 4) < "0029",
    )) {
      copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
    }
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir });
      insertProject(upgraded.db, { id: "proj" });
      insertTask(upgraded.db, { id: "t1", identifier: "PROJ-0001" });
      // The pre-0029 spelling: the same row a running board wrote.
      upgraded.db
        .prepare(
          "INSERT INTO agent_sessions(id, task_id, seg, owner, backend, session_id, status, ts) VALUES ('s1','t1','seg1','linus','claude','sid','running',?)",
        )
        .run(TS);
      applyMigrations(upgraded.db);

      assert.equal(
        upgraded.db.prepare("SELECT owner_kind FROM agent_sessions WHERE id='s1'").get().owner_kind,
        "claude",
        "the value moved with the column",
      );
      assert.equal(columnNamed(upgraded.db, "backend"), undefined);

      const shape = (db) => {
        const column = columnNamed(db, "owner_kind");
        return { type: column.type, notnull: column.notnull, dflt: column.dflt_value };
      };
      assert.deepEqual(shape(upgraded.db), shape(fresh.db), "the upgrade and a fresh board agree");

      // The natural key survived the rename: the index still refuses a second
      // (task, seg, owner) triple.
      assert.ok(
        upgraded.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_sessions_natural'")
          .get(),
        "ux_sessions_natural exists after the rename",
      );
      assert.throws(
        () =>
          upgraded.db
            .prepare(
              "INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, status, ts) VALUES ('s2','t1','seg1','linus','codex','sid2','running',?)",
            )
            .run(TS),
        /UNIQUE/,
      );
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
