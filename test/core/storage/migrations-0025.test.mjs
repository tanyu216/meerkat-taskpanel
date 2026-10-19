/**
 * 0025 — a review card's identity becomes structural.
 *
 * The review-card acceptance exemption must not be obtainable by editing a card
 * after the fact, so the marker moves out of the writable `meta_json` into two
 * columns:
 *
 *   * `review_of_id` — the reviewed card's **internal id** (`meta.review_of`
 *     holds an identifier, so the backfill matches either spelling);
 *   * `review_round` — a positive integer, and meaningless without the marker.
 *
 * What this file pins, in order:
 *
 *   1. the backfill (identifier → id, `legacy.review_of`, round coercion);
 *   2. fail-closed for a reference that resolves to nothing (or another
 *      project's card);
 *   3. immutability — both directions, including NULL → value;
 *   4. the shape a fresh board has (the index, plus the same triggers an
 *      upgraded board ends with).
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
  reasonCode,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The shipped set **before** 0025 — a board as the previous build left it. */
function before0025() {
  const dir = makeTempDir("meerkat-taskpanel-pre0025-");
  for (const name of readdirSync(defaultMigrationsDir()).filter((n) => n.endsWith(".sql") && n.slice(0, 4) < "0025")) {
    copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

const meta = (value) => JSON.stringify(value);

/** A pre-0025 board with two projects and the cards the backfill needs. */
async function legacyBoard() {
  const board = await createTempBoard({ migrate: false });
  applyMigrations(board.db, { dir: before0025() });
  insertProject(board.db, { id: "proj" });
  insertProject(board.db, { id: "other", name: "Other" });
  insertTask(board.db, { id: "orig", identifier: "PROJ-0001", status: "in_review" });
  insertTask(board.db, { id: "foreign", identifier: "PROJ-0002", project_id: "other", status: "todo" });
  return board;
}

describe("storage/migrations — 0025 makes the review marker structural", () => {
  it("backfills identifier and id spellings, the legacy key, and the round", async () => {
    const board = await legacyBoard();
    try {
      insertTask(board.db, {
        id: "by-identifier",
        identifier: "PROJ-0003",
        meta_json: meta({ review_of: "PROJ-0001", review_round: "2" }),
      });
      insertTask(board.db, {
        id: "by-id",
        identifier: "PROJ-0004",
        meta_json: meta({ review_of: "orig" }),
      });
      insertTask(board.db, {
        id: "legacy-key",
        identifier: "PROJ-0005",
        meta_json: meta({ legacy: { review_of: "PROJ-0001", review_round: 3 } }),
      });

      applyMigrations(board.db);

      const row = (id) => board.db.prepare("SELECT review_of_id, review_round FROM tasks WHERE id = ?").get(id);
      assert.deepEqual({ ...row("by-identifier") }, { review_of_id: "orig", review_round: 2 }, "identifier → id");
      assert.deepEqual({ ...row("by-id") }, { review_of_id: "orig", review_round: null }, "an id backfills too");
      assert.deepEqual({ ...row("legacy-key") }, { review_of_id: "orig", review_round: 3 }, "meta.legacy is read as a fallback");
      assert.deepEqual({ ...row("orig") }, { review_of_id: null, review_round: null }, "a normal card keeps no marker");
    } finally {
      board.close();
    }
  });

  it("fails closed: a dangling or cross-project reference, and a round without a marker", async () => {
    const board = await legacyBoard();
    try {
      insertTask(board.db, { id: "dangling", identifier: "PROJ-0003", meta_json: meta({ review_of: "PROJ-9999" }) });
      insertTask(board.db, { id: "cross", identifier: "PROJ-0004", meta_json: meta({ review_of: "PROJ-0002" }) });
      insertTask(board.db, { id: "round-only", identifier: "PROJ-0005", meta_json: meta({ review_round: 2 }) });
      insertTask(board.db, {
        id: "bad-round",
        identifier: "PROJ-0006",
        meta_json: meta({ review_of: "PROJ-0001", review_round: "round-two" }),
      });

      applyMigrations(board.db);

      const row = (id) => board.db.prepare("SELECT review_of_id, review_round FROM tasks WHERE id = ?").get(id);
      assert.equal(row("dangling").review_of_id, null, "an unresolvable name never mints the exemption");
      assert.equal(row("cross").review_of_id, null, "cross-project references are not review cards");
      assert.deepEqual({ ...row("round-only") }, { review_of_id: null, review_round: null }, "a round alone describes nothing");
      assert.deepEqual({ ...row("bad-round") }, { review_of_id: "orig", review_round: null }, "an unreadable round stays NULL");
    } finally {
      board.close();
    }
  });

  it("is immutable after INSERT — both directions, including NULL → value", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db, { id: "proj" });
      insertTask(board.db, { id: "orig", identifier: "PROJ-0001", status: "in_review" });
      insertTask(board.db, { id: "plain", identifier: "PROJ-0002", meta_json: "{}" });
      insertTask(board.db, {
        id: "review",
        identifier: "PROJ-0003",
        review_of_id: "orig",
        review_round: 1,
      });

      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET review_of_id = 'orig' WHERE id = 'plain'").run()),
        "REVIEW_OF_IMMUTABLE",
        "a plain card may not be promoted to a review card",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET review_of_id = NULL WHERE id = 'review'").run()),
        "REVIEW_OF_IMMUTABLE",
        "nor may the marker be cleared",
      );
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET review_round = 2 WHERE id = 'review'").run()),
        "REVIEW_OF_IMMUTABLE",
        "the round is part of the marker",
      );
      // A write that leaves both values alone is not the trigger's business.
      assert.equal(
        reasonCode(() => board.db.prepare("UPDATE tasks SET review_of_id = 'orig', review_round = 1 WHERE id = 'review'").run()),
        "NO_ERROR",
      );
    } finally {
      board.close();
    }
  });

  it("lands the upgrade on the shape a fresh board has", async () => {
    const upgraded = await createTempBoard({ migrate: false });
    const fresh = await createTempBoard();
    try {
      applyMigrations(upgraded.db, { dir: before0025() });
      applyMigrations(upgraded.db);

      const index = fresh.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_tasks_review_of'")
        .get();
      assert.ok(index, "the review-of read has an index");
      assert.ok(
        upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_tasks_review_of'").get(),
        "and an upgrade creates it too",
      );

      const triggers = (db) =>
        db
          .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name IN ('tr_tasks_review_marker_immutable','tr_tasks_children_terminal') ORDER BY name")
          .all();
      assert.deepEqual(triggers(upgraded.db), triggers(fresh.db), "an upgrade and an install end on the same guards");
      assert.deepEqual(
        triggers(fresh.db).map((row) => row.name),
        ["tr_tasks_children_terminal", "tr_tasks_review_marker_immutable"],
      );
      for (const row of triggers(fresh.db)) assert.equal(row.tbl_name, "tasks");
      assert.equal(upgraded.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      upgraded.close();
      fresh.close();
    }
  });
});
