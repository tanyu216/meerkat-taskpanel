/**
 * 0036 — a session carries opaque host-observation metadata.
 *
 * The migration is a plain `ALTER TABLE … ADD COLUMN` on a STRICT table:
 *
 *   1. existing sessions read `{}` (an absent meta is an empty object);
 *   2. a new session can store an object, or omit it and get `{}`;
 *   3. the natural key and the session status vocabulary are untouched;
 *   4. the upgrade ends on the same schema as a fresh board.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertProject, insertTask, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0036 — a board as the previous build left it. */
function before0036() {
  const dir = makeTempDir("meerkat-taskpanel-pre0036-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0036", "0038",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const columnsOf = (db, table) =>
  db.prepare(`SELECT name, dflt_value FROM pragma_table_info('${table}')`).all();

function insertSession(db, overrides = {}) {
  db.prepare(
    `INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, phase, pid, status, ts, goal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "s-1",
    overrides.task_id ?? "task-1",
    overrides.seg ?? "s1",
    overrides.owner ?? "linus",
    overrides.owner_kind ?? "claude",
    overrides.session_id ?? "sid-1",
    overrides.phase ?? null,
    overrides.pid ?? null,
    overrides.status ?? "running",
    overrides.ts ?? TS,
    overrides.goal ?? "",
  );
}

describe("storage/migrations — 0036 session meta", () => {
  it("adds an empty-object column and keeps every existing session", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0036() });
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001", status: "todo" });
      insertSession(board.db);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0036", "0037", "0038", "0039", "0040", "0041"]);

      const meta = columnsOf(board.db, "agent_sessions").find((c) => c.name === "meta_json");
      assert.ok(meta !== undefined, "meta_json exists");
      assert.equal(meta.dflt_value, "'{}'", "the column defaults to an empty object");

      const row = board.db.prepare("SELECT * FROM agent_sessions WHERE id = 's-1'").get();
      assert.equal(row.meta_json, "{}", "an existing session reads an empty object");
      assert.equal(row.seg, "s1");
      assert.equal(row.owner, "linus");
      assert.equal(row.status, "running");
    } finally {
      board.close();
    }
  });

  it("stores an object, and a fresh board has the same column", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "task-1", identifier: "PROJ-0001", status: "todo" });
      insertSession(board.db, { id: "s-1" });
      board.db
        .prepare("INSERT INTO agent_sessions(id, task_id, seg, owner, owner_kind, session_id, status, ts, goal, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("s-2", "task-1", "s2", "linus", "codex", "sid-2", "running", TS, "", JSON.stringify({ harness: "codex", thread_id: "t-1" }));

      const rows = board.db
        .prepare("SELECT id, meta_json FROM agent_sessions ORDER BY id")
        .all()
        .map((r) => ({ id: r.id, meta: JSON.parse(r.meta_json) }));
      assert.deepEqual(rows, [
        { id: "s-1", meta: {} },
        { id: "s-2", meta: { harness: "codex", thread_id: "t-1" } },
      ]);
    } finally {
      board.close();
    }
  });
});
