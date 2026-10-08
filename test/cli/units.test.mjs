/**
 * Step 7/15: the pieces a black-box CLI test cannot reach.
 *
 * `index.mjs` exposes `run(argv, io)` — the whole program with the streams
 * injected — so the dispatch path, the error path and the two tiny helpers
 * (`wantsJson`, `readStdin`) can be driven without a process boundary. The
 * renderers and the registry get the same treatment: they are pure, and their
 * edges (a command with no options, a boolean flag in help, an empty list) are
 * exactly the ones a real invocation rarely hits.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { createContext, readStdin, run, wantsJson } from "../../src/cli/index.mjs";
import { COMMANDS as tokenCommands } from "../../src/cli/commands/token.mjs";
import { allCommands, groups, registry } from "../../src/cli/commands/index.mjs";
import { actorLabel, fields, orNone, table, taskLine } from "../../src/cli/output/human.mjs";
import { commandSynopsis, flagSynopsis, commandUsage, groupUsage, topLevelUsage, versionLine } from "../../src/cli/usage.mjs";
import { VERSION } from "../../src/shared/constants.mjs";

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A capture pair for `run(argv, io)`. */
function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

describe("cli/index — the program, with injected streams", () => {
  it("recognises --json in both spellings", () => {
    assert.equal(wantsJson(["--json"]), true);
    assert.equal(wantsJson(["--json=true"]), true);
    assert.equal(wantsJson(["issue", "get", "X", "--json"]), true);
    assert.equal(wantsJson(["issue", "get", "X"]), false);
  });

  it("reads stdin to the end", async () => {
    assert.equal(await readStdin(Readable.from(["a", "b", "c"])), "abc");
    assert.equal(await readStdin(Readable.from([])), "");
  });

  it("builds a command context from the parsed flags", () => {
    const parsed = { flags: { agentPlatform: "claude", sessionId: "s-1" }, commandArgs: { ref: "X" } };
    const ctx = createContext(parsed, {
      client: { get() {} },
      env: {},
      cwd: "/tmp",
      stdin: async () => "hi",
      readFile: () => "file",
    });
    assert.deepEqual(ctx.actor, { kind: "agent", id: "s-1" });
    assert.equal(ctx.session, "s-1");
    assert.deepEqual(ctx.args, { ref: "X" });
    assert.equal(ctx.cwd, "/tmp");
  });

  it("prints the version and exits 0, with no board anywhere", async () => {
    const cap = capture();
    assert.equal(await run(["--version"], cap.io), 0);
    assert.equal(cap.out.join(""), `${VERSION}\n`);
    assert.deepEqual(cap.err, []);
  });

  it("prints help for the whole CLI, a group and a command, all exit 0", async () => {
    for (const argv of [[], ["--help"], ["issue"], ["issue", "--help"], ["issue", "deliver", "--help"]]) {
      const cap = capture();
      assert.equal(await run(argv, cap.io), 0, argv.join(" "));
      assert.match(cap.out.join(""), /^Usage: taskctl /);
    }
  });

  it("reports a usage failure on the chosen stream, with the right exit code", async () => {
    const human = capture();
    assert.equal(await run(["nope"], human.io), 2);
    assert.match(human.err.join(""), /^CLI_USAGE: /);

    const json = capture();
    assert.equal(await run(["nope", "--json"], json.io), 2);
    assert.equal(json.err.join(""), "");
    assert.equal(JSON.parse(json.out.join("")).error.code, "CLI_USAGE");
  });

  it("reports a runtime failure on the chosen stream, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskpanel-unit-"));
    tempDirs.push(dir);
    const env = { TASKD_NO_AUTOSTART: "1", TASKD_DATA_DIR: dir, TASKD_RUNTIME_POINTER: join(dir, "runtime.json") };

    const human = capture();
    assert.equal(await run(["project", "list"], { ...human.io, env }), 1);
    assert.match(human.err.join(""), /^CLI_IO: /);

    const json = capture();
    assert.equal(await run(["project", "list", "--json"], { ...json.io, env }), 1);
    const envelope = JSON.parse(json.out.join(""));
    assert.equal(envelope.error.code, "CLI_IO");
    assert.equal(envelope.error.details.token_source, "none");
  });
});

describe("cli/commands — the registry", () => {
  it("names the card's groups, and no dictionary management command", () => {
    assert.deepEqual(
      groups.map((group) => group.name),
      ["project", "context", "issue", "comment", "relation", "session", "assignees", "reporters", "report", "export", "token"],
    );
    for (const { group, command } of allCommands()) {
      assert.equal(/^(add|rm|remove|rename)$/.test(command.name) && /assignees|reporters/.test(group.name), false);
    }
  });

  it("has a run handler and a summary for every command", () => {
    for (const { group, command } of allCommands()) {
      assert.equal(typeof command.run, "function", `${group.name} ${command.name} has no run()`);
      assert.equal(typeof command.summary, "string");
      assert.ok(command.summary.length > 0);
      assert.equal(typeof command.usage, "string");
    }
  });

  it("never lets a command redeclare a global flag", () => {
    const globalNames = new Set(registry.globals.map((spec) => spec.flag));
    for (const { group, command } of allCommands()) {
      for (const spec of command.flags ?? []) {
        assert.equal(globalNames.has(spec.flag), false, `${group.name} ${command.name} redeclares --${spec.flag}`);
        assert.equal(typeof spec.key, "string", `${group.name} ${command.name} --${spec.flag} has no key`);
      }
    }
  });

  it("declares each flag at most once per command", () => {
    for (const { group, command } of allCommands()) {
      const names = (command.flags ?? []).map((spec) => spec.flag);
      assert.equal(new Set(names).size, names.length, `${group.name} ${command.name} repeats a flag`);
    }
  });
});

describe("cli/commands/token — the defensive branch", () => {
  const rotate = tokenCommands.find((command) => command.name === "rotate");

  it("reports no token when the service names no file", async () => {
    const result = await rotate.run({ client: { post: async () => ({ token_file: null }) }, flags: {} });
    assert.equal(result.data.token_file, null);
    assert.equal(result.data.token, null);
    assert.equal(result.data.rotated, true);
  });
});

describe("cli/usage", () => {
  it("writes a flag synopsis for every shape", () => {
    assert.equal(flagSynopsis({ flag: "json", as: "boolean" }), "--json");
    assert.equal(flagSynopsis({ flag: "help", as: "boolean", short: "-h" }), "-h, --help");
    assert.equal(flagSynopsis({ flag: "url" }), "--url <value>");
    assert.equal(flagSynopsis({ flag: "file", value: "<file|->" }), "--file <file|->");
  });

  it("renders a synopsis for required and optional positionals", () => {
    const group = { name: "issue" };
    assert.equal(
      commandSynopsis(group, { name: "get", positionals: [{ name: "ref" }] }),
      "taskctl issue get <ref> [options]",
    );
    assert.equal(
      commandSynopsis(group, { name: "list", positionals: [{ name: "x", required: false }] }),
      "taskctl issue list [<x>] [options]",
    );
    assert.equal(commandSynopsis(group, { name: "list" }), "taskctl issue list [options]");
  });

  it("prints the version line and a whole command's help", () => {
    assert.equal(versionLine(), `${VERSION}\n`);
    const text = commandUsage(
      { name: "issue" },
      {
        name: "get",
        summary: "Read one task.",
        positionals: [{ name: "ref", summary: "Task id." }],
        flags: [{ flag: "verbose", as: "boolean", summary: "Chatty." }],
      },
    );
    assert.match(text, /^Usage: taskctl issue get <ref> \[options\]/);
    assert.match(text, /Arguments:/);
    assert.match(text, /Options:/);
    assert.match(text, /Global options:/);

    // A command with nothing of its own still gets a usable page.
    const bare = commandUsage({ name: "context" }, { name: "current", summary: "Where am I?" });
    assert.match(bare, /Global options:/);
    assert.doesNotMatch(bare, /Arguments:/);
  });

  it("lists a group's commands", () => {
    const text = groupUsage({ name: "issue", summary: "Tasks.", commands: [{ name: "get", summary: "Read one.", positionals: [] }] });
    assert.match(text, /Commands:/);
    assert.match(text, /get/);
  });

  it("lists every group at the top level for every registry", () => {
    const text = topLevelUsage(registry);
    assert.match(text, /Groups:/);
    for (const group of groups) assert.match(text, new RegExp(group.name));
  });
});

describe("cli/output/human", () => {
  it("renders fields, tables and task lines", () => {
    assert.equal(fields([["a", 1], ["bb", null]]), "a   1\nbb  -");
    assert.equal(table(["only"], [["x"]]), "only\nx");
    assert.equal(table(["a", "b"], [[null, undefined]]), "a  b\n-  -");
    assert.equal(orNone([]), "none");
    assert.equal(orNone(["x", "y"]), "x\ny");
    assert.equal(actorLabel({ id: "a", display_name: "linus" }), "linus#a");
    assert.equal(actorLabel({ id: "a" }), "a#a");
    assert.equal(actorLabel(null), "-");

    const line = taskLine({
      identifier: "DEMO-0001",
      status: "todo",
      priority: "high",
      assignee: null,
      reporter: { id: "r", display_name: "elon" },
    });
    assert.equal(line, "DEMO-0001  todo  high  -  elon#r");
  });
});
