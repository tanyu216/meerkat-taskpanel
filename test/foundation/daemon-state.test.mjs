/**
 * The host-state primitives both the event hub and the loop keep their state with.
 *
 * These are small but load-bearing: an atomic publish is what makes a half-written
 * `sessions.state.json` impossible, `O_EXCL` is the one-writer rule, and the stale
 * check is how a crashed owner stops wedging the next start.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  LOCK_STALE_MS,
  acquireLock,
  ensurePrivateDir,
  lockIsStale,
  pidAlive,
  pidMatches,
  processStartToken,
  readJsonFile,
  releaseLock,
  removeFile,
  writeJsonFile,
} from "../../src/foundation/daemon-state.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-daemon-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("daemon-state — files", () => {
  it("creates an owner-only directory", () => {
    const dir = join(tempDir(), "nested", "private");
    ensurePrivateDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("writes JSON atomically and reads it back", () => {
    const file = join(tempDir(), "state.json");
    writeJsonFile(file, { pid: 7, list: [1, 2] });
    assert.deepEqual(readJsonFile(file), { pid: 7, list: [1, 2] });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      readJsonFile(join(tempDir(), "missing.json")),
      null,
      "a missing file is null, never a throw",
    );
    writeFileSync(file, "{ not json");
    assert.equal(readJsonFile(file), null, "a corrupt file is null too");
  });

  it("removes a file idempotently", () => {
    const file = join(tempDir(), "gone");
    writeFileSync(file, "x");
    removeFile(file);
    removeFile(file);
    assert.equal(existsSync(file), false);
  });
});

describe("daemon-state — pids and locks", () => {
  it("knows this process is alive and a dead pid is not", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(2147483646), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive("12"), false);
  });

  it("grants the lock once and reports a second owner", () => {
    const file = join(tempDir(), "writer.lock");
    assert.deepEqual(acquireLock(file), { ok: true });
    assert.deepEqual(acquireLock(file), { ok: false });
    const held = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(held.pid, process.pid);
    assert.equal(typeof held.startedAt, "number");

    releaseLock(file);
    assert.equal(existsSync(file), false);
    assert.deepEqual(acquireLock(file), { ok: true }, "released locks can be re-acquired");
  });

  it("calls a dead owner, an old lock and a missing lock stale", () => {
    const file = join(tempDir(), "stale.lock");
    writeJsonFile(file, { pid: 2147483646, startedAt: Date.now() });
    assert.equal(lockIsStale(file), true, "the owner is gone");

    writeJsonFile(file, { pid: process.pid, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    assert.equal(lockIsStale(file), true, "the start outlived the bound");

    writeJsonFile(file, { pid: process.pid, startedAt: Date.now() });
    assert.equal(lockIsStale(file), false);

    // A live pid is not proof on its own: the OS can reuse a pid for a
    // different process. When the stored start token differs, the owner is dead.
    if (processStartToken(process.pid) !== null) {
      writeJsonFile(file, { pid: process.pid, pidStart: "another-process", startedAt: Date.now() });
      assert.equal(lockIsStale(file), true, "the pid was reused by another process");
    }

    assert.equal(lockIsStale(join(tempDir(), "absent.lock")), true);
  });

  it("writes the owner's start token into a new lock", () => {
    const file = join(tempDir(), "writer.lock");
    assert.equal(acquireLock(file).ok, true);
    const held = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(Object.hasOwn(held, "pidStart"), true, "the record carries the token field");
    releaseLock(file);
  });
});

describe("daemon-state — durable publish", () => {
  it("fsyncs the temp file before the rename publishes it", () => {
    const file = join(tempDir(), "state.json");
    const calls = [];
    writeJsonFile(file, { round: 1 }, {
      fsyncSync: () => calls.push("fsync"),
      renameSync: (from, to) => {
        calls.push("rename");
        renameSync(from, to);
      },
    });
    assert.deepEqual(calls, ["fsync", "rename"], "data reaches the disk before it is visible");
    assert.deepEqual(readJsonFile(file), { round: 1 });
  });

  it("keeps the previous value readable when the publish fails", () => {
    const file = join(tempDir(), "state.json");
    writeJsonFile(file, { round: 1 });
    assert.throws(
      () =>
        writeJsonFile(file, { round: 2 }, {
          renameSync: () => {
            throw Object.assign(new Error("injected publish failure"), { code: "EIO" });
          },
        }),
      /injected publish failure/,
    );
    assert.deepEqual(readJsonFile(file), { round: 1 }, "the published value was never replaced");
  });
});

describe("daemon-state — process start tokens", () => {
  it("reads a stable token for a live pid and nothing for a dead one", () => {
    const token = processStartToken(process.pid);
    if (token === null) {
      // A platform without /proc or ps degrades to pid-only liveness; there is
      // no token behaviour to assert.
      return;
    }
    assert.equal(typeof token, "string");
    assert.notEqual(token, "");
    assert.equal(processStartToken(process.pid), token, "a live process keeps its token");
    assert.equal(processStartToken(2147483646), null, "a dead pid has no token");
    assert.equal(processStartToken(0), null);
  });

  it("treats a live pid with a mismatched token as dead", () => {
    const token = processStartToken(process.pid);
    if (token === null) return;
    assert.equal(pidMatches(process.pid, token), true);
    assert.equal(pidMatches(process.pid, `${token}-other`), false, "the pid was reused");
    assert.equal(pidMatches(process.pid, null), true, "no stored token degrades to pid-only");
    assert.equal(pidMatches(process.pid, ""), true);
    assert.equal(pidMatches(2147483646, token), false, "a dead pid stays dead");
  });
});
