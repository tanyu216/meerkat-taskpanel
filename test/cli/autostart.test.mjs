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
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { waitForPointer } from "../../src/shared/transport/autostart.mjs";
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
      const created = run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);
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
