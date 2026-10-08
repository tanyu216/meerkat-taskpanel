/**
 * Step 4: the argument parser (V1).
 *
 * The parser is a pure function over `(argv, registry)`, so it is tested with a
 * small fixture registry rather than the real one — what is under test is the
 * *syntax*, not the command list. Everything it refuses must be `CLI_USAGE`
 * (exit 2), never a runtime error.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { parseArgv, tokenize } from "../../src/cli/argv.mjs";

const REGISTRY = {
  groups: [
    {
      name: "issue",
      summary: "Tasks.",
      commands: [
        {
          name: "deliver",
          summary: "Write a report and move to in_review.",
          usage: "issue deliver <id> [--report-file <file|->] [--if-version <n>]",
          positionals: [{ name: "id" }],
          flags: [
            { flag: "report-file", key: "reportFile", as: "string", value: "<file|->" },
            { flag: "no-report", key: "noReport", as: "boolean" },
            { flag: "reason", key: "reason", as: "string" },
          ],
        },
        {
          name: "move",
          summary: "Move a task.",
          usage: "issue move <id> <status>",
          positionals: [{ name: "id" }, { name: "to" }],
          flags: [{ flag: "no-report", key: "noReport", as: "boolean" }],
        },
        {
          name: "get",
          summary: "Read one task.",
          usage: "issue get <id>",
          positionals: [{ name: "id" }],
          flags: [],
        },
        {
          name: "create",
          summary: "Create a task.",
          usage: "issue create --project <id> --title <text>",
          positionals: [],
          flags: [
            { flag: "meta", key: "meta", as: "kv" },
            { flag: "label", key: "labels", as: "string", repeat: true },
            { flag: "acceptance", key: "acceptance", as: "string", repeat: true },
          ],
        },
      ],
    },
    { name: "project", summary: "Projects.", commands: [{ name: "list", summary: "List.", usage: "project list", positionals: [] }] },
  ],
};

const parse = (argv) => parseArgv(argv, REGISTRY);

/** Assert the parse fails as a usage error and return the error. */
function usageFailure(argv) {
  try {
    parseArgv(argv, REGISTRY);
  } catch (err) {
    assert.equal(err.code, "CLI_USAGE", `expected CLI_USAGE, got ${err.code}: ${err.message}`);
    assert.equal(err.http, 400);
    return err;
  }
  throw new Error(`expected ${argv.join(" ")} to be rejected`);
}

describe("cli/argv — tokenize", () => {
  it("splits positionals from flags, with or without =", () => {
    const { positionals, flags } = tokenize(["issue", "get", "PROJ-0001", "--json", "--limit=5"]);
    assert.deepEqual(positionals, ["issue", "get", "PROJ-0001"]);
    assert.deepEqual(flags.get("json"), [true]);
    assert.deepEqual(flags.get("limit"), ["5"]);
  });

  it("treats a boolean flag as boolean and does not swallow the next token", () => {
    const { positionals, flags } = tokenize(["issue", "move", "PROJ-0001", "in_review", "--no-report"]);
    assert.deepEqual(positionals, ["issue", "move", "PROJ-0001", "in_review"]);
    assert.deepEqual(flags.get("no-report"), [true]);
  });

  it("accepts - as a value (stdin) and -- to end the flags", () => {
    assert.deepEqual(tokenize(["--report-file", "-"]).flags.get("report-file"), ["-"]);
    const { positionals, flags } = tokenize(["--", "--not-a-flag", "x"]);
    assert.deepEqual(positionals, ["--not-a-flag", "x"]);
    assert.equal(flags.size, 0);
  });
});

describe("cli/argv — parseArgv", () => {
  it("accepts a global flag in any position", () => {
    for (const argv of [
      ["--json", "issue", "get", "PROJ-1"],
      ["issue", "--json", "get", "PROJ-1"],
      ["issue", "get", "--json", "PROJ-1"],
      ["issue", "get", "PROJ-1", "--json"],
    ]) {
      const parsed = parseArgv(argv, REGISTRY);
      assert.equal(parsed.flags.json, true, argv.join(" "));
      assert.equal(parsed.group.name, "issue");
      assert.equal(parsed.command.name, "get");
      assert.deepEqual(parsed.commandArgs, { id: "PROJ-1" });
    }
  });

  it("coerces numbers and kv pairs, and collects repeatable flags", () => {
    const parsed = parseArgv(
      ["issue", "create", "--meta", "a=1", "--meta", "b=two", "--label", "x", "--label", "y", "--if-version", "7"],
      REGISTRY,
    );
    assert.deepEqual(parsed.flags.meta, { a: "1", b: "two" });
    assert.deepEqual(parsed.flags.labels, ["x", "y"]);
    assert.equal(parsed.flags.ifVersion, 7);
  });

  it("records the last value when a non-repeatable flag is given twice", () => {
    const parsed = parseArgv(
      ["issue", "deliver", "PROJ-1", "--report-file", "a.json", "--report-file", "-"],
      REGISTRY,
    );
    assert.equal(parsed.flags.reportFile, "-");
  });

  it("binds positionals to the declared slots", () => {
    const parsed = parseArgv(["issue", "move", "PROJ-0001", "in_review", "--no-report"], REGISTRY);
    assert.deepEqual(parsed.commandArgs, { id: "PROJ-0001", to: "in_review" });
    assert.equal(parsed.flags.noReport, true);
  });

  it("rejects unknown commands, unknown flags and missing arguments", () => {
    usageFailure(["nope", "list"]);
    usageFailure(["issue", "nope"]);
    usageFailure(["issue", "get", "PROJ-1", "--bogus"]);
    usageFailure(["issue", "get"]);
    usageFailure(["issue", "get", "PROJ-1", "extra"]);
    usageFailure(["project", "list", "extra"]);
    usageFailure(["issue", "deliver", "PROJ-1", "--report-file"]);
  });

  it("explains the fix for the two most common mistakes", () => {
    assert.match(usageFailure(["nope"]).hint.fix, /taskctl --help/);
    assert.match(usageFailure(["issue", "get", "PROJ-1", "--bogus"]).hint.fix, /issue get --help/);
  });

  it("routes --help and --version without a command", () => {
    assert.equal(parse(["--help"]).wantedHelp, true);
    assert.equal(parse(["--help"]).group, null);
    assert.equal(parse(["issue", "--help"]).group.name, "issue");
    assert.equal(parse(["issue", "--help"]).command, null);
    assert.equal(parse(["issue", "get", "--help"]).command.name, "get");
    assert.equal(parse(["-h"]).wantedHelp, true);
    assert.equal(parse(["--version"]).version, true);
    assert.equal(parse(["issue", "get", "PROJ-1", "--version"]).version, true);
  });

  it("treats an empty invocation as help, not as an error", () => {
    const parsed = parseArgv([], REGISTRY);
    assert.equal(parsed.wantedHelp, true);
    assert.equal(parsed.group, null);
  });
});
