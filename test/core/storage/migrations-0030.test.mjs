/**
 * 0030 — `comments.kind` gains `confirm_request`, the formal comment kind for
 * "send this back to the leader for confirmation" (`docs/sla.md` §11).
 *
 * SQLite cannot widen a `CHECK`, so the migration rebuilds the table. The
 * property under test is that the rebuild is **invisible** to everything else:
 * every row survives verbatim, both indexes and all five comment triggers come
 * back, the inbound `attachments.comment_id` reference still resolves, the
 * actor-delete guard (which names `comments` in its `WHEN` clause) is restored,
 * and the revision cursor still advances on the next insert.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0030 — a board as the previous build left it. */
function before0030() {
  const dir = makeTempDir("meerkat-taskpanel-pre0030-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0030")) {
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
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").trim()]),
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

/** A board at 0029 with one comment, one attachment and two actors. */
function seed(db) {
  db.prepare(
    "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("p1", "P1", 10, "[]", "{}", TS, TS);

  // 0023 moved the "kind" off the actor row and onto each act's reference.
  const insActor = db.prepare(
    "INSERT INTO actors(id, display_name, normalized_name, first_seen_at, last_seen_at) VALUES (?,?,?,?,?)",
  );
  insActor.run("a-terry", "Terry", "terry", TS, TS);
  insActor.run("a-linus", "linus", "linus", TS, TS);

  db.prepare(
    "INSERT INTO tasks(id, identifier, project_id, title, status, created_at, updated_at, status_changed_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("t1", "P1-0001", "p1", "one", "in_progress", TS, TS, TS);

  const insComment = db.prepare(
    "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insComment.run("c1", "t1", "human one", "confirm", "human", "a-terry", "[]", TS);
  insComment.run("c2", "t1", "agent note", "note", "agent", "a-linus", "[]", TS);

  db.prepare(
    "INSERT INTO attachments(id, task_id, comment_id, filename, kind, created_at) VALUES (?,?,?,?,?,?)",
  ).run("at1", "t1", "c1", "plan.md", "attachment", TS);
}

describe("storage/migrations — 0030 widens the comment-kind CHECK", () => {
  it("rebuilds comments without changing anything else", async () => {
    const board = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      const old = applyMigrations(board.db, { dir: before0030() });
      assert.equal(old.applied.at(-1).version, "0029");
      seed(board.db);
      const before = board.db.prepare("SELECT id, task_id, body, kind, author_kind, author_id, refs_json, created_at FROM comments ORDER BY id").all();

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0030", "0031", "0032", "0033", "0034", "0035", "0036", "0037", "0038", "0039", "0040", "0041", "0042"]);

      // 1 — rows survive verbatim.
      const after = board.db.prepare("SELECT id, task_id, body, kind, author_kind, author_id, refs_json, created_at FROM comments ORDER BY id").all();
      assert.deepEqual(after, before);

      // 2 — the new kind is accepted; an unknown one is still refused by the CHECK.
      const ins = board.db.prepare(
        "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
      );
      assert.doesNotThrow(() => ins.run("c3", "t1", "please confirm", "confirm_request", "agent", "a-linus", "[]", TS));
      assert.throws(() => ins.run("c4", "t1", "x", "nonsense", "agent", "a-linus", "[]", TS), /CHECK/i);

      // 3 — the shape is the same as a freshly-installed board.
      assert.deepEqual(indexShapes(board.db, "comments"), indexShapes(fresh.db, "comments"));
      assert.deepEqual(triggersOf(board.db), triggersOf(fresh.db));
      assert.deepEqual(foreignKeys(board.db), foreignKeys(fresh.db));

      // 4 — the inbound attachment reference still has teeth.
      assert.throws(
        () => board.db
          .prepare("INSERT INTO attachments(id, task_id, comment_id, filename, kind, created_at) VALUES (?,?,?,?,?,?)")
          .run("at2", "t1", "missing", "x", "attachment", TS),
        /FOREIGN KEY/i,
      );

      // 5 — the actor-delete guard survived the rebuild.
      assert.throws(() => board.db.prepare("DELETE FROM actors WHERE id = 'a-terry'").run(), /DICTIONARY_ENTRY_IN_USE/);

      // 6 — no scratch table, integrity clean, and the revision cursor advances.
      assert.deepEqual(tableNames(board.db).filter((n) => n.startsWith("comments_")), []);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
      const revisionBefore = board.db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision;
      ins.run("c5", "t1", "one more", "note", "human", "a-terry", "[]", TS);
      assert.equal(
        board.db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision,
        revisionBefore + 1,
      );
    } finally {
      board.close();
      fresh.close();
    }
  });
});
