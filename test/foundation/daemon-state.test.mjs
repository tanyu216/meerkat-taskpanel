/**
 * The host-state primitives both the event hub and the loop keep their state with.
 *
 * These are small but load-bearing: an atomic publish is what makes a half-written
 * `sessions.state.json` impossible, `O_EXCL` is the one-writer rule, and the stale
 * check is how a crashed owner stops wedging the next start.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  LOCK_STALE_MS,
  acquireLock,
  ensurePrivateDir,
  lockIsStale,
  pidAlive,
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

    assert.equal(lockIsStale(join(tempDir(), "absent.lock")), true);
  });
});
