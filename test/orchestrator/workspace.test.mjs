/**
 * The loop's per-card workspace: a git worktree + lane branch created before a
 * worker is dispatched, merged into the project's current branch when the card
 * is accepted, and removed only after the card is terminal.
 *
 * The git half is a command runner injected into every function, so the tests
 * never shell out (the one integration leg at the bottom skips when git is not
 * installed).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import * as ws from "../../src/orchestrator/workspace.mjs";

const OK = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom", status = 1) => ({ status, stdout: "", stderr });

/** A runner that answers by matching the joined argv; records every call. */
function recorder(responses = []) {
  const calls = [];
  const run = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const key = `${cmd} ${argv.join(" ")}`;
    for (const [match, result] of responses) {
      if (key.includes(match)) return typeof result === "function" ? result(cmd, argv, options) : result;
    }
    return OK("");
  };
  return { run, calls };
}

const entryNone = null;

describe("orchestrator/workspace — names and refs", () => {
  it("names the worktree and the lane branch by identifier and round", () => {
    assert.equal(ws.worktreeName("TP-0001", 1), "TP-0001");
    assert.equal(ws.worktreeName("TP-0001", 2), "TP-0001-r2");
    assert.equal(ws.laneBranch("TP-0001", 1), "lane/TP-0001");
    assert.equal(ws.laneBranch("TP-0001", 3), "lane/TP-0001-r3");
    assert.equal(ws.workspacePath("/p", "TP-0001", 2), "/p/.worktrees/TP-0001-r2");
  });

  it("sanitizes an identifier with taskDirName so it cannot escape the directory", () => {
    assert.equal(ws.worktreeName("../x", 1), ".._x");
    assert.equal(ws.worktreeName("a b/c", 1), "a_b_c");
  });

  it("reads the project directory's current branch, and refuses a detached HEAD", () => {
    const current = recorder([["rev-parse --abbrev-ref HEAD", OK("dev\n")]]);
    assert.deepEqual(ws.currentBranch({ projectDir: "/p", run: current.run }), { ok: true, ref: "dev" });

    const detached = ws.currentBranch({ projectDir: "/p", run: () => OK("HEAD\n") });
    assert.equal(detached.ok, false);
    assert.equal(detached.code, "WORKSPACE_DETACHED_HEAD");

    const notGit = ws.currentBranch({ projectDir: "/p", run: () => FAIL("not a repository") });
    assert.equal(notGit.ok, false);
    assert.equal(notGit.code, "WORKSPACE_BASE_UNRESOLVED");
  });

  it("prefers the project's base_ref, then the previous round's branch, then the current branch", () => {
    const current = recorder([["rev-parse --abbrev-ref HEAD", OK("dev\n")]]);
    assert.deepEqual(
      ws.resolveBaseRef({ projectDir: "/p", entry: { base_ref: "main" }, previousBranch: null, run: current.run }),
      { ok: true, ref: "main", source: "project" },
    );
    assert.deepEqual(
      ws.resolveBaseRef({ projectDir: "/p", entry: entryNone, previousBranch: "lane/TP-0001", run: current.run }),
      { ok: true, ref: "lane/TP-0001", source: "previous" },
    );
    assert.deepEqual(
      ws.resolveBaseRef({ projectDir: "/p", entry: entryNone, previousBranch: null, run: current.run }),
      { ok: true, ref: "dev", source: "current" },
    );
  });
});

describe("orchestrator/workspace — create and remove", () => {
  it("creates the worktree on its own lane branch from the resolved base", () => {
    const { run, calls } = recorder([
      ["rev-parse --abbrev-ref HEAD", OK("dev\n")],
      ["worktree add", OK("Preparing worktree\n")],
    ]);
    const result = ws.createWorkspace({
      projectDir: "/p",
      entry: entryNone,
      identifier: "TP-0001",
      round: 2,
      previousBranch: "lane/TP-0001",
      run,
      mkdir: () => {},
      exists: () => true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.workspace, {
      identifier: "TP-0001",
      round: 2,
      path: "/p/.worktrees/TP-0001-r2",
      branch: "lane/TP-0001-r2",
      base_ref: "lane/TP-0001",
      project_dir: "/p",
      created_by_loop: true,
    });
    const add = calls.find((call) => call.argv.includes("worktree"));
    assert.deepEqual(add.argv, [
      "-C",
      "/p",
      "worktree",
      "add",
      "-b",
      "lane/TP-0001-r2",
      "/p/.worktrees/TP-0001-r2",
      "lane/TP-0001",
    ]);
  });

  it("defers when the directory is not a git checkout", () => {
    const result = ws.createWorkspace({
      projectDir: "/p",
      entry: entryNone,
      identifier: "TP-0001",
      round: 1,
      previousBranch: null,
      run: () => OK("dev\n"),
      mkdir: () => {},
      exists: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_NOT_GIT");
  });

  it("defers when git refuses the worktree, and never falls back to the shared tree", () => {
    const result = ws.createWorkspace({
      projectDir: "/p",
      entry: entryNone,
      identifier: "TP-0001",
      round: 1,
      previousBranch: null,
      run: (cmd, argv) => (argv.includes("worktree") ? FAIL("fatal: already exists") : OK("dev\n")),
      mkdir: () => {},
      exists: () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_CREATE_FAILED");
    assert.match(result.message, /already exists/);
  });

  it("removes the worktree first, then deletes the merged branch", () => {
    const { run, calls } = recorder([
      ["worktree remove", OK("")],
      ["branch -d", OK("Deleted branch")],
    ]);
    const result = ws.removeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p" },
      run,
    });
    assert.equal(result.ok, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.deepEqual(
      calls.map((call) => call.argv.slice(2, 4)),
      [
        ["worktree", "remove"],
        ["branch", "-d"],
      ],
      "worktree remove runs before branch -d",
    );
  });

  it("leaves a dirty worktree in place and does not delete its branch", () => {
    const { run, calls } = recorder([["worktree remove", FAIL("contains modified files")]]);
    const result = ws.removeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p" },
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.worktreeRemoved, false);
    assert.equal(result.branchRemoved, false);
    assert.equal(calls.some((call) => call.argv.includes("branch") && call.argv.includes("-d")), false);
  });

  it("removes the worktree but keeps an unmerged branch, and says why", () => {
    const { run } = recorder([
      ["worktree remove", OK("")],
      ["branch -d", FAIL("not fully merged")],
    ]);
    const result = ws.removeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p" },
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, false);
    assert.match(result.reason, /not fully merged/);
  });
});

describe("orchestrator/workspace — merge into the project branch", () => {
  it("merges the lane branch with --no-ff into the checked-out branch", () => {
    const { run, calls } = recorder([
      ["status --porcelain", OK("")],
      ["merge --no-ff", OK("Merge made by the 'ort' strategy.")],
    ]);
    const result = ws.mergeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p", identifier: "TP-0001" },
      run,
    });
    assert.equal(result.ok, true);
    const merge = calls.find((call) => call.argv.includes("--no-ff"));
    assert.deepEqual(merge.argv.slice(2), ["merge", "--no-ff", "lane/TP-0001", "-m", "merge: TP-0001"]);
  });

  it("refuses to merge into a dirty project checkout", () => {
    const { run, calls } = recorder([["status --porcelain", OK(" M src/a.mjs\n")]]);
    const result = ws.mergeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p", identifier: "TP-0001" },
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_TARGET_DIRTY");
    assert.equal(calls.some((call) => call.argv.includes("merge")), false, "nothing was attempted");
  });

  it("aborts a conflicted merge, names the files, and leaves the branch for a human", () => {
    const { run, calls } = recorder([
      ["status --porcelain", OK("")],
      ["merge --no-ff", FAIL("CONFLICT (content): Merge conflict in src/a.mjs")],
      ["diff --name-only --diff-filter=U", OK("src/a.mjs\n")],
      ["merge --abort", OK("")],
    ]);
    const result = ws.mergeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p", identifier: "TP-0001" },
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_MERGE_CONFLICT");
    assert.deepEqual(result.conflicts, ["src/a.mjs"]);
    assert.equal(calls.some((call) => call.argv.includes("--abort")), true, "the merge is aborted");
  });
});

describe("orchestrator/workspace — the registry", () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const stateDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-workspace-"));
    dirs.push(dir);
    return dir;
  };

  it("round-trips a record and finds the latest round", () => {
    const dir = stateDir();
    const one = { identifier: "TP-0001", round: 1, path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p" };
    const two = { ...one, round: 2, path: "/p/.worktrees/TP-0001-r2", branch: "lane/TP-0001-r2" };
    ws.upsertWorkspaceRecord(dir, one);
    ws.upsertWorkspaceRecord(dir, two);
    assert.deepEqual(ws.findWorkspace(dir, { identifier: "TP-0001", round: 1 }), one);
    assert.equal(ws.findWorkspace(dir, { identifier: "TP-0001", round: 2 }).branch, "lane/TP-0001-r2");
    assert.equal(ws.findWorkspace(dir, { identifier: "TP-0001" }).round, 2, "latest round wins");
    ws.removeWorkspaceRecord(dir, { identifier: "TP-0001", round: 2 });
    assert.equal(ws.findWorkspace(dir, { identifier: "TP-0001" }).round, 1);
    assert.equal(ws.findWorkspace(dir, { identifier: "NOPE" }), null);
  });
});

// One real-git leg. Skipped when git is absent (the container image may strip
// it); everything above runs from the injected runner.
describe("orchestrator/workspace — real git", () => {
  const gitAvailable = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it("creates, merges and removes a real worktree", { skip: !gitAvailable }, () => {
    const root = mkdtempSync(join(tmpdir(), "meerkat-workspace-git-"));
    const project = join(root, "project");
    try {
      execFileSync("git", ["init", "-q", "-b", "dev", project]);
      execFileSync("git", ["-C", project, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", project, "config", "user.name", "Test"]);
      execFileSync("sh", ["-c", `printf 'a\\n' > '${project}/a.txt'`]);
      execFileSync("git", ["-C", project, "add", "a.txt"]);
      execFileSync("git", ["-C", project, "commit", "-q", "-m", "base"]);

      const created = ws.createWorkspace({
        projectDir: project,
        entry: null,
        identifier: "TP-0001",
        round: 1,
        previousBranch: null,
      });
      assert.equal(created.ok, true, created.message);
      assert.ok(existsSync(created.workspace.path), "the worktree exists");
      assert.ok(existsSync(join(created.workspace.path, "a.txt")), "it is a checkout of the base");

      execFileSync("sh", ["-c", `printf 'b\\n' > '${created.workspace.path}/b.txt'`]);
      execFileSync("git", ["-C", created.workspace.path, "add", "b.txt"]);
      execFileSync("git", ["-C", created.workspace.path, "commit", "-q", "-m", "work"]);

      const merged = ws.mergeWorkspace({ workspace: created.workspace });
      assert.equal(merged.ok, true, merged.message);
      assert.ok(existsSync(join(project, "b.txt")), "the work landed on the project branch");

      const removed = ws.removeWorkspace({ workspace: created.workspace });
      assert.equal(removed.ok, true, removed.reason);
      assert.equal(existsSync(created.workspace.path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
