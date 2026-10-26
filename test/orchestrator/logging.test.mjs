/**
 * The loop's logger keeps its old calling convention (`log(line)`) and its
 * `supervisor: ` prefix, but now gets levels, a timestamp, rotation and
 * redaction from `foundation/log.mjs`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { createLogger } from "../../src/orchestrator/runtime.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "tp-loop-log-"));

/** Collect what the loop writes to stderr (its logger writes there directly). */
function captureStderr(fn) {
  const original = process.stderr.write;
  let text = "";
  process.stderr.write = (chunk) => {
    text += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

describe("orchestrator/logging — the loop's line logger", () => {
  it("keeps `supervisor: ` immediately before the message on stderr", () => {
    const dir = tempDir();
    const log = createLogger({ log: join(dir, "supervisor.log"), logLevel: "info" });
    const text = captureStderr(() => log("/meerkat-loop Continue — timer turn"));
    assert.match(text, /^\d{4}-\d{2}-\d{2}T\S+ INFO {2}supervisor: \/meerkat-loop Continue/m);
  });

  it("appends a timestamped, levelled line to the loop log", () => {
    const dir = tempDir();
    const path = join(dir, "supervisor.log");
    const log = createLogger({ log: path, logLevel: "info" });
    captureStderr(() => log("continue: would run: claude"));
    log.close();
    assert.match(
      readFileSync(path, "utf8"),
      /^\d{4}-\d{2}-\d{2}T\S+ INFO {2}supervisor: continue: would run: claude$/m,
    );
  });

  it("honours a failure level given as the second argument", () => {
    const dir = tempDir();
    const log = createLogger({ log: join(dir, "supervisor.log"), logLevel: "info" });
    const text = captureStderr(() => log("patrol failed", { level: "warn" }));
    assert.match(text, / WARN {2}supervisor: patrol failed/);
  });

  it("writes no file during a dry run", () => {
    const dir = tempDir();
    const path = join(dir, "supervisor.log");
    const log = createLogger({ log: path, dryRun: true });
    captureStderr(() => log("dry"));
    log.close();
    assert.equal(existsSync(path), false);
  });

  it("redacts a token that reaches the loop log", () => {
    const dir = tempDir();
    const path = join(dir, "supervisor.log");
    const log = createLogger({ log: path, logLevel: "info" });
    const token = `td_${"c".repeat(64)}`;
    captureStderr(() => log(`token ${token}`));
    log.close();
    assert.doesNotMatch(readFileSync(path, "utf8"), /td_cccc/);
    assert.match(readFileSync(path, "utf8"), /td_\*\*\*\*/);
  });
});
