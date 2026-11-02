/**
 * The loop's one advisory interprocess lock.
 *
 * The lock exists because two processes write the same state files: the tick
 * (`loop run --continue-once`) enqueues while the pool (`loop session`) claims
 * and requeues. A read-modify-write without a lock loses rows. The contract:
 *
 *   * `wx` creation is the atomic point — two processes cannot both create;
 *   * a holder whose pid is gone is reclaimed, a live holder is not;
 *   * an unreadable lock is reclaimed only after a short grace period;
 *   * release is owner-checked, so a slow ex-holder cannot delete the next
 *     holder's lock;
 *   * re-entry in the same process nests instead of deadlocking.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  acquireFileLock,
  isLockHeld,
  readLock,
  releaseFileLock,
} from "../../src/foundation/file-lock.mjs";

const dirs = [];
function lockPath() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-file-lock-"));
  dirs.push(dir);
  return join(dir, "state.lock");
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("acquires a missing lock and writes the owner", () => {
  const path = lockPath();
  const lock = acquireFileLock(path);
  assert.equal(lock.acquired, true);
  assert.equal(lock.reentrant, false);
  const holder = readLock(path);
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.token, lock.token);
  releaseFileLock(path, lock.token);
  assert.equal(isLockHeld(path), false);
});

test("refuses a lock held by a live process", () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ version: 1, pid: process.pid, token: "other" }));
  const lock = acquireFileLock(path, { retries: 0 });
  assert.equal(lock.acquired, false);
  assert.equal(lock.reason, "held");
  assert.equal(lock.holder.token, "other");
  // The refused caller must not have removed the holder's file.
  assert.equal(readLock(path).token, "other");
});

test("takes over a lock whose pid is gone", () => {
  const path = lockPath();
  writeFileSync(
    path,
    JSON.stringify({ version: 1, pid: 4242, token: "dead-holder" }),
  );
  const lock = acquireFileLock(path, { isAlive: () => false, retries: 0 });
  assert.equal(lock.acquired, true);
  assert.equal(readLock(path).token, lock.token);
  releaseFileLock(path, lock.token);
});

test("takes over an unreadable lock only after the grace period", () => {
  const path = lockPath();
  writeFileSync(path, "not json");
  const fresh = acquireFileLock(path, { retries: 0 });
  assert.equal(fresh.acquired, false, "a fresh unreadable lock is a starting holder");

  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  const stale = acquireFileLock(path, { retries: 0 });
  assert.equal(stale.acquired, true, "an old unreadable lock is abandoned");
  releaseFileLock(path, stale.token);
});

test("release is owner-checked: a foreign token leaves the file alone", () => {
  const path = lockPath();
  const lock = acquireFileLock(path);
  const result = releaseFileLock(path, "not-the-owner");
  assert.equal(result.released, false);
  assert.equal(isLockHeld(path), true, "a slow ex-holder cannot delete the new lock");
  assert.equal(readFileSync(path, "utf8").includes(lock.token), true);
  releaseFileLock(path, lock.token);
});

test("re-entry in one process nests instead of deadlocking", () => {
  const path = lockPath();
  const first = acquireFileLock(path);
  const second = acquireFileLock(path);
  assert.equal(second.acquired, true);
  assert.equal(second.reentrant, true);
  assert.equal(second.token, first.token);

  releaseFileLock(path, second.token);
  assert.equal(isLockHeld(path), true, "one release lifts one nesting level");
  releaseFileLock(path, first.token);
  assert.equal(isLockHeld(path), false);
});
