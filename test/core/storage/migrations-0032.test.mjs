/**
 * 0032 — the acceptance baseline becomes a frozen column.
 *
 * Four properties:
 *
 *   1. the backfill reads modern `meta.acceptance` and falls back to
 *      `meta.acceptance_legacy[*].text`, trims and de-duplicates, and leaves
 *      `in_review` cards empty (the grandfather window);
 *   2. any rewrite must advance `acceptance_revision` by exactly one;
 *   3. a shrink needs an audited `acceptance_pruned` activity with a reason;
 *   4. a report cannot say `not_applicable` without a note.
 *
 * Raw SQL on purpose: the fixture's `createTask` would hide a backfill bug.
 */

import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { applyMigrations, defaultMigrationsDir } from "../../../src/core/storage/migrations-runner.mjs";
import { recordActivity } from "../../../src/core/storage/unit-of-work.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  ensureActor,
  insertReport,
  makeTempDir,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0032 — a board as the previous build left it. */
function before0032() {
  const dir = makeTempDir("meerkat-taskpanel-pre0032-");
  for (const name of readdirSync(defaultMigrationsDir()).filter(
    (n) => n.endsWith(".sql") && n.slice(0, 4) < "0032",
  )) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const triggersOf = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [r.name, String(r.sql).replace(/\s+/g, " ").trim()]),
  );

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

const foreignKeys = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .flatMap((table) =>
      db
        .prepare('SELECT "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)')
        .all(table)
        .map((fk) => ({ child: `${table}.${fk.col}`, parent: fk.parent })),
    );

function seedProject(db) {
  db.prepare(
    "INSERT INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("p1", "P1", 20, "[]", "{}", TS, TS);
}

/** One card with the given meta; `reviewOf` marks a review card. */
function seedTask(db, id, meta, { status = "todo", reviewOf = null } = {}) {
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, status, meta_json, review_of_id, review_round, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    `P1-${id}`,
    "p1",
    id,
    status,
    JSON.stringify(meta),
    reviewOf,
    reviewOf === null ? null : 1,
    TS,
    TS,
    TS,
  );
}

function seed(db) {
  seedProject(db);
  seedTask(db, "modern", { acceptance: [" a ", "b", "A", ""] });
  seedTask(db, "legacy", {
    acceptance_legacy: [
      { text: "old one", checked: true },
      { text: "old two", checked: false },
    ],
  });
  seedTask(db, "modern-wins", {
    acceptance: ["modern"],
    acceptance_legacy: [{ text: "legacy", checked: true }],
  });
  seedTask(db, "grandfathered", { acceptance: ["not seeded"] }, { status: "in_review" });
  seedTask(db, "review", { acceptance: ["a"] }, { reviewOf: "modern", status: "todo" });
}

describe("storage/migrations — 0032 acceptance snapshot", () => {
  it("backfills modern, falls back to legacy, de-duplicates, and leaves in_review empty", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0032() });
      seed(board.db);
      const up = applyMigrations(board.db);
      assert.deepEqual(up.applied.map((m) => m.version), ["0032", "0033"]);

      const rows = board.db
        .prepare("SELECT id, acceptance_json, acceptance_revision FROM tasks ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { id: "grandfathered", acceptance_json: "[]", acceptance_revision: 0 },
        { id: "legacy", acceptance_json: '["old one","old two"]', acceptance_revision: 1 },
        { id: "modern", acceptance_json: '["A","b"]', acceptance_revision: 1 },
        { id: "modern-wins", acceptance_json: '["modern"]', acceptance_revision: 1 },
        { id: "review", acceptance_json: '["a"]', acceptance_revision: 1 },
      ]);
    } finally {
      board.close();
    }
  });

  it("refuses a rewrite that does not advance the revision", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0032() });
      seed(board.db);
      applyMigrations(board.db);

      assert.throws(
        () =>
          board.db
            .prepare("UPDATE tasks SET acceptance_json = ? WHERE id = 'modern'")
            .run(JSON.stringify(["a", "b", "c"])),
        (err) => String(err.message).includes("ACCEPTANCE_SNAPSHOT_IMMUTABLE"),
      );
    } finally {
      board.close();
    }
  });

  it("allows an append, refuses an unaudited prune, and allows an audited prune", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0032() });
      seed(board.db);
      applyMigrations(board.db);

      const append = board.db.prepare(
        "UPDATE tasks SET acceptance_json = ?, acceptance_revision = acceptance_revision + 1 WHERE id = 'modern'",
      );
      assert.doesNotThrow(() => append.run(JSON.stringify(["A", "b", "c"])));

      const prune = board.db.prepare(
        "UPDATE tasks SET acceptance_json = ?, acceptance_revision = acceptance_revision + 1 WHERE id = 'modern'",
      );
      assert.throws(
        () => prune.run(JSON.stringify(["A"])),
        (err) => String(err.message).includes("ACCEPTANCE_SNAPSHOT_IMMUTABLE"),
      );

      recordActivity(board.db, {
        taskId: "modern",
        actorKind: "human",
        actorId: "terry",
        event: "acceptance_pruned",
        changes: { reason: "the operator narrowed the scope" },
        createdAt: TS,
      });
      assert.doesNotThrow(() => prune.run(JSON.stringify(["A"])));
    } finally {
      board.close();
    }
  });

  it("refuses not_applicable without a note, on a raw report insert", async () => {
    const board = await createTempBoard({ migrate: false });
    try {
      applyMigrations(board.db, { dir: before0032() });
      seed(board.db);
      applyMigrations(board.db);
      ensureActor(board.db, "terry", "human");

      assert.throws(
        () =>
          insertReport(board.db, {
            task_id: "modern",
            acceptance_json: JSON.stringify([{ text: "A", status: "not_applicable" }]),
            author_kind: "human",
            author_id: "terry",
          }),
        (err) => String(err.message).includes("REPORT_NOT_APPLICABLE_NOTE"),
      );
      assert.doesNotThrow(() =>
        insertReport(board.db, {
          task_id: "modern",
          round: 2,
          acceptance_json: JSON.stringify([
            { text: "A", status: "not_applicable", note: "canceled by the operator" },
          ]),
          author_kind: "human",
          author_id: "terry",
        }),
      );
    } finally {
      board.close();
    }
  });

  it("upgrades to the same schema as a fresh board", async () => {
    const fresh = await createTempBoard();
    const upgraded = await createTempBoard({ migrate: false });
    try {
      applyMigrations(upgraded.db, { dir: before0032() });
      seed(upgraded.db);
      applyMigrations(upgraded.db);

      assert.deepEqual(triggersOf(upgraded.db), triggersOf(fresh.db));
      assert.deepEqual(tableNames(upgraded.db), tableNames(fresh.db));
      assert.deepEqual(foreignKeys(upgraded.db), foreignKeys(fresh.db));
      assert.equal(upgraded.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      fresh.close();
      upgraded.close();
    }
  });
});
