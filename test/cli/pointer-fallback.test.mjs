/**
 * R1, read side: a board that was pushed off the machine-wide slot must still be
 * findable (card T-20261013-165749).
 *
 * The write side (T-20261013-160314-3, `test/concurrency/writer-guard.test.mjs`)
 * already refuses to displace a live board: when the machine-wide slot names a
 * *different* board, the newcomer is addressed beside its own data directory —
 * `<dataDir>/runtime.json`. That file was written and never read: the client
 * only ever consulted the machine-wide slot, so the board that had just been
 * pushed aside was unreachable *while it ran*. `taskctl` in its data directory
 * resolved the other board's address — answering from the wrong board, or, when
 * that address was stale or `TASKD_NO_AUTOSTART=1` was set, failing outright
 * instead of talking to the board that was up.
 *
 * The cases below are, in order: the read-side rule itself and the ways it must
 * *not* fire (no process needed — the pointer is a file), then the incident end
 * to end: one real daemon pushed off the slot by a live *other* board, reached
 * through the real CLI with nothing but `TASKD_DATA_DIR`.
 *
 * `home` is a temp dir in every case, so the "machine-wide" slot here is this
 * test's alone and a developer's real one is never in play.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ensureBoard, probeHealth, readPointer } from "../../src/foundation/transport/runtime.mjs";
import { resolveRuntimePointerPath } from "../../src/foundation/runtime-locator.mjs";
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

/** The machine-wide slot, under a temp `home` — darwin and linux alike. */
function slotPath(home) {
  return resolveRuntimePointerPath({ env: {}, home });
}

/** Write a pointer file, creating its directory the way the daemon would. */
function writePointerAt(path, pointer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pointer, null, 2)}\n`);
}

/**
 * The environment a child gets in these cases: a temp `home` (so the
 * machine-wide slot is this test's own), and *no named pointer* — an empty
 * `TASKD_RUNTIME_POINTER` is "not named", which is what puts the machine-wide
 * slot in play. `XDG_STATE_HOME` is dropped for the same reason: on Linux it
 * would move the slot out from under `home`.
 */
function slotChildEnv(home, extra = {}) {
  const env = baseEnv();
  delete env.XDG_STATE_HOME;
  env.HOME = home;
  env.TASKD_RUNTIME_POINTER = "";
  return { ...env, ...extra };
}

const other = { url: "http://127.0.0.1:9527", port: 9527, dataDir: "/tmp/other-board", pid: 4242 };
const mine = { url: "http://127.0.0.1:9531", port: 9531, pid: 4243 };

describe("cli/pointer-fallback — the pointer the reader believes", () => {
  it("prefers the board addressed beside its own data directory", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const slot = slotPath(home);
    const local = join(dataDir, "runtime.json");
    writePointerAt(slot, other);
    writePointerAt(local, { ...mine, dataDir });

    const pointer = readPointer({ env: {}, home, dataDir });
    assert.equal(pointer.url, mine.url, "the board that could not take the slot is found");
    assert.equal(pointer.path, local, "…and it is named by the file it was written to");

    // The other board's reader is untouched: for *its* data directory the
    // machine-wide slot is the answer, byte for byte.
    assert.deepEqual(readPointer({ env: {}, home, dataDir: "/tmp/other-board" }), { ...other, path: slot });
  });

  it("believes a named pointer verbatim, even with a data-directory file present", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const named = join(home, "explicit.json");
    writePointerAt(slotPath(home), other);
    writePointerAt(join(dataDir, "runtime.json"), { ...mine, dataDir });
    writePointerAt(named, { url: "http://127.0.0.1:9999", dataDir: "elsewhere" });

    // The caller (or `TASKD_RUNTIME_POINTER`) has chosen the namespace: the
    // fallback must not second-guess it — every case in this suite names its
    // pointer file, so an over-eager fallback would reach a developer's board.
    assert.equal(readPointer({ env: {}, home, dataDir, path: named }).url, "http://127.0.0.1:9999");
    assert.equal(
      readPointer({ env: { TASKD_RUNTIME_POINTER: named }, home, dataDir }).url,
      "http://127.0.0.1:9999",
    );
  });

  it("keeps the machine-wide slot when it names this very board", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const slot = slotPath(home);
    // A fossil from an earlier run of *this* board, beside its own data
    // directory, and the slot the board is in now. The slot wins: the local file
    // is exactly the stale address the health probe would have to reject.
    writePointerAt(slot, { ...other, dataDir });
    writePointerAt(join(dataDir, "runtime.json"), mine);

    const pointer = readPointer({ env: {}, home, dataDir });
    assert.equal(pointer.path, slot);
    assert.equal(pointer.url, other.url);
  });

  it("declines the fallback when this data directory has no address of its own", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    writePointerAt(slotPath(home), other);
    // Nothing beside the data directory yet: the machine-wide slot is all there is.
    assert.deepEqual(readPointer({ env: {}, home, dataDir }), { ...other, path: slotPath(home) });

    // …and junk there is not an address either.
    writePointerAt(join(dataDir, "runtime.json"), { port: 9531 });
    assert.equal(readPointer({ env: {}, home, dataDir }).url, other.url);
  });

  it("finds this data directory's own board when the slot is empty", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const local = join(dataDir, "runtime.json");
    writePointerAt(local, { ...mine, dataDir });

    // No machine-wide file at all — the slot's owner has exited. The board is
    // still running, so its own address is the one to answer with; autostarting
    // over it would be refused by the write lock it holds.
    const pointer = readPointer({ env: {}, home, dataDir });
    assert.equal(pointer.url, mine.url);
    assert.equal(pointer.path, local);
  });
});

describe("cli/pointer-fallback — a real board pushed off the slot", () => {
  it("resolves the slot's pointer only once when that is all there is", async () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const dead = await closedPortUrl();
    writePointerAt(slotPath(home), { url: dead, dataDir: other.dataDir, pid: other.pid });

    // Nothing beside this data directory, so the slot pointer *is* the preferred
    // one: a second candidate reading the same file would be the same question
    // asked twice, and the refusal is the ordinary one.
    await assert.rejects(
      () => ensureBoard({ env: { TASKD_DATA_DIR: dataDir, TASKD_NO_AUTOSTART: "1" }, home }),
      (err) => err.code === "CLI_IO" && /not answering/.test(err.message),
    );
  });

  it("reaches it through the CLI with nothing but TASKD_DATA_DIR", async () => {
    const home = makeTempDir();
    const otherDir = makeTempDir();
    const dataDir = makeTempDir();
    const slot = slotPath(home);
    const dead = await closedPortUrl();

    // The other board's address holds the machine-wide slot. Its pid is this
    // very process — alive, which is what makes the writer's rule ("a live
    // *other* board keeps the slot") the real one — and its address is dead,
    // which is what made the pre-fix symptom a hard failure rather than a quiet
    // answer from the wrong board.
    writePointerAt(slot, {
      url: dead,
      host: "127.0.0.1",
      port: Number(new URL(dead).port),
      dataDir: otherDir,
      pid: process.pid,
    });

    const board = await startTaskd({ dataDir, env: slotChildEnv(home) });
    try {
      // The write side did its half (R1): the incumbent's slot is untouched, and
      // this board is addressed beside its own data directory.
      assert.equal(readJsonFile(slot).url, dead, "the sitting board's address is not displaced");
      assert.equal(readJsonFile(join(dataDir, "runtime.json")).url, board.url, "…and this board has one");

      // Create a project through the board's own address, so the listing below
      // has something only *this* board can answer with.
      const created = runCli(
        ["project", "create", "--id", "displaced", "--name", "DISPLACED-BOARD", "--json"],
        { url: board.url, dataDir },
      );
      assert.equal(created.status, 0, created.stderr);

      // The read side: no --url, no named pointer, just the data directory.
      const listed = runCli(["project", "list", "--json"], { dataDir, noUrl: true, env: slotChildEnv(home) });
      assert.equal(listed.status, 0, `the running board must be reachable\n${listed.stdout}${listed.stderr}`);
      assert.deepEqual(
        JSON.parse(listed.stdout).data.projects.map((p) => p.id),
        ["displaced"],
        "the answer came from the board that is up, not from the slot's other address",
      );
    } finally {
      await board.close();
    }
  });

  it("believes the slot's live board rather than spawning over a fossil", async () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const slot = slotPath(home);
    const dead = await closedPortUrl();
    const live = await startTaskd(); // another board: its own data directory, its own address
    try {
      // The fallback file is a *fossil*: a board killed before it could remove
      // the address beside its own data directory. The slot's board, meanwhile,
      // is up and answering.
      writePointerAt(join(dataDir, "runtime.json"), {
        url: dead,
        host: "127.0.0.1",
        port: Number(new URL(dead).port),
        dataDir,
        pid: 999_001,
      });
      writePointerAt(slot, live.pointer);
      const slotBefore = readFileSync(slot, "utf8");

      const created = runCli(
        ["project", "create", "--id", "slot-board", "--name", "SLOT-BOARD", "--json"],
        { url: live.url, dataDir: live.dataDir },
      );
      assert.equal(created.status, 0, created.stderr);

      // `TASKD_NO_AUTOSTART=1` (the harness default) makes this sharp: believing
      // the fossil would fail the invocation, and spawning a board for it would
      // hand the spawn a *named* pointer path — the machine-wide one — so that
      // daemon would take the live board's address away (the write side's "never
      // displace a live board" rule does not reach a daemon this process starts).
      const listed = runCli(["project", "list", "--json"], { dataDir, noUrl: true, env: slotChildEnv(home) });
      assert.equal(listed.status, 0, `a reachable board must be believed\n${listed.stdout}${listed.stderr}`);
      assert.deepEqual(JSON.parse(listed.stdout).data.projects.map((p) => p.id), ["slot-board"]);
      assert.equal(readFileSync(slot, "utf8"), slotBefore, "the live board keeps its address, byte for byte");
    } finally {
      await live.close();
    }
  });
});

/**
 * The residual window (T-20261013-165749 §⑪ 遗留 ② / §6.3).
 *
 * The fossil guard above believes the slot's board *when it answers `/health`*.
 * "Reachable" and "healthy" are not the same thing: a board can hold its address
 * and run its event loop while `/health` reports that it is not serving yet (a
 * 503, a non-`ok` status). The guard then declines the slot, and the autostart
 * path takes over — and *that* path is the one place where the write side's rule
 * ("never displace a live board") does not reach, because the parent **names**
 * the machine-wide file to the daemon it spawns: a named pointer is obeyed
 * verbatim, so the newcomer overwrites the live-but-unhealthy board's address
 * instead of being addressed beside its own data directory.
 *
 * The harm is the incident this family of cards exists to remove: a board that
 * is up becomes unfindable — every reader of the slot now resolves a *different*
 * board's address, and the wedged one has no path back to the machine-wide file.
 *
 * The cases below are the two halves of the fix's contract: with a live but
 * unhealthy board in the slot the spawned daemon must be addressed beside its own
 * data directory (the slot untouched, byte for byte), and with nobody in the slot
 * the ordinary unnamed start must still be found — the child, not the parent,
 * decides which file it owns, so the parent waits at both places it may have
 * written.
 */

/** A board-shaped address that is reachable but unhealthy: `/health` is a 503. */
async function startUnhealthyBoard() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "BOARD_NOT_READY", message: "not serving yet" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    // It answers, so "reachable" is not the question — and it is a live process,
    // which is what makes the write side treat it as an owner rather than a fossil.
    pid: process.pid,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Stop the daemon an `ensureBoard` call started (the pid is in its pointer). */
async function stopSpawned(started) {
  const pid = started?.pointer?.pid;
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

/** The environment a child gets in these cases: a temp `home`, no named pointer. */
function spawnChildEnv(home, dataDir) {
  return slotChildEnv(home, { TASKD_DATA_DIR: dataDir, TASKD_PORT: "0", TASKD_HOST: "127.0.0.1" });
}

describe("cli/pointer-fallback — a live but unhealthy board keeps its address", () => {
  it("does not hand the machine-wide slot to the daemon it spawns", async () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const otherDir = makeTempDir();
    const slot = slotPath(home);
    const unhealthy = await startUnhealthyBoard();
    let started = null;
    try {
      // The slot names another board that is *up* — a live pid, a listening port
      // — whose `/health` does not report `ok`. The write side would refuse to
      // displace it; the autostart path must not do it by proxy either.
      writePointerAt(slot, {
        url: unhealthy.url,
        host: "127.0.0.1",
        port: unhealthy.port,
        dataDir: otherDir,
        pid: unhealthy.pid,
      });
      const slotBefore = readFileSync(slot, "utf8");

      // Beside our own data directory, a fossil: the preferred pointer does not
      // answer, the slot's board does not answer *health* — autostart is reached.
      const dead = await closedPortUrl();
      writePointerAt(join(dataDir, "runtime.json"), {
        url: dead,
        host: "127.0.0.1",
        port: Number(new URL(dead).port),
        dataDir,
        pid: 999_001,
      });

      started = await ensureBoard({
        env: spawnChildEnv(home, dataDir),
        // In-process, `homedir()` is the developer's — the slot below must be this
        // test's own. The child sees `HOME` (in `env`), so both agree on the path.
        home,
        waitMs: 20_000,
      });

      assert.equal(started.autostarted, true, "the fossil is not believed, so a board was started");
      assert.equal(
        readFileSync(slot, "utf8"),
        slotBefore,
        "the live board keeps its address, byte for byte",
      );
      const own = readJsonFile(join(dataDir, "runtime.json"));
      assert.equal(own.pid, started.pointer.pid, "the daemon is addressed beside its own data directory");
      assert.equal(await probeHealth(started.url), true, "…and the board we were given answers");
    } finally {
      await stopSpawned(started);
      await unhealthy.close();
    }
  });

  it("finds a daemon it started when the slot is nobody's", async () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const slot = slotPath(home);
    let started = null;
    try {
      // Nothing in the slot and nothing beside the data directory: the ordinary
      // production start, and the one the fix must not break. The child resolves
      // its own pointer from the environment, so it takes the machine-wide slot.
      started = await ensureBoard({ env: spawnChildEnv(home, dataDir), home, waitMs: 20_000 });
      assert.equal(started.autostarted, true);
      assert.equal(await probeHealth(started.url), true);
      assert.equal(started.pointer.path, slot, "the board is addressed at the machine-wide slot");
      assert.equal(readJsonFile(slot).pid, started.pointer.pid);
    } finally {
      await stopSpawned(started);
    }
  });
});
