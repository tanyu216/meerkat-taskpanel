/**
 * The command wrapper: full coverage of the use-case layer from one seam, with
 * severity decided once (success = debug, refusal = warn, fault = error) and the
 * command's own result or error left untouched.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { withCommandLogging } from "../../../src/core/commands/logging.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { DomainError } from "../../../src/foundation/errors.mjs";
import { withBoard } from "../../helpers/sqlite-fixture.mjs";

const HUMAN = { kind: "human", id: "Terry" };
const AGENT = { kind: "agent", id: "linus" };
const report = () => ({
  conclusion: "done",
  acceptance: [{ text: "x", status: "met" }],
  evidence: [{ kind: "commit", sha: "abc1234" }],
  author: AGENT,
});

/** A real board with a recording logger threaded through the command context. */
async function loggedBoard(fn) {
  const events = [];
  await withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, logger: (event) => events.push(event) });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
    return fn({ commands, events });
  });
  return events;
}

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

describe("commands/logging — business milestones", () => {
  it("records task_delivered only after the transaction commits", async () => {
    const events = await loggedBoard(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "ship", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
    });
    const delivered = events.filter((event) => event.event === "task_delivered");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].level, undefined, "severity comes from EVENT_LEVELS");
    assert.equal(delivered[0].from, "in_progress");
    assert.equal(delivered[0].to, "in_review");
    assert.equal(delivered[0].waived, false);
    assert.ok(delivered[0].identifier, "the human identifier rides along");
    assert.equal(delivered[0].actor, "agent:linus");
  });

  it("records a waived delivery as waived", async () => {
    const events = await loggedBoard(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "waive", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, noReport: true, reason: "hotfix, evidence in chat", actor: AGENT });
    });
    const delivered = events.find((event) => event.event === "task_delivered");
    assert.equal(delivered.waived, true);
    assert.equal(delivered.report_id, null);
  });

  it("records task_reopened when a terminal card re-enters work", async () => {
    const events = await loggedBoard(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "reopen", actor: AGENT });
      commands.moveStatus({ id: task.id, to: "canceled", actor: HUMAN });
      commands.reopenStatus({ id: task.id, reason: "needed after all", actor: HUMAN });
    });
    const reopened = events.find((event) => event.event === "task_reopened");
    assert.ok(reopened, "the reopen is recorded");
    assert.equal(reopened.level, undefined, "severity comes from EVENT_LEVELS");
    assert.equal(reopened.to, "todo");
    assert.equal(reopened.reason, "needed after all");
    assert.equal(reopened.actor, "human:Terry");
    assert.equal(
      events.filter((event) => event.event === "task_moved").length,
      1,
      "only the cancel move is a task_moved; the reopen is not also a generic move",
    );
  });

  it("records the create → claim → report → move backbone once each", async () => {
    const events = await loggedBoard(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "flow", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT }); // reuse by the same holder
      commands.writeReport({ taskId: task.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT });
    });

    const created = events.filter((event) => event.event === "task_created");
    assert.equal(created.length, 1);
    assert.equal(created[0].project_id, "proj");
    assert.equal(created[0].kind, "task");
    assert.equal(created[0].status, "todo");

    const claimed = events.filter((event) => event.event === "task_claimed");
    assert.equal(claimed.length, 1, "a re-claim by the same holder is not an event");
    assert.equal(claimed[0].status, "in_progress");

    assert.equal(events.filter((event) => event.event === "report_written").length, 1);

    const moved = events.filter((event) => event.event === "task_moved");
    assert.deepEqual(moved.map((event) => [event.from, event.to]), [["in_progress", "in_review"]]);
  });

  it("records an archive", async () => {
    const events = await loggedBoard(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "old", actor: AGENT });
      commands.moveStatus({ id: task.id, to: "canceled", actor: HUMAN });
      commands.archive({ id: task.id, days: 0, actor: HUMAN });
    });
    const archived = events.filter((event) => event.event === "task_archived");
    assert.equal(archived.length, 1);
    assert.equal(archived[0].status, "canceled");
    assert.equal(archived[0].actor, "human:Terry");
  });
});
