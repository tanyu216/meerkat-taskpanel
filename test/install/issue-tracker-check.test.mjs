/**
 * The per-repo issue-tracker check.
 *
 * `setup-matt-pocock-skills` is installed globally, but everything it writes is
 * per repository (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`,
 * `docs/agents/domain.md`, and the `## Agent skills` block in `CLAUDE.md` or
 * `AGENTS.md`). So the integration cannot happen at install time: the host agent
 * must see the check when its session starts, look at the repository it is in,
 * and configure that repository when the file is missing.
 *
 * One instruction text is authored once (`skills/meerkat-taskpanel/references/
 * issue-tracker-check.md`) and surfaced by each host:
 *
 *   - claude — the installed SessionStart hook prints it;
 *   - codex  — the installed `AGENTS.md` block inlines it;
 *   - pi / opencode / cursor — their plugin/extension routes inject it.
 *
 * The two install-time surfaces (claude, codex) are asserted here. The plugin
 * routes have their own suites.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-tracker-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = join(ROOT, "skills", "meerkat-taskpanel", "references", "issue-tracker-check.md");
const MARKER = "<!-- meerkat-taskpanel:issue-tracker-check -->";

after(cleanup);

/** Count non-overlapping occurrences of a literal string. */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("issue-tracker check: the shared instruction", () => {
  it("ships with the board skill and opens with its marker", () => {
    assert.ok(existsSync(SHARED), "the board skill must ship the shared instruction");
    const first = readFileSync(SHARED, "utf8").trim().split("\n")[0];
    assert.equal(first, MARKER);
  });

  it("names the done condition, the skill, and the tracker it configures", () => {
    const text = readFileSync(SHARED, "utf8");
    assert.match(text, /docs\/agents\/issue-tracker\.md/, "the done marker must be named");
    assert.match(text, /\/setup-matt-pocock-skills/, "the setup skill must be named");
    assert.match(text, /non-interactive|do not ask/i, "the run must be non-interactive");
    assert.match(text, /meerkat-taskpanel/, "the tracker must be named");
    assert.match(text, /taskctl/, "the CLI that drives the tracker must be named");
    assert.match(text, /Other/, "the setup skill's 'Other' tracker branch must be selected");
  });

  it("is warn-and-continue, and stays out of headless turns", () => {
    const text = readFileSync(SHARED, "utf8");
    assert.match(text, /issue-tracker setup skipped/, "the failure line must be stable");
    assert.match(text, /继续/, "the loop's continue turn must be recognised");
    assert.match(text, /supervisor/i, "supervisor wakes must be recognised");
    assert.match(text, /do not (run|execute|write)/i, "headless turns must be told what not to do");
  });

  it("carries no template token", () => {
    // Codex inlines the file through apply.mjs's {{TOKEN}} renderer.
    assert.ok(!readFileSync(SHARED, "utf8").includes("{{"), "the shared text must not contain {{");
  });
});

describe("issue-tracker check: claude session start", () => {
  it("prints the shared check from the installed hook", () => {
    const home = makeTempDir();
    const res = runInstall(["--target", "claude", "--prefix", home, "--agent-name", "alice"]);
    assert.equal(res.status, 0, res.stderr);

    const hook = join(home, ".claude", "hooks", "meerkat-taskpanel-session-start.sh");
    const run = spawnSync("bash", [hook], {
      encoding: "utf8",
      env: { ...process.env, TASKCTL_AGENT: "alice" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(MARKER), run.stdout);
  });

  it("stays silent once the repository is configured", () => {
    const home = makeTempDir();
    const res = runInstall(["--target", "claude", "--prefix", home, "--agent-name", "alice"]);
    assert.equal(res.status, 0, res.stderr);

    const repo = makeTempDir();
    mkdirSync(join(repo, "docs", "agents"), { recursive: true });
    writeFileSync(join(repo, "docs", "agents", "issue-tracker.md"), "# configured\n");

    const hook = join(home, ".claude", "hooks", "meerkat-taskpanel-session-start.sh");
    const run = spawnSync("bash", [hook], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, TASKCTL_AGENT: "alice" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes(MARKER), "a configured repo must not be told to configure again");
  });
});

describe("issue-tracker check: codex instructions", () => {
  it("renders the shared check once into AGENTS.md", () => {
    const home = makeTempDir();
    const res = runInstall(["--target", "codex", "--prefix", home, "--agent-name", "alice"]);
    assert.equal(res.status, 0, res.stderr);

    const text = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    assert.equal(count(text, MARKER), 1, "the check must appear exactly once");
    assert.ok(!text.includes("{{"), "template tokens must be rendered");
    assert.match(text, /docs\/agents\/issue-tracker\.md/);
  });
});
