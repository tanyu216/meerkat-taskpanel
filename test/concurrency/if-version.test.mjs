/**
 * Step 13: optimistic concurrency (I3's write side, D4).
 *
 * `if_version` is "re-read once and retry", not a lock: the loser is told the
 * current version and writes nothing at all — not the row, not a revision, not
 * an audit entry. A client that ignored a half-applied write would be worse off
 * than one that simply failed.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import {
  TS,
  cleanupTempDirs,
  countRows,
  createTempBoard,
  revision,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };

async function boardWithTask() {
  const board = await createTempBoard();
  const repos = createRepositories(board.db);
  const ctx = createContext({ db: board.db, repos, clock: () => TS });
  const commands = createCommands(ctx);
  commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws" });
  const task = commands.createTask({ projectId: "proj", title: "One", actor: AGENT });
  return { ...board, repos, ctx, commands, task };
}

describe("concurrency/if-version", () => {
  it("lets exactly one of two writers with the same ifVersion through", async () => {
    const board = await boardWithTask();
    try {
      const { commands, db, task } = board;
      const before = revision(db);
      const activitiesBefore = countRows(db, "task_activities");

      const first = commands.updateTask({
        id: task.id,
        ifVersion: 1,
        patch: { title: "winner" },
        actor: AGENT,
      });
      assert.equal(first.version, 2);

      assert.throws(
        () =>
          commands.updateTask({ id: task.id, ifVersion: 1, patch: { title: "loser" }, actor: AGENT }),
        (err) => {
          assert.equal(err.code, "VERSION_CONFLICT");
          assert.equal(err.http, 409);
          assert.equal(err.details.currentVersion, 2);
          assert.equal(err.details.expectedVersion, 1);
          assert.match(err.message, /re-read and retry once/);
          return true;
        },
      );

      assert.equal(commands.getTask({ id: task.id }).title, "winner", "no partial write");
      assert.equal(revision(db), before + 2, "only the winner moved the cursor");
      assert.equal(countRows(db, "task_activities"), activitiesBefore + 1, "only one audit row");
    } finally {
      board.close();
    }
  });

  it("applies the same rule to moves, claims and archives", async () => {
    const board = await boardWithTask();
    try {
      const { commands, db, task } = board;
      commands.claim({ id: task.id, actor: AGENT }); // version 2
      const after = revision(db);

      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "blocked", ifVersion: 1, actor: AGENT }),
        (err) => err.code === "VERSION_CONFLICT" && err.details.currentVersion === 2,
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress", "the move did not happen");
      assert.equal(revision(db), after, "and cost nothing");

      const moved = commands.moveStatus({ id: task.id, to: "blocked", ifVersion: 2, actor: AGENT });
      assert.equal(moved.status, "blocked");
      assert.equal(moved.version, 3);

      assert.throws(
        () => commands.archive({ id: task.id, ifVersion: 1, actor: AGENT, days: 0 }),
        (err) => ["VERSION_CONFLICT", "ARCHIVE_NOT_TERMINAL"].includes(err.code),
      );
    } finally {
      board.close();
    }
  });

  it("accepts a write without if_version (the caller is sure it is alone)", async () => {
    const board = await boardWithTask();
    try {
      const updated = board.commands.updateTask({ id: board.task.id, patch: { title: "blind" }, actor: AGENT });
      assert.equal(updated.version, 2);
    } finally {
      board.close();
    }
  });

  it("teaches the retry protocol rather than looping internally", async () => {
    const board = await boardWithTask();
    try {
      const { commands, db, task } = board;
      commands.updateTask({ id: task.id, patch: { title: "a" }, actor: AGENT });
      assert.throws(
        () => commands.updateTask({ id: task.id, ifVersion: 1, patch: { title: "b" }, actor: AGENT }),
        (err) => err.code === "VERSION_CONFLICT",
      );
      // The client re-reads, sees version 2, and retries with it.
      const fresh = commands.getTask({ id: task.id });
      assert.equal(fresh.version, 2);
      const retried = commands.updateTask({ id: task.id, ifVersion: fresh.version, patch: { title: "b" }, actor: AGENT });
      assert.equal(retried.title, "b");
      assert.equal(
        revision(db),
        8,
        "project + create + two updates = four writes, two bumps each; the refused retry cost nothing",
      );
    } finally {
      board.close();
    }
  });
});
