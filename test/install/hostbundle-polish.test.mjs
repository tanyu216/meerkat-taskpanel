/**
 * Host-bundle polish (T-20261010-001800): D2 docs wording, D3 `--force` re-render of
 * the Codex `AGENTS.md` snippet, D4 shim/hook robustness.
 *
 *   - D2 — the docs state the real contract: a repeat install exits 0, managed files
 *     and config keys keep their old value, and `--force` is the only way to overwrite.
 *     The identity flag is `--agent-name` (there is no `--no-agent`).
 *   - D3 — a `--force` re-render of the codex `AGENTS.md` snippet must not change
 *     anything except (at most) trailing newlines: the rendered block and the
 *     pre-existing content are preserved, and a plain re-run is byte-identical.
 *   - D4 — the SessionStart fallback names an absolute, PATH-independent command
 *     instead of a bare `taskctl`; the Codex trigger's "already holding" check uses the
 *     board's identity rule (`norm`: NFKC → strip whitespace → case-fold), so
 *     `Alice` / `A l i c e` count as the same agent.
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];

function makeTempDir(prefix = "taskpanel-polish-") {
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

/** An executable fake host CLI that records its argv to `$FAKE_LOG` and exits 0. */
function makeFakeCli(binDir, name) {
  const script = [
    "#!/usr/bin/env bash",
    "printf 'argv: %s\\n' \"$*\" >> \"${FAKE_LOG:-/dev/null}\"",
    "exit 0",
    "",
  ].join("\n");
  const dest = join(binDir, name);
  writeFileSync(dest, script, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

function fakeCliEnv(home, bin, log) {
  return {
    ...process.env,
    TASKPANEL_TARGET_HOME: home,
    FAKE_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  };
}

// ---------------------------------------------------------------------------
// D2 — docs state the real idempotence contract, with the right flag name
// ---------------------------------------------------------------------------

describe("hostbundle polish: docs (D2)", () => {
  const docs = {
    "docs/install.md": readFileSync(join(ROOT, "docs", "install.md"), "utf8"),
    "README.md": readFileSync(join(ROOT, "README.md"), "utf8"),
    "README.zh-CN.md": readFileSync(join(ROOT, "README.zh-CN.md"), "utf8"),
  };

  it("names the identity flag --agent-name and never a nonexistent --no-agent", () => {
    for (const [file, text] of Object.entries(docs)) {
      assert.match(text, /--agent-name/, `${file} must document --agent-name`);
      assert.ok(!/--no-agent\b/.test(text), `${file} must not mention a --no-agent flag`);
    }
  });

  it("docs/install.md spells out merge-style idempotence, exit 0, and the --force notice", () => {
    const text = docs["docs/install.md"];
    assert.match(text, /left unchanged — use --force to\s+overwrite/, "must quote the notice");
    assert.match(text, /merge-style and idempotent/i);
    assert.match(text, /exits? (non-zero|0|\*\*0\*\*)/i);
    assert.match(text, /--force/);
  });

  it("both READMEs state that --force is the only way to overwrite", () => {
    for (const file of ["README.md", "README.zh-CN.md"]) {
      const text = docs[file];
      assert.match(text, /left unchanged — use --force to\s+overwrite/, `${file} must quote the notice`);
      assert.match(text, /--force/, `${file} must mention --force`);
    }
  });
});

// ---------------------------------------------------------------------------
// D3 — codex AGENTS.md under --force keeps everything but (at most) trailing NLs
// ---------------------------------------------------------------------------

describe("hostbundle polish: codex AGENTS.md is byte-stable (D3)", () => {
  const BEGIN = "<!-- task-panel:begin -->";
  const END = "<!-- task-panel:end -->";
  /** The delimited block, verbatim. */
  const blockOf = (text) => text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length);
  /** Everything except trailing newlines. */
  const chomp = (text) => text.replace(/\n+$/, "");

  it("a --force re-run preserves the prefix and the rendered block (only trailing NL may differ)", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const env = fakeCliEnv(home, bin, join(bin, "log"));
    const agentsPath = join(home, ".codex", "AGENTS.md");

    // Pre-existing content must survive both the first write and the forced re-render.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(agentsPath, "# My rules\n\nAlways be kind.\n", "utf8");

    const first = runInstall(["--target", "codex", "--agent-name", "alice"], env);
    assert.equal(first.status, 0, first.stderr);
    const firstText = readFileSync(agentsPath, "utf8");
    assert.ok(firstText.startsWith("# My rules\n"), firstText);

    // Plain re-run is byte-identical (the documented idempotence).
    const again = runInstall(["--target", "codex", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(agentsPath, "utf8"), firstText, "a plain re-run must be byte-identical");

    // Forced re-run: same block, same prefix, at most a trailing-newline delta.
    const forced = runInstall(["--target", "codex", "--agent-name", "alice", "--force"], env);
    assert.equal(forced.status, 0, forced.stderr);
    const forcedText = readFileSync(agentsPath, "utf8");

    assert.equal((forcedText.match(/<!-- task-panel:begin -->/g) ?? []).length, 1, "exactly one block");
    assert.equal((forcedText.match(/<!-- task-panel:end -->/g) ?? []).length, 1, "exactly one block");
    assert.equal(blockOf(forcedText), blockOf(firstText), "the rendered block must be unchanged");
    assert.ok(forcedText.startsWith("# My rules\n"), "pre-existing content must survive --force");
    assert.equal(chomp(forcedText), chomp(firstText), "--force may differ only by trailing newlines");
  });

  it("a fresh forced re-run (no prior file) leaves a single well-formed block", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const env = fakeCliEnv(home, bin, join(bin, "log"));

    const first = runInstall(["--target", "codex", "--agent-name", "bob"], env);
    assert.equal(first.status, 0, first.stderr);
    const firstText = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");

    const forced = runInstall(["--target", "codex", "--agent-name", "bob", "--force"], env);
    assert.equal(forced.status, 0, forced.stderr);
    const forcedText = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");

    assert.equal(chomp(forcedText), chomp(firstText));
    assert.match(forcedText, /You are agent \*\*bob\*\*/);
    assert.ok(!forcedText.includes("{{"), "template tokens must be rendered");
  });
});

// ---------------------------------------------------------------------------
// D4a — SessionStart fallback is PATH-independent
// ---------------------------------------------------------------------------

describe("hostbundle polish: SessionStart fallback (D4a)", () => {
  it("names an absolute command instead of a bare taskctl", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(run.status, 0, run.stderr);

    const hook = join(home, ".claude", "hooks", "task-panel-session-start.sh");
    assert.ok(existsSync(hook));
    const text = readFileSync(hook, "utf8");

    const shim = join(home, ".claude", "bin", "taskctl");
    // The fallback must point at the shim by absolute path...
    assert.ok(text.includes(`$shim issue candidates --assignee $name`), text);
    assert.ok(text.includes(shim), "the absolute shim path must be rendered into the hook");
    // ...and offer the repo CLI when only the shim is missing.
    assert.ok(
      text.includes(`node ${join(ROOT, "src", "cli", "index.mjs")} --agent $name issue candidates`),
      text,
    );
    // It must never print the bare, PATH-dependent form.
    assert.ok(!/run: taskctl\b/.test(text), "the fallback must not print a bare `taskctl`");
    assert.ok(!text.includes("{{"), "template tokens must be rendered");
  });
});

// ---------------------------------------------------------------------------
// D4b — the trigger's "already holding" check follows the CLI's identity rule
// ---------------------------------------------------------------------------

/** A fake taskctl shim that answers the trigger from canned JSON and logs its calls. */
function writeFakeShim(path, listJson, candidateJson) {
  const script = [
    "#!/usr/bin/env bash",
    "printf 'call: %s\\n' \"$*\" >> \"${FAKE_LOG:-/dev/null}\"",
    "case \"$*\" in",
    `  *"issue list"*) printf '%s' '${JSON.stringify(listJson)}'; exit 0 ;;`,
    `  *"issue candidates"*) printf '%s' '${JSON.stringify(candidateJson)}'; exit 0 ;;`,
    '  *"issue move"*) exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
}

describe("hostbundle polish: trigger identity match (D4b)", () => {
  it("treats a case/space-variant assignee as 'already holding' and does not re-claim", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const install = runInstall(["--target", "codex", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(install.status, 0, install.stderr);

    const trigger = join(home, ".codex", "task-panel-claim.sh");
    assert.ok(existsSync(trigger));

    // Replace the installed shim with one that reports an in_progress card whose
    // assignee is "A l i c e" — one person under `norm`, a different string under ==.
    const shim = join(home, ".codex", "bin", "taskctl");
    const log = join(bin, "shim.log");
    writeFakeShim(
      shim,
      { data: { tasks: [{ identifier: "T-42", assignee: { display_name: "A l i c e" } }] } },
      { data: { candidates: [{ identifier: "T-99" }] } },
    );

    const run = spawnSync("bash", [trigger], {
      encoding: "utf8",
      env: { ...process.env, TASKCTL_AGENT: "alice", FAKE_LOG: log },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /already holding T-42/, run.stdout);
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.ok(!calls.includes("issue move"), `must not re-claim a held card:\n${calls}`);
  });

  it("still claims the first candidate when held by nobody", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const install = runInstall(["--target", "codex", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(install.status, 0, install.stderr);

    const shim = join(home, ".codex", "bin", "taskctl");
    const log = join(bin, "shim.log");
    writeFakeShim(
      shim,
      { data: { tasks: [{ identifier: "T-42", assignee: { display_name: "bob" } }] } },
      { data: { candidates: [{ identifier: "T-99" }] } },
    );

    const run = spawnSync("bash", [join(home, ".codex", "task-panel-claim.sh")], {
      encoding: "utf8",
      env: { ...process.env, TASKCTL_AGENT: "alice", FAKE_LOG: log },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /claiming T-99/, run.stdout);
    assert.match(readFileSync(log, "utf8"), /issue move T-99 in_progress/);
  });
});
