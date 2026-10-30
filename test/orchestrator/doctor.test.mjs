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
  LOG_TAIL_LINE_CHARS,
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
  {
    identifier: "T-202",
    title: "Reviewer card",
    status: "in_review",
    status_changed_at: at(120 * MIN),
    review_of_id: "orig-200",
  },
  { identifier: "T-300", title: "Queued", status: "todo" },
];

function sentinel(dir, { fail = false, tasks = TASKS } = {}) {
  const record = join(dir, "calls.jsonl");
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "if (process.env.TP_CALLS) appendFileSync(process.env.TP_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      fail
        ? 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "board down" } }));'
        : `process.stdout.write(JSON.stringify({ ok: true, data: { tasks: ${JSON.stringify(tasks)} } }));`,
    ].join("\n"),
  );
  return { script, record };
}

const noUnits = () => ({ status: 1, stdout: "", stderr: "", error: null });

/** A successful child-process result, in the shape every run seam uses. */
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function deps(overrides = {}) {
  return {
    run: noUnits,
    isAlive: () => false,
    now: () => NOW,
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

    assert.equal(report.compat, undefined, "the report carries no board-interface verdict");

    assert.equal(report.patrol.age_ms, 30 * MIN);
    assert.equal(report.patrol.cadence_min, 15);
    assert.equal(report.patrol.overdue, false, "30m is inside 3 × 15m");

    assert.equal(report.board.total, TASKS.length);
    assert.equal(report.board.truncated, false);
    assert.equal(report.board.counts.in_progress, 4);
    assert.equal(report.board.counts.in_review, 3);

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
      report.waiting.in_review.map((card) => [card.ref, card.review]),
      [["T-202", true], ["T-200", false], ["T-201", false]],
      "a review card is labelled, not judged — the workflow pass owns review aging",
    );
    assert.equal(report.waiting.in_review[0].age_ms, 120 * MIN);
    assert.equal("aging" in report.waiting.in_review[0], false);
    assert.equal(report.waiting.total, 3);
    assert.equal(report.stuck_cards.total, 2, "only the patrol's heartbeat judgement is 'stuck'");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.ok, true);
    assert.equal(report.attention, true);
    assert.ok(report.attention_reasons.includes("stuck_cards: 2"));
  });

  it("does not call an epic container a stuck card", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "E-1", title: "Container", kind: "epic", status: "in_progress", heartbeat_at: null },
        { identifier: "T-1", title: "Work", kind: "task", status: "in_progress", heartbeat_at: null },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.stuck_cards.in_progress.map((card) => card.ref),
      ["T-1"],
      "an epic's in_progress is the board's design, not a stale claim",
    );
    assert.equal(report.stuck_cards.total, 1);
  });

  it("calls out an acceptance the board refused: the marker says accepted, the card does not", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-400",
          title: "Approved but unclosable",
          status: "in_review",
          delivery_round: 1,
          status_changed_at: at(90 * MIN),
          meta: { accepted_by: "loop-review", accepted_round: "1" },
        },
        {
          // A marker from an earlier round is history, not a blocked approval.
          identifier: "T-401",
          title: "Marker from round 1",
          status: "in_review",
          delivery_round: 2,
          status_changed_at: at(30 * MIN),
          meta: { accepted_by: "loop-review", accepted_round: "1" },
        },
        { identifier: "T-402", title: "Plain delivery", status: "in_review", meta: {} },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.blocked_acceptance.cards.map((card) => [card.ref, card.round, card.age_ms]),
      [["T-400", 1, 90 * MIN]],
      "only a marker for the card's current round is a blocked acceptance",
    );
    assert.equal(report.blocked_acceptance.total, 1);
    assert.ok(report.attention_reasons.includes("blocked_acceptance: 1"));
    assert.equal(report.stuck_cards.total, 0, "a stray marker is not a stale claim");
  });

  it("names a done card whose lane never landed, and only when git says it did not", () => {
    const dir = tempDir();
    const projectDir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-500", title: "Landed long ago", status: "done", project_id: "proj" },
        { identifier: "T-501", title: "Worktree still out", status: "done", project_id: "proj" },
        { identifier: "T-502", title: "Branch survived cleanup", status: "done", project_id: "proj" },
        { identifier: "T-503", title: "Still being worked", status: "in_progress", project_id: "proj" },
      ],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [{ project: "proj", local_path: projectDir }] });

    const report = doctorReport(opts, { HOME: dir }, deps({
      git: (cmd, argv) => {
        const key = argv.join(" ");
        if (key.includes("worktree list")) {
          return ok(
            [
              `worktree ${projectDir}`,
              "branch refs/heads/dev",
              "",
              `worktree ${projectDir}/.worktrees/T-500`,
              "branch refs/heads/lane/T-500",
              "",
              `worktree ${projectDir}/.worktrees/T-501-m8`,
              "branch refs/heads/lane/T-501-prefix",
              "",
            ].join("\n"),
          );
        }
        if (key.includes("branch --no-merged")) {
          return ok("  lane/T-501-prefix\n  lane/T-502-docs\n");
        }
        return ok("");
      },
    }));

    assert.deepEqual(
      report.unlanded.cards.map((card) => [card.ref, card.branch, card.path === null ? null : "worktree"]),
      [
        ["T-501", "lane/T-501-prefix", "worktree"],
        ["T-502", "lane/T-502-docs", null],
      ],
      "T-500's lane is merged, and T-503 is not done at all",
    );
    assert.equal(report.unlanded.total, 2);
    assert.ok(report.attention_reasons.includes("unlanded: 2"));
    assert.deepEqual(report.errors, [], "a plain finding is not an error");
  });

  it("skips a project the map cannot resolve instead of failing the report", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-600", title: "Elsewhere", status: "done", project_id: "missing" }],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [] });

    const report = doctorReport(opts, { HOME: dir }, deps({ git: () => ok("") }));

    assert.equal(report.unlanded.total, 0);
    assert.ok(
      report.skipped.some((line) => /unlanded: missing/.test(line)),
      `the unreadable project is named as skipped: ${JSON.stringify(report.skipped)}`,
    );
    assert.deepEqual(report.errors, []);
  });

  it("keeps in_review as facts: the review-aging setting does not judge them", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);

    // `--review-aging-minutes` is accepted (it is a shared loop flag) but it is
    // the *workflow* pass's threshold. Applying it here would report every
    // delivery waiting for acceptance as an aged review card.
    const report = doctorReport(
      optsFor(dir, script, ["--review-aging-minutes", "5"]),
      { HOME: dir },
      deps(),
    );

    assert.equal(report.waiting.total, 3);
    for (const card of report.waiting.in_review) {
      assert.equal("aging" in card, false);
      assert.equal("threshold_ms" in card, false);
    }
    assert.equal(
      report.attention_reasons.some((reason) => /aging/.test(reason)),
      false,
    );
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

  it("never asks the board what version it is", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir);
    seedState(dir);

    process.env.TP_CALLS = record;
    try {
      doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    } finally {
      delete process.env.TP_CALLS;
    }

    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.length > 0, "the doctor still reads the board");
    assert.deepEqual(
      calls.filter((args) => args.includes("--version")),
      [],
      "the retired board-interface gate must not leave a version probe behind",
    );
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

  it("caps a long line so one embedded message cannot crowd out the report", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    // The live log carries whole assistant messages inside `msg="…"`.
    writeFileSync(join(dir, "supervisor.log"), `short line\n${"x".repeat(500)}\n`);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.log.lines[0], "short line");
    assert.equal(report.log.lines[1].length, LOG_TAIL_LINE_CHARS + 1);
    assert.match(report.log.lines[1], /x…$/);
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
    assert.match(out, /patrol\s+last_ok 2025-12-31T23:30:00.000Z \(30m ago, cadence 15m\)/);
    assert.match(out, /stuck\s+2 card\(s\): 2 in_progress/);
    assert.match(out, /T-100  in_progress  stale 31m > 30m  Stale claim/);
    assert.match(out, /waiting\s+3 in_review \(oldest 120m\)/);
    assert.match(out, /T-202  in_review  120m  \[review\]  Reviewer card/);
    assert.match(out, /T-200  in_review  90m  Waiting too long/);
    assert.match(out, /queue\s+depth 2/);

    out = "";
    const helpExit = await main(["--help"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(helpExit, 0);
    assert.match(out, /^Usage: taskctl loop doctor/);
  });
});
