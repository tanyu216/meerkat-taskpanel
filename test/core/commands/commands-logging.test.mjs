/**
 * The command wrapper: full coverage of the use-case layer from one seam, with
 * severity decided once (success = debug, refusal = warn, fault = error) and the
 * command's own result or error left untouched.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { withCommandLogging } from "../../../src/core/commands/logging.mjs";
import { DomainError } from "../../../src/foundation/errors.mjs";

/** A logger that records records and answers `isLevelEnabled` like the real one. */
function capture(logLevel = "info") {
  const records = [];
  const logger = (record) => records.push(record);
  logger.isLevelEnabled = (level) => level === "debug" && logLevel === "debug";
  return { records, logger };
}

describe("commands/logging — the wrapper", () => {
  it("returns the table unchanged when there is no logger", () => {
    const commands = { ping: () => "pong" };
    assert.equal(withCommandLogging(commands, undefined), commands);
    assert.equal(withCommandLogging(commands, null), commands);
  });

  it("passes the command's arguments and result through", () => {
    const { records, logger } = capture();
    let received;
    const commands = withCommandLogging(
      { echo: (input) => { received = input; return { ok: true }; } },
      logger,
    );
    const result = commands.echo({ task: 1 });
    assert.deepEqual(received, { task: 1 });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(records, [], "a successful write is not news at info");
  });

  it("records a successful command at debug only when debug is enabled", () => {
    const quiet = capture("info");
    withCommandLogging({ ping: () => 1 }, quiet.logger).ping();
    assert.deepEqual(quiet.records, []);

    const loud = capture("debug");
    withCommandLogging({ ping: () => 1 }, loud.logger).ping();
    assert.equal(loud.records[0].event, "command");
    assert.equal(loud.records[0].command, "ping");
    assert.equal(typeof loud.records[0].duration_ms, "number");
  });

  it("records a 4xx refusal as warn, keeping its code and rethrowing it", () => {
    const { records, logger } = capture();
    const refusal = new DomainError("VERSION_CONFLICT");
    const commands = withCommandLogging(
      { move: () => { throw refusal; } },
      logger,
    );
    assert.throws(() => commands.move(), (error) => error === refusal);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "command_failed");
    assert.equal(records[0].level, "warn");
    assert.equal(records[0].command, "move");
    assert.equal(records[0].code, "VERSION_CONFLICT");
    assert.equal(records[0].http, 409);
  });

  it("records a 5xx domain failure as error", () => {
    const { records, logger } = capture();
    const commands = withCommandLogging(
      { write: () => { throw new DomainError("DB_BUSY"); } },
      logger,
    );
    assert.throws(() => commands.write());
    assert.equal(records[0].level, "error");
    assert.equal(records[0].http, 503);
  });

  it("records an unmapped throw as error with no code", () => {
    const { records, logger } = capture();
    const commands = withCommandLogging(
      { crash: () => { throw new TypeError("not ours"); } },
      logger,
    );
    assert.throws(() => commands.crash(), TypeError);
    assert.equal(records[0].level, "error");
    assert.equal(records[0].code, null);
    assert.equal(records[0].http, null);
  });

  it("does not change the result when the logger itself throws", () => {
    const logger = () => {
      throw new Error("logger is broken");
    };
    logger.isLevelEnabled = () => false;
    const commands = withCommandLogging({ ping: () => "pong" }, logger);
    assert.equal(commands.ping(), "pong");

    const refusal = new DomainError("NOT_FOUND");
    const failing = withCommandLogging({ boom: () => { throw refusal; } }, logger);
    assert.throws(() => failing.boom(), (error) => error === refusal);
  });

  it("leaves non-function entries alone", () => {
    const { logger } = capture();
    const wrapped = withCommandLogging({ value: 7, ping: () => 1 }, logger);
    assert.equal(wrapped.value, 7);
  });
});
