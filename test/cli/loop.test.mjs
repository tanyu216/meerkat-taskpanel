/**
 * `taskctl loop …` — the command surface and its two board-free verbs.
 *
 * The migration's honesty hinges on two things this file pins:
 *
 *   1. the ten verbs are registered as *local* commands (no board connect
 *      happens before the handler runs — `loop status` must answer with the
 *      board down);
 *   2. the two globals the loop cannot honour (`--as-human`, `--session-id`,
 *      `--if-version`) are refused, and a mutating verb without
 *      `--actor-kind` is a usage error, not a board call.
 *
 * `loop compat` is gone: the loop ships with the board, so there is no board
 * generation to gate on (ADR 0005). The last describe pins that it stays gone.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { COMMANDS } from "../../src/cli/commands/loop.mjs";
import {
  cleanupTempDirs,
  makeTempDir,
  parseJson,
  runCli,
} from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

const VERBS = [
  "patrol",
  "workflow",
  "poll",
  "tick",
  "console",
  "doctor",
  "status",
  "run",
  "subscribe",
  "session",
];

describe("cli/commands/loop — the surface", () => {
  it("registers the ten verbs, each local", () => {
    assert.deepEqual(COMMANDS.map((command) => command.name), VERBS);
    for (const command of COMMANDS) {
      assert.equal(command.local, true, `${command.name} must not connect first`);
      assert.equal(typeof command.run, "function");
      assert.match(command.usage, /^loop /);
    }
  });

  it("asks for an actor on every verb that writes", async () => {
    // No board, no identity: the refusal must come from dispatch, before any
    // transport code could run.
    const result = runCli(["loop", "patrol", "--dry-run"], { noIdentity: true });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--actor-kind is required/);
  });

  it("refuses the globals the loop cannot honour", () => {
    for (const flag of ["--as-human", "--session-id=x", "--if-version=3"]) {
      const result = runCli(["--actor-kind", "claude", "loop", "poll", "--dry-run", flag], {
        noIdentity: true,
      });
      assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
      assert.match(result.stderr, /is not valid for the loop/);
    }
  });

  it("accepts --workspace and refuses a value it does not know", () => {
    // Raw argv is forwarded to the loop's own parser, so the CLI must declare
    // the flag or the documented mode never reaches it.
    const stateDir = makeTempDir("meerkat-taskpanel-loop-workspace-");
    const accepted = runCli([
      "--actor-kind",
      "claude",
      "loop",
      "poll",
      "--dry-run",
      "--workspace",
      "shared",
      "--state-dir",
      stateDir,
    ]);
    assert.notEqual(accepted.status, 2, accepted.stderr);
    assert.doesNotMatch(accepted.stderr, /unknown option --workspace/);

    const refused = runCli([
      "--actor-kind",
      "claude",
      "loop",
      "poll",
      "--dry-run",
      "--workspace",
      "bogus",
      "--state-dir",
      stateDir,
    ]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /worktree or shared/);
  });

  it("answers --help for the group and every verb", () => {
    const group = runCli(["loop", "--help"], { noIdentity: true });
    assert.equal(group.status, 0);
    for (const verb of VERBS) assert.match(group.stdout, new RegExp(`\\b${verb}\\b`));

    for (const verb of VERBS) {
      const page = runCli(["loop", verb, "--help"], { noIdentity: true });
      assert.equal(page.status, 0, `${verb}: ${page.stderr}`);
      assert.match(page.stdout, new RegExp(`Usage: taskctl loop ${verb}`));
    }
  });
});

describe("cli/commands/loop — status", () => {
  it("reports the runtime verdict with the board down", () => {
    const stateDir = makeTempDir("meerkat-taskpanel-loop-state-");
    const result = runCli(["loop", "status", "--json", "--state-dir", stateDir], {
      actorKind: "claude",
      noUrl: true,
      env: { TASKD_NO_AUTOSTART: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const data = parseJson(result);
    assert.equal(typeof data.verdict, "string");
    assert.equal(typeof data.pool.live, "boolean");
    // `--state-dir` derives the registry file inside the directory, so the
    // verdict cannot read a developer's real loop state.
    assert.equal(data.pool.file, join(stateDir, "sessions.state.json"));
  });
});

describe("cli/commands/loop — doctor", () => {
  it("reports without an identity, and never writes to the board", () => {
    const dir = makeTempDir("meerkat-taskpanel-loop-doctor-");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "sentinel.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(process.env.TP_DOCTOR_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) {",
        '  process.stdout.write(`${JSON.stringify({ ok: true, data: { version: "0.1.0", schema_version: 4 } })}\\n`);',
        "} else {",
        "  process.stdout.write(`${JSON.stringify({ ok: true, data: { tasks: [",
        '    { identifier: "T-1", status: "in_progress", heartbeat_at: null },',
        "  ] } })}\\n`);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = runCli(
      [
        "loop",
        "doctor",
        "--json",
        "--cli",
        script,
        "--state-dir",
        join(dir, "state"),
        "--log",
        join(dir, "loop.log"),
      ],
      { noIdentity: true, noUrl: true, env: { TP_DOCTOR_CALLS: record } },
    );

    assert.equal(result.status, 0, result.stderr);
    const data = parseJson(result);
    assert.equal(data.read_only, true);
    assert.equal(data.data, undefined, "the loop's verbs print their own JSON, not the envelope");
    assert.equal(typeof data.supervisor.verdict, "string");
    assert.equal(data.compat, undefined, "the report carries no board-interface verdict");
    assert.equal(data.queue.depth, 0, "a fresh state directory is empty, not an error");
    assert.equal(data.log.missing, true, "a log that was never written is not an error");
    assert.deepEqual(data.stuck_cards.in_progress.map((card) => card.ref), ["T-1"]);
    assert.deepEqual(data.errors, []);
    assert.equal(data.ok, true);

    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const writes = calls.filter((args) => /\b(move|claim|deliver|add|update|create)\b/.test(args.join(" ")));
    assert.deepEqual(writes, [], "the doctor never writes to the board");
  });
});

describe("cli/commands/loop — the moved entries", () => {
  /** A board stand-in that records argv and answers every read with empty data. */
  function sentinel(dir) {
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "sentinel.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        'process.stdout.write(`${JSON.stringify({ ok: true, data: { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} }, sla: [] } })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    return { script, record };
  }

  it("tick --passes runs exactly the listed passes, in order", () => {
    const dir = makeTempDir("meerkat-taskpanel-loop-tick-");
    const { script, record } = sentinel(dir);
    const result = runCli(
      [
        "loop",
        "tick",
        "--passes",
        "patrol,workflow",
        "--dry-run",
        "--cli",
        script,
        "--repo",
        dir,
        "--state-dir",
        join(dir, "state"),
        "--log",
        join(dir, "loop.log"),
      ],
      { actorKind: "claude", noUrl: true, env: { TP_SENTINEL: record } },
    );
    assert.equal(result.status, 0, result.stderr);

    const calls = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const sla = calls.findIndex((args) => args.includes("sla"));
    const reconcile = calls.findIndex((args) => args.includes("reconcile"));
    assert.ok(sla !== -1, "patrol must read the SLA rows");
    assert.ok(reconcile !== -1, "workflow must ask the board for its plan");
    assert.ok(sla < reconcile, "patrol runs before workflow");
    // `--passes` is honoured: poll was not listed, so nothing claimed.
    assert.equal(calls.some((args) => args.includes("claim")), false);
  });

  it("run --ping-once is one clock, and both one-shots together are refused", () => {
    const dir = makeTempDir("meerkat-taskpanel-loop-run-");
    const ping = runCli(
      ["loop", "run", "--ping-once", "--state-dir", dir, "--log", join(dir, "loop.log")],
      { actorKind: "claude", noUrl: true },
    );
    assert.equal(ping.status, 0, ping.stderr);

    const both = runCli(
      ["loop", "run", "--ping-once", "--continue-once", "--state-dir", dir],
      { actorKind: "claude", noUrl: true },
    );
    assert.equal(both.status, 2);
    assert.match(both.stderr, /choose --ping-once or --continue-once/);
  });
});

describe("cli/commands/loop — the retired board-interface gate", () => {
  it("no longer answers `loop compat`", () => {
    const result = runCli(["loop", "compat"], { noIdentity: true });
    assert.equal(result.status, 2, "an unknown verb is usage, not a verdict");
    assert.match(result.stderr, /unknown command/);
  });

  it("no longer advertises the verb, or a `--quiet` it was the only user of", () => {
    const group = runCli(["loop", "--help"], { noIdentity: true });
    assert.equal(group.status, 0);
    assert.doesNotMatch(group.stdout, /\bcompat\b/);

    const quiet = runCli(["loop", "doctor", "--quiet"], { noIdentity: true });
    assert.equal(quiet.status, 2);
    assert.match(quiet.stderr, /--quiet/);
  });
});
