/**
 * 0013 — `awaiting` becomes a first-class status, across an existing board.
 *
 * The card asks for the *upgrade* to be proven, not just the fresh schema: a
 * board the previous build left behind (rows already in `in_progress`,
 * `in_review` and `blocked`, comments pointing at them) must come out the other
 * side with
 *
 *   * the widened status enum (and only that — an unknown word is still
 *     refused, and so is a reason code outside `E1..E5`);
 *   * the re-encoded transition whitelist, with `awaiting` reachable from
 *     `in_progress` and `in_review`/`done` still out of its reach;
 *   * the delivery gate, the terminal guard, the round bump and the revision
 *     cursor intact — a rebuild that silently dropped a trigger would be a
 *     missing invariant, which is exactly what this file exists to catch;
 *   * every row, every other column, and every foreign key still pointing at
 *     `tasks`.
 *
 * The rebuild is the only supported way to widen a SQLite `CHECK` (there is no
 * `ALTER TABLE … MODIFY`), so "nothing else moved" is the property under test —
 * see the migration's own header for why it is a rebuild and not an edit.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { applyMigrations } from "../../../src/core/storage/migrations-runner.mjs";
import { indexShapesOf, migrationsBefore } from "../../helpers/migration-shapes.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  createTempBoard,
  insertTask,
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/**
 * The shipped set **before** 0013 — a board as the previous build left it.
 *
 * Selected by version, not by name: `!n.startsWith("0013")` would have kept
 * 0014, which runs *after* 0013 and so cannot belong to a board the previous
 * build left behind. A pre-0013 board is 0001 … 0012, and nothing later.
 */
const before0013 = migrationsBefore("0013", { prefix: "meerkat-taskpanel-pre0013-" });

const columnsOf = (db) => db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
/**
 * The **named** indexes on `tasks`, each with the shape that makes it *itself* —
 * its columns, its uniqueness, and whether it is partial.
 *
 * `pragma_index_list` also reports SQLite's own implicit index for the `TEXT`
 * primary key (`sqlite_autoindex_tasks_1`); it is present before and after the
 * rebuild, is not ours to create, and would only make the comparisons below look
 * like drift.
 *
 * The shape is read, and not only the name: 0005's `ix_tasks_source` is
 * *partial* (`WHERE source_path IS NOT NULL`), so an index restored under the
 * right name with the wrong predicate would be a different index wearing the
 * same label.
 */
// 0025 adds a review-marker index of its own. This comparison is about the
// *rebuilt* table keeping the indexes it had; a later migration's own new index
// is named here rather than the rule being loosened.
const indexShapes = (db) => indexShapesOf(db, "tasks", { exclude: ["ix_tasks_review_of"] });
const triggerNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'").all().map((r) => r.name);
const tasksSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;

/** Every trigger `tasks` must still have after the rebuild. */
const EXPECTED_TRIGGERS = [
  "tr_tasks_terminal",
  "tr_tasks_transition",
  "tr_tasks_archive_terminal",
  "tr_tasks_kind_downgrade",
  "tr_latest_report_belongs",
  "tr_deliver_gate",
  "tr_tasks_round_bump",
  // 0025/0026 — the head's review-marker and children-terminal guards.
  "tr_tasks_review_marker_immutable",
  "tr_tasks_children_terminal",
  // 0027 — the reopen edge releases the finished row's bookkeeping before the
  // terminal guard lets the status through.
  "tr_tasks_reopen_state",
  // 0031 — the review-required marker and its `done` floor.
  "tr_tasks_review_card_not_required",
  "tr_tasks_review_card_not_required_update",
  "tr_tasks_review_required_done",
  // 0032 — the frozen acceptance baseline and its audited prune.
  "tr_tasks_acceptance_prune_audited",
  "tr_tasks_acceptance_revision",
  // 0033 — the epic's done guard (the rollup-marker trigger lives on
  // task_reports, so it is not in this tasks-only list).
  "tr_tasks_epic_rollup_done",
  "tr_rev_tasks_ins",
  "tr_rev_tasks_upd",
  "tr_rev_tasks_del",
];

/** Build the "previous build" board with rows the migration must not lose. */
function seedLegacyBoard(db) {
  db.prepare(
    `INSERT INTO projects(id, name, next_task_number, labels, meta_json, readme, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy", "Legacy project", 7, '["m1"]', '{"k":"v"}', "# notes", TS, TS);
  insertTask(db, { id: "running", identifier: "LEGACY-0001", project_id: "legacy", status: "in_progress" });
  insertTask(db, { id: "reviewed", identifier: "LEGACY-0002", project_id: "legacy", status: "in_review" });
  insertTask(db, { id: "paused", identifier: "LEGACY-0003", project_id: "legacy", status: "blocked", blocked_at: TS });
  db.prepare(
    "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("c1", "running", "hello", "note", "human", "terry", "[]", 1, TS);
}

describe("storage/migrations — 0013 makes `awaiting` a first-class status (M1)", () => {
  it("carries an existing board across the rebuild, widening the status enum", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      const old = applyMigrations(board.db, { dir: before0013() });
      assert.equal(old.applied.at(-1).version, "0012");
      assert.equal(/awaiting/.test(tasksSql(board.db)), false, "precondition: the old CHECK has no `awaiting`");
      // The index set the previous build left on `tasks` — all seven of them,
      // 0005's partial `ix_tasks_source` among them. Step 3 compares against
      // this, so an index the rebuild drops is a red test rather than a board
      // that is quietly not the one a fresh install builds. (This is the exact
      // index that went missing: 0013 re-created six of the seven, and 0014
      // restores the seventh.)
      const indexesBefore = indexShapes(board.db);
      assert.ok(
        indexesBefore.some((index) => index.name === "ix_tasks_source"),
        "precondition: the previous build's board carries 0005's ix_tasks_source",
      );
      seedLegacyBoard(board.db);

      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034"]);
      assert.deepEqual(up.skipped.slice(-2), ["0011", "0012"]);

      // 1 — the enum: the new word is storable, the old ones still are, and an
      // unknown word / a bad reason code are still refused.
      assert.match(tasksSql(board.db), /awaiting/, "the rebuilt CHECK must name `awaiting`");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting', awaiting_reason = 'E3', status_changed_at = ? WHERE id = 'running'").run(TS2)),
        "NO_ERROR",
      );
      assert.equal(board.db.prepare("SELECT awaiting_reason FROM tasks WHERE id='running'").get().awaiting_reason, "E3");
      // A word the whitelist does not know is refused by the *trigger*, which is
      // what 0002 documents: BEFORE triggers run first, so their reason code wins
      // over the table's CHECK. The CHECK is the backstop for the INSERT path,
      // asserted directly below.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'nonsense' WHERE id = 'running'").run()), "INVALID_TRANSITION");
      assert.equal(
        reasonCode(() =>
          board.db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, created_at, updated_at)
               VALUES ('t-check','CHECK-1','legacy','x','nonsense', ?, ?)`,
            )
            .run(TS, TS),
        ),
        "VALIDATION_FAILED",
        "the widened CHECK still refuses a word the vocabulary does not have",
      );
      // ...and the reason code's own vocabulary, which no trigger shadows.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET awaiting_reason = 'E9' WHERE id = 'running'").run()), "VALIDATION_FAILED");
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET awaiting_reason = 'free text' WHERE id = 'running'").run()), "VALIDATION_FAILED");

      // 2 — the whitelist speaks `awaiting`; the gate and the terminal guard bite.
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_progress', status_changed_at = ? WHERE id = 'running'").run(TS2)), "NO_ERROR");
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting' WHERE id = 'running'").run()), "NO_ERROR");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'running'").run()),
        "INVALID_TRANSITION",
        "an awaiting card may not reach review",
      );
      // The gate itself: `blocked → in_review` with no report for the round is
      // still refused. (`in_review → done` is *acceptance* and needs no report —
      // that is the exit the gate exists to protect, not one it blocks.)
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'paused'").run()),
        "REPORT_REQUIRED",
        "the delivery gate survived the rebuild",
      );
      assert.equal(reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = 'paused'").run()), "NO_ERROR");
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET status = 'awaiting' WHERE id = 'reviewed'").run()),
        "INVALID_TRANSITION",
        "awaiting is entered from in_progress only",
      );

      // 3 — nothing was rebuilt away. The expected index set is the one read off
      // the board the upgrade started from, not a list written out here: a
      // hand-copied list is what let the missing index ship, and a rebuild that
      // drops one now fails on this line.
      assert.deepEqual(indexShapes(board.db), indexesBefore, "the rebuild must not add or drop an index");
      assert.deepEqual(triggerNames(board.db).sort(), EXPECTED_TRIGGERS.slice().sort());
      for (const name of EXPECTED_TRIGGERS) {
        const row = board.db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name = ?").get(name);
        assert.equal(row.tbl_name, "tasks", `${name} must still be attached to tasks`);
      }

      // 4 — every row, every other column, and every foreign key survived.
      for (const column of ["id", "identifier", "title", "delivery_round", "idem", "meta_json", "report_waiver_reason", "awaiting_reason"]) {
        assert.ok(columnsOf(board.db).includes(column), `tasks.${column} must survive the rebuild`);
      }
      const legacy = board.db.prepare("SELECT * FROM projects WHERE id = 'legacy'").get();
      assert.equal(legacy.name, "Legacy project");
      assert.equal(Number(legacy.next_task_number), 7);
      assert.equal(legacy.meta_json, '{"k":"v"}');
      assert.equal(board.db.prepare("SELECT blocked_at FROM tasks WHERE id = 'paused'").get().blocked_at, TS);
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

  it("moves exactly one trigger and nothing else — a rebuild is not a rewrite", async () => {
    // The rebuild drops and re-creates 15 triggers because dropping `tasks`
    // takes its own with it and parks the five that merely *name* `tasks` from
    // other tables. Every one of them must come back byte-identical to the
    // definition the history shipped, except the one this migration exists to
    // change. A guard quietly rewritten during a rebuild is exactly the kind of
    // loss this card is supposed to make impossible, so it is asserted by text.
    // Whitespace and `IF NOT EXISTS` are not part of a guard's meaning, so they
    // are normalised away rather than compared.
    const squeeze = (s) =>
      String(s)
        .replace(/\s+/g, " ")
        .replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+/i, "CREATE TRIGGER ")
        .trim();
    const triggersOf = (db) =>
      Object.fromEntries(
        db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all().map((r) => [r.name, squeeze(r.sql)]),
      );

    const before = await createTempBoard({ migrate: false });
    const after = await createTempBoard();
    try {
      applyMigrations(before.db, { dir: before0013() });
      const oldTriggers = triggersOf(before.db);
      const newTriggers = triggersOf(after.db);

      // `after` runs the **whole shipped set**, so a migration later than this
      // one may legitimately bring or remove a trigger of its own; the key sets
      // differ by exactly those. The rebuild itself may never lose one or invent
      // one, so the allowances are named rather than the comparison loosened.
      // Later files touch triggers: `0017_block_cycle.sql` adds
      // `tr_rel_block_cycle`; `0019_actors.sql` merges the two dictionary tables
      // into `actors` — removing the four triggers on each old table and adding
      // `tr_dict_actors_delete` + `tr_rev_actors_{ins,upd,del}`; and
      // `0021_block_chain.sql` / `0022_block_pair_on_parent.sql` add the two
      // relation guards `tr_rel_block_chain` + `tr_rel_parent_block_pair`.
      const LATER_MIGRATION_TRIGGERS = [
        "tr_dict_actors_delete",
        "tr_rel_block_chain",
        "tr_rel_block_cycle",
        "tr_rel_parent_block_pair",
        "tr_reports_not_applicable_note",
        "tr_reports_rollup_valid",
        "tr_rev_actors_del",
        "tr_rev_actors_ins",
        "tr_rev_actors_upd",
        "tr_tasks_acceptance_prune_audited",
        "tr_tasks_acceptance_revision",
        "tr_tasks_children_terminal",
        "tr_tasks_epic_rollup_done",
        "tr_tasks_reopen_state",
        "tr_tasks_review_card_not_required",
        "tr_tasks_review_card_not_required_update",
        "tr_tasks_review_marker_immutable",
        "tr_tasks_review_required_done",
      ];
      const LATER_MIGRATION_TRIGGERS_REMOVED = [
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
        LATER_MIGRATION_TRIGGERS,
        "only a later migration's own trigger may appear",
      );
      assert.deepEqual(
        Object.keys(oldTriggers).filter((name) => !(name in newTriggers)).sort(),
        LATER_MIGRATION_TRIGGERS_REMOVED,
        "the rebuild must not lose a trigger (0019 removes the two old tables' triggers)",
      );
      // The transition whitelist gains its `awaiting` clause and the revision
      // cursor's column domain gains `awaiting_reason` (0013); 0019 later rewrites
      // that same cursor's domain again when the `tasks` columns move, and removes
      // the two old tables' triggers. (`tr_dict_actors_delete` is 0019's, so it is
      // an *addition* to this baseline, not a change; 0020 widens it in place and
      // re-declares every trigger it parks verbatim.) 0024 then rewrites two of
      // them in place: the whitelist gains the epic's one pair and the delivery
      // gate gains the matching arming clause — a *change*, never a new name, so
      // `LATER_MIGRATION_TRIGGERS` above is untouched. Everything else must be
      // identical.
      const changed = Object.keys(oldTriggers).filter((name) => oldTriggers[name] !== newTriggers[name]).sort();
      assert.deepEqual(
        changed,
        [
          ...LATER_MIGRATION_TRIGGERS_REMOVED,
          "tr_rev_tasks_upd",
          "tr_tasks_transition",
          "tr_deliver_gate",
          // 0027 rewrites the terminal guard and the round bump in place.
          "tr_tasks_terminal",
          "tr_tasks_round_bump",
        ].sort(),
        "only these may change",
      );

      // ...and the parked guards that survive to the head really are the shipped
      // guards, not lookalikes (0019 removes `tr_dict_assignees_delete` /
      // `tr_dict_reporters_delete` with their tables, so those two are gone).
      for (const name of ["tr_rel_cross_project", "tr_rel_parent_guard", "tr_rel_parent_epic"]) {
        assert.equal(newTriggers[name], oldTriggers[name], `${name} must survive the rebuild verbatim`);
      }
    } finally {
      before.close();
      after.close();
    }
  });

  it("lands the upgrade on the index set a fresh board has — no index added, none lost", async () => {
    // The rebuild's blind spot, and the reason this test exists: `tasks` is
    // dropped and re-created, so an index the file forgets to name stops
    // existing — no error, no violated constraint, just two boards that claim
    // the same migration set and differ underneath. 0013 lost 0005's partial
    // `ix_tasks_source` exactly that way; 0014 puts it back. The set is therefore
    // *derived* from a board built before 0013 and compared twice: against the
    // upgraded board (the rebuild returned everything it took) and against a
    // fresh one (an upgrade and an install end in the same place — same names,
    // same columns, same partiality).
    const upgrade = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgrade.db, { dir: before0013() });
      const before = indexShapes(upgrade.db);
      assert.ok(
        before.some((index) => index.name === "ix_tasks_source"),
        "precondition: the previous build's board carries 0005's ix_tasks_source",
      );

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

  it("is a no-op on a board that is already at 0013", async () => {
    const board = await createTempBoard();
    try {
      const again = applyMigrations(board.db);
      assert.deepEqual(again.applied, []);
      assert.equal(again.skipped.includes("0013"), true);
      assert.match(tasksSql(board.db), /awaiting/);
      assert.equal(columnsOf(board.db).includes("awaiting_reason"), true);
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
      // The rebuild asks the runner for foreign keys off (see the marker in the
      // file); the runner has to put the pinned pragma back, or every later write
      // in this connection would run unchecked.
      assert.equal(
        Number(board.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
        1,
        "foreign key enforcement must be back on after the rebuild",
      );
      // The rename must not have rewritten the children's REFERENCES clauses:
      // they have to name `tasks`, which is the table that exists.
      for (const child of ["task_relations", "comments", "attachments", "agent_sessions", "task_reports"]) {
        const parents = board.db
          .prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list('${child}')`)
          .all()
          .map((r) => r.parent);
        assert.equal(parents.includes("tasks"), true, `${child} must still reference tasks`);
        assert.equal(parents.some((name) => name.startsWith("tasks_") && name !== "tasks"), false, `${child} references a scratch name`);
      }
    } finally {
      board.close();
    }
  });
});
