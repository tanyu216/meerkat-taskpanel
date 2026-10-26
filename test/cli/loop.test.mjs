/**
 * `taskctl loop …` — the command surface and its two board-free verbs.
 *
 * The migration's honesty hinges on three things this file pins:
 *
 *   1. the ten verbs are registered as *local* commands (no board connect
 *      happens before the handler runs — `loop status` must answer with the
 *      board down);
 *   2. the two globals the loop cannot honour (`--as-human`, `--session-id`,
 *      `--if-version`) are refused, and a mutating verb without
 *      `--actor-kind` is a usage error, not a board call;
 *   3. `loop compat` still makes the same three-way decision the retired
 *      `board-check.mjs` made (0 compatible, 2 usage, 3 no verdict).
 */

import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { COMMANDS } from "../../src/cli/commands/loop.mjs";
import { VERSION } from "../../src/foundation/constants.mjs";
import {
  ROOT,
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
  "status",
  "run",
  "subscribe",
  "session",
  "compat",
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

describe("cli/commands/loop — compat", () => {
  it("accepts this tree as a board", () => {
    const result = runCli(["loop", "compat", "--repo", ROOT, "--json"], {
      actorKind: "claude",
      noUrl: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const data = parseJson(result);
    assert.equal(data.ok, true);
    assert.equal(data.version, VERSION);
    assert.equal(data.boardInterface, "task-interface v1");
  });

  it("treats a named-but-missing --cli as usage, not a verdict", () => {
    const result = runCli(["loop", "compat", "--cli", join(makeTempDir(), "nope")], {
      actorKind: "claude",
      noUrl: true,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--cli not found/);
  });

  it("exits 3 for a board below the floor", () => {
    const dir = makeTempDir("meerkat-taskpanel-old-board-");
    const board = join(dir, "board.js");
    writeFileSync(
      board,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, data: { version: \"1.0.0\", schema_version: 1 } }));\n",
    );
    chmodSync(board, 0o755);

    const old = runCli(["loop", "compat", "--cli", board, "--json"], { actorKind: "claude", noUrl: true });
    assert.equal(old.status, 3, old.stderr);
    const data = parseJson(old);
    assert.equal(data.ok, false);
    assert.equal(data.code, "BOARD_TOO_OLD");

    // `--quiet` changes only the success line, never the verdict.
    const quiet = runCli(["loop", "compat", "--repo", ROOT, "--quiet"], { actorKind: "claude", noUrl: true });
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
  });
});
