/**
 * Step 13: claiming under contention (I1/I2).
 *
 * "Exactly one winner" is asserted from three directions — separate
 * connections in one process, separate processes, and the command layer each of
 * them uses — because each direction can fail differently.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { isDomainError } from "../../src/shared/errors.mjs";
import { TS, TS2, cleanupTempDirs, countRows, createTempBoard, insertProject, insertTask } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTEXT_MODULE = resolve(ROOT, "src/core/commands/context.mjs");
const REPOS_MODULE = resolve(ROOT, "src/core/storage/repositories/index.mjs");
const DRIVER_MODULE = resolve(ROOT, "src/core/storage/driver.mjs");

/** Eight connections, each with its own command layer, all claiming one task. */
async function raceWithConnections(dbPath, actors) {
  const connections = await Promise.all(actors.map(() => openDatabase({ path: dbPath })));
  try {
    return connections.map((db) => {
      const repos = createRepositories(db);
      const ctx = createContext({ db, repos, clock: () => TS2 });
      const commands = createCommands(ctx);
      return { db, commands, repos };
    });
  } catch (err) {
    for (const db of connections) closeDatabase(db);
    throw err;
  }
}

describe("concurrency/claim — one winner", () => {
  it("lets exactly one of eight connections claim, and says why the rest failed", async () => {
    const board = await createTempBoard();
    const dbPath = board.dbPath;
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      const dbPathValue = dbPath;
      board.close();

      const claims = await raceWithConnections(
        dbPathValue,
        Array.from({ length: 8 }, (_, i) => `agent-${i}`),
      );
      try {
        const results = claims.map(({ commands }, i) => {
          try {
            const claimed = commands.claim({ id: "t", actor: { kind: "agent", id: `agent-${i}` } });
            return { ok: true, task: claimed.task };
          } catch (err) {
            return { ok: false, code: isDomainError(err) ? err.code : "UNKNOWN", err };
          }
        });

        const winners = results.filter((r) => r.ok);
        assert.equal(winners.length, 1, `expected one winner, got ${results.map((r) => r.code ?? "ok")}`);
        for (const loser of results.filter((r) => !r.ok)) {
          assert.ok(
            ["EXECUTION_ACTIVE", "CLAIM_LOST"].includes(loser.code),
            `unexpected loser code ${loser.code}`,
          );
        }

        const finalDb = await openDatabase({ path: dbPathValue });
        try {
          const row = finalDb.prepare("SELECT status, claimed_by, version FROM tasks WHERE id = 't'").get();
          assert.equal(row.status, "in_progress");
          assert.equal(winners[0].task.claimedBy, row.claimed_by, "the winner's claim is the stored one");
          assert.equal(Number(row.version), 2, "one successful claim, one version bump");
          const claimsRecorded = Number(
            finalDb.prepare("SELECT COUNT(*) AS n FROM task_activities WHERE event = 'task_claimed'").get().n,
          );
          assert.equal(claimsRecorded, 1, "exactly one claim was recorded");
        } finally {
          closeDatabase(finalDb);
        }
      } finally {
        for (const { db } of claims) closeDatabase(db);
      }
    } finally {
      board.close();
    }
  });

  it("is idempotent for the holder: a second claim is reused, not re-recorded", async () => {
    const board = await createTempBoard();
    try {
      const repos = createRepositories(board.db);
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws" });
      const task = commands.createTask({ projectId: "proj", title: "One", actor: { kind: "agent", id: "linus" } });

      commands.claim({ id: task.id, actor: { kind: "agent", id: "linus" } });
      const again = commands.claim({ id: task.id, actor: { kind: "agent", id: "linus" } });
      assert.equal(again.reused, true);
      assert.equal(countRows(board.db, "task_activities"), 3, "create + claim, and nothing for the reuse");
    } finally {
      board.close();
    }
  });

  it("never loses a claim to SQLITE_BUSY: 200 writes in a row", async () => {
    const board = await createTempBoard();
    try {
      const repos = createRepositories(board.db);
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws" });
      const task = commands.createTask({ projectId: "proj", title: "One", actor: { kind: "agent", id: "linus" } });

      for (let i = 0; i < 200; i += 1) {
        const updated = commands.updateTask({
          id: task.id,
          patch: { title: `round ${i}` },
          actor: { kind: "agent", id: "linus" },
        });
        assert.equal(updated.version, i + 2);
      }
      assert.equal(commands.getTask({ id: task.id }).title, "round 199");
      assert.equal(
        countRows(board.db, "task_activities"),
        202,
        "the project row, the create, and 200 updates — one audit row each",
      );
    } finally {
      board.close();
    }
  });

  it("has a real subprocess race through the command layer", async () => {
    const board = await createTempBoard();
    const dbPath = board.dbPath;
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      board.close();

      const script = `
        import { openDatabase, closeDatabase } from ${JSON.stringify(DRIVER_MODULE)};
        import { createRepositories } from ${JSON.stringify(REPOS_MODULE)};
        import { createContext } from ${JSON.stringify(CONTEXT_MODULE)};
        const db = await openDatabase({ path: process.env.TASKD_TEST_DB });
        const repos = createRepositories(db);
        const ctx = createContext({ db, repos, clock: () => ${JSON.stringify(TS2)} });
        const commands = (await import(${JSON.stringify(resolve(ROOT, "src/core/commands/index.mjs"))})).createCommands(ctx);
        let result;
        try {
          const claimed = commands.claim({ id: "t", actor: { kind: "agent", id: process.env.TASKD_TEST_ACTOR } });
          result = claimed.reused ? "reused" : "claimed";
        } catch (err) {
          result = err.code ?? "UNKNOWN";
        }
        process.stdout.write(result);
        closeDatabase(db);
      `;

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          new Promise((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
              env: { ...process.env, TASKD_TEST_DB: dbPath, TASKD_TEST_ACTOR: `proc-${i}` },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("error", rejectPromise);
            child.on("close", (code) =>
              code === 0 ? resolvePromise(out.trim()) : rejectPromise(new Error(err || `exit ${code}`)),
            );
          }),
        ),
      );

      assert.equal(results.filter((r) => r === "claimed").length, 1, JSON.stringify(results));
      for (const loser of results.filter((r) => r !== "claimed")) {
        assert.ok(["EXECUTION_ACTIVE", "CLAIM_LOST", "reused"].includes(loser), loser);
      }
    } finally {
      board.close();
    }
  });
});
