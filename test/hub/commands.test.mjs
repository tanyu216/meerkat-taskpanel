/**
 * Command-level branches the socket-level suites do not reach: an unresolved
 * board, a logger that throws, and each watch mode's entry into its helper.
 *
 * These call the command objects directly, with a context shaped like the
 * dispatcher's, so the failure path is exercised without a board round trip.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { COMMANDS as eventCommands, runHub } from "../../src/cli/commands/events.mjs";
import { COMMANDS as exportCommands } from "../../src/cli/commands/export.mjs";
import { hubPaths, writeJsonFile } from "../../src/cli/hub/runtime.mjs";
import { createBoardClient } from "../../src/foundation/transport/client.mjs";
import { fakeBoard } from "./helpers/fake-board.mjs";

const TOKEN = "td_hubcommands";
const dirs = [];
const children = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-hub-commands-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("event and watch command branches", () => {
  let board;
  let projectDir;
  let env;

  beforeEach(async () => {
    board = await fakeBoard();
    projectDir = tempDir();
    env = { ...process.env, MEERKAT_HUB_DIR: tempDir(), TASKD_NO_AUTOSTART: "1" };
    delete env.TASKD_TOKEN;
    delete env.MEERKAT_TASKPANEL_ENV_FILE;
  });

  afterEach(async () => {
    await board?.close();
  });

  /** The command object by name, so a test can call its `run` directly. */
  const command = (commands, name) => commands.find((entry) => entry.name === name);

  const ctxFor = (overrides) => ({
    client: createBoardClient({
      url: board.url,
      token: TOKEN,
      actor: { kind: "claude", id: "tester" },
    }),
    board: null,
    flags: {},
    args: {},
    identity: { actor: { kind: "claude", id: "tester" } },
    env,
    cwd: projectDir,
    emit: () => {},
    ...overrides,
  });

  it("refuses an unresolved board before starting a hub or a watcher", async () => {
    const hub = command(eventCommands, "hub");
    const follow = command(eventCommands, "follow");
    const watch = command(exportCommands, "watch");
    const ref = { ref: "DEMO-0001" };

    await assert.rejects(() => hub.run(ctxFor()), (err) => err.code === "CLI_IO");
    await assert.rejects(() => follow.run(ctxFor()), (err) => err.code === "CLI_IO");

    for (const flags of [{ detach: true }, {}, { stop: true }, { watchStatus: true }]) {
      await assert.rejects(
        () => watch.run(ctxFor({ flags, args: ref })),
        (err) => err.code === "CLI_IO",
      );
    }
  });

  it("refuses conflicting watch modes before touching a board", async () => {
    const watch = command(exportCommands, "watch");
    const conflicts = [
      { once: true, detach: true },
      { once: true, watchStatus: true },
      { once: true, stop: true },
      { detach: true, stop: true },
      { watchStatus: true, stop: true },
      { standalone: true, detach: true },
      { standalone: true, stop: true },
      { standalone: true, watchStatus: true },
    ];
    for (const flags of conflicts) {
      await assert.rejects(
        () => watch.run(ctxFor({ flags, args: { ref: "DEMO-0001" } })),
        (err) => err.code === "CLI_USAGE",
      );
    }
  });

  it("stops a hub through the command, and reports when there is none", async () => {
    const hub = command(eventCommands, "hub");
    assert.ok(
      hub.flags.some((flag) => flag.flag === "stop"),
      "events hub must declare --stop, or the dispatcher refuses it",
    );
    const none = await hub.run(
      ctxFor({ board: { url: board.url, token: `${TOKEN}-none` }, flags: { stop: true } }),
    );
    assert.equal(none.data.stopped, false);
    assert.equal(none.data.reason, "no-pointer");
    assert.match(none.human, /no local event hub is running/);
  });

  it("refuses to stop a process the owner lock does not name", async () => {
    const token = `${TOKEN}-mismatch`;
    const paths = hubPaths(board.url, token, env);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    writeJsonFile(paths.pointer, { pid: child.pid });
    writeJsonFile(paths.owner, { pid: process.pid });

    const hub = command(eventCommands, "hub");
    await assert.rejects(
      () => hub.run(ctxFor({ board: { url: board.url, token }, flags: { stop: true } })),
      (err) => err.code === "CLI_IO" && /owner lock does not match/.test(err.message),
    );
  });

  it("starts and stops a hub even when its logger throws", async () => {
    const hubDir = tempDir();
    const server = await runHub(
      {
        client: createBoardClient({ url: board.url, token: `${TOKEN}-log` }),
        board: { url: board.url, token: `${TOKEN}-log` },
        env: { ...env, MEERKAT_HUB_DIR: hubDir },
      },
      {
        log: () => {
          throw new Error("the log fd is gone");
        },
      },
    );
    await server.stop();
  });
});
