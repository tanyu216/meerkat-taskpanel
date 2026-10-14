/**
 * R1 re-run — "one writer per data directory", across **real processes**.
 *
 * The repo's own `writer-guard` suite covers the lock and the pointer as plain
 * function calls (10/11 green here). Its last case spawns two real `taskd`
 * daemons, which this sandbox cannot do (`listen` is EPERM — see the report's
 * environment note), so the multi-instance rule is re-proved here with two real
 * *processes* driving the production `acquireWriterLock` /
 * `removeRuntimePointer` instead.
 *
 * Four claims:
 *   1. a second live process is refused by name — `BOARD_ALREADY_RUNNING`;
 *   2. a non-owner instance exiting does **not** delete the live pointer;
 *   3. a `SIGKILL`ed owner (a fossil lock) is recovered without a human;
 *   4. the owner's own exit releases its own lock.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CORE = `file://${REPO}/src/core/index.mjs`;
const { writerLockPath, readRuntimePointer, writeRuntimePointer, removeRuntimePointer } = await import(CORE);

const dir = mkdtempSync(join(tmpdir(), "r1-probe-"));
const pointerPath = join(dir, "runtime.json");
const lockPath = writerLockPath(dir);
const children = new Set();
const log = [];

function spawnNode(source, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, PROBE_CORE: CORE, PROBE_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    /** Wait until the child has printed `marker`, or fail. */
    async until(marker, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (out.includes(marker)) return true;
        if (child.exitCode !== null) throw new Error(`child exited early (${child.exitCode}): ${err}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`child never printed ${marker}: out=${out} err=${err}`);
    },
  };
}

/** A real, live lock holder — the shape of a running `taskd`. */
const HOLDER = `
const { acquireWriterLock } = await import(process.env.PROBE_CORE);
const lock = acquireWriterLock(process.env.PROBE_DIR, {
  logger: (event) => console.error("LOG " + JSON.stringify(event)),
});
process.stdout.write("held " + process.pid + "\\n");
process.on("SIGTERM", () => { lock.release(); process.exit(0); });
setInterval(() => {}, 1000);
`;

/** The second instance: it must be refused *by name*, not become a writer. */
const CONTENDER = `
const { acquireWriterLock } = await import(process.env.PROBE_CORE);
try {
  acquireWriterLock(process.env.PROBE_DIR);
  console.log("ACQUIRED");
  process.exit(0);
} catch (err) {
  console.error("REFUSED " + err.code + " http=" + err.http);
  process.exit(1);
}
`;

/** A non-owner instance that starts and exits while somebody else owns the slot. */
const NON_OWNER_EXIT = `
const { removeRuntimePointer } = await import(process.env.PROBE_CORE);
const removed = removeRuntimePointer({ path: process.env.PROBE_POINTER, pid: process.pid });
console.log("removed=" + removed);
`;

try {
  // (1) + (4): one live holder, one contender, then the holder leaves cleanly.
  const holder = spawnNode(HOLDER);
  await holder.until("held");
  assert.equal(existsSync(lockPath), true, "the winner wrote the lock file");
  log.push({ step: "holder-acquired", lockPath, pid: Number(holder.stdout().match(/held (\d+)/)[1]) });

  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", CONTENDER], {
    env: { ...process.env, PROBE_CORE: CORE, PROBE_DIR: dir },
    encoding: "utf8",
    timeout: 20_000,
  });
  log.push({ step: "contender", status: contender.status, stderr: contender.stderr.trim() });
  assert.notEqual(contender.status, 0, "the second live process is refused");
  assert.match(contender.stderr, /BOARD_ALREADY_RUNNING/, "…and is refused by name");
  assert.match(contender.stderr, /http=409/, "…with the 409 the card names");

  // (2) the live board's pointer, written by its owner, surviving an intruder's exit.
  const livePid = Number(holder.stdout().match(/held (\d+)/)[1]);
  writeRuntimePointer({ url: "http://127.0.0.1:9527", pid: livePid, dataDir: dir }, { path: pointerPath });
  const before = readFileSync(pointerPath, "utf8");

  const intruder = spawnSync(process.execPath, ["--input-type=module", "-e", NON_OWNER_EXIT], {
    env: { ...process.env, PROBE_CORE: CORE, PROBE_POINTER: pointerPath },
    encoding: "utf8",
    timeout: 20_000,
  });
  log.push({ step: "non-owner-exit", stdout: intruder.stdout.trim(), status: intruder.status });
  assert.equal(intruder.stdout.trim(), "removed=false", "a non-owner exit declines to delete");
  assert.equal(existsSync(pointerPath), true, "the live pointer is still there");
  assert.equal(readFileSync(pointerPath, "utf8"), before, "…and byte-identical");
  assert.equal(readRuntimePointer({ path: pointerPath }).pid, livePid, "…still naming the live instance");

  // The owner may still clean up after itself.
  assert.equal(removeRuntimePointer({ path: pointerPath, pid: livePid }), true);
  assert.equal(existsSync(pointerPath), false, "the owner's own exit removes its pointer");

  holder.child.kill("SIGTERM");
  await new Promise((resolve) => holder.child.once("exit", resolve));
  assert.equal(existsSync(lockPath), false, "the owner's exit releases its own lock");
  log.push({ step: "owner-exit", lockReleased: true });

  // (3) a SIGKILLed owner leaves a fossil; the next instance must not need a human.
  const doomed = spawnNode(HOLDER);
  await doomed.until("held");
  doomed.child.kill("SIGKILL");
  await new Promise((resolve) => doomed.child.once("exit", resolve));
  assert.equal(existsSync(lockPath), true, "the SIGKILLed owner left the lock behind");
  const fossil = JSON.parse(readFileSync(lockPath, "utf8"));
  log.push({ step: "fossil", holderPid: fossil.pid });

  const successor = spawnNode(`
const { acquireWriterLock } = await import(process.env.PROBE_CORE);
const lock = acquireWriterLock(process.env.PROBE_DIR, {
  logger: (event) => console.error("LOG " + JSON.stringify(event)),
});
process.stdout.write("held " + process.pid + "\\n");
process.on("SIGTERM", () => { lock.release(); process.exit(0); });
setInterval(() => {}, 1000);
`);
  await successor.until("held");
  assert.match(successor.stderr(), /writer_lock_stale/, "the fossil is logged, not obeyed");
  assert.notEqual(Number(successor.stdout().match(/held (\d+)/)[1]), fossil.pid);
  log.push({ step: "fossil-recovered", newPid: Number(successor.stdout().match(/held (\d+)/)[1]) });
  successor.child.kill("SIGTERM");
  await new Promise((resolve) => successor.child.once("exit", resolve));

  console.log(JSON.stringify(log, null, 2));
  console.log("R1 PROBE PASS");
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
