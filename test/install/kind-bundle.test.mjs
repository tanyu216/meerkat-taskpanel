/**
 * Agent-bundle install contract: `install.sh --target claude` / `--target codex`.
 *
 * The two bundle agent kinds deploy more than a skill — agent config, slash commands
 * (Claude) / the AGENTS.md snippet and scheduling units (Codex), and a `taskctl` shim that pins the agent
 * identity. These tests pin that contract under an isolated home
 * (`MEERKAT_TASKPANEL_TARGET_HOME`), and in particular the two "never clobber"
 * rules the rest of the installer relies on:
 *
 *   - idempotent: re-running with the same inputs leaves every file byte-identical;
 *   - merge-style: pre-existing settings.json / AGENTS.md content survives untouched.
 *
 * The install needs no agent CLI — it writes the whole bundle itself — so every
 * case runs the same way on a bare machine and inside the verification image.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

import { mergeSettings } from "../../scripts/install/lib/apply.mjs";
import { VERSION } from "../../src/foundation/constants.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-kindbundle-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

// MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE is the contract's test-only bypass: an install
// loads a real OS unit for the taskd guard, and a test must never do that. The guard
// has its own cases in `taskd-guard.test.mjs`, where the supervisor is faked on PATH.

/** Env for an install into an isolated `home`, with any extra keys layered on. */
function agentEnv(home, extra = {}) {
  return {
    ...process.env,
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
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

describe("agent bundle: mergeSettings", () => {
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

  it("writes the whole identity: the agent, what it is, and the human it may sign as", () => {
    // The kind is what the board reads to tell a person from an agent — a
    // human's `decision` is the one kind it acts on (it goes on the record,
    // resumes an `awaiting` card, and counts as the leader acting). A settings
    // file that named an agent and not its kind would record every one of that
    // agent's writes as a person's.
    const { data } = mergeSettings({}, {
      agent: "linus",
      kind: "claude",
      human: "Terry",
      hookCommand: "/h.sh",
    });
    assert.equal(data.env.TASKCTL_AGENT, "linus");
    assert.equal(data.env.TASKCTL_ACTOR_KIND, "claude");
    assert.equal(data.env.TASKCTL_HUMAN, "Terry");
  });

  it("skips a key with no value rather than writing it empty", () => {
    // An empty kind is worse than none — the board refuses a blank one outright,
    // and a settings file that carried one would fail every write in the session.
    const { data } = mergeSettings({}, { agent: "linus", kind: "", human: undefined, hookCommand: "/h.sh" });
    assert.equal("TASKCTL_ACTOR_KIND" in data.env, false);
    assert.equal("TASKCTL_HUMAN" in data.env, false);
    assert.equal(data.env.TASKCTL_AGENT, "linus");
  });

  it("keeps an existing kind rather than clobbering it — and --force replaces it", () => {
    const kept = mergeSettings(
      { env: { TASKCTL_ACTOR_KIND: "codex" } },
      { agent: "linus", kind: "claude", hookCommand: "/h.sh" },
    );
    assert.equal(kept.data.env.TASKCTL_ACTOR_KIND, "codex", "a session's own declaration outranks the installer's");
    const forced = mergeSettings(kept.data, {
      agent: "linus",
      kind: "claude",
      hookCommand: "/h.sh",
      force: true,
    });
    assert.equal(forced.data.env.TASKCTL_ACTOR_KIND, "claude");
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

describe("agent bundle: claude", () => {
  it("deploys skill + settings + hook + shim + slash commands", () => {
    const home = makeTempDir();

    const run = runInstall(["--target", "claude", "--agent-name", "alice"], agentEnv(home));
    assert.equal(run.status, 0, run.stderr);

    // 1. skill
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")), "skill missing");

    // 2. settings.json — merged identity + SessionStart
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "alice");
    assert.equal(settings.env.TASKCTL_ACTOR_KIND, "claude", "the agent-kind script names the kind it is installing for");
    const start = settings.hooks.SessionStart;
    assert.equal(start.length, 1);
    assert.equal(start[0].hooks[0].type, "command");
    assert.ok(start[0].hooks[0].command.endsWith(".claude/hooks/meerkat-taskpanel-session-start.sh"));

    // 3. hook script (executable, rendered, restates the eight rules)
    const hook = join(home, ".claude", "hooks", "meerkat-taskpanel-session-start.sh");
    assert.ok(isExecutable(hook), "hook must be executable");
    const hookText = readFileSync(hook, "utf8");
    assert.match(hookText, /claimable for \$name/);
    assert.match(hookText, /the eight rules/);
    assert.ok(!hookText.includes("{{"), "template tokens must be rendered");

    // 4. shim (executable, injects --agent)
    const shim = join(home, ".claude", "bin", "taskctl");
    assert.ok(isExecutable(shim), "shim must be executable");
    const shimText = readFileSync(shim, "utf8");
    assert.ok(shimText.includes('agent="${TASKCTL_AGENT:-alice}"'), shimText);
    assert.ok(shimText.includes('--agent "$agent"'), shimText);
    // The shim's `--agent` is a *default*, not a lock: `"$@"` comes last, so a
    // team role (`--agent jobs` / `linus` / `turing`) overrides it.
    const execLine = shimText.split("\n").find((line) => line.startsWith("exec "));
    assert.ok(execLine, "the shim must end in an exec line");
    assert.match(execLine, /--agent "\$agent".*"\$@"$/, "the caller's flags must come last");
    // ...and the *kind*, or every write from this shim reads as a human's.
    assert.ok(shimText.includes('kind="${TASKCTL_ACTOR_KIND:-claude}"'), shimText);
    assert.ok(shimText.includes('--actor-kind "$kind"'), shimText);
    // ...and the human, so `--as-human` on this agent kind signs with the person's
    // name and not the agent's.
    assert.ok(shimText.includes('human="${TASKCTL_HUMAN:-'), shimText);
    assert.ok(!shimText.includes("{{"), "template tokens must be rendered");

    // 5. slash commands
    for (const name of ["board", "claim", "deliver"]) {
      const cmd = join(home, ".claude", "commands", `${name}.md`);
      assert.ok(existsSync(cmd), `${name}.md missing`);
      assert.ok(!readFileSync(cmd, "utf8").includes("{{"), `${name}.md has unrendered tokens`);
    }
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

    const run = runInstall(["--target", "claude", "--agent-name", "alice"], agentEnv(home));
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

    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], agentEnv(home)).status, 0);
    const forced = runInstall(["--target", "claude", "--agent-name", "bob", "--force"], agentEnv(home));
    assert.equal(forced.status, 0, forced.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "bob");
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.ok(readFileSync(join(home, ".claude", "bin", "taskctl"), "utf8").includes("TASKCTL_AGENT:-bob"));
  });

  it("defaults the agent name to Worker when --agent-name is omitted", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude"], agentEnv(home));
    assert.equal(run.status, 0, run.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "Worker");
  });

  it("the installed shim runs the real CLI and forwards --version", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], agentEnv(home));
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

describe("agent bundle: codex", () => {
  it("deploys skill + shim + AGENTS.md snippet + scheduling units", () => {
    const home = makeTempDir();

    const run = runInstall(["--target", "codex", "--agent-name", "alice"], agentEnv(home));
    assert.equal(run.status, 0, run.stderr);

    // 1. skill
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat", "SKILL.md")), "skill missing");

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

    // 4. no claim trigger; the scheduling units are the automation
    assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false);
    assert.ok(existsSync(join(home, ".codex", "scheduling")), "scheduling units must land");
  });

  it("--no-automation skips the scheduling units but keeps the rest", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "codex", "--agent-name", "alice", "--no-automation"],
      agentEnv(home),
    );
    assert.equal(run.status, 0, run.stderr);

    assert.equal(existsSync(join(home, ".codex", "scheduling")), false);
    assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false);
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat", "SKILL.md")));
    assert.ok(existsSync(join(home, ".codex", "AGENTS.md")));
    assert.ok(existsSync(join(home, ".codex", "bin", "taskctl")));
  });

  it("preserves pre-existing AGENTS.md content when appending the snippet", () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# My rules\n\nAlways be kind.\n", "utf8");

    const run = runInstall(["--target", "codex", "--agent-name", "alice"], agentEnv(home));
    assert.equal(run.status, 0, run.stderr);

    const agents = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith("# My rules\n"), agents);
    assert.match(agents, /<!-- meerkat-taskpanel:begin -->/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — re-running writes nothing
// ---------------------------------------------------------------------------

describe("agent bundle: idempotency", () => {
  it("re-running claude + codex leaves every installed file unchanged", () => {
    const home = makeTempDir();
    const env = agentEnv(home);

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
// The board skill's rename: `meerkat-taskpanel/` -> `meerkat/`
// ---------------------------------------------------------------------------

describe("agent bundle: legacy board-skill directory", () => {
  /** A pre-rename install: `skills/meerkat-taskpanel/` carrying operator data. */
  function seedLegacySkill(home) {
    const legacy = join(home, ".claude", "skills", "meerkat-taskpanel");
    mkdirSync(join(legacy, "roles"), { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "---\nname: meerkat-taskpanel\n---\n");
    writeFileSync(join(legacy, "roles", "manifest.json"), '{"roles":[]}');
    writeFileSync(join(legacy, "projects.json"), '{"demo":{"local_path":"/tmp/demo"}}');
    return legacy;
  }

  it("carries operator data into the new skill, then removes the legacy directory", () => {
    const home = makeTempDir();
    const legacy = seedLegacySkill(home);

    const result = runInstall(["--target", "claude"], agentEnv(home));
    assert.equal(result.status, 0, result.stderr);

    const dest = join(home, ".claude", "skills", "meerkat");
    assert.ok(existsSync(join(dest, "SKILL.md")), "board skill missing at its new name");
    assert.equal(readFileSync(join(dest, "roles", "manifest.json"), "utf8"), '{"roles":[]}');
    assert.equal(
      readFileSync(join(dest, "projects.json"), "utf8"),
      '{"demo":{"local_path":"/tmp/demo"}}',
    );
    assert.equal(existsSync(legacy), false, "the pre-rename directory must not survive");
    assert.match(result.stdout, /migrated legacy skill/);
  });

  it("never clobbers operator data the new skill already holds", () => {
    const home = makeTempDir();
    const legacy = seedLegacySkill(home);
    const dest = join(home, ".claude", "skills", "meerkat");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: meerkat\n---\n");
    writeFileSync(join(dest, "projects.json"), '{"kept":{}}');

    const result = runInstall(["--target", "claude"], agentEnv(home));
    assert.equal(result.status, 0, result.stderr);

    assert.equal(readFileSync(join(dest, "projects.json"), "utf8"), '{"kept":{}}');
    assert.ok(existsSync(join(dest, "roles", "manifest.json")), "missing data must still move");
    assert.equal(existsSync(legacy), false);
  });

  it("--link keeps the legacy directory rather than writing through the symlink", () => {
    const home = makeTempDir();
    const legacy = seedLegacySkill(home);

    const result = runInstall(["--target", "claude", "--link"], agentEnv(home));
    assert.equal(result.status, 0, result.stderr);

    const dest = join(home, ".claude", "skills", "meerkat");
    assert.ok(lstatSync(dest).isSymbolicLink(), "board skill should be a link");
    assert.ok(existsSync(join(legacy, "projects.json")), "operator data must stay where it is");
    assert.match(result.stdout + result.stderr, /legacy skill dir kept/);
  });

  it("--dry-run reports the migration and changes nothing", () => {
    const home = makeTempDir();
    const legacy = seedLegacySkill(home);

    const result = runInstall(["--target", "claude", "--dry-run"], agentEnv(home));
    assert.equal(result.status, 0, result.stderr);

    assert.match(result.stdout, /would migrate legacy skill/);
    assert.ok(existsSync(join(legacy, "projects.json")));
    assert.equal(existsSync(join(home, ".claude", "skills", "meerkat")), false);
  });
});
