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
    { identifier: "T-2", title: "Already answered", status: "in_progress" },
    { identifier: "T-4", title: "Still asking", status: "in_progress" },
    { identifier: "T-6", title: "Answered by the project session", status: "in_progress" },
  ],
  in_review: [{ identifier: "T-3", title: "Awaiting acceptance", status: "in_review" }],
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
      ["T-1", "T-4"],
      "T-2/T-5 have newer human answers and T-6 has the project session's note, so none is asked again",
    );
    assert.equal(result.questions.find((entry) => entry.ref === "T-1").kind, "awaiting");
    assert.equal(result.questions.find((entry) => entry.ref === "T-4").kind, "agent-question");
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
