/**
 * The logging facility: level parsing, the text line format, redaction, sink
 * injection, the rotating file sink and the async correlation context.
 *
 * These are the only unit tests `src/foundation/log.mjs` gets, so every branch
 * that decides whether a line is emitted, how it renders, or what it leaks is
 * covered here.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  EVENT_LEVELS,
  LOG_LEVELS,
  createFileSink,
  createLogger,
  currentLogContext,
  formatLogRecord,
  levelFromEnv,
  parseLogLevel,
  withLogContext,
} from "../../src/foundation/log.mjs";

const FIXED = new Date("2026-01-02T03:04:05.678Z");

/** A logger whose sink collects lines and whose clock is frozen. */
function capture(options = {}) {
  const lines = [];
  const logger = createLogger({
    clock: () => FIXED,
    sinks: [(line) => lines.push(line)],
    ...options,
  });
  return { lines, logger };
}

describe("log — level vocabulary", () => {
  it("ranks the four levels and `off`", () => {
    assert.deepEqual(LOG_LEVELS, { debug: 10, info: 20, warn: 30, error: 40, off: Infinity });
  });

  it("parses levels case-insensitively and accepts the aliases", () => {
    assert.equal(parseLogLevel("DEBUG"), "debug");
    assert.equal(parseLogLevel(" info "), "info");
    assert.equal(parseLogLevel("warning"), "warn");
    assert.equal(parseLogLevel("none"), "off");
    assert.equal(parseLogLevel("silent"), "off");
  });

  it("returns null for anything that is not a level", () => {
    assert.equal(parseLogLevel("verbose"), null);
    assert.equal(parseLogLevel(""), null);
    assert.equal(parseLogLevel(undefined), null);
    assert.equal(parseLogLevel(42), null);
  });

  it("reads the level from the environment, reporting an invalid value", () => {
    assert.deepEqual(levelFromEnv({}), { level: "info", raw: null, valid: true });
    assert.deepEqual(levelFromEnv({ TASKD_LOG_LEVEL: "warn" }), {
      level: "warn",
      raw: "warn",
      valid: true,
    });
    assert.deepEqual(levelFromEnv({ TASKD_LOG_LEVEL: "loud" }), {
      level: "info",
      raw: "loud",
      valid: false,
    });
    assert.equal(levelFromEnv({}, "off").level, "off");
  });
});

describe("log — the callable contract", () => {
  it("accepts the legacy event object", () => {
    const { lines, logger } = capture();
    logger({ event: "label_gc", archived: 2 });
    assert.equal(lines[0], "2026-01-02T03:04:05.678Z INFO  event=label_gc archived=2");
  });

  it("accepts a free-form string", () => {
    const { lines, logger } = capture();
    logger("something happened");
    assert.equal(lines[0], "2026-01-02T03:04:05.678Z INFO  something happened");
  });

  it("lets a second-argument level override the default", () => {
    const { lines, logger } = capture();
    logger("careful", { level: "warn" });
    assert.equal(lines[0], "2026-01-02T03:04:05.678Z WARN  careful");
  });

  it("honours an explicit level on an event object over EVENT_LEVELS", () => {
    const { lines, logger } = capture({ level: "debug" });
    logger({ event: "label_gc_failed", level: "debug", code: "X" });
    assert.match(lines[0], /^2026-01-02T03:04:05\.678Z DEBUG /);
  });

  it("takes the event's level from the catalogue", () => {
    const { lines, logger } = capture();
    logger({ event: "label_gc_failed", code: "DB_BUSY" });
    assert.match(lines[0], /^2026-01-02T03:04:05\.678Z ERROR /);
    assert.equal(EVENT_LEVELS.label_gc_failed, "error");
  });

  it("exposes .info/.warn/.error/.debug methods", () => {
    const { lines, logger } = capture({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn({ event: "x" });
    logger.error("e");
    assert.deepEqual(
      lines.map((line) => line.slice(25, 30).trim()),
      ["DEBUG", "INFO", "WARN", "ERROR"],
    );
  });

  it("records an Error as a structured field", () => {
    const { lines, logger } = capture();
    const err = Object.assign(new Error("boom"), { code: "DB_BUSY" });
    logger.error(err);
    assert.match(lines[0], /ERROR error=\{"name":"Error","code":"DB_BUSY","message":"boom"\}/);
  });

  it("adds the stack only when debug output is enabled", () => {
    const err = new Error("boom");
    const atInfo = capture();
    atInfo.logger.error(err);
    assert.doesNotMatch(atInfo.lines[0], /stack/);

    const atDebug = capture({ level: "debug" });
    atDebug.logger.error(err);
    assert.match(atDebug.lines[0], /"stack":/);
  });
});

describe("log — filtering", () => {
  it("drops lines below the threshold", () => {
    const { lines, logger } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(lines.map((line) => line.slice(25, 30).trim()), ["WARN", "ERROR"]);
  });

  it("emits nothing at all when level is off", () => {
    const { lines, logger } = capture({ level: "off" });
    logger.error("still nothing");
    assert.deepEqual(lines, []);
    assert.equal(logger.isLevelEnabled("error"), false);
  });

  it("reports what is enabled", () => {
    const { logger } = capture({ level: "info" });
    assert.equal(logger.isLevelEnabled("debug"), false);
    assert.equal(logger.isLevelEnabled("info"), true);
    assert.equal(logger.isLevelEnabled("error"), true);
  });

  it("falls back to info for an unknown record level", () => {
    const { lines, logger } = capture();
    logger({ event: "x", level: "chatty" });
    assert.match(lines[0], / INFO  /);
  });
});

describe("log — text format", () => {
  it("renders a stable timestamp, padded level, event first and fields in order", () => {
    const line = formatLogRecord(
      {
        ts: "2026-01-02T03:04:05.678Z",
        level: "info",
        event: "request",
        message: "done",
        method: "GET",
        path: "/api/v1/tasks",
        status: 200,
      },
      {},
    );
    assert.equal(
      line,
      "2026-01-02T03:04:05.678Z INFO  event=request message=done method=GET path=/api/v1/tasks status=200",
    );
  });

  it("quotes values that are not safe bare words", () => {
    const line = formatLogRecord(
      { ts: "t", level: "warn", event: "x", note: "two words", blank: "" },
      {},
    );
    assert.equal(line, 't WARN  event=x note="two words" blank=""');
  });

  it("renders null, booleans, numbers and objects", () => {
    const line = formatLogRecord(
      { ts: "t", level: "info", event: "x", a: null, b: true, c: 3, d: { k: 1 } },
      {},
    );
    assert.equal(line, 't INFO  event=x a=null b=true c=3 d={"k":1}');
  });

  it("truncates a long value", () => {
    const line = formatLogRecord(
      { ts: "t", level: "info", event: "x", big: "a".repeat(50) },
      { maxValueChars: 10 },
    );
    assert.match(line, /big=aaaaaaaaaa…/);
    assert.ok(line.length < 60);
  });

  it("puts a prefix immediately before the body", () => {
    const line = formatLogRecord({ ts: "t", level: "info", message: "/meerkat-loop Continue" }, {
      prefix: "supervisor",
    });
    assert.equal(line, "t INFO  supervisor: /meerkat-loop Continue");
  });
});

describe("log — redaction", () => {
  it("never emits a token, whichever field it arrives in", () => {
    const token = `td_${"a".repeat(64)}`;
    const { lines, logger } = capture();
    logger({ event: "x", note: `bearer ${token}`, raw: token });
    assert.doesNotMatch(lines[0], /td_aaaa/);
    assert.match(lines[0], /td_\*\*\*\*/);
  });

  it("blanks a secret-named key but keeps token_source and token_file readable", () => {
    const { lines, logger } = capture();
    logger({ event: "x", token: "abc", token_source: "env", token_file: "/tmp/t" });
    assert.match(lines[0], /token="td_\*\*\*\*"/);
    assert.match(lines[0], /token_source=env/);
    assert.match(lines[0], /token_file=\/tmp\/t/);
  });

  it("redacts a free-form message", () => {
    const { lines, logger } = capture();
    logger(`Authorization: Bearer ${"b".repeat(32)}`);
    assert.doesNotMatch(lines[0], /bbbb/);
  });
});

describe("log — sinks", () => {
  it("fans a line out to every sink", () => {
    const a = [];
    const b = [];
    const logger = createLogger({ clock: () => FIXED, sinks: [(l) => a.push(l), (l) => b.push(l)] });
    logger.info("both");
    assert.equal(a.length, 1);
    assert.deepEqual(a, b);
  });

  it("survives a sink that throws", () => {
    const kept = [];
    const logger = createLogger({
      clock: () => FIXED,
      sinks: [() => {
        throw new Error("sink is broken");
      }, (l) => kept.push(l)],
    });
    assert.doesNotThrow(() => logger.info("still logged"));
    assert.equal(kept.length, 1);
  });

  it("child() merges extra meta into every line", () => {
    const { lines, logger } = capture();
    logger.child({ request_id: "r1" }).info("hello");
    assert.equal(lines[0], "2026-01-02T03:04:05.678Z INFO  hello request_id=r1");
  });

  it("merges the ambient context into every line", () => {
    const { lines, logger } = capture();
    withLogContext({ request_id: "r2" }, () => logger.info("inside"));
    assert.equal(lines[0], "2026-01-02T03:04:05.678Z INFO  inside request_id=r2");
    assert.equal(currentLogContext(), null);
  });
});

describe("log — the rotating file sink", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "tp-log-"));

  it("appends lines and creates missing directories", () => {
    const root = dir();
    const path = join(root, "nested", "taskd.log");
    const sink = createFileSink({ path });
    sink("one");
    sink("two");
    assert.equal(readFileSync(path, "utf8"), "one\ntwo\n");
    assert.equal(sink.path, path);
  });

  it("creates the file owner-only", () => {
    const root = dir();
    const path = join(root, "taskd.log");
    createFileSink({ path })("secret");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("rotates at the size threshold", () => {
    const root = dir();
    const path = join(root, "taskd.log");
    const sink = createFileSink({ path, maxBytes: 10 });
    sink("12345");
    sink("67890");
    sink("abcde"); // would exceed 10 → the live file becomes .1
    assert.equal(readFileSync(`${path}.1`, "utf8"), "67890\n");
    assert.equal(readFileSync(`${path}.2`, "utf8"), "12345\n");
    assert.equal(readFileSync(path, "utf8"), "abcde\n");
  });

  it("keeps only the configured number of rotations", () => {
    const root = dir();
    const path = join(root, "taskd.log");
    const sink = createFileSink({ path, maxBytes: 4, keep: 2 });
    for (let i = 0; i < 6; i += 1) sink(`l${i}`);
    assert.equal(existsSync(`${path}.1`), true);
    assert.equal(existsSync(`${path}.2`), true);
    assert.equal(existsSync(`${path}.3`), false);
    assert.equal(readFileSync(path, "utf8"), "l5\n");
  });

  it("swallows write failures instead of taking the caller down", () => {
    const root = dir();
    const path = join(root, "blocked");
    writeFileSync(path, "i am a file, not a directory");
    const sink = createFileSink({ path: join(path, "taskd.log") });
    assert.doesNotThrow(() => sink("nope"));
  });
});
