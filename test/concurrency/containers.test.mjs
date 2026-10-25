/**
 * The container close under contention.
 *
 * Two children of one epic are delivered to `in_review`; two *processes* then
 * accept them to `done` at the same time. Only the process whose transaction
 * sees the finished set may write the rollup — the other must find the epic
 * already in `in_review` and write nothing. The assertion is on the writes, not
 * on which process won: exactly one rollup report, exactly one closure note,
 * one delivery round.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { TS, TS2, cleanupTempDirs, createTempBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTEXT_MODULE = resolve(ROOT, "src/core/commands/context.mjs");
const REPOS_MODULE = resolve(ROOT, "src/core/storage/repositories/index.mjs");
const DRIVER_MODULE = resolve(ROOT, "src/core/storage/driver.mjs");
const COMMANDS_MODULE = resolve(ROOT, "src/core/commands/index.mjs");

const AGENT = { kind: "agent", id: "linus" };
const REPORT = {
  conclusion: "done",
  acceptance: [{ text: "the child is done", status: "met" }],
  evidence: [{ kind: "path", path: "src/example.mjs" }],
};

/** Run one child's `→ done` in a fresh process, against the shared database. */
function acceptInChildProcess(dbPath, childId) {
  const script = `
    import { openDatabase, closeDatabase } from ${JSON.stringify(DRIVER_MODULE)};
    import { createRepositories } from ${JSON.stringify(REPOS_MODULE)};
    import { createContext } from ${JSON.stringify(CONTEXT_MODULE)};
    const { createCommands } = await import(${JSON.stringify(COMMANDS_MODULE)});
    const db = await openDatabase({ path: process.env.TASKD_TEST_DB });
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, clock: () => ${JSON.stringify(TS2)} });
    const commands = createCommands(ctx);
    let result;
    try {
      commands.moveStatus({
        id: process.env.TASKD_TEST_CHILD,
        to: "done",
        // A child card is accepted by a non-human writer under every policy.
        actor: { kind: "agent", id: "linus" },
      });
      result = "done";
    } catch (err) {
      result = err.code ?? "UNKNOWN";
    }
    process.stdout.write(result);
    closeDatabase(db);
  `;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TASKD_TEST_DB: dbPath, TASKD_TEST_CHILD: childId },
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
  });
}

describe("concurrency/containers — one rollup", () => {
  it("writes one rollup when the last two children are accepted at the same time", async () => {
    const board = await createTempBoard();
    const dbPath = board.dbPath;
    let epicId;
    const childIds = [];
    try {
      const repos = createRepositories(board.db);
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "P", actor: AGENT });

      const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
      epicId = epic.id;
      for (const [title, allowDup] of [["One", false], ["Two", true]]) {
        const child = commands.createTask({
          projectId: "proj",
          title,
          acceptanceMode: "off",
          allowDup,
          actor: AGENT,
        });
        childIds.push(child.id);
        commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });
        commands.claim({ id: child.id, actor: AGENT });
        commands.deliver({ taskId: child.id, report: REPORT, actor: AGENT });
      }
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress", "both children are in review");
    } finally {
      board.close();
    }

    const results = await Promise.all(childIds.map((id) => acceptInChildProcess(dbPath, id)));
    assert.deepEqual(results, ["done", "done"], "both children reach done; the rollup is the shared write");

    const finalDb = await openDatabase({ path: dbPath });
    try {
      const epic = finalDb
        .prepare("SELECT status, delivery_round FROM tasks WHERE id = ?")
        .get(epicId);
      assert.equal(epic.status, "in_review");
      assert.equal(Number(epic.delivery_round), 1, "one delivery round — a second closure never bumped it");
      assert.equal(
        Number(finalDb.prepare("SELECT COUNT(*) AS c FROM task_reports WHERE task_id = ?").get(epicId).c),
        1,
        "exactly one rollup report",
      );
      assert.equal(
        Number(
          finalDb
            .prepare("SELECT COUNT(*) AS c FROM comments WHERE task_id = ? AND body LIKE 'Auto-rollup%'")
            .get(epicId).c,
        ),
        1,
        "exactly one closure note",
      );
      assert.equal(
        Number(finalDb.prepare("SELECT COUNT(*) AS c FROM task_reports").get().c),
        3,
        "the two children's own reports, plus exactly one rollup",
      );
    } finally {
      closeDatabase(finalDb);
    }
  });
});
