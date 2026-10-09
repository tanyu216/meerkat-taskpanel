/**
 * Creating the same key under contention
 * (T-20261009-175500-idem-taskpanel).
 *
 * The guard is a read-then-insert, which is a classic race; the partial unique
 * index is the arbiter. This file proves the *outcome* under real parallelism —
 * exactly one row, and every loser converging onto it — from two directions,
 * because each can fail differently: separate connections in one process, and
 * separate processes.
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
import { TS2, cleanupTempDirs, countRows, createTempBoard, insertProject } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "task | alice |  | PROJ-9";

describe("concurrency/idem — one row per key", () => {
  it("lets eight connections create with one key and ends with exactly one row", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      const dbPath = board.dbPath;

      const connections = await Promise.all(Array.from({ length: 8 }, () => openDatabase({ path: dbPath })));
      try {
        const results = connections.map((db) => {
          const ctx = createContext({ db, repos: createRepositories(db), clock: () => TS2 });
          const commands = createCommands(ctx);
          try {
            const task = commands.createTask({ projectId: "proj", title: "racy", idem: KEY, actor: { kind: "agent", id: "l" } });
            return { ok: true, id: task.id };
          } catch (err) {
            return { ok: false, code: isDomainError(err) ? err.code : "UNKNOWN" };
          }
        });

        assert.deepEqual(results.filter((r) => !r.ok), [], "no create may fail outright — every loser reuses");
        assert.equal(new Set(results.map((r) => r.id)).size, 1, "every caller is handed the same task");
      } finally {
        for (const db of connections) closeDatabase(db);
      }

      assert.equal(countRows(board.db, "tasks"), 1, "exactly one row");
    } finally {
      board.close();
    }
  });

  it("has a real subprocess race that still commits exactly one row", async () => {
    const board = await createTempBoard();
    const dbPath = board.dbPath;
    try {
      insertProject(board.db);
      board.close();

      const script = `
        import { openDatabase, closeDatabase } from ${JSON.stringify(resolve(ROOT, "src/core/storage/driver.mjs"))};
        import { createRepositories } from ${JSON.stringify(resolve(ROOT, "src/core/storage/repositories/index.mjs"))};
        import { createContext } from ${JSON.stringify(resolve(ROOT, "src/core/commands/context.mjs"))};
        import { createCommands } from ${JSON.stringify(resolve(ROOT, "src/core/commands/index.mjs"))};
        const db = await openDatabase({ path: process.env.TASKD_TEST_DB });
        const ctx = createContext({ db, repos: createRepositories(db), clock: () => ${JSON.stringify(TS2)} });
        const commands = createCommands(ctx);
        let result;
        try {
          const first = commands.createTask({ projectId: "proj", title: "racy", idem: process.env.TASKD_TEST_IDEM, actor: { kind: "agent", id: "l" } });
          const second = commands.createTask({ projectId: "proj", title: "racy", idem: process.env.TASKD_TEST_IDEM, actor: { kind: "agent", id: "l" } });
          result = first.id === second.id ? "stable" : "DIVERGED";
        } catch (err) {
          result = err.code ?? "UNKNOWN";
        }
        process.stdout.write(result);
        closeDatabase(db);
      `;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          new Promise((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
              env: { ...process.env, TASKD_TEST_DB: dbPath, TASKD_TEST_IDEM: KEY },
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

      assert.deepEqual(results, Array(8).fill("stable"), `unexpected outcomes: ${JSON.stringify(results)}`);

      const finalDb = await openDatabase({ path: dbPath });
      try {
        assert.equal(countRows(finalDb, "tasks"), 1, "exactly one row despite the race");
      } finally {
        closeDatabase(finalDb);
      }
    } finally {
      board.close();
    }
  });
});
