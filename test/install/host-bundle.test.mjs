/**
 * Host-bundle install contract: `install.sh --target claude` / `--target codex`.
 *
 * The two bundle hosts now deploy more than a skill — MCP registration, host config,
 * slash commands (Claude) / a claim trigger (Codex), and a `taskctl` shim that pins the
 * agent identity. These tests pin that contract under an isolated home
 * (`MEERKAT_TASKPANEL_TARGET_HOME`), and in particular the two "never clobber" rules the rest of
 * the installer relies on:
 *
 *   - idempotent: re-running with the same inputs leaves every file byte-identical;
 *   - merge-style: pre-existing settings.json / AGENTS.md content survives untouched.
 *
 * The MCP registration runs the host CLI (`claude mcp add …` / `codex mcp add …`). The
 * host CLIs are *not* guaranteed to be present (they are not in the verification image),
 * so the invocation contract is tested with fake CLIs on PATH — deterministic everywhere —
 * and the two "real CLI" branches (registration actually lands / the CLI is absent so the
 * exact manual command is printed) are each asserted only where they are reachable.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { mergeSettings } from "../../scripts/install/lib/apply.mjs";
import { VERSION } from "../../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];

function makeTempDir(prefix = "meerkat-taskpanel-hostbundle-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runInstall(args, env = {}) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Absolute path of a command on PATH, or null when absent. */
function whichBin(name) {
  const run = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const path = run.stdout.trim();
  return path ? path : null;
}

const haveClaude = whichBin("claude") !== null;
const haveCodex = whichBin("codex") !== null;

/**
 * Write an executable fake `<name>` CLI into `binDir` that records its argv plus the
 * HOME / CODEX_HOME it was invoked with to `$FAKE_LOG`, and exits `$FAKE_EXIT` (0 by
 * default) after printing `$FAKE_STDOUT` / `$FAKE_STDERR`. Used to pin the exact MCP
 * registration command without depending on a real host CLI being installed.
 */
function makeFakeCli(binDir, name) {
  const script = [
    "#!/usr/bin/env bash",
    "{",
    "  printf 'argv:'; for a in \"$@\"; do printf ' <%s>' \"$a\"; done; printf '\\n'",
    "  printf 'HOME=%s\\n' \"${HOME-}\"",
    "  printf 'CODEX_HOME=%s\\n' \"${CODEX_HOME-}\"",
    "} >> \"${FAKE_LOG:-/dev/null}\"",
    "printf '%s\\n' \"${FAKE_STDOUT:-}\"",
    "if [ -n \"${FAKE_STDERR:-}\" ]; then printf '%s\\n' \"$FAKE_STDERR\" >&2; fi",
    "exit \"${FAKE_EXIT:-0}\"",
    "",
  ].join("\n");
  const dest = join(binDir, name);
  writeFileSync(dest, script, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

/** Env for an install that sees fake `claude`/`codex` on PATH and logs to `log`. */
function fakeCliEnv(home, bin, log, extra = {}) {
  return {
    ...process.env,
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    FAKE_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
    ...extra,
  };
}

/** A plain object mapping each file path (relative to `dir`) to its contents. */
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out[relative(dir, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return out;
}

function isExecutable(path) {
  return (statSync(path).mode & 0o111) !== 0;
}

// ---------------------------------------------------------------------------
// mergeSettings — the merge contract, unit-level
// ---------------------------------------------------------------------------

describe("host bundle: mergeSettings", () => {
  it("adds env.TASKCTL_AGENT + a SessionStart hook and preserves every other key", () => {
    const { data, changed } = mergeSettings(
      {
        permissions: { allow: ["Read"] },
        env: { OTHER: "keep-me" },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      },
      { agent: "alice", hookCommand: "/home/alice/.claude/hooks/meerkat-taskpanel-session-start.sh" },
    );

    assert.equal(changed, true);
    assert.equal(data.env.TASKCTL_AGENT, "alice");
    assert.equal(data.env.OTHER, "keep-me");
    assert.deepEqual(data.permissions, { allow: ["Read"] });
    assert.equal(data.hooks.PreToolUse.length, 1);
    assert.equal(data.hooks.SessionStart.length, 1);
    assert.equal(
      data.hooks.SessionStart[0].hooks[0].command,
      "/home/alice/.claude/hooks/meerkat-taskpanel-session-start.sh",
    );
  });

  it("is idempotent: a second merge with the same inputs changes nothing", () => {
    const first = mergeSettings({}, { agent: "alice", hookCommand: "/h.sh" });
    assert.equal(first.changed, true);

    const second = mergeSettings(first.data, { agent: "alice", hookCommand: "/h.sh" });
    assert.equal(second.changed, false);
    assert.equal(second.data.hooks.SessionStart.length, 1);
  });

  it("--force replaces the managed agent and hook without duplicating the hook", () => {
    const first = mergeSettings({}, { agent: "alice", hookCommand: "/h.sh" });
    const forced = mergeSettings(first.data, { agent: "bob", hookCommand: "/h.sh", force: true });

    assert.equal(forced.data.env.TASKCTL_AGENT, "bob");
    assert.equal(forced.data.hooks.SessionStart.length, 1);
  });

  it("leaves a malformed env shape untouched rather than clobbering it", () => {
    const { data } = mergeSettings(
      { env: ["not-an-object"], hooks: {} },
      { agent: "alice", hookCommand: "/h.sh" },
    );
    assert.deepEqual(data.env, ["not-an-object"]);
    assert.equal(data.hooks.SessionStart.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Claude bundle
// ---------------------------------------------------------------------------

describe("host bundle: claude", () => {
  it("deploys skill + settings + hook + shim + slash commands and registers MCP", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const log = join(bin, "claude.log");
    makeFakeCli(bin, "claude");

    const run = runInstall(["--target", "claude", "--agent-name", "alice"], fakeCliEnv(home, bin, log));
    assert.equal(run.status, 0, run.stderr);

    // 1. skill
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat-taskpanel", "SKILL.md")), "skill missing");

    // 2. settings.json — merged identity + SessionStart
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "alice");
    const start = settings.hooks.SessionStart;
    assert.equal(start.length, 1);
    assert.equal(start[0].hooks[0].type, "command");
    assert.ok(start[0].hooks[0].command.endsWith(".claude/hooks/meerkat-taskpanel-session-start.sh"));

    // 3. hook script (executable, rendered, restates the eight rules)
    const hook = join(home, ".claude", "hooks", "meerkat-taskpanel-session-start.sh");
    assert.ok(isExecutable(hook), "hook must be executable");
    const hookText = readFileSync(hook, "utf8");
    assert.match(hookText, /分给我的待领卡/);
    assert.match(hookText, /八条规矩/);
    assert.ok(!hookText.includes("{{"), "template tokens must be rendered");

    // 4. shim (executable, injects --agent)
    const shim = join(home, ".claude", "bin", "taskctl");
    assert.ok(isExecutable(shim), "shim must be executable");
    const shimText = readFileSync(shim, "utf8");
    assert.ok(shimText.includes('agent="${TASKCTL_AGENT:-alice}"'), shimText);
    assert.ok(shimText.includes('--agent "$agent"'), shimText);
    assert.ok(!shimText.includes("{{"), "template tokens must be rendered");

    // 5. slash commands
    for (const name of ["board", "claim", "deliver"]) {
      const cmd = join(home, ".claude", "commands", `${name}.md`);
      assert.ok(existsSync(cmd), `${name}.md missing`);
      assert.ok(!readFileSync(cmd, "utf8").includes("{{"), `${name}.md has unrendered tokens`);
    }

    // 6. MCP registration — the exact command, run against the isolated home
    const argvLine = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("argv:"));
    assert.match(argvLine, /^argv: <mcp> <add> <meerkat-taskpanel> <--> <node> <.*\/src\/mcp\/main\.mjs>$/);
    assert.ok(readFileSync(log, "utf8").includes(`HOME=${home}`));
  });

  it("preserves pre-existing settings.json keys and hooks", () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          env: { OTHER_VAR: "keep-me" },
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      fakeCliEnv(home, bin, join(bin, "log")),
    );
    assert.equal(run.status, 0, run.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.equal(settings.env.OTHER_VAR, "keep-me");
    assert.equal(settings.env.TASKCTL_AGENT, "alice");
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.SessionStart.length, 1);
  });

  it("--force updates the managed identity but leaves unrelated keys alone", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const log = join(bin, "log");

    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], fakeCliEnv(home, bin, log)).status, 0);
    const forced = runInstall(
      ["--target", "claude", "--agent-name", "bob", "--force"],
      fakeCliEnv(home, bin, log),
    );
    assert.equal(forced.status, 0, forced.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "bob");
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.ok(readFileSync(join(home, ".claude", "bin", "taskctl"), "utf8").includes("TASKCTL_AGENT:-bob"));
  });

  it("defaults the agent name to $USER when --agent-name is omitted", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(run.status, 0, run.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, process.env.USER || process.env.LOGNAME || "agent");
  });

  it("the installed shim runs the real CLI and forwards --version", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(run.status, 0, run.stderr);

    const shim = join(home, ".claude", "bin", "taskctl");
    const env = { ...process.env };
    delete env.TASKCTL_AGENT;
    const version = spawnSync(shim, ["--version"], { encoding: "utf8", env });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), VERSION);
  });
});

// ---------------------------------------------------------------------------
// Codex bundle
// ---------------------------------------------------------------------------

describe("host bundle: codex", () => {
  it("deploys skill + shim + AGENTS.md snippet + trigger and registers MCP", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const log = join(bin, "codex.log");
    makeFakeCli(bin, "codex");

    const run = runInstall(["--target", "codex", "--agent-name", "alice"], fakeCliEnv(home, bin, log));
    assert.equal(run.status, 0, run.stderr);

    // 1. skill
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat-taskpanel", "SKILL.md")), "skill missing");

    // 2. shim
    const shim = join(home, ".codex", "bin", "taskctl");
    assert.ok(isExecutable(shim), "shim must be executable");
    assert.ok(readFileSync(shim, "utf8").includes("TASKCTL_AGENT:-alice"));

    // 3. AGENTS.md — claim-first snippet appended with the identity rendered
    const agents = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    assert.match(agents, /<!-- meerkat-taskpanel:begin -->/);
    assert.match(agents, /You are agent \*\*alice\*\*/);
    assert.ok(agents.includes(`taskctl issue candidates --assignee alice`));
    assert.ok(agents.includes(join(home, ".codex", "bin", "taskctl")), "shim path must be rendered into AGENTS.md");
    assert.ok(!agents.includes("{{"), "template tokens must be rendered");

    // 4. claim trigger (executable, rendered, mentions the schedule)
    const trigger = join(home, ".codex", "meerkat-taskpanel-claim.sh");
    assert.ok(isExecutable(trigger), "trigger must be executable");
    const triggerText = readFileSync(trigger, "utf8");
    assert.match(triggerText, /name="\$\{TASKCTL_AGENT:-alice\}"/);
    assert.ok(triggerText.includes(join(home, ".codex", "meerkat-taskpanel-claim.sh")), "trigger path must be rendered");
    assert.ok(!triggerText.includes("{{"), "template tokens must be rendered");

    // 5. MCP registration — the exact command with CODEX_HOME pointed at the isolated home
    const logText = readFileSync(log, "utf8");
    const argvLine = logText.split("\n").find((l) => l.startsWith("argv:"));
    assert.match(argvLine, /^argv: <mcp> <add> <meerkat-taskpanel> <--> <node> <.*\/src\/mcp\/main\.mjs>$/);
    assert.ok(logText.includes(`CODEX_HOME=${join(home, ".codex")}`));
  });

  it("--no-automation skips the claim trigger but keeps the rest", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(
      ["--target", "codex", "--agent-name", "alice", "--no-automation"],
      fakeCliEnv(home, bin, join(bin, "log")),
    );
    assert.equal(run.status, 0, run.stderr);

    assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false);
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat-taskpanel", "SKILL.md")));
    assert.ok(existsSync(join(home, ".codex", "AGENTS.md")));
    assert.ok(existsSync(join(home, ".codex", "bin", "taskctl")));
  });

  it("preserves pre-existing AGENTS.md content when appending the snippet", () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# My rules\n\nAlways be kind.\n", "utf8");

    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(["--target", "codex", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(run.status, 0, run.stderr);

    const agents = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith("# My rules\n"), agents);
    assert.match(agents, /<!-- meerkat-taskpanel:begin -->/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — re-running writes nothing
// ---------------------------------------------------------------------------

describe("host bundle: idempotency", () => {
  it("re-running claude + codex leaves every installed file unchanged", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    makeFakeCli(bin, "codex");
    const env = fakeCliEnv(home, bin, join(bin, "log"));

    const first = runInstall(["--target", "claude,codex", "--agent-name", "alice"], env);
    assert.equal(first.status, 0, first.stderr);
    const before = snapshotTree(home);
    assert.ok(Object.keys(before).length > 5, "expected a real install, not an empty home");

    const again = runInstall(["--target", "claude,codex", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already installed/);
    assert.match(again.stdout, /unchanged/);

    assert.deepEqual(snapshotTree(home), before, "a second install must change nothing");
  });
});

// ---------------------------------------------------------------------------
// MCP registration reply modes + the two real-CLI branches
// ---------------------------------------------------------------------------

describe("host bundle: MCP registration", () => {
  it("treats an 'already exists' reply from the host CLI as success", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      fakeCliEnv(home, bin, join(bin, "log"), {
        FAKE_EXIT: "1",
        FAKE_STDOUT: "Error: MCP server 'meerkat-taskpanel' already exists",
      }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /already registered/);
  });

  it("prints the exact manual command when the host CLI fails for another reason", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      fakeCliEnv(home, bin, join(bin, "log"), { FAKE_EXIT: "1", FAKE_STDOUT: "something broke" }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /claude mcp add meerkat-taskpanel -- node .*src\/mcp\/main\.mjs/);
  });

  it("claude (when present) writes a real registration", { skip: !haveClaude }, () => {
    const home = makeTempDir();
    const env = { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: home };
    delete env.CLAUDE_CONFIG_DIR;

    const run = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(run.status, 0, run.stderr);

    assert.ok(existsSync(join(home, ".claude.json")), "claude mcp add must write .claude.json");
    const config = readFileSync(join(home, ".claude.json"), "utf8");
    assert.match(config, /meerkat-taskpanel/);
    assert.match(config, /src\/mcp\/main\.mjs/);
  });

  it("codex (when present) writes a real registration", { skip: !haveCodex }, () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "codex", "--agent-name", "alice"], {
      ...process.env,
      MEERKAT_TASKPANEL_TARGET_HOME: home,
    });
    assert.equal(run.status, 0, run.stderr);

    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.meerkat-taskpanel\]/);
    assert.match(config, /src\/mcp\/main\.mjs/);
  });

  it("claude (when absent) prints the exact manual command instead", { skip: haveClaude }, () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], {
      ...process.env,
      MEERKAT_TASKPANEL_TARGET_HOME: home,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /claude mcp add meerkat-taskpanel -- node .*src\/mcp\/main\.mjs/);
  });

  it("codex (when absent) prints the exact manual command instead", { skip: haveCodex }, () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "codex", "--agent-name", "alice"], {
      ...process.env,
      MEERKAT_TASKPANEL_TARGET_HOME: home,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /codex mcp add meerkat-taskpanel -- node .*src\/mcp\/main\.mjs/);
  });
});
