/**
 * The process-level crash boundary (S1, epic TP-0025).
 *
 * Two levels, because both are part of the contract:
 *
 *   * the unit cases drive a fake process-like emitter, so the latch, the bound
 *     and the EPIPE rule are observable without killing the test runner;
 *   * two **real child processes** prove the same behaviour at the boundary the
 *     defect was found: an escaped rejection leaves one `process_crash` record
 *     and exits 1, and a closed stdout reader does not end the entry.
 *
 * Run with: node --test test/foundation/crash-guard.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import {
  CRASH_FATAL_TIMEOUT_MS,
  installCrashGuard,
  installEntryCrashGuard,
} from "../../src/foundation/crash-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD_URL = pathToFileURL(join(ROOT, "src", "foundation", "crash-guard.mjs")).href;

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-crash-guard-"));
  tempDirs.push(dir);
  return dir;
}

/** An installable target that is not the test runner's own process. */
function harness(overrides = {}) {
  const target = new EventEmitter();
  target.pid = 4242;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const records = [];
  const exits = [];
  const fatal = [];
  const guard = installCrashGuard({
    name: "test-entry",
    log: (record) => records.push(record),
    onFatal: () => fatal.push(Date.now()),
    exit: (code) => exits.push(code),
    target,
    streams: [stdout, stderr],
    ...overrides,
  });
  return { target, stdout, stderr, records, exits, fatal, guard };
}

/** One microtask turn is enough for the synchronous `onFatal` path to finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("crash-guard — one crash, one record, exit 1", () => {
  it("records an uncaught exception once and exits 1", async () => {
    const h = harness();
    const error = Object.assign(new Error("entry point blew up"), { code: "EBOOM" });
    h.target.emit("uncaughtException", error, "uncaughtException");
    await settled();

    assert.equal(h.records.length, 1, "exactly one process_crash record");
    const [record] = h.records;
    assert.equal(record.event, "process_crash");
    assert.equal(record.level, "error");
    assert.equal(record.reason, "uncaughtException");
    assert.equal(record.entry, "test-entry");
    assert.equal(record.error, error);
    assert.equal(h.fatal.length, 1, "onFatal ran before the exit");
    assert.deepEqual(h.exits, [1]);
  });

  it("records an unhandled rejection and exits 1", async () => {
    const h = harness();
    h.target.emit("unhandledRejection", new Error("promise blew up"));
    await settled();

    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].reason, "unhandledRejection");
    assert.deepEqual(h.exits, [1]);
  });

  it("still records once when both handlers fire for the same incident", async () => {
    const h = harness();
    // Node's `--unhandled-rejections=strict` shape: the rejection arrives twice.
    h.target.emit("unhandledRejection", new Error("boom"));
    h.target.emit("uncaughtException", new Error("boom"), "unhandledRejection");
    await settled();

    assert.equal(h.records.length, 1, "the latch is what makes it exactly one");
    assert.deepEqual(h.exits, [1], "one exit, not two");
  });

  it("a broken log sink does not replace the crash", async () => {
    const h = harness({
      log: () => {
        throw new Error("sink is broken");
      },
    });
    h.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.deepEqual(h.exits, [1]);
  });
});

describe("crash-guard — the cleanup is bounded at 1500 ms", () => {
  it("uses 1500 ms by default", () => {
    assert.equal(CRASH_FATAL_TIMEOUT_MS, 1500);
  });

  it("exits even when onFatal never settles", async () => {
    const h = harness({ onFatal: () => new Promise(() => {}), timeoutMs: 25 });
    const started = Date.now();
    h.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(h.exits, [1], "the bound, not the cleanup, decides the exit");
    assert.ok(Date.now() - started < 1_000);
  });

  it("exits 1 when onFatal throws or rejects", async () => {
    const thrown = harness({ onFatal: () => { throw new Error("cleanup blew up"); } });
    thrown.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.deepEqual(thrown.exits, [1]);

    const rejected = harness({ onFatal: async () => { throw new Error("cleanup rejected"); } });
    rejected.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.deepEqual(rejected.exits, [1]);
  });

  it("exits at once when there is no onFatal to wait for", async () => {
    const h = harness({ onFatal: undefined, timeoutMs: 60_000 });
    h.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.deepEqual(h.exits, [1], "no cleanup means no wait");
  });
});

describe("crash-guard — EPIPE is not fatal, anything else still throws", () => {
  it("swallows EPIPE on stdout and stderr", async () => {
    const h = harness();
    const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    assert.doesNotThrow(() => h.stdout.emit("error", epipe()));
    assert.doesNotThrow(() => h.stderr.emit("error", epipe()));
    await settled();
    assert.deepEqual(h.records, [], "a closed reader is not a crash");
    assert.deepEqual(h.exits, [], "and it is not an exit either");
  });

  it("re-throws any other stream error so it takes the crash path", () => {
    const h = harness();
    const other = Object.assign(new Error("bad file descriptor"), { code: "EBADF" });
    assert.throws(() => h.stdout.emit("error", other), /bad file descriptor/);
    assert.deepEqual(h.exits, [], "throwing it is the caller's uncaught path, not a swallowed exit");
  });
});

describe("crash-guard — installation is idempotent and removable", () => {
  it("does not install twice on the same target", async () => {
    const h = harness();
    const second = installCrashGuard({
      log: () => {},
      exit: () => {},
      target: h.target,
      streams: [h.stdout, h.stderr],
    });
    h.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.equal(h.records.length, 1, "the second install changed nothing");
    second.uninstall();
    h.guard.uninstall();
  });

  it("uninstall removes every listener it added", async () => {
    const h = harness();
    h.guard.uninstall();
    // An 'error' event with no listener throws by EventEmitter's own rule.
    assert.throws(() => h.stdout.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
    h.target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await settled();
    assert.deepEqual(h.records, [], "nothing is recorded after uninstall");
  });
});

describe("crash-guard — the entry helper", () => {
  it("installs the boundary on the process with the tree's logger, and removes it", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    // Synchronous install/uninstall: the window in which the real process has
    // the handlers is one stack frame, so no event can reach them here.
    const guard = installEntryCrashGuard("test-entry");
    assert.equal(process.listenerCount("uncaughtException"), before.uncaught + 1);
    assert.equal(process.listenerCount("unhandledRejection"), before.rejection + 1);
    guard.uninstall();
    assert.equal(process.listenerCount("uncaughtException"), before.uncaught);
    assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
  });
});

describe("crash-guard — a real child process", () => {
  function runChild(script) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    return { child, exited, output: () => ({ stdout, stderr }) };
  }

  it("logs exactly one process_crash and exits 1 for an escaped rejection", async () => {
    const { exited, output } = runChild(`
      import { installCrashGuard } from ${JSON.stringify(GUARD_URL)};
      installCrashGuard({
        name: "rejecting-entry",
        log: (record) => process.stderr.write(
          \`REC \${JSON.stringify({ ...record, error: { name: record.error?.name, message: record.error?.message } })}\\n\`,
        ),
        onFatal: () => process.stderr.write("CLEANUP\\n"),
      });
      async function main() { throw new Error("entry point blew up"); }
      main().then((code) => process.exit(code));
    `);
    const outcome = await exited;
    const { stderr } = output();
    assert.equal(outcome.signal, null, "the guard exits on its own; the test does not kill it");
    assert.equal(outcome.code, 1, "a crash is a controlled non-zero exit");
    const records = stderr.split("\n").filter((line) => line.startsWith("REC "));
    assert.equal(records.length, 1, `one record, got:\n${stderr}`);
    const record = JSON.parse(records[0].slice(4));
    assert.equal(record.event, "process_crash");
    assert.equal(record.level, "error");
    assert.equal(record.reason, "unhandledRejection");
    assert.equal(record.error.message, "entry point blew up");
    assert.match(stderr, /CLEANUP/, "onFatal ran before the exit");
  });

  it("survives a stdout reader that closes early", async () => {
    const dir = tempDir();
    const done = join(dir, "done.txt");
    const { child, exited, output } = runChild(`
      import { appendFileSync } from "node:fs";
      import { installCrashGuard } from ${JSON.stringify(GUARD_URL)};
      installCrashGuard({ name: "epipe-entry", log: () => {} });
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        process.stdout.write(\`tick \${ticks}\\n\`);
        if (ticks >= 40) {
          clearInterval(timer);
          appendFileSync(${JSON.stringify(done)}, "done\\n");
          process.exit(0);
        }
      }, 10);
    `);

    // Wait for the first write, then take the reader away: every later write is
    // an EPIPE.
    const first = await new Promise((resolve) => {
      let settled = false;
      child.stdout.once("data", () => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, 5_000).unref?.();
    });
    assert.equal(first, true, "the entry wrote before the reader closed");
    child.stdout.destroy();

    const outcome = await exited;
    assert.equal(outcome.signal, null, "EPIPE killed the process with a signal");
    assert.equal(outcome.code, 0, `EPIPE ended a working entry:\n${output().stderr}`);
    assert.ok(existsSync(done), "the entry kept running after its reader went away");
  });
});
