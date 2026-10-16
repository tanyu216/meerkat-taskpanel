/**
 * 0019 — the two dictionary tables become one `actors` table, deduplicated, and
 * `tasks` loses the denormalised kind copies.
 *
 * This is the one migration in the set that **destroys rows**, so the property
 * under test is the merge itself, proved against a board that actually contains
 * the collisions it exists to resolve. A board where nothing collides proves
 * nothing, so the seed below is built to collide in both directions:
 *
 *   * `terry` appears **twice inside `assignees`** (same normalised name, two
 *     kinds) — legal under 0004's `UNIQUE(normalized_name, kind)`;
 *   * `terry` appears **again in `reporters`** — the cross-table collision.
 *
 * The merge must collapse all three onto one survivor (the earliest row, which
 * here lives in `reporters` — so a task whose `assignee_id` pointed at an
 * `assignees` row must be repointed **across tables**), and it must lose nothing:
 * `use_count` sums, `first_seen_at` takes the minimum, `last_seen_at` the maximum,
 * and every `tasks` reference still resolves afterwards.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertTask, makeTempDir, reasonCode } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0019 — a board as the previous build left it. */
function before0019() {
  const dir = makeTempDir("meerkat-taskpanel-pre0019-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0019")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

/**
 * The shipped set **through 0022** — everything this file's migration did, and
 * nothing after it.
 *
 * `0023` moves the kind off the actor row, so a test that applied *every* file
 * would be asserting 0023's outcome inside a 0019 suite: `actors.kind` — the
 * column `0019` introduced — would be gone before the assertions ran. A
 * migration's own test asserts the state *that migration* produces; `0023` has
 * its own (`migrations-0023.test.mjs`).
 */
function through0022() {
  const dir = makeTempDir("meerkat-taskpanel-through0022-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) <= "0022")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const d = (n) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const EARLY = "2025-12-01T00:00:00.000Z";
const LATE = "2026-02-01T00:00:00.000Z";

/** The named indexes on `tasks` — name, uniqueness, partiality, columns. */
const indexShapes = (db) =>
  db
    .prepare("SELECT name, \"unique\" AS uniq, partial AS part FROM pragma_index_list('tasks')")
    .all()
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

/**
 * A board with the two collision cases, and tasks that reach into both tables.
 *
 * `t1.assignee` and `t2.assignee` point at rows inside `assignees`; the `terry`
 * group's survivor is `r1`, which lives in `reporters` — so if the repoint did not
 * cross tables, both would dangle.
 */
function seedCollidingBoard(db) {
  db.prepare(
    "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("p1", "P1", 10, "[]", "{}", TS, TS);

  const insAssignee = db.prepare(
    "INSERT INTO assignees(id, kind, display_name, normalized_name, platform, first_seen_at, last_seen_at, use_count) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insReporter = db.prepare(
    "INSERT INTO reporters(id, kind, display_name, normalized_name, platform, first_seen_at, last_seen_at, use_count) VALUES (?,?,?,?,?,?,?,?)",
  );
  // `terry` twice within `assignees` (human a1, agent a2) …
  insAssignee.run("a1", "human", "Terry", "terry", null, d(1), d(2), 2);
  insAssignee.run("a2", "agent", "terry", "terry", null, d(3), d(4), 1);
  insAssignee.run("a3", "agent", "Linus", "linus", null, d(1), d(1), 3);
  // … and `terry` a third time in `reporters`, with the earliest first_seen (so it
  // is the survivor and the repoint must cross tables).
  insReporter.run("r1", "human", "TERRY", "terry", null, EARLY, LATE, 5);
  insReporter.run("r2", "human", "Elon", "elon", null, d(1), d(5), 1);

  insertTask(db, { id: "t1", identifier: "P1-0001", project_id: "p1", assignee_kind: "human", assignee_id: "a1", reporter_id: "r1", creator_kind: "human", creator_id: "Terry", claimed_by: "linus" });
  insertTask(db, { id: "t2", identifier: "P1-0002", project_id: "p1", assignee_kind: "agent", assignee_id: "a2", reporter_id: "r2", creator_kind: "agent", creator_id: "linus" });
  insertTask(db, { id: "t3", identifier: "P1-0003", project_id: "p1", assignee_kind: "agent", assignee_id: "a3" });
  insertTask(db, { id: "t4", identifier: "P1-0004", project_id: "p1", reporter_id: "r1", claimed_by: "elon" });
}

const actor = (db, id) => db.prepare("SELECT id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count FROM actors WHERE id = ?").get(id);
const refs = (db, id) => ({ ...db.prepare("SELECT id, assignee_id, reporter_id, claimed_by FROM tasks WHERE id = ?").get(id) });

describe("storage/migrations — 0019 merges the two dictionary tables into `actors`", () => {
  it("deduplicates across both tables, repoints every reference, and loses nothing", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0019() });
      assert.equal(old.applied.at(-1).version, "0018");
      seedCollidingBoard(board.db);
      // Precondition: the collision really is there, in both directions.
      assert.equal(board.db.prepare("SELECT COUNT(*) n FROM assignees").get().n, 3);
      assert.equal(board.db.prepare("SELECT COUNT(*) n FROM reporters").get().n, 2);
      assert.equal(
        board.db.prepare("SELECT COUNT(*) n FROM (SELECT normalized_name FROM assignees GROUP BY normalized_name HAVING COUNT(*)>1)").get().n,
        1,
        "precondition: one name collides within `assignees`",
      );
      const indexesBefore = indexShapes(board.db);
      const triggersBefore = triggersOf(board.db);

      // Through 0022: this suite asserts what *0019* built, and 0023 (which moves
      // the kind off the actor row) has its own.
      const up = applyMigrations(board.db, { dir: through0022() });
      assert.deepEqual(up.applied.map((m) => m.version), ["0019", "0020", "0021", "0022"]);

      // 1 — the merge itself. Three `terry` rows become one, and the sums hold.
      const merged = board.db.prepare("SELECT * FROM actors ORDER BY normalized_name").all();
      assert.equal(merged.length, 3, "three people, not five rows");
      const terry = actor(board.db, "r1");
      assert.equal(terry.kind, "human", "the survivor's kind wins");
      assert.equal(terry.display_name, "TERRY", "the earliest spelling wins");
      assert.equal(terry.normalized_name, "terry");
      assert.equal(terry.first_seen_at, EARLY, "first_seen_at is the minimum");
      assert.equal(terry.last_seen_at, LATE, "last_seen_at is the maximum");
      assert.equal(Number(terry.use_count), 8, "2 + 1 + 5 — use_count sums over the group");
      assert.equal(Number(actor(board.db, "a3").use_count), 3, "a group of one keeps its count");
      assert.equal(Number(actor(board.db, "r2").use_count), 1);

      // 2 — references. The old assignee rows a1/a2 are gone; the cards that
      // pointed at them must now point at the survivor r1 (a cross-table repoint).
      // `claimed_by` was a free string at 0019 and became an actor reference at
      // 0020, so it reads back through the actor row as the name the card carried.
      const actorIdByName = (name) =>
        board.db.prepare("SELECT id FROM actors WHERE normalized_name = ?").get(name).id;
      assert.deepEqual(refs(board.db, "t1"), { id: "t1", assignee_id: "r1", reporter_id: "r1", claimed_by: actorIdByName("linus") });
      assert.deepEqual(refs(board.db, "t2"), { id: "t2", assignee_id: "r1", reporter_id: "r2", claimed_by: null });
      assert.deepEqual(refs(board.db, "t3"), { id: "t3", assignee_id: "a3", reporter_id: null, claimed_by: null });
      assert.deepEqual(refs(board.db, "t4"), { id: "t4", assignee_id: null, reporter_id: "r1", claimed_by: actorIdByName("elon") });

      // Every reference resolves — nothing dangles.
      assert.equal(
        board.db.prepare("SELECT COUNT(*) n FROM tasks t WHERE t.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = t.assignee_id)").get().n,
        0,
        "no dangling assignee",
      );
      assert.equal(
        board.db.prepare("SELECT COUNT(*) n FROM tasks t WHERE t.reporter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = t.reporter_id)").get().n,
        0,
        "no dangling reporter",
      );

      // 3 — the two old tables are gone. `claimed_by` was untouched by 0019 (it
      // was a free string then); 0020, later in the same upgrade, turns it into a
      // reference — so it reads back through the actor row.
      const tables = tableNames(board.db);
      assert.equal(tables.includes("actors"), true);
      assert.equal(tables.includes("assignees"), false);
      assert.equal(tables.includes("reporters"), false);
      assert.equal(refs(board.db, "t1").claimed_by, actorIdByName("linus"), "claimed_by names the actor for `linus`");

      // 4 — the three denormalised columns are gone; the two ALTER-added ones stay.
      const columns = board.db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
      for (const gone of ["assignee_kind", "creator_kind", "creator_id"]) {
        assert.equal(columns.includes(gone), false, `tasks.${gone} must be dropped`);
      }
      for (const kept of ["assignee_id", "reporter_id", "awaiting_reason", "blocked_reason", "claimed_by"]) {
        assert.equal(columns.includes(kept), true, `tasks.${kept} must survive`);
      }

      // 5 — the index set did not move.
      assert.deepEqual(indexShapes(board.db), indexesBefore, "0019 must not add or drop a `tasks` index");
      assert.equal(indexesBefore.length, 7);

      // 6 — only the trigger it must move moved; nothing else, and nothing was
      // lost except the two old tables' own triggers.
      const triggersAfter = triggersOf(board.db);
      const DICTIONARY_TRIGGERS_REMOVED = [
        "tr_dict_assignees_delete",
        "tr_dict_reporters_delete",
        "tr_rev_assignees_del",
        "tr_rev_assignees_ins",
        "tr_rev_assignees_upd",
        "tr_rev_reporters_del",
        "tr_rev_reporters_ins",
        "tr_rev_reporters_upd",
      ];
      assert.deepEqual(
        Object.keys(triggersAfter).filter((name) => !(name in triggersBefore)).sort(),
        ["tr_dict_actors_delete", "tr_rel_block_chain", "tr_rel_parent_block_pair", "tr_rev_actors_del", "tr_rev_actors_ins", "tr_rev_actors_upd"],
        "0019 adds one delete guard and three revision triggers on `actors`; 0021/0022 add the two relation guards",
      );
      assert.deepEqual(
        Object.keys(triggersBefore).filter((name) => !(name in triggersAfter)).sort(),
        DICTIONARY_TRIGGERS_REMOVED,
        "the two old tables take their own triggers with them",
      );
      const changed = Object.keys(triggersBefore).filter((name) => triggersBefore[name] !== triggersAfter[name]).sort();
      assert.deepEqual(
        changed,
        [...DICTIONARY_TRIGGERS_REMOVED, "tr_rev_tasks_upd"].sort(),
        "only `tr_rev_tasks_upd`'s column domain moves — it named the three dropped columns",
      );
      // The relation guards and the delivery gate really are the shipped text.
      for (const name of ["tr_rel_cross_project", "tr_rel_parent_guard", "tr_rel_parent_epic", "tr_rel_block_cycle", "tr_deliver_gate", "tr_tasks_transition"]) {
        assert.equal(triggersAfter[name], triggersBefore[name], `${name} must survive the rebuild verbatim`);
      }
      assert.equal(/\bassignee_kind\b/.test(triggersAfter.tr_rev_tasks_upd), false, "the cursor no longer names a dropped column");

      // 7 — no scratch table survived, and foreign key enforcement is back on.
      assert.deepEqual(
        board.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tasks_%'").all().map((r) => r.name),
        [],
        "the scratch table must be renamed away",
      );
      assert.equal(Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);

      // 8 — the database agrees it is consistent.
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);

      // 9 — a foreign key still has teeth against the new target.
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare("INSERT INTO tasks(id, identifier, project_id, title, status, assignee_id, created_at, updated_at) VALUES ('tx','P1-0009','p1','x','todo','no-such-actor',?,?)")
            .run(TS, TS),
        ),
        "NOT_FOUND",
        "tasks.assignee_id now references actors(id)",
      );
    } finally {
      board.close();
    }
  });

  it("arms one delete guard on `actors` that checks both roles", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0019() });
      seedCollidingBoard(board.db);
      applyMigrations(board.db, { dir: through0022() });

      // r1 is an assignee of one card and a reporter of two.
      assert.equal(reasonCode(() => board.db.prepare("DELETE FROM actors WHERE id = 'r1'").run()), "DICTIONARY_ENTRY_IN_USE");
      // r2 is **only** a reporter — the guard must look at `reporter_id` too.
      assert.equal(reasonCode(() => board.db.prepare("DELETE FROM actors WHERE id = 'r2'").run()), "DICTIONARY_ENTRY_IN_USE");
      // a3 is only an assignee — the `assignee_id` half.
      assert.equal(reasonCode(() => board.db.prepare("DELETE FROM actors WHERE id = 'a3'").run()), "DICTIONARY_ENTRY_IN_USE");
      // An unreferenced row deletes cleanly.
      board.db.prepare("INSERT INTO actors(id, kind, display_name, normalized_name, first_seen_at, last_seen_at) VALUES ('spare','human','Spare','spare',?,?)").run(TS, TS);
      assert.equal(reasonCode(() => board.db.prepare("DELETE FROM actors WHERE id = 'spare'").run()), "NO_ERROR");
    } finally {
      board.close();
    }
  });

  it("lands the upgrade on the index set a fresh board has — no index added, none lost", async () => {
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0019() });
      const before = indexShapes(upgrade.db);
      applyMigrations(upgrade.db);
      assert.deepEqual(indexShapes(upgrade.db), before, "an upgrade must not add or lose a `tasks` index");
      assert.deepEqual(indexShapes(fresh.db), indexShapes(upgrade.db), "an upgraded board and a fresh board agree");
    } finally {
      upgrade.close();
      fresh.close();
    }
  });

  it("is a no-op on a board that is already at 0019", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0019"), true);
      assert.equal(tableNames(board.db).includes("actors"), true);
      assert.equal(tableNames(board.db).includes("assignees"), false);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });
});
