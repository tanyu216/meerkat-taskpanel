/**
 * The local event hub, end to end.
 *
 * A fake board (HTTP + SSE) stands in for taskd; the hub runs as the real
 * detached child the CLI starts, so every leg exercises the deployment shape
 * rather than an in-process stand-in. The properties under test are the ones the
 * design exists for:
 *
 *   * one board connection serves many local consumers;
 *   * a detached registration survives the command that made it — including a
 *     harness that kills the command's whole process group (codex);
 *   * done/TTL remove a registration; a hub restart resumes persistent ones;
 *   * the pointer and runtime directory are owner-only.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { run } from "../../src/cli/index.mjs";
import { hubRecords } from "../../src/cli/hub/client.mjs";
import {
  HUB_PROTOCOL,
  hubKey,
  hubPaths,
  readJsonFile,
  writeJsonFile,
} from "../../src/cli/hub/runtime.mjs";
import { fakeBoard } from "./helpers/fake-board.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_ENTRY = join(ROOT, "src", "cli", "index.mjs");
/** A fixed token makes the hub key deterministic and the test hermetic. */
const TOKEN = "td_hubtest";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs = 8_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/** Stop every hub this test's runtime directory knows about. */
async function stopHubs(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^hub-[0-9a-f]+\.json$/.test(name));
  } catch {
    return;
  }
  const pids = names
    .map((name) => readJsonFile(join(dir, name))?.pid)
    .filter((pid) => Number.isInteger(pid));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // A graceful stop removes the pointer. Waiting on the pid instead would hang
  // on a zombie in a container whose PID 1 does not reap reparented children.
  try {
    await waitFor(
      () => names.every((name) => readJsonFile(join(dir, name)) === null),
      3_000,
    );
  } catch {
    /* fall through to the hard stop */
  }
  for (const pid of pids) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best effort */
      }
    }
  }
}

/** Read a child's stdout until `ready` is satisfied. */
function collect(child) {
  const state = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr += chunk;
  });
  return state;
}

describe("local event hub", () => {
  let board;
  let hubDir;
  let projectDir;
  let env;
  /** @type {Array<import("node:child_process").ChildProcess>} */
  let children;

  beforeEach(async () => {
    hubDir = mkdtempSync(join(tmpdir(), "meerkat-hub-"));
    projectDir = mkdtempSync(join(tmpdir(), "meerkat-proj-"));
    board = await fakeBoard();
    children = [];
    env = { ...process.env, MEERKAT_HUB_DIR: hubDir, TASKD_NO_AUTOSTART: "1" };
    delete env.TASKD_TOKEN;
    delete env.MEERKAT_TASKPANEL_ENV_FILE;
  });

  afterEach(async () => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await stopHubs(hubDir);
    await board.close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const cli = async (args) => {
    let stdout = "";
    let stderr = "";
    const exit = await run(
      ["--url", board.url, "--token", TOKEN, ...args, "--actor-kind", "claude", "--agent", "tester"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        env,
        cwd: projectDir,
      },
    );
    return { exit, stdout, stderr };
  };

  const cardPath = (identifier) => join(projectDir, ".meerkat", identifier, "card.md");
  const hubPointer = () => readJsonFile(hubPaths(board.url, TOKEN, env).pointer);

  it("registers, refreshes, reports and stops one card through one board connection", async () => {
    board.add("DEMO-0001", "uuid-1", "# DEMO-0001 v1\n");

    const detach = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--detach", "--json"]);
    assert.equal(detach.exit, 0, detach.stderr);
    const registered = JSON.parse(detach.stdout);
    assert.equal(registered.ok, true);
    assert.equal(registered.data.running, true);
    assert.equal(typeof registered.data.registration_id, "string");
    assert.equal(readFileSync(cardPath("DEMO-0001"), "utf8"), "# DEMO-0001 v1\n");

    await waitFor(() => board.connections() >= 1);
    board.update("DEMO-0001", { markdown: "# DEMO-0001 v2\n" });
    board.emit("uuid-1");
    await waitFor(() => readFileSync(cardPath("DEMO-0001"), "utf8").includes("v2"));

    const status = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(status.exit, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.running, true);

    // The hub is the only board client: detach/status/stop are local sockets.
    assert.equal(board.connections(), 1);

    const stop = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--stop", "--json"]);
    assert.equal(stop.exit, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.stopped, true);

    const after = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(JSON.parse(after.stdout).data.running, false);
  });

  it("shares one board connection across two registrations and a follower", async () => {
    board.add("DEMO-0001", "uuid-1", "# one\n");
    board.add("DEMO-0002", "uuid-2", "# two\n");
    await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--detach", "--json"]);
    await cli(["export", "watch", "DEMO-0002", "--dir", projectDir, "--detach", "--json"]);

    const follow = spawn(
      process.execPath,
      [CLI_ENTRY, "events", "follow", "--url", board.url, "--token", TOKEN, "--actor-kind", "claude", "--agent", "tester", "--idle", "0"],
      { env, cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(follow);
    const output = collect(follow);
    try {
      await waitFor(() => output.stdout.includes('"type":"open"'));
    } catch (err) {
      console.error("FOLLOW stdout:", output.stdout);
      console.error("FOLLOW stderr:", output.stderr);
      throw err;
    }

    board.emit("uuid-1");
    await waitFor(() => output.stdout.includes('"type":"event"'));

    assert.equal(board.connections(), 1);
  });

  it("survives the harness killing the command's process group (codex)", { skip: process.platform === "win32" }, async () => {
    board.add("DEMO-0003", "uuid-3", "# v1\n");
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        "export",
        "watch",
        "DEMO-0003",
        "--dir",
        projectDir,
        "--detach",
        "--json",
        "--url",
        board.url,
        "--token",
        TOKEN,
        "--actor-kind",
        "claude",
        "--agent",
        "tester",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: projectDir },
    );
    children.push(child);
    const output = collect(child);
    const exited = new Promise((done) => child.once("exit", done));
    try {
      await waitFor(() => /"ok"\s*:\s*true/.test(output.stdout));
    } catch (err) {
      console.error("CODEX child stdout:", output.stdout);
      console.error("CODEX child stderr:", output.stderr);
      console.error("CODEX child code:", child.exitCode, "signal:", child.signalCode);
      console.error("CODEX hub dir:", (() => { try { return readdirSync(hubDir); } catch { return []; } })());
      throw err;
    }
    await exited;

    // What codex does at the end of a shell tool call: signal the whole group.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* the leader already exited; the group is empty */
    }

    const pointer = hubPointer();
    assert.ok(pointer !== null && alive(pointer.pid), "the hub escaped the command's process group");

    try {
      await waitFor(() => board.connections() >= 1);
    } catch (err) {
      console.error("CODEX files:", readdirSync(hubDir));
      for (const name of readdirSync(hubDir).filter((n) => n.endsWith(".log"))) {
        console.error("CODEX log", name, ":", readFileSync(join(hubDir, name), "utf8").slice(-2000));
      }
      console.error("CODEX pointer:", JSON.stringify(hubPointer()));
      throw err;
    }
    board.update("DEMO-0003", { markdown: "# v2\n" });
    board.emit("uuid-3");
    try {
      await waitFor(() => readFileSync(cardPath("DEMO-0003"), "utf8").includes("v2"));
    } catch (err) {
      console.error("CODEX stdout:", output.stdout);
      console.error("CODEX stderr:", output.stderr);
      throw err;
    }
  });

  it("stops a registration when the card reaches done", async () => {
    board.add("DEMO-0004", "uuid-4", "# open\n");
    await cli(["export", "watch", "DEMO-0004", "--dir", projectDir, "--detach", "--json"]);

    board.update("DEMO-0004", { markdown: "# final\n", status: "done" });
    board.emit("uuid-4");
    await waitFor(() => readFileSync(cardPath("DEMO-0004"), "utf8").includes("final"));

    await waitFor(async () => {
      const status = await cli(["export", "watch", "DEMO-0004", "--dir", projectDir, "--watch-status", "--json"]);
      return JSON.parse(status.stdout).data.running === false;
    }, 8_000);
  });

  it("expires a registration at its TTL", async () => {
    board.add("DEMO-0005", "uuid-5", "# ttl\n");
    await cli(["export", "watch", "DEMO-0005", "--dir", projectDir, "--ttl", "400", "--detach", "--json"]);

    await waitFor(async () => {
      const status = await cli(["export", "watch", "DEMO-0005", "--dir", projectDir, "--watch-status", "--json"]);
      return JSON.parse(status.stdout).data.running === false;
    }, 8_000);
  });

  it("resumes a detached registration after the hub restarts", async () => {
    board.add("DEMO-0006", "uuid-6", "# before\n");
    board.add("DEMO-0007", "uuid-7", "# second\n");
    await cli(["export", "watch", "DEMO-0006", "--dir", projectDir, "--detach", "--json"]);
    const first = hubPointer();
    assert.ok(first !== null);

    process.kill(first.pid, "SIGTERM");
    await waitFor(() => !alive(first.pid));

    // A new client starts a new hub; the persisted registration is rehydrated.
    await cli(["export", "watch", "DEMO-0007", "--dir", projectDir, "--detach", "--json"]);
    const second = hubPointer();
    assert.ok(second !== null && second.pid !== first.pid);

    await waitFor(async () => {
      const status = await cli(["export", "watch", "DEMO-0006", "--dir", projectDir, "--watch-status", "--json"]);
      return JSON.parse(status.stdout).data.running === true;
    }, 8_000);

    board.update("DEMO-0006", { markdown: "# after\n" });
    board.emit("uuid-6");
    await waitFor(() => readFileSync(cardPath("DEMO-0006"), "utf8").includes("after"));
  });

  it("publishes an owner-only pointer in an owner-only directory", async () => {
    board.add("DEMO-0008", "uuid-8", "# perms\n");
    await cli(["export", "watch", "DEMO-0008", "--dir", projectDir, "--detach", "--json"]);
    const pointer = hubPointer();
    assert.ok(pointer !== null);
    if (process.platform !== "win32") {
      const pointerPath = hubPaths(board.url, TOKEN, env).pointer;
      assert.equal(statSync(pointerPath).mode & 0o777, 0o600);
      assert.equal(statSync(hubDir).mode & 0o777, 0o700);
    }
  });

  it("reconnects to the board and re-renders a registration after the gap", async () => {
    board.add("DEMO-0010", "uuid-10", "# before reconnect\n");
    await cli(["export", "watch", "DEMO-0010", "--dir", projectDir, "--detach", "--json"]);
    await waitFor(() => board.connections() >= 1);

    board.dropStreams();
    await waitFor(() => board.connections() >= 2, 10_000);

    board.update("DEMO-0010", { markdown: "# after reconnect\n" });
    board.emit("uuid-10");
    await waitFor(() => readFileSync(cardPath("DEMO-0010"), "utf8").includes("after reconnect"));
  });

  it("lets a foreground viewer attach to a detached registration without retiring it", async () => {
    board.add("DEMO-0009", "uuid-9", "# viewer\n");
    await cli(["export", "watch", "DEMO-0009", "--dir", projectDir, "--detach", "--json"]);

    const viewer = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        "export",
        "watch",
        "DEMO-0009",
        "--dir",
        projectDir,
        "--url",
        board.url,
        "--token",
        TOKEN,
        "--actor-kind",
        "claude",
        "--agent",
        "tester",
      ],
      { env, cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(viewer);
    const output = collect(viewer);
    await waitFor(() => output.stdout.includes('"type":"refresh"'));

    const exited = new Promise((done) => viewer.once("exit", done));
    viewer.kill("SIGTERM");
    await exited;

    const status = await cli(["export", "watch", "DEMO-0009", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(JSON.parse(status.stdout).data.running, true);

    board.update("DEMO-0009", { markdown: "# after viewer\n" });
    board.emit("uuid-9");
    await waitFor(() => readFileSync(cardPath("DEMO-0009"), "utf8").includes("after viewer"));
  });

  it("lets a human caller start the hub with --as-human", async () => {
    board.add("DEMO-0011", "uuid-11", "# human\n");
    const result = await cli([
      "export", "watch", "DEMO-0011", "--dir", projectDir, "--detach", "--json", "--as-human",
    ]);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.running, true);
    assert.equal(readFileSync(cardPath("DEMO-0011"), "utf8"), "# human\n");
    const pointer = hubPointer();
    assert.ok(pointer !== null && alive(pointer.pid));
  });

  it("replaces a hub from another protocol generation and resumes its registrations", async () => {
    board.add("DEMO-0012", "uuid-12", "# legacy\n");
    const paths = hubPaths(board.url, TOKEN, env);
    writeJsonFile(paths.state, {
      version: 2,
      registrations: [
        {
          id: "legacy-watch",
          refs: ["DEMO-0012"],
          dir: projectDir,
          ttl_ms: 0,
          created_at: 0,
          expires_at: null,
          cards: [{ ref: "DEMO-0012", path: cardPath("DEMO-0012") }],
        },
      ],
    });

    const legacy = spawn(
      process.execPath,
      [join(ROOT, "test", "hub", "helpers", "legacy-hub.mjs"), board.url, TOKEN],
      { env, cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(legacy);
    const legacyOutput = collect(legacy);
    await waitFor(() => legacyOutput.stdout.includes("\n"));

    const before = hubPointer();
    assert.ok(before !== null && before.pid === legacy.pid);
    assert.equal(before.protocol, HUB_PROTOCOL + 1);

    // A client of this generation must evict it, not time out against its lock.
    const follow = await cli(["events", "follow", "--idle", "600"]);
    assert.equal(follow.exit, 0, follow.stderr);
    assert.match(follow.stdout, /"type":"open"/);

    assert.ok(await waitFor(() => !alive(legacy.pid)));
    const after = hubPointer();
    assert.ok(after !== null && after.pid !== legacy.pid && alive(after.pid));
    assert.equal(after.protocol, HUB_PROTOCOL);

    // The replacement rehydrates the detached registration the old hub persisted.
    await waitFor(() => readFileSync(cardPath("DEMO-0012"), "utf8").includes("legacy"));
  });

  it("stops the local hub with events hub --stop", async () => {
    board.add("DEMO-0014", "uuid-14", "# stop\n");
    await cli(["export", "watch", "DEMO-0014", "--dir", projectDir, "--detach", "--json"]);
    const running = hubPointer();
    assert.ok(running !== null && alive(running.pid));

    const stop = await cli(["events", "hub", "--stop", "--json"]);
    assert.equal(stop.exit, 0, stop.stderr);
    const envelope = JSON.parse(stop.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(
      { stopped: envelope.data.stopped, pid: envelope.data.pid },
      { stopped: true, pid: running.pid },
    );
    assert.ok(await waitFor(() => !alive(running.pid)));
    assert.equal(hubPointer(), null);

    const again = await cli(["events", "hub", "--stop", "--json"]);
    assert.equal(again.exit, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).data.stopped, false);
  });

  it("keys a hub by board URL", () => {
    assert.notEqual(hubKey("http://127.0.0.1:1", ""), hubKey("http://127.0.0.1:2", ""));
  });
});
