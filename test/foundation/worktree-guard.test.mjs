/**
 * The worktree guard policy (`src/foundation/worktree-guard.mjs`).
 *
 * One policy for Claude, Codex and pi. The important branches are the deny (a
 * write to the protected primary checkout), the allow (a linked worktree, an
 * exempt path, a project that never opted in), and the honest gaps: a shell
 * command is text, not an execution plan.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideGuard, normalizeAction, denyReason } from "../../src/foundation/worktree-guard.mjs";

const ROOT = "/repo";

/** A git runner answering the two probes the guard makes. */
function git({ linked = false } = {}) {
  return (cmd, argv) => {
    const joined = argv.join(" ");
    if (joined.includes("--show-toplevel")) {
      return { status: 0, stdout: linked ? `${ROOT}/.worktrees/a` : `${ROOT}\n`, stderr: "" };
    }
    if (joined.includes("--git-dir")) {
      return { status: 0, stdout: linked ? `${ROOT}/.git/worktrees/a` : ".git\n", stderr: "" };
    }
    if (joined.includes("--git-common-dir")) {
      return { status: 0, stdout: ".git\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

const exists = (path) => path === `${ROOT}/docs/agents/worktrees.md`;

/** A Claude payload for one edit. */
const claudeEdit = (path) => ({
  tool_name: "Edit",
  tool_input: { file_path: path },
});

describe("normalizeAction", () => {
  it("normalizes each runtime's write tools", () => {
    assert.deepEqual(normalizeAction("claude", claudeEdit("/repo/a")), {
      kind: "edit",
      paths: ["/repo/a"],
    });
    assert.deepEqual(
      normalizeAction("pi", { toolName: "write", input: { path: "a" } }),
      { kind: "edit", paths: ["a"] },
    );
    assert.deepEqual(
      normalizeAction("codex", {
        tool_name: "apply_patch",
        tool_input: { input: "*** Begin Patch\n*** Update File: src/a.mjs\n*** End Patch" },
      }),
      { kind: "edit", paths: ["src/a.mjs"] },
    );
    assert.deepEqual(normalizeAction("claude", { tool_name: "Read", tool_input: {} }), null);
  });
});

describe("decideGuard", () => {
  it("denies an edit to the protected primary checkout", () => {
    const result = decideGuard({
      runtime: "claude",
      payload: claudeEdit(`${ROOT}/src/a.mjs`),
      cwd: ROOT,
      run: git(),
      exists,
    });
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /primary checkout/);
    assert.match(result.reason, /taskctl worktree create/);
  });

  it("allows a linked worktree and exempt paths", () => {
    const linked = decideGuard({
      runtime: "claude",
      payload: claudeEdit(`${ROOT}/.worktrees/a/src/a.mjs`),
      cwd: `${ROOT}/.worktrees/a`,
      run: git({ linked: true }),
      exists,
    });
    assert.equal(linked.decision, "allow");

    for (const path of [
      `${ROOT}/node_modules/x.js`,
      `${ROOT}/.meerkat/TP-1/card.md`,
      `${ROOT}/docs/agents/worktrees.md`,
    ]) {
      const result = decideGuard({
        runtime: "claude",
        payload: claudeEdit(path),
        cwd: ROOT,
        run: git(),
        exists,
      });
      assert.equal(result.decision, "allow", `${path} is exempt`);
    }
  });

  it("allows when the project never opted in", () => {
    const result = decideGuard({
      runtime: "claude",
      payload: claudeEdit(`${ROOT}/src/a.mjs`),
      cwd: ROOT,
      run: git(),
      exists: () => false,
    });
    assert.equal(result.decision, "allow");
  });

  it("denies a write-like shell command in the checkout", () => {
    for (const command of [
      "sed -i s/a/b/ src/a.mjs",
      "echo x > README.md",
      "rm -rf src",
      // Removing a worktree is `taskctl worktree leave`, never a raw rm: the
      // registration would survive the directory.
      "rm -rf .worktrees/a",
    ]) {
      const result = decideGuard({
        runtime: "claude",
        payload: { tool_name: "Bash", tool_input: { command } },
        cwd: ROOT,
        run: git(),
        exists,
      });
      assert.equal(result.decision, "deny", command);
    }
  });

  it("allows reads and commands that only touch exempt roots", () => {
    for (const command of [
      "ls -la",
      "git status",
      "taskctl worktree create a",
      "cp /tmp/a /tmp/b",
    ]) {
      const result = decideGuard({
        runtime: "claude",
        payload: { tool_name: "Bash", tool_input: { command } },
        cwd: ROOT,
        run: git(),
        exists,
      });
      assert.equal(result.decision, "allow", command);
    }
  });

  it("applies the same decision to Codex and pi payloads", () => {
    const codex = decideGuard({
      runtime: "codex",
      payload: {
        tool_name: "apply_patch",
        tool_input: { input: "*** Update File: src/a.mjs" },
      },
      cwd: ROOT,
      run: git(),
      exists,
    });
    assert.equal(codex.decision, "deny");

    const pi = decideGuard({
      runtime: "pi",
      payload: { toolName: "edit", input: { path: "src/a.mjs" } },
      cwd: ROOT,
      run: git(),
      exists,
    });
    assert.equal(pi.decision, "deny");
  });

  it("denies a native EnterWorktree creation and allows entering a path", () => {
    const named = decideGuard({
      runtime: "claude",
      payload: { tool_name: "EnterWorktree", tool_input: { name: "feature" } },
      cwd: ROOT,
      run: git(),
      exists,
    });
    assert.equal(named.decision, "deny");
    assert.match(named.reason, /taskctl worktree create/);

    const pathed = decideGuard({
      runtime: "claude",
      payload: { tool_name: "EnterWorktree", tool_input: { path: `${ROOT}/.worktrees/feature` } },
      cwd: ROOT,
      run: git(),
      exists,
    });
    assert.equal(pathed.decision, "allow");
  });

  it("fails open when git cannot answer", () => {
    const result = decideGuard({
      runtime: "claude",
      payload: claudeEdit(`${ROOT}/src/a.mjs`),
      cwd: ROOT,
      run: () => null,
      exists,
    });
    assert.equal(result.decision, "allow");
  });
});

describe("denyReason", () => {
  it("names the runtime-specific next command", () => {
    const reason = denyReason({ root: ROOT, target: `${ROOT}/src/a.mjs` });
    assert.match(reason, /EnterWorktree/);
    assert.match(reason, /codex -C/);
    assert.match(reason, /cd "/);
  });
});
