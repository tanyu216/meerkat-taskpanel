/**
 * 0015 — `deploy` becomes a task kind, across an existing board.
 *
 * The migration's job is to widen **one** `CHECK` and move nothing else, so
 * "nothing else moved" is the property under test — the same standard
 * `test/core/storage/migrations-0013.test.mjs` holds 0013 to, applied to the
 * rebuild that ships after it:
 *
 *   * `deploy` is storable and round-trips; `task` and `epic` still are; a word
 *     outside the vocabulary is still refused by the table's `CHECK`;
 *   * every row, every column (0013's `awaiting_reason` included) and every
 *     foreign key pointing at `tasks` survives;
 *   * **all seven** indexes come back — the set an upgraded board carries is the
 *     set a fresh board has, which is the trap that produced 0014;
 *   * every trigger comes back byte-identical to the definition a pre-0015 board
 *     carries: this migration widens a `CHECK`, it does not move a rule. (0013's
 *     equivalent assertion allows two changed triggers, because 0013 *did* move
 *     the transition whitelist and the revision cursor. Here the expected set of
 *     changed triggers is empty, which is the stronger claim.)
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { indexShapesOf, migrationsBefore, migrationsThrough, triggersOf } from "../../helpers/migration-shapes.mjs";
import { TS, cleanupTempDirs, createTempBoard, insertTask, reasonCode } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0015 — a board as the previous build left it. */
const before0015 = migrationsBefore("0015", { prefix: "meerkat-taskpanel-pre0015-" });
/** The set through 0038: 0039 rebuilds `tasks` again and retires `deploy`, which
 *  is that file's subject, not this one's. */
const through0038 = migrationsThrough("0038", { prefix: "meerkat-taskpanel-through0038-" });

const columnsOf = (db) => db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
const tasksSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;

/**
 * The **named** indexes on `tasks`, each with the shape that makes it itself —
 * name, columns, uniqueness, partiality. 0005's `ix_tasks_source` is the one
 * 0013's rebuild lost, so it is the first thing this comparison will catch if
 * 0015 repeats the mistake.
 */
// 0025 adds a review-marker index of its own. This comparison is about the
// *rebuilt* table keeping the indexes it had; a later migration's own new index
// is named here rather than the rule being loosened.
const indexShapes = (db) => indexShapesOf(db, "tasks", { exclude: ["ix_tasks_review_of"] });

/** Build the "previous build" board with rows the migration must not lose. */
function seedLegacyBoard(db) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, readme, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy", "Legacy project", 7, '["m1"]', '{"k":"v"}', "# notes", TS, TS);
  insertTask(db, { id: "running", identifier: "LEGACY-0001", project_id: "legacy", status: "in_progress" });
  insertTask(db, { id: "paused", identifier: "LEGACY-0002", project_id: "legacy", status: "awaiting", awaiting_reason: "E3" });
  insertTask(db, { id: "epic", identifier: "LEGACY-0003", project_id: "legacy", kind: "epic" });
  db.prepare(
    "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("c1", "running", "hello", "note", "human", "terry", "[]", 1, TS);
}

describe("storage/migrations — 0015 makes `deploy` a task kind (T-20261013-232004)", () => {
  it("carries an existing board across the rebuild, widening the kind enum", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0015() });
      assert.equal(old.applied.at(-1).version, "0014");
      assert.equal(/deploy/.test(tasksSql(board.db)), false, "precondition: the old CHECK has no `deploy`");
      const indexesBefore = indexShapes(board.db);
      assert.ok(
        indexesBefore.some((index) => index.name === "ix_tasks_source"),
        "precondition: the previous build's board carries 0005's ix_tasks_source",
      );
      seedLegacyBoard(board.db);

      const up = applyMigrations(board.db, { dir: through0038() });
      // 0015 and everything after it: 0016 (`blocked_reason`) is the next file in
      // the set, and this board is below both.
      assert.deepEqual(up.applied.map((m) => m.version), ["0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035", "0036", "0038"]);
      assert.deepEqual(up.skipped.slice(-2), ["0013", "0014"]);

      // 1 — the enum: the new word is storable, the old ones still are (they are
      // the rows seeded above), and a word the vocabulary does not have is still
      // refused. No trigger shadows `kind` except 0011's epic-downgrade guard,
      // which fires only on an epic *leaving* `epic`.
      assert.match(tasksSql(board.db), /'deploy'/, "the rebuilt CHECK must name `deploy`");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET kind = 'deploy' WHERE id = 'running'").run()),
        "NO_ERROR",
        "a card can become a deployment card",
      );
      assert.equal(board.db.prepare("SELECT kind FROM tasks WHERE id = 'running'").get().kind, "deploy");
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, kind, created_at, updated_at)
               VALUES ('t-check','CHECK-1','legacy','x','todo','nonsense', ?, ?)`,
            )
            .run(TS, TS),
        ),
        "VALIDATION_FAILED",
        "the widened CHECK still refuses a kind the vocabulary does not have",
      );

      // 2 — the guards a rebuild could have dropped are all still armed. Note
      // `running` is a `deploy` card by now: the marker is a read-time exclusion
      // (`domain/claim.mjs`), not a state-machine rule, so its transitions are
      // exactly a task's.
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'running'").run()),
        "REPORT_REQUIRED",
        "the delivery gate survived the rebuild",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'paused'").run()),
        "INVALID_TRANSITION",
        "an awaiting card may not reach review (0013's whitelist survived)",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'paused'").run()),
        "NO_ERROR",
        "awaiting may still resume",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET kind = 'task' WHERE id = 'epic'").run()),
        "NO_ERROR",
        "an epic with no children may be downgraded (0011's guard survived)",
      );
      // A `deploy` card is a leaf like any other task: the parent guard still
      // demands an `epic` of a parent, so the new kind buys no new edge.
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent','running','epic', ?)",
            )
            .run(TS),
        ),
        "VALIDATION_FAILED",
        "only an epic can be a parent, `deploy` included",
      );

      // 3 — nothing was rebuilt away. The expected index set is the one read off
      // the board the upgrade started from, not a list written out here.
      assert.deepEqual(indexShapes(board.db), indexesBefore, "the rebuild must not add or drop an index");
      assert.equal(indexesBefore.length, 7, "the previous build's board carries all seven indexes");

      // 4 — every row, every other column, and every foreign key survived.
      for (const column of ["id", "identifier", "title", "delivery_round", "idem", "meta_json", "report_waiver_reason", "awaiting_reason"]) {
        assert.ok(columnsOf(board.db).includes(column), `tasks.${column} must survive the rebuild`);
      }
      const legacy = board.db.prepare("SELECT * FROM projects WHERE id = 'legacy'").get();
      assert.equal(legacy.name, "Legacy project");
      assert.equal(Number(legacy.next_task_number), 7);
      assert.equal(legacy.meta_json, '{"k":"v"}');
      assert.equal(
        board.db.prepare("SELECT awaiting_reason FROM tasks WHERE id = 'paused'").get().awaiting_reason,
        "E3",
        "0013's awaiting_reason is copied, not dropped",
      );
      assert.equal(board.db.prepare("SELECT body FROM comments WHERE id = 'c1'").get().body, "hello");
      assert.equal(
        board.db.prepare("SELECT COUNT(*) n FROM pragma_foreign_key_list('comments') WHERE \"table\" = 'tasks'").get().n,
        1,
        "comments must still reference the rebuilt tasks table, not the old one",
      );
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at) VALUES ('orphan','no-such-task','x','note','agent','a','[]',1,?)",
            )
            .run(TS),
        ),
        "NOT_FOUND",
        "the foreign key still has teeth after the rebuild",
      );

      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("moves no trigger at all — a rebuild is not a rewrite", async () => {
    // The rebuild drops `tasks` (taking its triggers) and re-creates them from
    // 0013's text. 0013 itself moved two of them on purpose (the transition
    // whitelist and the revision cursor's column domain); 0015 moves **none**, so
    // the expected set of changed triggers is empty. A guard quietly rewritten
    // during a rebuild is exactly the loss this assertion makes impossible.
    const before = await createTempBoard({ migrate: false });
    const after = await createTempBoard();
    try {
      applyMigrations(before.db, { dir: before0015() });
      const oldTriggers = triggersOf(before.db);
      const newTriggers = triggersOf(after.db);

      // As in the 0013 suite: `after` runs the whole shipped set, so a later
      // migration's own trigger is an allowed addition/removal. Later files
      // touch triggers: `0017_block_cycle.sql` adds `tr_rel_block_cycle`, and
      // `0019_actors.sql` merges the two dictionary tables into `actors` — removing
      // the four triggers on each old table (`tr_dict_*_delete` + `tr_rev_*_{ins,upd,del}`),
      // adding `tr_dict_actors_delete` and `tr_rev_actors_{ins,upd,del}`, and
      // re-declaring `tr_rev_tasks_upd` during its `tasks` rebuild. What 0015's own
      // rebuild may not do is lose one or invent one of its own. 0021/0022 add the
      // two relation guards `tr_rel_block_chain` / `tr_rel_parent_block_pair`.
      const LATER_TRIGGERS_ADDED = [
        "tr_deliver_gate_done",
        "tr_dict_actors_delete",
        "tr_rel_block_chain",
        "tr_rel_block_cycle",
        "tr_rel_parent_block_pair",
        "tr_reports_not_applicable_note",
        "tr_reports_rollup_valid",
        "tr_rev_actors_del",
        "tr_rev_actors_ins",
        "tr_rev_actors_upd",
        "tr_tasks_acceptance_agent_done",
        "tr_tasks_acceptance_mode_ins",
        "tr_tasks_acceptance_mode_upd",
        "tr_tasks_acceptance_prune_audited",
        "tr_tasks_acceptance_revision",
        "tr_tasks_children_terminal",
        "tr_tasks_epic_rollup_done",
        "tr_tasks_reopen_state",
        "tr_tasks_review_card_not_required",
        "tr_tasks_review_card_not_required_update",
        "tr_tasks_review_marker_immutable",
      ];
      const LATER_TRIGGERS_REMOVED = [
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
        Object.keys(newTriggers)
          .filter((name) => !(name in oldTriggers))
          .sort(),
        LATER_TRIGGERS_ADDED,
        "only a later migration's own trigger may appear",
      );
      assert.deepEqual(
        Object.keys(oldTriggers).filter((name) => !(name in newTriggers)).sort(),
        LATER_TRIGGERS_REMOVED,
        "0015's rebuild must not lose a trigger (0019 removes the two old tables' triggers)",
      );
      const changed = Object.keys(oldTriggers).filter((name) => oldTriggers[name] !== newTriggers[name]).sort();
      assert.deepEqual(
        changed,
        [
          ...LATER_TRIGGERS_REMOVED,
          "tr_rev_projects_upd",
          "tr_rev_tasks_upd",
          "tr_tasks_transition",
          "tr_deliver_gate",
          // 0027 rewrites the terminal guard and the round bump in place.
          "tr_tasks_terminal",
          "tr_tasks_round_bump",
        ].sort(),
        "0015 must change no trigger — 0019's own `tasks` rebuild moves `tr_rev_tasks_upd`, 0020 re-declares every trigger it parks verbatim, 0024 rewrites the whitelist and the delivery gate in place for the epic overlay, and 0027 rewrites the terminal guard and the round bump for reopen",
      );

      for (const name of ["tr_rel_cross_project", "tr_rel_parent_guard", "tr_rel_parent_epic"]) {
        assert.equal(newTriggers[name], oldTriggers[name], `${name} must survive the rebuild verbatim`);
      }
    } finally {
      before.close();
      after.close();
    }
  });

  it("lands the upgrade on the index set a fresh board has — no index added, none lost", async () => {
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0015() });
      const before = indexShapes(upgrade.db);

      applyMigrations(upgrade.db);

      assert.deepEqual(indexShapes(upgrade.db), before, "an upgrade must not add or lose an index");
      assert.deepEqual(
        indexShapes(fresh.db),
        indexShapes(upgrade.db),
        "an upgraded board and a fresh board must carry the same indexes",
      );
    } finally {
      upgrade.close();
      fresh.close();
    }
  });

  it("is a no-op on a board that is already at 0015", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: through0038() });
      const again = applyMigrations(board.db, { dir: through0038() });
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0015"), true);
      assert.match(tasksSql(board.db), /'deploy'/);
      assert.equal(board.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(board.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      board.close();
    }
  });

  it("leaves no scratch table behind, and no deferred foreign keys", async () => {
    const board = await createTempBoard();
    try {
      const leftovers = board.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tasks_%'")
        .all()
        .map((r) => r.name);
      assert.deepEqual(leftovers, [], "the scratch table must be renamed away, not orphaned");
      assert.equal(
        Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
        1,
        "foreign key enforcement must be back on after the rebuild",
      );
      for (const child of ["task_relations", "comments", "attachments", "agent_sessions", "task_reports"]) {
        const parents = board.db
          .prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list('${child}')`)
          .all()
          .map((r) => r.parent);
        assert.equal(parents.includes("tasks"), true, `${child} must still reference tasks`);
        assert.equal(
          parents.some((name) => name.startsWith("tasks_") && name !== "tasks"),
          false,
          `${child} references a scratch name`,
        );
      }
    } finally {
      board.close();
    }
  });
});
