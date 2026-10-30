/**
 * `taskctl loop doctor` — the read-only daily inspection.
 *
 * The board is a sentinel CLI and the state directory is real files, so the test
 * asserts both the report and the promise behind it: every board call is a read,
 * and no file under the state directory changes.
 *
 * The two "stuck" judgements are not re-tested here — they belong to
 * `planPatrol` (`scheduling.mjs`) and to the workflow's `review_aging` rule.
 * What is asserted is that the doctor *uses* those rules, and reports the
 * threshold it used.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  LOG_TAIL_LINES,
  LOG_TAIL_BYTES,
  doctorReport,
  main,
} from "../../src/orchestrator/doctor.mjs";
import { parseArgs } from "../../src/orchestrator/options.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-doctor-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

/** Six cards: three in progress (stale / fresh / unreadable), two in review, one todo. */
const TASKS = [
  { identifier: "T-100", title: "Stale claim", status: "in_progress", heartbeat_at: at(31 * MIN) },
  { identifier: "T-101", title: "Healthy claim", status: "in_progress", heartbeat_at: at(5 * MIN) },
  { identifier: "T-102", title: "No heartbeat", status: "in_progress", heartbeat_at: null },
  { identifier: "T-103", title: "Just inside the window", status: "in_progress", heartbeat_at: at(29 * MIN) },
  { identifier: "T-200", title: "Waiting too long", status: "in_review", status_changed_at: at(90 * MIN) },
  { identifier: "T-201", title: "Just delivered", status: "in_review", status_changed_at: at(10 * MIN) },
  { identifier: "T-300", title: "Queued", status: "todo" },
];

function sentinel(dir, { fail = false } = {}) {
  const record = join(dir, "calls.jsonl");
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "if (process.env.TP_CALLS) appendFileSync(process.env.TP_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      fail
        ? 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "board down" } }));'
        : `process.stdout.write(JSON.stringify({ ok: true, data: { tasks: ${JSON.stringify(TASKS)} } }));`,
    ].join("\n"),
  );
  return { script, record };
}

const noUnits = () => ({ status: 1, stdout: "", stderr: "", error: null });

const compatibleBoard = () => ({
  status: 0,
  stdout: JSON.stringify({ ok: true, data: { version: "0.1.0", schema_version: 4 } }),
  stderr: "",
  error: null,
});

function deps(overrides = {}) {
  return {
    run: noUnits,
    isAlive: () => false,
    now: () => NOW,
    boardRun: compatibleBoard,
    ...overrides,
  };
}

function optsFor(dir, script, extra = []) {
  return parseArgs(
    [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
      ...extra,
    ],
    { HOME: dir },
  );
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function seedState(dir, { patrolAgeMs = 30 * MIN, cadenceMin = 15 } = {}) {
  writeJson(join(dir, "cards.queue.json"), {
    version: 1,
    cards: [{ status: "pending" }, { status: "processing" }],
  });
  writeJson(join(dir, "subagents.state.json"), {
    version: 1,
    subagents: [{ status: "running" }, { status: "completed" }],
  });
  writeJson(join(dir, "loop-patrol-last-ok.json"), {
    mechanism: "sla",
    last_ok: at(patrolAgeMs),
    cadence_period_min: cadenceMin,
  });
}

function writeLog(dir, count) {
  const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(dir, "supervisor.log"), `${lines.join("\n")}\n`);
  return lines;
}

describe("loop doctor — the report", () => {
  it("covers every surface in one pass", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeLog(dir, 50);

    // The scan set comes from config, never from `--agent` (which names units), so
    // the test sets it explicitly instead of inheriting the developer's environment.
    const previous = process.env.MEERKAT_TASKPANEL_AGENTS;
    process.env.MEERKAT_TASKPANEL_AGENTS = "alice,bob";
    let report;
    try {
      report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    } finally {
      if (previous === undefined) delete process.env.MEERKAT_TASKPANEL_AGENTS;
      else process.env.MEERKAT_TASKPANEL_AGENTS = previous;
    }

    assert.equal(report.read_only, true);
    assert.equal(report.supervisor.verdict, "absent");
    assert.deepEqual(report.agents, ["alice", "bob"]);

    assert.deepEqual(report.compat, {
      ok: true,
      version: "0.1.0",
      schemaVersion: 4,
      boardInterface: "task-interface v1",
    });

    assert.equal(report.patrol.age_ms, 30 * MIN);
    assert.equal(report.patrol.cadence_min, 15);
    assert.equal(report.patrol.overdue, false, "30m is inside 3 × 15m");

    assert.equal(report.board.total, TASKS.length);
    assert.equal(report.board.truncated, false);
    assert.equal(report.board.counts.in_progress, 4);
    assert.equal(report.board.counts.in_review, 2);

    assert.equal(report.log.source, "live");
    assert.equal(report.log.lines.length, LOG_TAIL_LINES);
    assert.equal(report.log.lines.at(-1), "line 50");
    assert.equal(report.log.truncated, true);

    assert.equal(report.queue.depth, 2);
    assert.equal(report.queue.pending, 1);
    assert.equal(report.queue.processing, 1);
    assert.equal(report.queue.failed, 0);

    assert.equal(report.subagents.live, 1);
    assert.equal(report.subagents.total, 2);
    assert.deepEqual(report.subagents.by_status, { running: 1, completed: 1 });

    assert.deepEqual(
      report.stuck_cards.in_progress.map((card) => card.ref),
      ["T-100", "T-102"],
      "29 minutes is inside the patrol window, and the unreadable heartbeat is reported, not dropped",
    );
    assert.equal(report.stuck_cards.in_progress[0].threshold_ms, 30 * MIN);
    assert.equal(report.stuck_cards.in_progress[1].reason, "heartbeat-unreadable");
    assert.equal(report.stuck_cards.in_progress[1].detail, "missing");

    assert.deepEqual(
      report.stuck_cards.in_review.map((card) => [card.ref, card.aging]),
      [["T-200", true], ["T-201", false]],
    );
    assert.equal(report.stuck_cards.total, 3);

    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.ok, true);
    assert.equal(report.attention, true);
    assert.ok(report.attention_reasons.some((reason) => reason.startsWith("stuck_cards:")));
  });

  it("lets the resolved review-aging setting move the line", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);

    const report = doctorReport(
      optsFor(dir, script, ["--review-aging-minutes", "5"]),
      { HOME: dir },
      deps(),
    );

    assert.deepEqual(
      report.stuck_cards.in_review.map((card) => [card.ref, card.aging]),
      [["T-200", true], ["T-201", true]],
      "10 minutes is aging at a 5-minute threshold",
    );
    assert.equal(report.stuck_cards.in_review[0].threshold_ms, 5 * MIN);
  });

  it("calls an overdue patrol marker out, and only when a cadence is declared", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir, { patrolAgeMs: 60 * MIN, cadenceMin: 15 });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.patrol.overdue, true, "60m is outside 3 × 15m");
    assert.ok(report.attention_reasons.includes("patrol: marker overdue"));

    writeJson(join(dir, "loop-patrol-last-ok.json"), { mechanism: "sla", last_ok: at(600 * MIN) });
    const undeclared = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(undeclared.patrol.overdue, null, "no cadence, no invented threshold");
    assert.equal(
      undeclared.attention_reasons.includes("patrol: marker overdue"),
      false,
    );
  });

  it("keeps the report complete when the board cannot be read", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, { fail: true });
    seedState(dir);
    writeLog(dir, 3);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.ok, false);
    assert.match(report.errors[0], /^board: board down/);
    assert.equal(report.queue.depth, 2, "the local checks still run");
    assert.equal(report.log.lines.length, 3);
    assert.equal(report.stuck_cards.total, 0);
    assert.equal(report.board.total, 0);
    assert.equal(report.attention, true);
  });

  it("reports an incompatible board as a verdict, not as a broken report", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);

    const report = doctorReport(
      optsFor(dir, script),
      { HOME: dir },
      deps({
        boardRun: () => ({ status: 0, stdout: "not json", stderr: "", error: null }),
      }),
    );

    assert.equal(report.compat.ok, false);
    assert.equal(report.compat.code, "BOARD_UNREADABLE");
    assert.equal(report.ok, true, "the report itself is complete");
    assert.equal(report.attention, true);
    assert.ok(report.attention_reasons.some((reason) => reason.startsWith("compat:")));
  });
});

describe("loop doctor — the log tail", () => {
  it("falls back to the rotated generation, and calls a missing log missing", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeFileSync(join(dir, "supervisor.log.1"), "old 1\nold 2\n");

    const rotated = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(rotated.log.source, "rotated");
    assert.deepEqual(rotated.log.lines, ["old 1", "old 2"]);
    assert.equal(rotated.log.truncated, false);

    rmSync(join(dir, "supervisor.log.1"));
    const missing = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(missing.log.missing, true);
    assert.equal(missing.log.source, "missing");
    assert.deepEqual(missing.log.lines, []);
    assert.deepEqual(missing.errors, [], "a log that was never written is not an error");
    assert.equal(missing.ok, true);
  });

  it("reads a bounded tail rather than the whole file", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    // One line far longer than the byte cap: the read must not pull it all in.
    writeFileSync(join(dir, "supervisor.log"), `${"x".repeat(LOG_TAIL_BYTES * 2)}\ntail 1\ntail 2\n`);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.log.lines, ["tail 1", "tail 2"]);
    assert.equal(report.log.truncated, true);
  });
});

describe("loop doctor — read-only", () => {
  it("issues no board write, and leaves the state directory alone", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir);
    seedState(dir);
    writeLog(dir, 5);

    const before = ["cards.queue.json", "subagents.state.json", "loop-patrol-last-ok.json", "supervisor.log"]
      .map((name) => readFileSync(join(dir, name), "utf8"));

    process.env.TP_CALLS = record;
    try {
      doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    } finally {
      delete process.env.TP_CALLS;
    }

    const after = ["cards.queue.json", "subagents.state.json", "loop-patrol-last-ok.json", "supervisor.log"]
      .map((name) => readFileSync(join(dir, name), "utf8"));
    assert.deepEqual(after, before, "the inspection writes nothing to its own state");

    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    const writes = calls.filter((args) => /\b(move|claim|deliver|add|update|create)\b/.test(args.join(" ")));
    assert.deepEqual(writes, [], "the doctor never writes to the board");
    for (const args of calls) {
      assert.equal(args.includes("issue") && args.includes("list"), true, `unexpected board call: ${args.join(" ")}`);
    }
  });
});

describe("loop doctor — the process boundary", () => {
  it("emits the raw report with --json and a digest without it", async () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeLog(dir, 2);
    const argv = [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
    ];

    let out = "";
    const exit = await main([...argv, "--json"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(exit, 0);
    const report = JSON.parse(out);
    assert.equal(report.read_only, true);
    assert.equal(report.ok, true);
    assert.equal(report.data, undefined, "the loop's verbs print their own JSON, not the envelope");

    out = "";
    const textExit = await main(argv, { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(textExit, 0);
    assert.match(out, /supervisor\s+absent/);
    assert.match(out, /queue\s+depth 2/);

    out = "";
    const helpExit = await main(["--help"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(helpExit, 0);
    assert.match(out, /^Usage: taskctl loop doctor/);
  });
});
