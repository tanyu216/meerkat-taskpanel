#!/usr/bin/env node
/**
 * A fault-injection fixture: an entry point whose `main()` throws.
 *
 * The real entries share one shape — `main(...).then((code) => process.exit(code))`
 * with no `.catch` — so an escaped rejection is an unlogged death. This fixture
 * is that shape, plus the one thing a fixed entry does before returning: it
 * installs the crash guard. In the P0 baseline the guard module does not exist
 * yet, so the fixture behaves exactly like today's entries: the rejection
 * escapes, the process exits 1, nothing is recorded and nothing is cleaned up.
 *
 * The test asserts the contract the guard exists to keep:
 *   * a `process_crash` record reaches the log,
 *   * `onFatal` cleanup runs (the lock is released),
 *   * the process exits 1.
 *
 * Environment:
 *   RESILIENCE_CRASH_LOG  JSONL file the guard's `log(record)` appends to.
 *   RESILIENCE_CLEANUP    file `onFatal` appends "cleanup\n" to.
 *   RESILIENCE_LOCK       lock file `onFatal` must remove.
 */

import { appendFileSync, rmSync } from "node:fs";

// A fixture, not a test: inert unless the suite asked it to run. This keeps a
// broad `node --test` file walk from executing a process that is meant to die.
if (process.env.RESILIENCE_CRASH_LOG === undefined) process.exit(0);

const record = (entry) => {
  const file = process.env.RESILIENCE_CRASH_LOG;
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

const onFatal = () => {
  const marker = process.env.RESILIENCE_CLEANUP;
  if (marker !== undefined && marker !== "") appendFileSync(marker, "cleanup\n");
  const lock = process.env.RESILIENCE_LOCK;
  if (lock !== undefined && lock !== "") rmSync(lock, { force: true });
};

async function loadGuard() {
  try {
    return await import("../../../src/foundation/crash-guard.mjs");
  } catch {
    // P0: the module does not exist yet; that absence is the defect under test.
    return null;
  }
}

const guard = await loadGuard();
if (guard !== null && typeof guard.installCrashGuard === "function") {
  guard.installCrashGuard({
    name: "resilience-fixture",
    log: record,
    onFatal,
    exit: (code) => process.exit(code),
  });
}

async function main() {
  throw new Error("entry point blew up");
}

// The shipped entries' shape, byte for byte: no `.catch`.
main().then((code) => process.exit(code));
