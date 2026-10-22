/**
 * `taskctl status` — the local read of the board's runtime pointer.
 *
 * Three properties are the whole point of the command, and each has a case here:
 *
 *   * it needs **no identity** and never autostarts (it must work on a machine
 *     with no board, which is exactly when an agent asks);
 *   * "not running" is an **answer**, not a failure — exit 0;
 *   * `--url` is a pin: the runtime pointer is not consulted behind it.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, closedPortUrl, dataOf, runCli, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/status — no board", () => {
  it("answers running:false, exit 0, with no --actor-kind and no autostart", () => {
    const run = runCli(["status", "--json"], { noIdentity: true, env: { TASKD_NO_AUTOSTART: "1" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const data = dataOf(run);
    assert.deepEqual(Object.keys(data).sort(), ["runtime", "schema_version", "version"]);
    assert.equal(data.runtime.running, false);
    assert.equal(data.runtime.pointer, null);
    assert.equal(typeof data.runtime.data_dir, "string");
    assert.match(data.runtime.note, /no readable runtime pointer/);
  });

  it("prints the human form without failing", () => {
    const run = runCli(["status"], { noIdentity: true });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^board: not running$/m);
  });

  it("shows its own help", () => {
    const run = runCli(["status", "--help"], { noUrl: true });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Usage: taskctl status /m);
    assert.match(run.stdout, /Global options:/);
  });
});

describe("cli/status — a live board", () => {
  it("reports the pointer the client actually uses", async () => {
    await withCli(async ({ runNoUrl, url, dataDir, taskd }) => {
      const run = runNoUrl(["status", "--json"]);
      assert.equal(run.status, 0, run.stderr);
      const runtime = dataOf(run).runtime;
      assert.equal(runtime.running, true);
      assert.equal(runtime.url, url);
      assert.equal(runtime.pointer, taskd.pointerPath);
      assert.equal(runtime.data_dir, dataDir);
      assert.equal(runtime.pid, taskd.pid);
      assert.equal(runtime.note, null);
    });
  });

  it("treats --url as a pin and does not fall back to the pointer", async () => {
    await withCli(async ({ run, url }) => {
      const pinned = dataOf(run(["status", "--json"])).runtime;
      assert.equal(pinned.pointer, null, "--url: the pointer is not consulted");
      assert.equal(pinned.url, url);
      assert.equal(pinned.running, true);
    });
  });

  it("reports a closed --url as not running, exit 0", async () => {
    const dead = await closedPortUrl();
    const run = runCli(["status", "--json"], { url: dead, noIdentity: true });
    assert.equal(run.status, 0, run.stderr);
    const runtime = dataOf(run).runtime;
    assert.equal(runtime.url, dead);
    assert.equal(runtime.running, false);
    assert.equal(runtime.pointer, null);
  });
});
