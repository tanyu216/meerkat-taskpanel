/**
 * The creation idempotency guard, at the service layer
 * (T-20261009-175500-idem-taskpanel).
 *
 * What "refuse and reuse" means here, precisely: `createTask` returns the
 * existing Task DTO, writes **no** row and appends **no** activity — the caller
 * gets the existing `id`/`identifier` as the answer and nothing observable
 * changed. The database half of the same rule is `test/contract/idem.test.mjs`;
 * the racing half is `test/concurrency/idem.test.mjs`.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { cleanupTempDirs, countRows, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };

/** A board with repositories, commands and one project. */
async function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", workspacePath: "/tmp/ws", actor: AGENT });
    return fn({ db, repos, commands });
  });
}

describe("commands/idem — explicit key", () => {
  it("creates the first card with the key, and returns it on the task DTO", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "First", idem: "k-1", actor: AGENT });
      assert.equal(task.idem, "k-1");
      assert.equal(countRows(db, "tasks"), 1);
    });
  });

  it("refuses the second create and reuses the existing task — no new row, no activity", async () => {
    await board(async ({ db, commands }) => {
      const first = commands.createTask({ projectId: "proj", title: "Ship it", idem: "k-1", actor: AGENT });
      const activitiesAfterFirst = countRows(db, "task_activities");

      const second = commands.createTask({ projectId: "proj", title: "Ship it (retry)", idem: "k-1", actor: AGENT });

      assert.equal(second.id, first.id, "the answer is the existing task's id");
      assert.equal(second.identifier, first.identifier);
      assert.equal(second.title, "Ship it", "the existing card is returned unchanged");
      assert.equal(countRows(db, "tasks"), 1, "exactly one row");
      assert.equal(countRows(db, "task_activities"), activitiesAfterFirst, "a reuse records nothing");
    });
  });

  it("releases the key when the holder reaches a terminal status", async () => {
    await board(async ({ db, commands }) => {
      const first = commands.createTask({ projectId: "proj", title: "Cancel me", idem: "k-1", actor: AGENT });
      commands.moveStatus({ id: first.id, to: "canceled", actor: AGENT });

      const again = commands.createTask({ projectId: "proj", title: "Restart", idem: "k-1", actor: AGENT });
      assert.notEqual(again.id, first.id);
      assert.equal(again.identifier, "PROJ-0002");
      assert.equal(countRows(db, "tasks"), 2);
    });
  });
});

describe("commands/idem — --allow-dup", () => {
  it("lets the same key be created twice, writing NULL on both", async () => {
    await board(async ({ db, commands }) => {
      const a = commands.createTask({ projectId: "proj", title: "A", idem: "k-1", allowDup: true, actor: AGENT });
      const b = commands.createTask({ projectId: "proj", title: "B", idem: "k-1", allowDup: true, actor: AGENT });
      assert.notEqual(a.id, b.id);
      assert.equal(a.idem, null, "an unkeyed row never collides");
      assert.equal(b.idem, null);
      assert.equal(countRows(db, "tasks"), 2);
    });
  });

  it("does not occupy the key for a later guarded create", async () => {
    await board(async ({ db, commands }) => {
      commands.createTask({ projectId: "proj", title: "A", idem: "k-1", allowDup: true, actor: AGENT });
      const guarded = commands.createTask({ projectId: "proj", title: "B", idem: "k-1", actor: AGENT });
      assert.equal(guarded.idem, "k-1");
      assert.equal(countRows(db, "tasks"), 2);
    });
  });
});

describe("commands/idem — derived key", () => {
  it("derives the same key from an assignee, so the second create reuses", async () => {
    await board(async ({ db, commands }) => {
      // A named assignee (rather than an id) so the dictionary resolver supplies
      // the `assignee_id` the FK wants — and so the reuse path is proven to skip
      // that resolver entirely.
      const first = commands.createTask({ projectId: "proj", title: "One", assignee: "alice", actor: AGENT });
      assert.equal(first.idem, "task | alice |  | ");

      const second = commands.createTask({ projectId: "proj", title: "Two", assignee: "alice", actor: AGENT });
      assert.equal(second.id, first.id);
      assert.equal(countRows(db, "tasks"), 1);
    });
  });

  it("partakes of `target` and `review_of`, and lets review_of win over parent", async () => {
    await board(async ({ db, commands }) => {
      const byTarget = commands.createTask({ projectId: "proj", title: "T", target: "PROJ-9", actor: AGENT });
      assert.equal(byTarget.idem, "task |  |  | PROJ-9");
      assert.equal(
        commands.createTask({ projectId: "proj", title: "T (retry)", target: "PROJ-9", actor: AGENT }).id,
        byTarget.id,
      );

      // review_of takes the `source` slot; a differing parent must not change it.
      const reviewed = commands.createTask({ projectId: "proj", title: "R", reviewOf: "REV-1", parent: "P-1", actor: AGENT });
      assert.equal(reviewed.idem, "task |  | REV-1 | ");
      const reReviewed = commands.createTask({ projectId: "proj", title: "R", reviewOf: "REV-1", parent: "P-2", actor: AGENT });
      assert.equal(reReviewed.id, reviewed.id);
      assert.equal(countRows(db, "tasks"), 2);
    });
  });

  it("stays off for a generic card, so two ordinary cards can both be created", async () => {
    await board(async ({ db, commands }) => {
      const a = commands.createTask({ projectId: "proj", title: "Generic one", actor: AGENT });
      const b = commands.createTask({ projectId: "proj", title: "Generic two", actor: AGENT });
      assert.notEqual(a.id, b.id, "a degenerate key must not turn into a blanket refusal");
      assert.equal(a.idem, null);
      assert.equal(b.idem, null);
      assert.equal(countRows(db, "tasks"), 2);
    });
  });

  it("reads the discriminators from meta too, when the callers omit the top-level ones", async () => {
    await board(async ({ db, commands }) => {
      const first = commands.createTask({
        projectId: "proj",
        title: "From meta",
        meta: { review_of: "REV-7" },
        actor: AGENT,
      });
      assert.equal(first.idem, "task |  | REV-7 | ");
      const second = commands.createTask({
        projectId: "proj",
        title: "From meta (retry)",
        meta: { review_of: "REV-7" },
        actor: AGENT,
      });
      assert.equal(second.id, first.id);
      assert.equal(countRows(db, "tasks"), 1);
    });
  });
});
