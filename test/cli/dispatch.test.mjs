/**
 * Step 7: the entry point — dispatch, help routing and output discipline (V1).
 *
 * Three things are asserted here and nowhere else:
 *
 *   * **help is generated from the registry**, so `taskctl --help` names every
 *     group and `taskctl <group> --help` names every command in it (card A1);
 *   * **help and version never need a board** — they must work before any
 *     process is spawned or any data directory exists;
 *   * the token never appears on either stream, whatever the command did.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, closedPortUrl, runCli, withCli } from "./helpers/cli-harness.mjs";
import { allCommands, groups } from "../../src/cli/commands/index.mjs";

after(cleanupTempDirs);

describe("cli/dispatch — help", () => {
  it("lists every group at the top level", () => {
    const run = runCli(["--help"], { noUrl: true });
    assert.equal(run.status, 0, run.stderr);
    for (const group of groups) {
      assert.match(run.stdout, new RegExp(`\\b${group.name}\\b`), `missing group ${group.name}`);
    }
    assert.match(run.stdout, /Global options:/);
  });

  it("names every command of a group, and every group has one", () => {
    for (const group of groups) {
      assert.ok(group.commands.length > 0, `${group.name} has no commands`);
      const run = runCli([group.name, "--help"], { noUrl: true });
      assert.equal(run.status, 0, run.stderr);
      for (const command of group.commands) {
        assert.match(run.stdout, new RegExp(`\\b${command.name}\\b`), `missing ${group.name} ${command.name}`);
      }
    }
  });

  it("prints per-command usage and its options, exit 0", () => {
    for (const { group, command } of allCommands()) {
      const run = runCli([group.name, command.name, "--help"], { noUrl: true });
      assert.equal(run.status, 0, `${group.name} ${command.name}: ${run.stderr}`);
      assert.match(run.stdout, /^Usage: taskctl /m);
    }
  });

  it("does not need a board: help works with autostart forbidden and no data dir", () => {
    const run = runCli(["--help"], { noUrl: true, env: { TASKD_NO_AUTOSTART: "1" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
  });

  it("explains an unknown group and an unknown command, exit 2", () => {
    const bad = runCli(["nope"], { noUrl: true });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /CLI_USAGE/);
    assert.match(bad.stderr, /unknown command "nope"/);
    assert.match(bad.stderr, /taskctl --help/);

    const worse = runCli(["issue", "nope"], { noUrl: true });
    assert.equal(worse.status, 2);
    assert.match(worse.stderr, /issue --help/);
  });

  it("explains an unknown flag, and refuses a missing required flag", () => {
    const unknown = runCli(["issue", "get", "X", "--bogus"], { noUrl: true });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option --bogus/);

    const missing = runCli(["issue", "create", "--title", "x"], { noUrl: true });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--project is required/);
  });
});

describe("cli/dispatch — output routing", () => {
  it("puts --json success on stdout, and nothing but warnings on stderr", async () => {
    await withCli(async ({ run }) => {
      const result = run(["project", "list", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout).ok, true);
    });
  });

  it("puts --json failures on stdout as well, so a pipe only needs one stream", async () => {
    await withCli(async ({ run }) => {
      const result = run(["issue", "get", "NOPE-0001", "--json"]);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "NOT_FOUND");
      assert.equal(envelope.error.http, 404);
    });
  });

  it("keeps human failures on stderr and leaves stdout clean", async () => {
    await withCli(async ({ run }) => {
      const result = run(["issue", "get", "NOPE-0001"]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^NOT_FOUND: /);
    });
  });

  it("never prints a token, whichever stream it uses", async () => {
    const token = `td_${"cd".repeat(32)}`;
    const dead = await closedPortUrl();
    // A --token sent to a board that is not there exercises the error path
    // *with* a secret in hand — the exact case a careless message leaks.
    for (const args of [["project", "list"], ["project", "list", "--json"]]) {
      const result = runCli(args, { url: dead, token });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout.includes(token), false, `stdout leaked: ${result.stdout}`);
      assert.equal(result.stderr.includes(token), false, `stderr leaked: ${result.stderr}`);
    }
  });

  it("reports where the token came from, without ever reporting the token", async () => {
    const token = `td_${"ef".repeat(32)}`;
    await withCli(async ({ run }) => {
      const result = run(["project", "list", "--json"], { token });
      const data = JSON.parse(result.stdout).data;
      assert.equal(data.token_source, "env");
      assert.equal(result.stdout.includes(token), false);
    });
  });

  it("adds token_source to a failure too, so the diagnostic survives", async () => {
    const token = `td_${"12".repeat(32)}`;
    const dead = await closedPortUrl();
    // `--token` on the line, not in the environment: the ladder is the point, so
    // the *first* rung is the one that has to survive a failed call.
    const result = runCli(["project", "list", "--json", "--token", token], { url: dead });
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "CLI_IO");
    assert.equal(envelope.error.details.token_source, "flag");
    assert.equal(result.stdout.includes(token), false);
  });

  it("fails clearly when the board is unreachable (CLI_IO, exit 1)", async () => {
    const dead = await closedPortUrl();
    const result = runCli(["project", "list", "--json"], { url: dead });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "CLI_IO");
    assert.equal(envelope.error.details.token_source, "none");
    assert.match(envelope.error.message, /cannot reach the board/);
  });
});
