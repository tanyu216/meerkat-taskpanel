/**
 * 0020 — the three remaining attribution columns (`tasks.claimed_by`,
 * `comments.author_id`, `task_reports.author_id`) become references to
 * `actors(id)`, and every free-string value already in them is back-filled into
 * an actor row first.
 *
 * The property under test is the **back-fill**, so the seed board is built to
 * carry everything the rule has to answer for, and a board with nothing to
 * back-fill would prove nothing:
 *
 *   * a value that is already an actor's name (`linus`) → the row is **reused**,
 *     not duplicated;
 *   * a value that is the same person in another spelling (`  LINUS `, `terry`
 *     vs `Terry`) → **one** row (this is the merge the CHANGELOG calls out);
 *   * a value no actor carries yet (`local`, `unknown`) → a row is **created**;
 *   * `claimed_by = ''` → NULL (the column means "nobody", not "somebody blank");
 *   * `NULL` → stays `NULL`.
 *
 * After the rebuild every reference must resolve, the FK must be real
 * (a write naming an unknown actor is refused), `normalized_name` must equal
 * `norm(display_name)` for every row — the canonicalisation the SQL runs is the
 * `norm` this repo uses, for the values it can see — and the index set and every
 * trigger must match a freshly-installed board.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { norm } from "../../../src/foundation/norm.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0020 — a board as the previous build left it. */
function before0020() {
  const dir = makeTempDir("meerkat-taskpanel-pre0020-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0020")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

/** The named indexes on a table — name, uniqueness, partiality, columns. */
const indexShapes = (db, table) =>
  db
    .prepare(`SELECT name, "unique" AS uniq, partial AS part FROM pragma_index_list(?)`)
    .all(table)
    .filter((row) => !row.name.startsWith("sqlite_autoindex"))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((row) => ({
      name: row.name,
      unique: Number(row.uniq),
      partial: Number(row.part),
      columns: db.prepare("SELECT name FROM pragma_index_info(?)").all(row.name).map((c) => c.name),
    }));

/** Every trigger's text, whitespace-normalised (whitespace is not meaning). */
const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").replace(/CREATE TRIGGER IF NOT EXISTS /i, "CREATE TRIGGER ").trim()]),
  );

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

/** Every `table.column` pair that has a foreign key, with its parent. */
const foreignKeys = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .flatMap((table) =>
      db
        .prepare("SELECT \"table\" AS parent, \"from\" AS col FROM pragma_foreign_key_list(?)")
        .all(table)
        .map((fk) => ({ child: `${table}.${fk.col}`, parent: fk.parent })),
    );

/**
 * A board at 0019 carrying attribution values: existing actors, a spelling
 * collision, values with no actor row, and the two "nobody" spellings.
 */
function seedAttributionBoard(db) {
  db.prepare(
    "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("p1", "P1", 10, "[]", "{}", TS, TS);

  const insTask = db.prepare(
    "INSERT INTO tasks(id, identifier, project_id, title, status, claimed_by, claimed_at, created_at, updated_at, status_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  insTask.run("t1", "P1-0001", "p1", "reuses an actor", "in_progress", "linus", TS, TS, TS, TS);
  insTask.run("t2", "P1-0002", "p1", "same person, other spelling", "in_progress", "  LINUS ", TS, TS, TS, TS);
  insTask.run("t3", "P1-0003", "p1", "nobody knows them yet", "in_progress", "local", TS, TS, TS, TS);
  insTask.run("t4", "P1-0004", "p1", "blank means nobody", "in_progress", "", TS, TS, TS, TS);
  insTask.run("t5", "P1-0005", "p1", "already nobody", "in_progress", null, null, TS, TS, TS);

  const insComment = db.prepare(
    "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insComment.run("c1", "t1", "human one", "discuss", "human", "Terry", "[]", TS);
  insComment.run("c2", "t1", "same person, lower case", "note", "agent", "terry", "[]", TS);
  insComment.run("c3", "t2", "an actor that exists", "note", "agent", "linus", "[]", TS);
  insComment.run("c4", "t3", "nobody knows them yet", "note", "human", "  loCAL ", "[]", TS);

  const insReport = db.prepare(
    "INSERT INTO task_reports(task_id, round, conclusion, acceptance_json, evidence_json, author_kind, author_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insReport.run("t1", 1, "done", "[]", "[]", "human", "Terry", TS);
  insReport.run("t2", 1, "done", "[]", "[]", "agent", "unknown", TS);
}

/** The actor a value was back-filled into, by the value's `norm`. */
const actorByKey = (db, key) =>
  db.prepare("SELECT id, display_name, normalized_name FROM actors WHERE normalized_name = ?").get(key);

describe("storage/migrations — 0020 gives the attribution columns a reference", () => {
  it("back-fills every value, deduplicates spellings, and keeps the FK real", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0020() });
      assert.equal(old.applied.at(-1).version, "0019");
      // Precondition: the columns really are free strings at 0019.
      assert.match(
        board.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get().sql,
        /claimed_by\s+TEXT,/,
        "claimed_by carries no reference before 0020",
      );
      seedAttributionBoard(board.db);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035", "0036", "0037", "0038", "0039", "0040", "0041", "0042"]);

      // 1 — the back-fill. Four keys that were free strings with no actor row:
      //     `linus` (reused), plus `local`, `terry` and `unknown` (created). The
      //     seed creates no actors of its own, so every row here came from 0020.
      const keys = board.db.prepare("SELECT normalized_name FROM actors ORDER BY normalized_name").all().map((r) => r.normalized_name);
      assert.deepEqual(keys, ["linus", "local", "terry", "unknown"]);

      // 2 — the spelling merge the CHANGELOG records: `Terry` and `terry` are one
      //     person, and the kind preference (`human`) is what the group keeps.
      const terry = actorByKey(board.db, "terry");
      assert.equal(terry.display_name, "Terry", "the lexically-first spelling wins");
      assert.equal(
        board.db.prepare("SELECT COUNT(*) AS n FROM actors WHERE normalized_name = 'terry'").get().n,
        1,
        "one person, not two",
      );

      // 3 — every reference resolves, and no column lost its meaning. `''` is
      //     NULL (nobody), and a NULL stays NULL.
      const claims = Object.fromEntries(
        board.db.prepare("SELECT id, claimed_by FROM tasks ORDER BY id").all().map((r) => [r.id, r.claimed_by]),
      );
      assert.equal(claims.t1, actorByKey(board.db, "linus").id, "an existing actor is reused");
      assert.equal(claims.t2, claims.t1, "a different spelling of the same person is the same row");
      assert.equal(claims.t3, actorByKey(board.db, "local").id);
      assert.equal(claims.t4, null, "a blank claim is nobody, not a blank person");
      assert.equal(claims.t5, null);

      const authorOf = (id) =>
        board.db.prepare("SELECT a.normalized_name AS k FROM comments c JOIN actors a ON a.id = c.author_id WHERE c.id = ?").get(id).k;
      assert.deepEqual(["c1", "c2", "c3", "c4"].map(authorOf), ["terry", "terry", "linus", "local"]);

      const reportAuthors = board.db
        .prepare("SELECT a.normalized_name AS k FROM task_reports r JOIN actors a ON a.id = r.author_id ORDER BY r.task_id")
        .all()
        .map((r) => r.k);
      assert.deepEqual(reportAuthors, ["terry", "unknown"]);

      // 4 — the canonicalisation is `norm`: the column equals the JS function on
      //     every row. (A SQL-only migration cannot run `norm`, so this pins the
      //     agreement for the ASCII/CJK names a board actually carries.)
      for (const actor of board.db.prepare("SELECT display_name, normalized_name FROM actors").all()) {
        assert.equal(actor.normalized_name, norm(actor.display_name), `${actor.display_name} canonicalises to norm()`);
      }

      // 5 — the reference is real: naming an actor that does not exist is refused,
      //     through the same mapper a caller sees.
      assert.throws(
        () =>
          board.db
            .prepare("INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, created_at) VALUES ('c9','t1','x','note','agent','nobody','[]',?)")
            .run(TS),
        /FOREIGN KEY/i,
      );

      // 6 — the scratch map is gone, integrity is clean, and every reference resolves.
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(tableNames(board.db).filter((n) => n.startsWith("_attr")), []);
      assert.equal(
        board.db.prepare("SELECT COUNT(*) AS n FROM tasks t WHERE t.claimed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = t.claimed_by)").get().n,
        0,
      );
    } finally {
      board.close();
    }
  });

  it("lands the upgrade on the schema a fresh board has — indexes and triggers included", async () => {
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0020() });
      seedAttributionBoard(upgrade.db);
      applyMigrations(upgrade.db);

      // The rebuild re-creates every index and every trigger; a missing one is a
      // silent invariant hole. Compare by shape, and by full text for triggers.
      for (const table of ["tasks", "comments", "task_reports"]) {
        assert.deepEqual(
          indexShapes(upgrade.db, table),
          indexShapes(fresh.db, table),
          `${table}: the upgrade must land on the fresh index set`,
        );
      }
      assert.deepEqual(triggersOf(upgrade.db), triggersOf(fresh.db), "no trigger added, lost or rewritten");

      // …and the two new references are on both sides of the rebuild.
      const fks = foreignKeys(upgrade.db);
      const has = (child, parent) => fks.some((fk) => fk.child === child && fk.parent === parent);
      assert.ok(has("tasks.claimed_by", "actors"), "tasks.claimed_by references actors");
      assert.ok(has("comments.author_id", "actors"), "comments.author_id references actors");
      assert.ok(has("task_reports.author_id", "actors"), "task_reports.author_id references actors");
      // The deliberate exclusions (see `test/contract/attribution-boundary.test.mjs`).
      assert.equal(has("task_activities.actor_id", "actors"), false, "the audit log is not a reference");
      assert.equal(has("agent_sessions.owner", "actors"), false, "telemetry is not a reference");
    } finally {
      upgrade.close();
      fresh.close();
    }
  });
});
