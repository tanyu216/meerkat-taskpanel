/**
 * The CLI is quiet by default: stdout is the data plane and stderr is the
 * product's error surface, so a diagnostic line appears only when
 * `TASKD_LOG_LEVEL=debug` asks for one — and never on stdout, never with argv
 * (which is where `--token` lives).
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { run } from "../../src/cli/index.mjs";

const TOKEN = `td_${"e".repeat(64)}`;

async function cli(argv, env = {}) {
  const stdout = [];
  const stderr = [];
  const code = await run(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("cli/logging — diagnostics are opt-in", () => {
  it("writes nothing extra by default", async () => {
    const result = await cli(["--version"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it("writes cli_command on stderr when debug is asked for", async () => {
    const quiet = await cli(["--version"]);
    const loud = await cli(["--version"], { TASKD_LOG_LEVEL: "debug" });
    assert.equal(loud.stdout, quiet.stdout, "stdout is byte-identical");
    assert.match(loud.stderr, / DEBUG event=cli_command service=taskctl command=null group=null/);
  });

  it("never repeats the rendered failure, and still logs the code", async () => {
    const result = await cli(["no-such-command"], { TASKD_LOG_LEVEL: "debug" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /event=cli_failure/);
    assert.match(result.stderr, /code=CLI_USAGE/);
    // The product error is still emitted exactly once, by the renderer.
    assert.equal(result.stderr.match(/CLI_USAGE/g).length, 2, "the log line plus the rendered one");
  });

  it("never logs argv or a token", async () => {
    const result = await cli(["--version", "--token", TOKEN], { TASKD_LOG_LEVEL: "debug" });
    assert.doesNotMatch(result.stderr, /td_e{64}/);
    assert.doesNotMatch(result.stderr, /--token/);
  });

  it("keeps a --json document byte-identical with logging on", async () => {
    const quiet = await cli(["--version", "--json"]);
    const loud = await cli(["--version", "--json"], { TASKD_LOG_LEVEL: "debug" });
    assert.equal(loud.stdout, quiet.stdout);
    assert.match(loud.stderr, /event=cli_command/);
  });

  it("stays silent at info, because every CLI event is debug", async () => {
    const result = await cli(["--version"], { TASKD_LOG_LEVEL: "info" });
    assert.equal(result.stderr, "");
  });
});
