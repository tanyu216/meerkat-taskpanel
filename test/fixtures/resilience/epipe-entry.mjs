#!/usr/bin/env node
/**
 * A fault-injection fixture: writes to stdout after the reader closes.
 *
 * A headless agent turn whose parent stops reading is ordinary (`| head`), and
 * today the next `process.stdout.write` raises an unhandled EPIPE event that
 * kills the process. A fixed entry installs the crash guard first, which owns
 * the stdout/stderr EPIPE handler; this fixture then survives and exits 0.
 *
 * Environment:
 *   RESILIENCE_DONE  file the fixture appends "done\n" to after its last write.
 */

import { appendFileSync } from "node:fs";

// A fixture, not a test: inert unless the suite asked it to run.
if (process.env.RESILIENCE_DONE === undefined) process.exit(0);

const noopLog = () => {};

async function loadGuard() {
  try {
    return await import("../../../src/foundation/crash-guard.mjs");
  } catch {
    return null;
  }
}

const guard = await loadGuard();
if (guard !== null && typeof guard.installCrashGuard === "function") {
  guard.installCrashGuard({
    name: "resilience-epipe-fixture",
    log: noopLog,
    onFatal: () => {},
    exit: (code) => process.exit(code),
  });
}

const done = process.env.RESILIENCE_DONE;
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  process.stdout.write(`tick ${ticks}\n`);
  if (ticks >= 20) {
    clearInterval(timer);
    if (done !== undefined && done !== "") appendFileSync(done, "done\n");
    process.exit(0);
  }
}, 25);
