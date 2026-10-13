/**
 * R1 — the single-writer guard (card T-20261012-234647).
 *
 * The concurrency audit found the process model unguarded in two places, and
 * both are reproduced here as the *opposite* of what the audit saw:
 *
 *   1. **No lock.** Two `taskd` processes could own one data directory. Now the
 *      second is refused with `BOARD_ALREADY_RUNNING`, a stale lock (a
 *      `SIGKILL`ed daemon) is recovered rather than obeyed, and a loser can
 *      never remove the winner's lock.
 *   2. **The pointer was deleted unconditionally on exit.** The audit's
 *      reproduction was "a non-owner instance exits and deletes the live
 *      instance's pointer" — the live board then went unreachable and the next
 *      `taskctl` started a second daemon. Now removal is ownership-checked by
 *      `pid`, exactly the rule `waitForPointer` already applies when reading.
 *
 * Everything here is a plain function call: the lock and the pointer are files,
 * so no daemon has to be started to prove the rule — except the last case, which
 * starts a real one and checks that a second, competing start is refused *and*
 * leaves the live board's pointer intact.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import {
  acquireWriterLock,
  isProcessAlive,
  removeRuntimePointer,
  resolveRuntimePointerPath,
  writeRuntimePointer,
} from "../../src/core/index.mjs";
import { WRITER_LOCK_FILENAME } from "../../src/shared/constants.mjs";

/** The daemon *program* — what autostart spawns. */
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/server/main.mjs");

/** Poll a predicate, so the two-process case is not a fixed sleep. */
async function until(predicate, { timeoutMs = 15_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-guard-"));
  tempDirs.push(dir);
  return dir;
};

/** A pid that is certainly not running: this process's own pid, minus the dead ones. */
function deadPid() {
  // `0` and negatives are rejected by `isProcessAlive` before the syscall, and
  // 2^31-ish is out of range on every platform we ship to — both are "no
  // process holds this lock", which is all this test needs.
  return 2147483646;
}

describe("concurrency/writer-guard — one writer per data directory", () => {
  it("gives the lock to exactly one caller and refuses the next by name", () => {
    const dir = tempDir();
    const first = acquireWriterLock(dir, { pid: process.pid, now: "2026-10-12T00:00:00.000Z" });
    assert.equal(first.path, join(dir, WRITER_LOCK_FILENAME));
    assert.equal(existsSync(first.path), true, "the lock is a file, not a convention");
    assert.equal(JSON.parse(readFileSync(first.path, "utf8")).pid, process.pid);

    // The holder is this very process, so it is demonstrably alive: a second
    // start must be refused, and the refusal must name the holder.
    assert.throws(
      () => acquireWriterLock(dir, { pid: deadPid() }),
      (err) => {
        assert.equal(err.code, "BOARD_ALREADY_RUNNING");
        assert.equal(err.http, 409);
        assert.equal(err.details.pid, process.pid, "the message names who to stop");
        return true;
      },
      "one data directory cannot have two live owners",
    );

    assert.equal(first.release(), true);
    assert.equal(existsSync(first.path), false, "a released lock is gone, not left for a human");
    // …and the directory is usable again.
    const second = acquireWriterLock(dir, { pid: process.pid });
    assert.equal(second.release(), true);
  });

  it("recovers a fossil lock — a SIGKILLed daemon must not need a human", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, WRITER_LOCK_FILENAME),
      `${JSON.stringify({ pid: deadPid(), version: "0.0.0", startedAt: "2026-10-11T00:00:00.000Z" })}\n`,
    );
    const logs = [];
    const lock = acquireWriterLock(dir, { pid: process.pid, logger: (event) => logs.push(event) });
    assert.equal(lock.pid, process.pid, "a lock whose owner is gone is taken over");
    assert.deepEqual(
      logs.filter((entry) => entry.event === "writer_lock_stale").length,
      1,
      "the takeover is logged — it is a recovery, not a silent overwrite",
    );
    assert.equal(lock.release(), true);
    assert.equal(existsSync(lock.path), false);
  });

  it("never removes a lock that names somebody else", () => {
    const dir = tempDir();
    const lock = acquireWriterLock(dir, { pid: process.pid });
    // Somebody else's name is on the file now (a third instance that recovered
    // this lock as stale). Releasing must be a no-op, not a favour to them.
    writeFileSync(lock.path, `${JSON.stringify({ pid: deadPid() })}\n`);
    assert.equal(lock.release(), false, "the release is declined");
    assert.equal(existsSync(lock.path), true, "the other owner's lock survives");
    assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, deadPid());
  });

  it("treats a live pid as alive and a dead one as recoverable", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(deadPid()), false);
    assert.equal(isProcessAlive(0), false, "pid 0 means 'every process in the group', not one");
    assert.equal(isProcessAlive("not a pid"), false);
  });
});

describe("concurrency/writer-guard — the pointer belongs to its owner", () => {
  it("removes its own pointer", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    writeRuntimePointer({ url: "http://127.0.0.1:1", pid: process.pid }, { path });
    assert.equal(removeRuntimePointer({ path, pid: process.pid }), true);
    assert.equal(existsSync(path), false);
  });

  it("refuses to delete the pointer a live instance is using", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    // The *live* instance's pointer, written by another pid.
    writeRuntimePointer({ url: "http://127.0.0.1:9527", pid: 999_001 }, { path });

    // The audit's reproduction: a non-owner instance exits. It must not unplug
    // the board it never owned.
    assert.equal(removeRuntimePointer({ path, pid: deadPid() }), false, "the removal is declined");
    assert.equal(existsSync(path), true, "the live instance's address survives");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 999_001);

    // And the owner still can.
    assert.equal(removeRuntimePointer({ path, pid: 999_001 }), true);
    assert.equal(existsSync(path), false);
  });

  it("removes a pointer that names nobody (there is nobody to protect)", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    // The shape the existing shutdown tests write: a bare address, no pid.
    writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:1" }));
    assert.equal(removeRuntimePointer({ path, pid: process.pid }), true);
    assert.equal(existsSync(path), false);
  });

  it("stays idempotent", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    assert.equal(removeRuntimePointer({ path, pid: process.pid }), true, "nothing there is fine");
    assert.equal(removeRuntimePointer({ path }), true);
  });
});

describe("concurrency/writer-guard — two *boards*, one pointer slot", () => {
  /**
   * The comparison the audit's incident needed and never had.
   *
   * `pid` alone does not identify a board: a board is *(pid, dataDir)*. The
   * machine-wide pointer is one file, so a board whose data dir is not the
   * incumbent's — a dev run, a stray `--data-dir <tmp>` — could take the slot
   * on start and empty it on exit, and the canonical board (still running,
   * still healthy) went unreachable. `home` is a temp dir, so the "machine-wide"
   * slot is this test's alone and the developer's real one is never in play.
   */
  const slotOptions = (home) => ({ env: {}, home });

  it("does not displace the live board that holds the shared slot", () => {
    const home = tempDir();
    const canonical = join(home, "canonical-board");
    const stray = join(home, "stray-board");
    const slot = resolveRuntimePointerPath(slotOptions(home));

    // The canonical board (this process standing in for the live daemon) is up.
    const mine = writeRuntimePointer(
      { url: "http://127.0.0.1:9527", dataDir: canonical, pid: process.pid },
      slotOptions(home),
    );
    assert.equal(mine.path, slot, "the first board holds the machine-wide slot");
    const before = readFileSync(slot, "utf8");

    // A board with another data dir starts. It must not take the slot: an
    // overwrite here is the "抢占" half of the incident.
    const other = writeRuntimePointer(
      { url: "http://127.0.0.1:9531", dataDir: stray, pid: deadPid() },
      slotOptions(home),
    );
    assert.notEqual(other.path, slot, "the newcomer is addressed elsewhere");
    assert.equal(readFileSync(slot, "utf8"), before, "the canonical address is byte-identical");
    assert.equal(JSON.parse(before).dataDir, canonical);

    // …and its cleanup cannot unplug the board it never owned ("摘除"), even
    // though it is removing a pointer that names its own pid.
    assert.equal(removeRuntimePointer({ path: other.path, pid: deadPid(), dataDir: stray }), true);
    assert.equal(existsSync(slot), true, "the canonical board is still addressable");
    assert.equal(readFileSync(slot, "utf8"), before, "…and its address was not emptied");
    assert.equal(removeRuntimePointer({ path: other.path, pid: deadPid(), dataDir: stray }), true, "idempotent");

    // A board that *is* over the canonical data dir may take over a slot whose
    // owner is gone — the same crash-recovery rule the write lock applies.
    writeRuntimePointer({ url: "http://127.0.0.1:1", dataDir: canonical, pid: deadPid() }, slotOptions(home));
    const restarted = writeRuntimePointer(
      { url: "http://127.0.0.1:9527", dataDir: canonical, pid: process.pid },
      slotOptions(home),
    );
    assert.equal(restarted.path, slot, "a stale owner of the same board is recovered, not obeyed");
  });

  it("declines to remove a pointer that names another board's data dir", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    writeRuntimePointer(
      { url: "http://127.0.0.1:9527", dataDir: join(dir, "board-a"), pid: process.pid },
      { path },
    );
    const before = readFileSync(path, "utf8");

    // The same pid — with `pid` as the only rule, this removal used to succeed
    // and a live board lost its address. The ownership check has to name the
    // *data dir* too.
    assert.equal(
      removeRuntimePointer({ path, pid: process.pid, dataDir: join(dir, "board-b") }),
      false,
      "another board's pointer is not ours to delete",
    );
    assert.equal(existsSync(path), true, "the other board's address survives");
    assert.equal(readFileSync(path, "utf8"), before, "…and is not emptied (the 15:37 symptom)");

    assert.equal(removeRuntimePointer({ path, pid: process.pid, dataDir: join(dir, "board-a") }), true);
    assert.equal(existsSync(path), false);
  });
});

describe("concurrency/writer-guard — two real daemons", () => {
  it("refuses the second start and leaves the live board reachable", async () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    const env = {
      ...process.env,
      TASKD_DATA_DIR: dir,
      TASKD_RUNTIME_POINTER: pointerPath,
      TASKD_PORT: "0",
      TASKD_HOST: "127.0.0.1",
    };
    delete env.TASKD_DB;
    delete env.TASKD_NO_AUTOSTART;

    const first = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "ignore", "pipe"] });
    assert.equal(
      await until(() => existsSync(pointerPath) && typeof readJson(pointerPath)?.url === "string"),
      true,
      "the first daemon wrote its pointer",
    );
    const live = readJson(pointerPath);

    try {
      // The audit's reproduction, run for real: a second instance on the same
      // data directory. It must be refused rather than become a second writer.
      const second = spawnSync(process.execPath, [SERVER], { env, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(second.status, 0, "the second daemon did not start");
      assert.match(second.stderr, /BOARD_ALREADY_RUNNING|already owns/, "…and says why");

      // The live instance is untouched: its pointer is still there, still names
      // it, and still answers. Previously a stranger's exit deleted this file.
      assert.equal(existsSync(pointerPath), true, "the live pointer survives the contender");
      assert.deepEqual(readJson(pointerPath), live);
      assert.equal((await fetch(`${live.url}/health`)).status, 200, "the live board is still reachable");
    } finally {
      first.kill("SIGTERM");
      await once(first, "exit");
    }

    // And the owner's own exit still cleans up after itself.
    assert.equal(await until(() => !existsSync(pointerPath)), true, "SIGTERM removes its own pointer");
    assert.equal(existsSync(join(dir, WRITER_LOCK_FILENAME)), false, "…and releases its own lock");
  });
});

/** Read a JSON file, or `null` when it is missing or malformed. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
