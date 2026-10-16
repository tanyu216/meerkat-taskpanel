/**
 * 0023 — the kind moves off the actor row (`actors.kind`, which `0019` added) and
 * onto the three references on `tasks` that record an act
 * (`assignee_kind`, `reporter_kind`, the new `claimed_kind`).
 *
 * Three properties, in the order they matter:
 *
 *   1. **Nothing is rebuilt.** Three `ADD COLUMN` and one `DROP COLUMN` in place,
 *      so every trigger's text on an upgraded board is identical to a freshly
 *      installed one, and the table/index names are unchanged. This is the whole
 *      reason the migration is written this way, and it is the property a
 *      careless edit (reaching for the `CREATE new → copy → DROP old → RENAME`
 *      dance out of habit) would silently destroy.
 *   2. **The kinds are carried across.** Whatever `actors.kind` said about a
 *      task's assignee, reporter and claim is what those columns hold afterwards.
 *   3. **An absent one stays absent.** A task with no reference keeps a NULL kind,
 *      and nothing invents a value — the same rule `blocked_reason` follows.
 *
 * The seed board is built *at 0022*, because the backfill is what is under test
 * and a board with nothing to carry over would prove nothing.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertProject, insertTask, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0023 — a board as the previous build left it. */
function before0023() {
  const dir = makeTempDir("meerkat-taskpanel-pre0023-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0023")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

const indexNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

/** Every trigger's text, whitespace-normalised — whitespace is not meaning. */
const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").trim()]),
  );

// `notnull` is a keyword in a column list, so the projection is `*` — the pragma's
// own column order is not something to re-spell.
const columnsOf = (db, table) => db.prepare(`SELECT * FROM pragma_table_info(?)`).all(table);

describe("storage/migrations — 0023 moves the kind onto the record", () => {
  it("rebuilds nothing: the schema objects and their text are what a fresh board has", async () => {
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir: before0023() });
      applyMigrations(upgraded.db);

      assert.deepEqual(tableNames(upgraded.db), tableNames(fresh.db), "the table set is unchanged");
      assert.deepEqual(indexNames(upgraded.db), indexNames(fresh.db), "so is the index set");
      // The load-bearing one: an in-place ADD/DROP leaves every trigger's *text*
      // alone, where a rebuild would have had to re-declare the ten on `tasks`
      // and the five on `task_relations` — and being short by one is exactly the
      // failure this history has made twice.
      assert.deepEqual(triggersOf(upgraded.db), triggersOf(fresh.db), "and every trigger's text");
    } finally {
      upgraded.close();
      fresh.close();
    }
  });

  it("drops `actors.kind` and says the same thing with three columns on `tasks`", async () => {
    const board = await createTempBoard();
    try {
      const actors = columnsOf(board.db, "actors").map((c) => c.name);
      assert.equal(actors.includes("kind"), false, "the actor row carries no kind");
      for (const column of ["id", "display_name", "normalized_name", "first_seen_at", "last_seen_at", "use_count"]) {
        assert.ok(actors.includes(column), `actors.${column} survives`);
      }

      const tasks = columnsOf(board.db, "tasks");
      for (const name of ["assignee_kind", "reporter_kind", "claimed_kind"]) {
        const column = tasks.find((c) => c.name === name);
        assert.ok(column !== undefined, `tasks.${name} exists`);
        assert.equal(Number(column.notnull), 0, `tasks.${name} is nullable — "not recorded" is a real answer`);
        assert.equal(column.dflt_value, null, `and it defaults to nothing`);
      }
      // Appended, like `blocked_reason` before them, so nothing that reads `tasks`
      // positionally has to be re-taught where a column sits.
      assert.deepEqual(
        tasks.slice(-3).map((c) => c.name),
        ["assignee_kind", "reporter_kind", "claimed_kind"],
      );
    } finally {
      board.close();
    }
  });

  it("carries each actor's kind across to the reference that named them", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0023() });
      insertProject(board.db);
      // The pre-0023 shape: the kind lives on the actor row, so the fixture is
      // told what each person is *there*.
      insertTask(board.db, {
        id: "t-1",
        identifier: "PROJ-0001",
        status: "in_progress",
        assignee_id: "linus",
        reporter_id: "Terry",
        claimed_by: "linus",
      });
      const kinds = board.db.prepare("SELECT id, kind FROM actors ORDER BY id").all();
      assert.deepEqual(kinds.map((r) => r.kind), ["agent", "agent"], "the fixture registers both as agents");

      applyMigrations(board.db);

      const task = board.db
        .prepare("SELECT assignee_kind, reporter_kind, claimed_kind FROM tasks WHERE id = 't-1'")
        .get();
      assert.deepEqual({ ...task }, { assignee_kind: "agent", reporter_kind: "agent", claimed_kind: "agent" });

      // ...and each kind sits beside the reference that earned it: `Terry` is the
      // reporter, `linus` holds the claim, and their rows are still there even
      // though the column that used to carry the kind is gone.
      const names = board.db
        .prepare(
          `SELECT (SELECT display_name FROM actors WHERE id = tasks.assignee_id) AS assignee,
                  (SELECT display_name FROM actors WHERE id = tasks.reporter_id) AS reporter,
                  (SELECT display_name FROM actors WHERE id = tasks.claimed_by)  AS holder
             FROM tasks WHERE id = 't-1'`,
        )
        .get();
      assert.deepEqual({ ...names }, { assignee: "linus", reporter: "Terry", holder: "linus" });
    } finally {
      board.close();
    }
  });

  it("invents nothing: a task with no reference keeps a NULL kind", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0023() });
      insertProject(board.db);
      insertTask(board.db, { id: "t-bare", identifier: "PROJ-0001", status: "todo" });
      insertTask(board.db, {
        id: "t-half",
        identifier: "PROJ-0002",
        status: "in_progress",
        assignee_id: "linus",
      });

      applyMigrations(board.db);

      const bare = board.db
        .prepare("SELECT assignee_kind, reporter_kind, claimed_kind FROM tasks WHERE id = 't-bare'")
        .get();
      assert.deepEqual({ ...bare }, { assignee_kind: null, reporter_kind: null, claimed_kind: null });

      // A half-populated card keeps one and leaves the others alone — the columns
      // follow their own reference, not each other.
      const half = board.db
        .prepare("SELECT assignee_kind, reporter_kind, claimed_kind FROM tasks WHERE id = 't-half'")
        .get();
      assert.deepEqual({ ...half }, { assignee_kind: "agent", reporter_kind: null, claimed_kind: null });
    } finally {
      board.close();
    }
  });

  it("leaves the honest value on a claim that recorded no kind", async () => {
    // `claimed_kind` is new, so *every* existing claim predates it. NULL is what
    // that means — a different statement from "a human claimed it", and the one
    // value this migration must not fabricate. The reference is what carries the
    // evidence, and it is present.
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t-1", identifier: "PROJ-0001", status: "in_progress", claimed_by: "linus" });
      const task = board.db.prepare("SELECT claimed_by, claimed_kind FROM tasks WHERE id = 't-1'").get();
      assert.equal(task.claimed_by, "linus", "the holder is recorded");
      assert.equal(task.claimed_kind, null, "and no kind, because none was");
    } finally {
      board.close();
    }
  });

  it("applies cleanly to a board that is already current, and to a fresh one", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, [], "a second run is a no-op");
      assert.ok(again.skipped.includes("0023"));
    } finally {
      board.close();
    }
  });
});
