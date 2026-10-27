/**
 * The interactive installer wizard.
 *
 * The helpers are shell functions in `scripts/install/_wizard.sh`; they are
 * source-only (no top-level side effects), so every case here sources the file
 * and feeds stdin, the same idiom `claim-unassigned.test.mjs` uses for
 * `_common.sh`. `--interactive` is the deterministic end-to-end hook: it forces
 * the wizard even on a pipe, so no pty is needed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { createInstallHarness } from "./helpers/install-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const harness = createInstallHarness({ prefix: "meerkat-taskpanel-wizard-" });
after(() => harness.cleanup());

/** Source `_wizard.sh` and run one snippet; `input` is the piped answers. */
function runShell(snippet, { input = "", env = {} } = {}) {
  return spawnSync("bash", ["-c", `. "$1/scripts/install/_wizard.sh"\n${snippet}`, "_", ROOT], {
    encoding: "utf8",
    input,
    env: { ...process.env, HOME: "/home/tester", ...env },
  });
}

/** Call one helper, capturing both its stdout value and its exit code. */
function call(snippet, input = "", env = {}) {
  const run = runShell(
    `out="$(${snippet})"; code=$?; printf 'OUT:%s\\nCODE:%s\\n' "$out" "$code"`,
    { input, env },
  );
  const match = /^OUT:([\s\S]*)\nCODE:(\d+)\n$/.exec(run.stdout);
  assert.ok(match, `snippet produced no envelope: ${JSON.stringify(run.stdout)} / ${run.stderr}`);
  return { ...run, out: match[1], code: Number(match[2]) };
}

const KIND_BY_DIR = { ".claude": "claude", ".codex": "codex", ".agents": "pi" };

function configOf(home, agentDir) {
  const kind = KIND_BY_DIR[agentDir] ?? agentDir;
  const path = join(harness.kindConfigDirFor(home), `.env.${kind}`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("wizard_should_run — the one trigger decision", () => {
  const run = (args) => {
    const result = runShell(
      `if wizard_should_run ${args}; then echo yes; else echo no; fi`,
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  it("starts for no arguments on a terminal", () => {
    assert.equal(run('"" "" "" 1 1'), "yes");
  });

  it("never starts when stdin is not a terminal", () => {
    assert.equal(run('"" "" "" 1 ""'), "no");
  });

  it("--interactive forces it even without a terminal", () => {
    assert.equal(run('1 "" "" 0 ""'), "yes");
  });

  it("--yes wins over --interactive", () => {
    assert.equal(run('1 1 "" 0 1'), "no");
  });

  it("--dry-run never prompts", () => {
    assert.equal(run('1 "" 1 0 1'), "no");
    assert.equal(run('"" "" 1 1 1'), "no");
  });

  it("a flagged invocation without -i keeps the legacy path", () => {
    assert.equal(run('"" "" "" 0 1'), "no");
  });
});

describe("wizard_yesno", () => {
  const ask = (input, dflt = "yes") => call(`wizard_yesno 'Proceed?' ${dflt}`, input);

  it("a blank line accepts the default", () => {
    assert.deepEqual(ask("\n").out, "yes");
    assert.deepEqual(ask("\n", "no").out, "no");
  });

  it("accepts y/yes/1 and n/no/0 case-insensitively", () => {
    assert.equal(ask("y\n").out, "yes");
    assert.equal(ask("YES\n").out, "yes");
    assert.equal(ask("1\n").out, "yes");
    assert.equal(ask("N\n").out, "no");
    assert.equal(ask("no\n").out, "no");
    assert.equal(ask("0\n").out, "no");
  });

  it("re-prompts after an invalid answer", () => {
    const result = ask("maybe\ny\n");
    assert.equal(result.code, 0);
    assert.equal(result.out, "yes");
    assert.match(result.stderr, /Please answer y or n/);
  });

  it("q cancels with status 2", () => {
    assert.equal(ask("q\n").code, 2);
  });

  it("EOF cancels with status 2 instead of looping", () => {
    const result = ask("");
    assert.equal(result.code, 2);
    assert.equal(result.out, "");
    assert.match(result.stderr, /Proceed\?/);
  });
});

describe("wizard_int", () => {
  const ask = (input, dflt = "60", min = "1") => call(`wizard_int 'Seconds' ${dflt} ${min}`, input);

  it("a blank line accepts the default", () => {
    assert.equal(ask("\n").out, "60");
  });

  it("accepts a positive whole number", () => {
    assert.equal(ask("30\n").out, "30");
  });

  it("rejects zero, negatives, words and overflow, then accepts the retry", () => {
    for (const bad of ["0\n", "-1\n", "abc\n", "99999999999999999999\n"]) {
      const result = ask(`${bad}15\n`);
      assert.equal(result.code, 0, `${bad} should not cancel`);
      assert.equal(result.out, "15", `${bad} should re-prompt`);
      assert.match(result.stderr, /whole number|positive|>=\s*1/);
    }
  });

  it("honours a minimum above 1", () => {
    assert.equal(ask("5\n8\n", "10", "8").out, "8");
  });

  it("EOF cancels with status 2", () => {
    assert.equal(ask("").code, 2);
  });
});

describe("wizard_text", () => {
  it("a blank line accepts the default", () => {
    assert.equal(call("wizard_text 'Name' alice plain", "\n").out, "alice");
  });

  it("expands only a leading ~ or ~/", () => {
    assert.equal(call("wizard_text 'Home' /tmp path", "~\n").out, "/home/tester");
    assert.equal(call("wizard_text 'Home' /tmp path", "~/board\n").out, "/home/tester/board");
    assert.equal(call("wizard_text 'Home' /tmp path", "~bob/x\n").out, "~bob/x");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(call("wizard_text 'Name' alice name", "  bob  \n").out, "bob");
  });

  it("a name treats q as a literal value", () => {
    const result = call("wizard_text 'Name' alice name", "q\n");
    assert.equal(result.code, 0);
    assert.equal(result.out, "q");
  });

  it("reviewer accepts none or - to clear", () => {
    assert.equal(call("wizard_text 'Reviewer' bob reviewer", "none\n").out, "");
    assert.equal(call("wizard_text 'Reviewer' bob reviewer", "-\n").out, "");
    assert.equal(call("wizard_text 'Reviewer' bob reviewer", "\n").out, "bob");
  });

  it("q cancels a path question", () => {
    assert.equal(call("wizard_text 'Home' /tmp path", "q\n").code, 2);
  });

  it("EOF cancels", () => {
    assert.equal(call("wizard_text 'Name' alice plain", "").code, 2);
  });
});

describe("wizard_menu", () => {
  const ask = (input) =>
    call(
      "wizard_menu auto 'auto=auto-detect' 'launchd=launchd' 'cron=cron'",
      input,
    );

  it("renders numbered choices on stderr", () => {
    const result = ask("\n");
    assert.equal(result.code, 0);
    assert.match(result.stderr, /1\) auto-detect/);
    assert.match(result.stderr, /3\) cron/);
    assert.equal(result.out, "auto");
  });

  it("accepts an index or the key", () => {
    assert.equal(ask("2\n").out, "launchd");
    assert.equal(ask("cron\n").out, "cron");
  });

  it("re-prompts after an invalid index", () => {
    const result = ask("9\n3\n");
    assert.equal(result.out, "cron");
    assert.match(result.stderr, /Please choose 1-3/);
  });

  it("q and EOF cancel", () => {
    assert.equal(ask("q\n").code, 2);
    assert.equal(ask("").code, 2);
  });
});

describe("wizard_multi", () => {
  const ask = (input, dflt = "claude") =>
    call(
      `wizard_multi ${dflt} 'claude=Claude' 'codex=Codex' 'pi=Pi'`,
      input,
    );

  it("a blank line accepts the default", () => {
    assert.equal(ask("\n").out, "claude");
  });

  it("accepts indices and keys in one comma-separated line", () => {
    assert.equal(ask("1,3\n").out, "claude,pi");
    assert.equal(ask("codex, pi\n").out, "codex,pi");
  });

  it("all and * select every entry in menu order", () => {
    assert.equal(ask("all\n").out, "claude,codex,pi");
    assert.equal(ask("*\n").out, "claude,codex,pi");
  });

  it("de-duplicates", () => {
    assert.equal(ask("1,1,2\n").out, "claude,codex");
  });

  it("rejects the whole line when any token is invalid", () => {
    const result = ask("bogus,1\n2\n");
    assert.equal(result.out, "codex");
    assert.match(result.stderr, /Unknown choice/);
  });

  it("re-prompts when nothing is selected", () => {
    const result = ask(",\n1\n");
    assert.equal(result.out, "claude");
    assert.match(result.stderr, /Select at least one/);
  });

  it("q and EOF cancel", () => {
    assert.equal(ask("q\n").code, 2);
    assert.equal(ask("").code, 2);
  });
});

describe("wizard_targets — two-step target selection", () => {
  it("full install: the server plus the selected agent kinds", () => {
    const result = call("wizard_targets full claude,openclaw,codex,pi '' /tmp/home", "\n\n");
    assert.equal(result.code, 0);
    assert.equal(result.out, "server,claude,openclaw,codex,pi");
    assert.match(result.stderr, /Install mode/);
    assert.match(result.stderr, /full install/);
  });

  it("skills only: the agent kinds, no server", () => {
    assert.equal(call("wizard_targets skills claude '' /tmp/home", "\n\n").out, "claude");
  });

  it("server only: skips the agent question", () => {
    const result = call("wizard_targets server claude '' /tmp/home", "\n");
    assert.equal(result.out, "server");
    assert.doesNotMatch(result.stderr, /Agent kinds/);
  });

  it("maps the mode and agent indices", () => {
    const result = call("wizard_targets skills claude '' /tmp/home", "1\n1,3\n");
    assert.equal(result.out, "server,claude,codex");
  });

  it("--no-server skips the mode question and installs agent skills", () => {
    const result = call("wizard_targets full claude 1 /tmp/home", "\n");
    assert.equal(result.out, "claude");
    assert.match(result.stderr, /--no-server/);
    assert.doesNotMatch(result.stderr, /Install mode/);
  });

  it("server is not an agent choice", () => {
    const result = call("wizard_targets skills claude '' /tmp/home", "\nserver\n1\n");
    assert.equal(result.out, "claude");
    assert.match(result.stderr, /Unknown choice: server/);
  });
});

describe("run_wizard — prefills", () => {
  function runWizardShell(input, { lines = [], prints = [] } = {}) {
    const snippet = [
      '. "$1/scripts/install/_common.sh"',
      '. "$1/scripts/install/_wizard.sh"',
      "PREFIX_HOME=/tmp/home",
      "TARGET=claude",
      ...lines,
      'run_wizard >/dev/null 2>&1 || exit 2',
      ...prints,
    ].join("\n");
    return spawnSync("bash", ["-c", snippet, "_", ROOT], {
      encoding: "utf8",
      input,
      env: { ...process.env, HOME: "/home/tester", USER: "tester", LOGNAME: "tester" },
    });
  }

  // prefix, mode, agents, human, link, claim, recover, workflow, continue, supervisor
  const blanks = "\n\n\n\n\n\n\n\n\n\n";

  it("defaults the human name to the OS user", () => {
    const run = runWizardShell(blanks, {
      prints: ['printf "%s\\n" "$MEERKAT_TASKPANEL_HUMAN_NAME"'],
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "tester");
  });

  it("leaves the parsed agent name untouched (it is no longer asked)", () => {
    const run = runWizardShell(blanks, {
      lines: ["AGENT_NAME=bob"],
      prints: ['printf "%s\\n" "$AGENT_NAME"'],
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "bob");
  });
});

describe("install.sh --interactive end to end", () => {
  const runWizard = (args, input, env = {}) => harness.runInstallWithInput(args, input, env);
  const answers = (...lines) => lines.map((line) => `${line}\n`).join("");

  it("asks the remaining questions and installs the chosen shape", () => {
    const home = harness.makeTempDir();
    // prefix, mode, agents, human, link, claim, recover, workflow, continue, supervisor
    const run = runWizard(
      ["--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      answers("", "", "", "alice", "", "n", "", "", "", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /interactive setup/);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
    for (const absent of [".codex", ".agents", ".openclaw", ".meerkat-taskpanel"]) {
      assert.equal(existsSync(join(home, absent)), false, `${absent} must not be installed`);
    }

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_HUMAN, "alice");
    assert.equal(settings.env.TASKCTL_AGENT, "Worker");

    const config = configOf(home, ".claude");
    assert.ok(config !== null, ".claude/meerkat-taskpanel.env must exist");
    assert.match(config, /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_RECOVER_STALE=yes$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_WORKFLOW=yes$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_CONTINUE=yes$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_REVIEWER=Reviewer$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_PING_INTERVAL=60$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=600$/m);
  });

  it("truncated input cancels before anything is written", () => {
    const home = harness.makeTempDir();
    const run = runWizard(["--interactive", "--target", "claude", "--prefix", home], answers("", ""));
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cancelled/);
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("q at a menu cancels with exit 2 and no writes", () => {
    const home = harness.makeTempDir();
    const run = runWizard(
      ["--interactive", "--target", "claude", "--prefix", home],
      answers("", "", "q"),
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cancelled/);
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("an invalid agent line re-asks and the install continues", () => {
    const home = harness.makeTempDir();
    const run = runWizard(
      ["--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      answers("", "", "bogus", "1", "alice", "", "", "", "", "", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Unknown choice/);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
  });

  it("--interactive under --dry-run never prompts", () => {
    const home = harness.makeTempDir();
    const run = runWizard(
      ["--interactive", "--dry-run", "--target", "claude", "--prefix", home],
      "",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /interactive setup/);
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("--yes wins over --interactive", () => {
    const home = harness.makeTempDir();
    const run = runWizard(
      ["--interactive", "--yes", "--dry-run", "--target", "claude", "--prefix", home],
      "",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /interactive setup/);
  });

  it("zero arguments on a pipe never prompts (regression pin)", () => {
    const home = harness.makeTempDir();
    const run = runWizard([], "", {
      MEERKAT_TASKPANEL_DRY_RUN: "1",
      MEERKAT_TASKPANEL_TARGET_HOME: home,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /interactive setup/);
  });

  it("--no-server skips the mode question", () => {
    const home = harness.makeTempDir();
    // prefix, agents, human, link, claim, recover, workflow, continue, supervisor
    const run = runWizard(
      ["--no-server", "--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      answers("", "", "alice", "", "", "", "", "", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--no-server/);
    assert.doesNotMatch(run.stderr, /Install mode/);
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
  });

  it("a server-only selection installs no agent skills but records the human name", () => {
    const home = harness.makeTempDir();
    // prefix, mode, human, web
    const run = runWizard(
      ["--interactive", "--target", "server", "--prefix", home, "--skip-web-build"],
      answers("", "", "alice", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.ok(existsSync(join(home, ".meerkat-taskpanel", "bin", "taskctl")));
    const env = readFileSync(join(home, ".meerkat-taskpanel", ".env"), "utf8");
    assert.match(env, /^TASKCTL_HUMAN=alice$/m);
  });

  it("choosing full from a skills-only prefill installs the server too", () => {
    const home = harness.makeTempDir();
    // prefix, mode=1(full), agents, human, link, web, claim, recover, workflow, continue, supervisor
    const run = runWizard(
      ["--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      answers("", "1", "", "", "", "", "", "", "", "", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
    assert.ok(existsSync(join(home, ".meerkat-taskpanel", "bin", "taskctl")));
  });

  it("choosing server-only skips the agent questions", () => {
    const home = harness.makeTempDir();
    // prefix, mode=3(server), human, web
    const run = runWizard(
      ["--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      answers("", "3", "alice", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.ok(existsSync(join(home, ".meerkat-taskpanel", "bin", "taskctl")));
    assert.match(
      readFileSync(join(home, ".meerkat-taskpanel", ".env"), "utf8"),
      /^TASKCTL_HUMAN=alice$/m,
    );
  });

  it("leaves the removed options to their flags", () => {
    // Agent name, reviewer and the two intervals are no longer wizard
    // questions; an explicit flag must still take effect.
    const home = harness.makeTempDir();
    const run = runWizard(
      [
        "--interactive",
        "--target",
        "claude",
        "--prefix",
        home,
        "--skip-web-build",
        "--agent-name",
        "Bob",
        "--reviewer",
        "Grace",
        "--ping-interval",
        "30",
        "--continue-interval",
        "120",
      ],
      answers("", "", "", "alice", "", "", "", "", "", ""),
    );
    assert.equal(run.status, 0, run.stderr);
    const config = configOf(home, ".claude");
    assert.match(config, /^MEERKAT_TASKPANEL_REVIEWER=Grace$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_PING_INTERVAL=30$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=120$/m);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.TASKCTL_AGENT, "Bob");
    assert.equal(settings.env.TASKCTL_HUMAN, "alice");
  });

  it("a prefilled claim flag is the default, and typing overrides it", () => {
    const prefilled = harness.makeTempDir();
    const kept = runWizard(
      ["--interactive", "--target", "claude", "--prefix", prefilled, "--claim-unassigned=no"],
      answers("", "", "", "", "", "", "", "", "", ""),
    );
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(configOf(prefilled, ".claude"), /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);

    const overridden = harness.makeTempDir();
    const changed = runWizard(
      [
        "--interactive",
        "--target",
        "claude",
        "--prefix",
        overridden,
        "--claim-unassigned=no",
        "--skip-web-build",
      ],
      answers("", "", "", "", "", "y", "", "", "", ""),
    );
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(configOf(overridden, ".claude"), /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes$/m);
  });
});
