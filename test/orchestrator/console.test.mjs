/**
 * The live-session console cycle: read-only, and it names exactly the questions
 * a human still owes an answer to.
 *
 * The board is a sentinel CLI, so the test can assert the argv as well as the
 * aggregation — in particular that the console never writes.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseArgs } from "../../src/orchestrator/options.mjs";
import { consoleCycle } from "../../src/orchestrator/console.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-console-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

const TASKS = {
  awaiting: [
    { identifier: "T-1", title: "Needs a decision", status: "awaiting" },
    { identifier: "T-5", title: "Answered in the UI", status: "awaiting" },
  ],
  in_progress: [
    { identifier: "T-2", title: "Answered, not released", status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z" },
    { identifier: "T-4", title: "Still asking", status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z" },
    { identifier: "T-6", title: "Note, not released", status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z" },
  ],
  in_review: [{ identifier: "T-3", title: "Awaiting acceptance", status: "in_review" }],
  blocked: [
    {
      identifier: "T-7",
      title: "Held for a decision",
      status: "blocked",
      blocked_reason: "decision",
    },
    {
      identifier: "T-8",
      title: "Blocked on a resource",
      status: "blocked",
      blocked_reason: "resource",
    },
    {
      identifier: "T-9",
      title: "Answered hold",
      status: "blocked",
      blocked_reason: "decision",
    },
    {
      identifier: "T-10",
      title: "Needs a real host",
      status: "blocked",
      blocked_reason: "external",
      blocked_at: "2025-12-31T20:00:00Z",
    },
  ],
};

const COMMENTS = {
  "T-1": [
    { kind: "question", author_kind: "claude", body: "Which option?", created_at: "2026-01-01T00:00:00Z" },
  ],
  "T-5": [
    { kind: "note", author_kind: "human", body: "Use option B.", created_at: "2026-01-01T00:05:00Z" },
    { kind: "question", author_kind: "claude", body: "Which option?", created_at: "2026-01-01T00:00:00Z" },
  ],
  "T-2": [
    { kind: "note", author_kind: "human", body: "Use option A.", created_at: "2026-01-01T00:05:00Z" },
    { kind: "question", author_kind: "claude", body: "Which option?", created_at: "2026-01-01T00:00:00Z" },
  ],
  "T-4": [
    { kind: "question", author_kind: "claude", body: "Deploy now?", created_at: "2026-01-01T00:00:00Z" },
  ],
  // The middle rung's answer is an agent `note`; it settles the question too.
  "T-6": [
    { kind: "note", author_kind: "claude", body: "decision: use option B", created_at: "2026-01-01T00:05:00Z" },
    { kind: "question", author_kind: "claude", body: "Which option?", created_at: "2026-01-01T00:00:00Z" },
  ],
  "T-3": [],
  // The loop's hold question lands on a `blocked` card: the human never saw it.
  "T-7": [
    {
      kind: "question",
      author_kind: "claude",
      body: "Decide: narrow the baseline, take the work as-is, or cancel.",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  // A resource block is not a human decision, whatever question it carries.
  "T-8": [
    { kind: "question", author_kind: "claude", body: "Waiting on CI.", created_at: "2026-01-01T00:00:00Z" },
  ],
  // Answered by the human; the card is still `blocked` until it is moved.
  "T-9": [
    { kind: "note", author_kind: "human", body: "Narrow the baseline.", created_at: "2026-01-01T00:05:00Z" },
    { kind: "question", author_kind: "claude", body: "Decide: ...", created_at: "2026-01-01T00:00:00Z" },
  ],
};

function sentinelCli(dir) {
  const calls = join(dir, "calls.jsonl");
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      "if (process.env.TP_CLI_CALLS) appendFileSync(process.env.TP_CLI_CALLS, `${JSON.stringify(argv)}\\n`);",
      "const start = argv.findIndex((a) => a === 'issue' || a === 'comment');",
      "const args = start === -1 ? [] : argv.slice(start);",
      "const status = args.includes('--status') ? args[args.indexOf('--status') + 1] : null;",
      "let data = {};",
      "if (args[0] === 'issue' && status !== null) {",
      `  const tasks = ${JSON.stringify(TASKS)};`,
      "  data = { tasks: tasks[status] ?? [] };",
      "} else if (args[0] === 'comment') {",
      `  const comments = ${JSON.stringify(COMMENTS)};`,
      "  data = { comments: comments[args[2]] ?? [] };",
      "}",
      'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
    ].join("\n"),
  );
  return { script, calls };
}

function optsFor(dir, script) {
  return parseArgs(
    [
      "--state", join(dir, "state.json"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
    ],
    { HOME: dir },
  );
}

const noUnits = (command) =>
  command === "crontab"
    ? { status: 1, stdout: "", stderr: "", error: null }
    : { status: 1, stdout: "", stderr: "", error: null };

describe("the live-session console", () => {
  it("lists awaiting and unanswered in-progress questions, and pending acceptance", async () => {
    const dir = tempDir();
    const { script, calls } = sentinelCli(dir);
    const previous = process.env.TP_CLI_CALLS;
    process.env.TP_CLI_CALLS = calls;
    let result;
    try {
      result = await consoleCycle(optsFor(dir, script), {
        run: noUnits,
        isAlive: () => false,
        now: () => NOW,
      });
    } finally {
      if (previous === undefined) delete process.env.TP_CLI_CALLS;
      else process.env.TP_CLI_CALLS = previous;
    }

    assert.equal(result.supervisor.verdict, "absent");
    assert.deepEqual(
      result.questions.map((entry) => entry.ref).sort(),
      ["T-1", "T-10", "T-2", "T-4", "T-6", "T-7"],
      "T-5 is answered on an awaiting card (the board resumes it); T-2 and T-6 are answered " +
        "but not released, so the director still owes the release; T-7 is a blocked/decision " +
        "hold; T-10 is an external block (operator work); T-8 is a resource block and T-9 was " +
        "answered, so both stay out",
    );
    assert.equal(result.questions.find((entry) => entry.ref === "T-1").kind, "awaiting");
    assert.equal(result.questions.find((entry) => entry.ref === "T-4").kind, "agent-question");
    assert.equal(result.questions.find((entry) => entry.ref === "T-2").answered_pending_release, true);
    assert.equal(result.questions.find((entry) => entry.ref === "T-6").answered_pending_release, false);
    const blocked = result.questions.find((entry) => entry.ref === "T-7");
    assert.equal(blocked.kind, "blocked-decision");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_reason, "decision");
    assert.match(blocked.question, /narrow the baseline/i);
    assert.equal(blocked.answered_pending_release, false);
    const external = result.questions.find((entry) => entry.ref === "T-10");
    assert.equal(external.kind, "blocked-external");
    assert.equal(external.blocked_reason, "external");
    assert.equal(external.status, "blocked");
    assert.equal(typeof external.age_ms, "number");
    assert.equal(typeof result.questions.find((entry) => entry.ref === "T-4").age_ms, "number");
    assert.deepEqual(result.pending_acceptance.map((entry) => entry.ref), ["T-3"]);
    assert.deepEqual(result.errors, []);

    const argv = readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const writes = argv.filter((args) =>
      /\b(move|claim|deliver|add|update|create)\b/.test(args.join(" ")),
    );
    assert.deepEqual(writes, [], "the console never writes to the board");
  });

  it("reports a failed board read instead of crashing", async () => {
    const dir = tempDir();
    const script = join(dir, "broken-cli.mjs");
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "down" } }));\n');
    const result = await consoleCycle(optsFor(dir, script), {
      run: noUnits,
      isAlive: () => false,
      now: () => NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.questions.length, 0);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /down/);
  });
});
