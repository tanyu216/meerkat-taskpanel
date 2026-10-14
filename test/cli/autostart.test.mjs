/**
 * Step 9: finding the board, and starting one (V11, §F-E2).
 *
 * The lifecycle surface is deliberately tiny. Starting a daemon is the flakiest
 * thing this milestone does, so **exactly one** case actually does it, and it
 * cleans up after itself; everything else is either a refusal or a unit-level
 * decision that needs no process at all.
 *
 * The sequence the one case asserts is the real one: no board anywhere → the CLI
 * spawns `taskd` → the daemon writes a pointer naming the port the OS gave it →
 * the CLI's command succeeds → `SIGTERM` removes the pointer.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { waitForPointer, spawnTaskd } from "../../src/shared/transport/autostart.mjs";
import { ensureBoard } from "../../src/shared/transport/runtime.mjs";
import { resolveRuntimePointerPath } from "../../src/shared/runtime-locator.mjs";
import {
  baseEnv,
  cleanupTempDirs,
  closedPortUrl,
  makeTempDir,
  readJsonFile,
  runCli,
  startTaskd,
  waitUntil,
} from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/autostart — refusals need no process", () => {
  it("TASKD_NO_AUTOSTART=1 makes 'no board' an explicit, actionable failure", () => {
    const dataDir = makeTempDir();
    const result = runCli(["project", "list", "--json"], {
      dataDir,
      noUrl: true,
      env: { TASKD_NO_AUTOSTART: "1" },
    });
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "CLI_IO");
    assert.equal(error.details.noAutostart, true);
    assert.match(error.message, /TASKD_NO_AUTOSTART is set/);
    assert.match(error.hint.fix, /src\/server\/main\.mjs/);

    // Nothing was started, so nothing wrote a pointer.
    assert.equal(existsSync(join(dataDir, "runtime.json")), false);
  });

  it("does not start a board behind an explicit --url", async () => {
    const dataDir = makeTempDir();
    const dead = await closedPortUrl();
    const result = runCli(["project", "list", "--json"], {
      dataDir,
      url: dead,
      // Autostart is *allowed* here; an explicit address still wins.
      env: { TASKD_NO_AUTOSTART: "" },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "CLI_IO");
    assert.equal(existsSync(join(dataDir, "logs", "taskd.log")), false, "no daemon was spawned");
  });

  it("tells the daemon it starts which pointer file to write", async () => {
    // The spawned daemon resolves its own pointer from the *environment*, so a
    // caller that named a path has to say so out loud. Otherwise the parent
    // waits on the caller's file while the child writes the machine-wide one —
    // which is both a hang and the way an isolated test (or a second board)
    // reaches into a live board's address.
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const pinned = join(makeTempDir(), "runtime.json");
    const env = { ...baseEnv(), TASKD_DATA_DIR: dataDir, TASKD_PORT: "0", TASKD_HOST: "127.0.0.1", HOME: home };
    delete env.TASKD_RUNTIME_POINTER;

    const spawns = [];
    const spawnFn = (command, args, options) => {
      spawns.push({ command, args, options });
      return { pid: 2_147_483_646, unref() {} };
    };

    // The injected spawner starts nothing, so the wait has to end — as a
    // refusal ("started but never answered"), which is the point: no daemon, no
    // real port, no second autostart case.
    await assert.rejects(() => spawnTaskd({ env, pointerPath: pinned, waitMs: 1, spawnFn }));
    assert.equal(spawns.length, 1, "exactly one daemon was spawned");
    assert.equal(spawns[0].options.env.TASKD_RUNTIME_POINTER, pinned, "the child is told where to write");
    assert.equal(spawns[0].options.env.TASKD_DATA_DIR, dataDir, "…and keeps the rest of the environment");
    assert.equal(existsSync(resolveRuntimePointerPath({ env, home })), false, "the machine-wide slot is untouched");
  });
});

describe("cli/autostart — a pointer named through the environment (T-20261014-044653)", () => {
  it("is handed to the child, and is the file this parent waits on", async () => {
    // A name is the `pointerPath` *option* or `TASKD_RUNTIME_POINTER`, and the two
    // arrive separately: the CLI (and the scheduling guard) has the option unset
    // and the variable in the environment. Treating only the option as a name is
    // how a *fix* for the autostart-steals-a-live-board window would break this
    // path — the child would be left to choose a file for itself (the machine-wide
    // slot) while this parent waited at the named one, which cannot end.
    const dataDir = makeTempDir();
    const named = join(makeTempDir(), "runtime.json");
    const live = await startTaskd();
    try {
      const env = {
        ...baseEnv(),
        TASKD_DATA_DIR: dataDir,
        TASKD_RUNTIME_POINTER: named,
        TASKD_PORT: "0",
        TASKD_HOST: "127.0.0.1",
      };

      const childPid = 2_147_483_646;
      let childEnv = null;
      const spawnFn = (command, args, options) => {
        childEnv = options.env;
        // A "daemon" that writes exactly where it was told, naming the pid the
        // parent is waiting for — nothing else makes a file believable there.
        writeFileSync(named, JSON.stringify({ url: live.url, port: live.port, pid: childPid }));
        return { pid: childPid, unref() {} };
      };

      const started = await spawnTaskd({ env, waitMs: 2_000, spawnFn });
      assert.equal(childEnv.TASKD_RUNTIME_POINTER, named, "the child is told where to write");
      assert.equal(started.url, live.url, "and the parent waited at that file, not at the machine-wide slot");
    } finally {
      await live.close();
    }
  });
});

describe("cli/autostart — the pointer is only believed after /health", () => {
  it("ignores a stale pointer and starts a fresh board instead", async () => {
    // A pointer left behind by a process that is gone. Its pid is a real one
    // (this test's parent) so the *address* is what disqualifies it, which is
    // exactly the case a naive implementation gets wrong.
    const dataDir = makeTempDir();
    const pointerPath = join(dataDir, "runtime.json");
    const dead = await closedPortUrl();
    const fs = await import("node:fs");
    fs.writeFileSync(
      pointerPath,
      JSON.stringify({ url: dead, port: Number(new URL(dead).port), dataDir, pid: process.pid }),
    );

    const final = await waitForPointer({ pointerPath, timeoutMs: 50, pid: process.pid });
    assert.notEqual(final, null, "the file itself is readable — the CLI is what must not trust it");

    // The CLI, by contrast, notices the address is dead and spawns a board.
    const started = await startTaskd({ dataDir });
    try {
      const result = runCli(["project", "list", "--json"], { dataDir, noUrl: true });
      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(readJsonFile(pointerPath).port, Number(new URL(dead).port));
    } finally {
      await started.close();
    }
  });

  it("waits for a pointer whose pid matches the process it just started", async () => {
    const dataDir = makeTempDir();
    const pointerPath = join(dataDir, "runtime.json");
    // Nothing writes it: the wait must end as a `null`, not an exception.
    const missing = await waitForPointer({ pointerPath, timeoutMs: 120, pollMs: 20, pid: 1 });
    assert.equal(missing, null);

    const fs = await import("node:fs");
    fs.writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:1", pid: 999999 }));
    assert.equal(
      await waitForPointer({ pointerPath, timeoutMs: 80, pollMs: 20, pid: process.pid }),
      null,
      "a pointer naming somebody else's pid is not ours",
    );
    assert.notEqual(await waitForPointer({ pointerPath, timeoutMs: 80, pollMs: 20, pid: 999999 }), null);
  });
});

describe("cli/autostart — a guarded board is reused, never doubled (T-20261013-213717-3)", () => {
  // The OS-level `taskd` keepalive (docs/scheduling.md § The taskd guard) leaves a
  // *healthy* runtime pointer behind. The CLI must therefore treat it like any other
  // running board: reuse it, and never start a second server against the same data
  // directory — the write lock (R1) makes a second one lose, but losing is still a
  // spawned process and a restart the operator did not ask for.
  /** The environment the CLI would run with, aimed at one board. */
  function boardEnv(board, extra = {}) {
    return {
      ...baseEnv(),
      TASKD_DATA_DIR: board.dataDir,
      TASKD_RUNTIME_POINTER: board.pointerPath,
      TASKD_PORT: "0",
      TASKD_HOST: "127.0.0.1",
      TASKD_NO_AUTOSTART: "",
      ...extra,
    };
  }

  it("reuses the pointer a running board left behind, and spawns nothing", async () => {
    // A real `taskd` stands in for the guarded one: same program the unit runs, same
    // pointer, same write lock. It is *not* this process's child in production, which
    // is why the pid in the pointer belongs to somebody else here too.
    const board = await startTaskd();
    try {
      const resolved = await ensureBoard({ env: boardEnv(board), pointerPath: board.pointerPath });
      assert.equal(resolved.autostarted, false, "a healthy pointer is reused, not re-started");
      assert.equal(resolved.url, board.url.replace(/\/+$/, ""));
      assert.equal(readJsonFile(board.pointerPath).pid, board.pid, "still the same server");

      // Nothing spawned means no second log writer: the lazy start creates this file
      // before it spawns, so its absence is the honest evidence.
      const boardLog = join(board.dataDir, "logs", "taskd.log");
      const before = existsSync(boardLog) ? readFileSync(boardLog, "utf8").length : 0;
      const again = await ensureBoard({ env: boardEnv(board), pointerPath: board.pointerPath });
      assert.equal(again.autostarted, false);
      assert.equal(existsSync(boardLog) ? readFileSync(boardLog, "utf8").length : 0, before);
    } finally {
      await board.close();
    }
  });

  it("falls back to the lazy start once the guarded board is gone", async () => {
    const board = await startTaskd();
    const { dataDir, pointerPath, url } = board;
    const deadUrl = url.replace(/\/+$/, "");

    // SIGKILL: the supervisor's own case. Nothing cleans up, so the pointer survives
    // pointing at a process that is gone — the state the guard is *not* there to fix,
    // because the guard itself is what stopped.
    const exited = new Promise((resolve) => board.child.once("exit", resolve));
    board.child.kill("SIGKILL");
    await exited;
    assert.equal(existsSync(pointerPath), true, "SIGKILL leaves the pointer behind");

    const started = await ensureBoard({ env: boardEnv(board), pointerPath, waitMs: 20_000 });
    try {
      assert.equal(started.autostarted, true, "a pointer that does not answer is not believed");
      const pointer = readJsonFile(pointerPath);
      assert.notEqual(pointer.pid, board.pid, "a fresh server, not the dead one");
      assert.notEqual(pointer.url.replace(/\/+$/, ""), deadUrl);
    } finally {
      // `ensureBoard` spawned this one, so stopping it is this case's job.
      const pid = readJsonFile(pointerPath)?.pid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  });
});

describe("cli/autostart — the one case that starts a daemon (F-E2)", () => {
  it("starts taskd, runs the command, and leaves nothing behind on SIGTERM", async () => {
    const dataDir = makeTempDir();
    const pointerPath = join(dataDir, "runtime.json");
    const env = {
      ...baseEnv(),
      TASKD_DATA_DIR: dataDir,
      TASKD_RUNTIME_POINTER: pointerPath,
      TASKD_PORT: "0",
      TASKD_HOST: "127.0.0.1",
      // Autostart is *allowed* here — and only here.
      TASKD_NO_AUTOSTART: "",
    };

    let pid = null;
    try {
      const run = (args) => {
        const result = runCli(args, { dataDir, noUrl: true, env, timeout: 30_000 });
        if (pid === null && existsSync(pointerPath)) pid = readJsonFile(pointerPath)?.pid ?? null;
        return result;
      };

      // No --url and no board: the CLI has to start one.
      const created = run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
      assert.equal(JSON.parse(created.stdout).data.project.id, "demo");

      assert.notEqual(pid, null, "the daemon wrote a runtime pointer");
      const pointer = readJsonFile(pointerPath);
      assert.equal(pointer.port > 0, true, "the pointer names the port the OS assigned, not 0");
      assert.equal(pointer.dataDir, dataDir);

      // A second command finds the same board rather than starting another.
      const listed = run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(readJsonFile(pointerPath).pid, pid, "no second daemon");
      assert.equal(readJsonFile(pointerPath).port, pointer.port);
    } finally {
      // The harness did not start this daemon, so stopping it is this test's job
      // — and stopping it is also how the pointer-removal promise is checked.
      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }

    const removed = await waitUntil(() => existsSync(pointerPath) === false, { timeoutMs: 5_000 });
    assert.equal(removed, true, "SIGTERM removes the runtime pointer");
  });
});
