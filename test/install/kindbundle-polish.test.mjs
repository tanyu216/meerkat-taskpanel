/**
 * Agent-bundle polish (T-20261010-001800): D2 docs wording, D3 `--force` re-render of
 * the Codex `AGENTS.md` snippet, D4 shim/hook robustness.
 *
 *   - D2 — the docs state the real contract: a repeat install exits 0, managed files
 *     and config keys keep their old value, and `--force` is the only way to overwrite.
 *     The identity flag is `--agent-name` (there is no `--no-agent`).
 *   - D3 — a `--force` re-render of the codex `AGENTS.md` snippet must not change
 *     anything except (at most) trailing newlines: the rendered block and the
 *     pre-existing content are preserved, and a plain re-run is byte-identical.
 *   - D4 — the SessionStart fallback names an absolute, PATH-independent command
 *     instead of a bare `taskctl`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-polish-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

// The taskd keepalive guard is skipped here (its own cases live in
// `taskd-guard.test.mjs`): an install loads a real OS unit, and these cases are
// about the agent bundle, not the guard. `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` is
// the contract's test-only bypass.

/** An executable fake agent CLI that records its argv to `$FAKE_LOG` and exits 0. */
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
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    FAKE_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  };
}

// ---------------------------------------------------------------------------
// D2 — docs state the real idempotence contract, with the right flag name
// ---------------------------------------------------------------------------

describe("kindbundle polish: docs (D2)", () => {
  const docs = {
    "docs/ops/install.md": readFileSync(join(ROOT, "docs", "ops", "install.md"), "utf8"),
    "README.md": readFileSync(join(ROOT, "README.md"), "utf8"),
    "README.zh-CN.md": readFileSync(join(ROOT, "README.zh-CN.md"), "utf8"),
  };

  it("names the identity flag --agent-name and never a nonexistent --no-agent", () => {
    for (const [file, text] of Object.entries(docs)) {
      assert.match(text, /--agent-name/, `${file} must document --agent-name`);
      assert.ok(!/--no-agent\b/.test(text), `${file} must not mention a --no-agent flag`);
    }
  });

  it("docs/ops/install.md spells out merge-style idempotence, exit 0, and the --force notice", () => {
    const text = docs["docs/ops/install.md"];
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

describe("kindbundle polish: codex AGENTS.md is byte-stable (D3)", () => {
  const BEGIN = "<!-- meerkat-taskpanel:begin -->";
  const END = "<!-- meerkat-taskpanel:end -->";
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

    assert.equal((forcedText.match(/<!-- meerkat-taskpanel:begin -->/g) ?? []).length, 1, "exactly one block");
    assert.equal((forcedText.match(/<!-- meerkat-taskpanel:end -->/g) ?? []).length, 1, "exactly one block");
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

describe("kindbundle polish: SessionStart fallback (D4a)", () => {
  it("names an absolute command instead of a bare taskctl", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], fakeCliEnv(home, bin, join(bin, "log")));
    assert.equal(run.status, 0, run.stderr);

    const hook = join(home, ".claude", "hooks", "meerkat-taskpanel-session-start.sh");
    assert.ok(existsSync(hook));
    const text = readFileSync(hook, "utf8");

    const shim = join(home, ".claude", "bin", "taskctl");
    // The fallback must point at the shim by absolute path...
    assert.ok(text.includes(`$shim issue candidates --assignee $name`), text);
    assert.ok(text.includes(shim), "the absolute shim path must be rendered into the hook");
    // ...and offer the repo CLI when only the shim is missing — with the identity
    // a direct invocation needs (the shim is what would otherwise inject it).
    assert.ok(
      text.includes(`node ${join(ROOT, "src", "cli", "index.mjs")} --actor-kind claude --agent $name issue candidates`),
      text,
    );
    // It must never print the bare, PATH-dependent form.
    assert.ok(!/run: taskctl\b/.test(text), "the fallback must not print a bare `taskctl`");
    assert.ok(!text.includes("{{"), "template tokens must be rendered");
  });
});
