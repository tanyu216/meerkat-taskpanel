/**
 * `taskctl worktree` — the local session-worktree lifecycle.
 *
 * A session tree is `<root>/.worktrees/<slug>` on its own branch; the loop's
 * `lane/` trees are a different owner and are never touched here. Removal is
 * the safety property under test: only a clean tree whose branch is already an
 * ancestor of the integration branch goes, and there is no `--force`.
 *
 * The cases drive a real git repository; the command is local, so no board or
 * token is needed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  cleanupTempDirs,
  dataOf,
  errorOf,
  makeTempDir,
  runCli,
} from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A real repository on `dev`, with `.worktrees/` ignored and one commit. */
function makeRepo({ ignoreWorktrees = true } = {}) {
  const dir = join(makeTempDir("meerkat-taskpanel-wt-"), "checkout");
  mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
    return String(result.stdout ?? "").trim();
  };
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ignoreWorktrees ? ".worktrees/\n" : "");
  writeFileSync(join(dir, "README.md"), "base\n");
  git("add", ".gitignore", "README.md");
  git("commit", "-q", "-m", "base");
  return { dir, git };
}

/** Run the local command from the repository without board identity. */
function wt(dir, args) {
  return runCli(["worktree", ...args], { cwd: dir, noIdentity: true });
}

/** Commit a change in a worktree so it can be merged. */
function commitIn(tree, file = "work.txt", text = "work\n") {
  writeFileSync(join(tree, file), text);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  };
  git("add", file);
  git("commit", "-q", "-m", "work");
}

describe("cli/worktree create", () => {
  it("creates .worktrees/<slug> on a new branch from the current branch", () => {
    const { dir } = makeRepo();
    const result = wt(dir, ["create", "a", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const data = dataOf(result);
    assert.equal(data.path, join(realpathSync(dir), ".worktrees", "a"));
    assert.equal(data.branch, "a");
    assert.equal(data.base, "dev");
    assert.ok(existsSync(data.path));
  });

  it("takes an explicit branch and base", () => {
    const { dir, git } = makeRepo();
    git("branch", "topic");
    const result = wt(dir, ["create", "b", "--branch", "feat/b", "--base", "topic", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).branch, "feat/b");
    assert.equal(dataOf(result).base, "topic");
  });

  it("refuses a second tree for the same slug or branch", () => {
    const { dir } = makeRepo();
    assert.equal(wt(dir, ["create", "a", "--json"]).status, 0);
    const sameSlug = wt(dir, ["create", "a", "--json"]);
    assert.equal(sameSlug.status, 1);
    assert.equal(errorOf(sameSlug).code, "WORKTREE_EXISTS");

    const sameBranch = wt(dir, ["create", "other", "--branch", "a", "--json"]);
    assert.equal(sameBranch.status, 1);
    assert.equal(errorOf(sameBranch).code, "WORKTREE_EXISTS");
  });

  it("requires .worktrees/ to be ignored", () => {
    const { dir } = makeRepo({ ignoreWorktrees: false });
    const result = wt(dir, ["create", "a", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorOf(result).code, "WORKTREE_NOT_IGNORED");
    assert.match(errorOf(result).hint.fix, /\.worktrees\//);
  });

  it("refuses a lane/ branch and an invalid slug", () => {
    const { dir } = makeRepo();
    const lane = wt(dir, ["create", "a", "--branch", "lane/TP-1", "--json"]);
    assert.equal(lane.status, 1);
    assert.equal(errorOf(lane).code, "WORKTREE_LOOP_OWNED");

    const bad = wt(dir, ["create", "../escape", "--json"]);
    assert.equal(bad.status, 1);
    assert.equal(errorOf(bad).code, "WORKTREE_INVALID");
  });
});

describe("cli/worktree leave", () => {
  it("removes a clean, merged tree and its branch", () => {
    const { dir, git } = makeRepo();
    const created = wt(dir, ["create", "a", "--json"]);
    const tree = dataOf(created).path;
    commitIn(tree);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");

    const result = wt(dir, ["leave", "a", "--remove", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).removed, true);
    assert.equal(dataOf(result).branch_removed, true);
    assert.equal(existsSync(tree), false);
  });

  it("refuses a dirty tree", () => {
    const { dir } = makeRepo();
    const created = wt(dir, ["create", "a", "--json"]);
    const tree = dataOf(created).path;
    writeFileSync(join(tree, "README.md"), "dirty\n");

    const result = wt(dir, ["leave", "a", "--remove", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorOf(result).code, "WORKTREE_DIRTY");
    assert.ok(existsSync(tree), "the tree survives");
  });

  it("refuses an unmerged branch", () => {
    const { dir } = makeRepo();
    const created = wt(dir, ["create", "a", "--json"]);
    commitIn(dataOf(created).path);

    const result = wt(dir, ["leave", "a", "--remove", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorOf(result).code, "WORKTREE_UNMERGED");
  });

  it("refuses a loop-owned lane", () => {
    const { dir, git } = makeRepo();
    git("worktree", "add", "-q", ".worktrees/lane1", "-b", "lane/TP-1", "dev");
    const result = wt(dir, ["leave", "lane1", "--remove", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorOf(result).code, "WORKTREE_LOOP_OWNED");
  });

  it("keeps a tree by default", () => {
    const { dir } = makeRepo();
    const tree = dataOf(wt(dir, ["create", "a", "--json"])).path;
    const result = wt(dir, ["leave", "a", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).removed, false);
    assert.ok(existsSync(tree));
  });
});

describe("cli/worktree guard", () => {
  it("prints each runtime's deny shape and stays silent on allow", () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, "docs", "agents"), { recursive: true });
    writeFileSync(join(dir, "docs", "agents", "worktrees.md"), "rules\n");
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "README.md") },
      cwd: dir,
    });

    const claude = runCli(["worktree", "guard", "--runtime", "claude"], {
      cwd: dir,
      noIdentity: true,
      input: payload,
    });
    assert.equal(claude.status, 0, claude.stderr);
    const claudeOut = JSON.parse(claude.stdout);
    assert.equal(claudeOut.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(claudeOut.hookSpecificOutput.permissionDecision, "deny");
    assert.match(claudeOut.hookSpecificOutput.permissionDecisionReason, /taskctl worktree create/);

    const pi = runCli(["worktree", "guard", "--runtime", "pi"], {
      cwd: dir,
      noIdentity: true,
      input: JSON.stringify({
        toolName: "edit",
        input: { path: join(dir, "README.md") },
        cwd: dir,
      }),
    });
    assert.equal(pi.status, 0, pi.stderr);
    assert.equal(JSON.parse(pi.stdout).block, true);

    const read = runCli(["worktree", "guard", "--runtime", "claude"], {
      cwd: dir,
      noIdentity: true,
      input: JSON.stringify({ tool_name: "Read", tool_input: {}, cwd: dir }),
    });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout.trim(), "");
  });
});

describe("cli/worktree sweep", () => {
  it("removes clean+merged trees and reports the rest", () => {
    const { dir, git } = makeRepo();
    const a = dataOf(wt(dir, ["create", "a", "--json"])).path;
    const b = dataOf(wt(dir, ["create", "b", "--json"])).path;
    commitIn(a);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");
    writeFileSync(join(b, "README.md"), "dirty\n");

    const result = wt(dir, ["sweep", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const data = dataOf(result);
    assert.deepEqual(data.removed.map((tree) => tree.slug), ["a"]);
    assert.deepEqual(data.kept.map((tree) => tree.slug), ["b"]);
    assert.match(data.kept[0].reason, /uncommitted/);
    assert.equal(existsSync(a), false);
    assert.ok(existsSync(b));
  });

  it("--dry-run reports without removing", () => {
    const { dir, git } = makeRepo();
    const a = dataOf(wt(dir, ["create", "a", "--json"])).path;
    commitIn(a);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");

    const result = wt(dir, ["sweep", "--dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(dataOf(result).would_remove.map((tree) => tree.slug), ["a"]);
    assert.ok(existsSync(a));
  });

  it("never removes the session's own tree", () => {
    const { dir, git } = makeRepo();
    const a = dataOf(wt(dir, ["create", "a", "--json"])).path;
    commitIn(a);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");

    const result = runCli(["worktree", "sweep", "--json"], { cwd: a, noIdentity: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).removed.length, 0);
    assert.ok(dataOf(result).kept.some((tree) => tree.slug === "a" && /current/.test(tree.reason)));
  });
});
