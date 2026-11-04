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

  it("probes a ref with rev-parse --verify --quiet and separates absent from unprobeable", () => {
    const present = recorder([["rev-parse --verify --quiet", OK("abc123\n")]]);
    assert.deepEqual(ws.probeRef({ projectDir: "/p", ref: "lane/x", run: present.run }), {
      ok: true,
      exists: true,
    });
    assert.deepEqual(present.calls[0].argv, [
      "-C",
      "/p",
      "rev-parse",
      "--verify",
      "--quiet",
      "lane/x^{commit}",
    ]);

    assert.deepEqual(
      ws.probeRef({ projectDir: "/p", ref: "lane/x", run: () => FAIL("", 1) }),
      { ok: true, exists: false },
      "exit 1 is an absent ref",
    );

    const broken = ws.probeRef({
      projectDir: "/p",
      ref: "lane/x",
      run: () => FAIL("fatal: not a git repository", 128),
    });
    assert.equal(broken.ok, false, "exit 128 is not an absent ref");
    assert.equal(broken.code, "WORKSPACE_BASE_UNRESOLVED");

    const noGit = ws.probeRef({ projectDir: "/p", ref: "lane/x", run: () => null });
    assert.equal(noGit.ok, false, "git could not start");
  });

  it("falls back to the current branch when the previous round's lane branch is gone", () => {
    const run = (cmd, argv) => {
      const key = argv.join(" ");
      if (key.includes("rev-parse --verify --quiet")) return FAIL("", 1);
      if (key.includes("rev-parse --abbrev-ref HEAD")) return OK("dev\n");
      return OK("");
    };
    assert.deepEqual(
      ws.resolveBaseRef({
        projectDir: "/p",
        entry: entryNone,
        previousBranch: "lane/TP-0009-r2",
        run,
      }),
      { ok: true, ref: "dev", source: "current", skipped_previous: "lane/TP-0009-r2" },
    );
  });

  it("refuses a declared base_ref that does not resolve instead of falling back", () => {
    const run = (cmd, argv) => {
      const key = argv.join(" ");
      if (key.includes("rev-parse --verify --quiet")) return FAIL("", 1);
      return OK("dev\n");
    };
    const result = ws.resolveBaseRef({
      projectDir: "/p",
      entry: { base_ref: "release" },
      previousBranch: null,
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_BASE_UNRESOLVED");
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
      project: "TP",
      identifier: "TP-0001",
      round: 2,
      previousBranch: "lane/TP-0001",
      run,
      mkdir: () => {},
      exists: () => true,
    });
    assert.equal(result.ok, true);
    const { created_at, ...workspace } = result.workspace;
    assert.deepEqual(workspace, {
      identifier: "TP-0001",
      project: "TP",
      round: 2,
      path: "/p/.worktrees/TP-0001-r2",
      branch: "lane/TP-0001-r2",
      base_ref: "lane/TP-0001",
      project_dir: "/p",
      created_by_loop: true,
    });
    assert.match(created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

  it("re-attaches a surviving same-round lane branch without -b and without resolving a base", () => {
    const { run, calls } = recorder([
      ["worktree prune", OK("")],
      ["rev-parse --verify --quiet", OK("abc123\n")],
      ["worktree add", OK("")],
    ]);
    const result = ws.createWorkspace({
      projectDir: "/p",
      entry: { base_ref: "missing" },
      project: "TP",
      identifier: "TP-0001",
      round: 2,
      previousBranch: "lane/TP-0001",
      reuseExistingBranch: true,
      run,
      mkdir: () => {},
      exists: (path) => path === "/p/.git",
    });
    assert.equal(result.ok, true);
    assert.equal(result.workspace.reused_branch, true);
    assert.equal(result.workspace.base_ref, "lane/TP-0001-r2");
    const add = calls.find((call) => call.argv.includes("add"));
    assert.deepEqual(add.argv, [
      "-C",
      "/p",
      "worktree",
      "add",
      "/p/.worktrees/TP-0001-r2",
      "lane/TP-0001-r2",
    ]);
    assert.equal(
      calls.some((call) => call.argv.join(" ").includes("rev-parse --abbrev-ref")),
      false,
      "a repair needs no base",
    );
  });

  it("moves an orphan non-checkout directory aside before creating the worktree", () => {
    const path = "/p/.worktrees/TP-0001-r2";
    const moves = [];
    const { run } = recorder([
      ["worktree prune", OK("")],
      ["rev-parse --verify --quiet", OK("abc123\n")],
      ["worktree add", OK("")],
    ]);
    const result = ws.createWorkspace({
      projectDir: "/p",
      entry: entryNone,
      identifier: "TP-0001",
      round: 2,
      previousBranch: null,
      reuseExistingBranch: true,
      run,
      mkdir: () => {},
      exists: (candidate) => candidate === "/p/.git" || candidate === path,
      rename: (from, to) => moves.push({ from, to }),
      now: () => 1700000000000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(moves, [{ from: path, to: `${path}.orphan-1700000000000` }]);
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

  it("clears the loop's own process dir and retries, so a brief cannot block removal", () => {
    // git refuses `worktree remove` when untracked files remain, and the loop
    // itself writes the card brief into <worktree>/.meerkat/<ref>/.
    let attempts = 0;
    const run = (cmd, argv) => {
      if (!argv.includes("remove")) return OK("");
      attempts += 1;
      return attempts === 1 ? FAIL("contains modified or untracked files") : OK("");
    };
    const cleared = [];
    const result = ws.removeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p" },
      run,
      removeDir: (dir) => cleared.push(dir),
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 2, "the removal is retried once");
    assert.deepEqual(cleared, ["/p/.worktrees/TP-0001/.meerkat"]);
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

  it("refuses to land when the project declares another integration branch", () => {
    // The project rule is authoritative: `merge_ref` names the branch acceptance
    // must land on, and a checkout sitting elsewhere is a refusal, not a merge.
    const { run, calls } = recorder([
      ["status --porcelain", OK("")],
      ["rev-parse --abbrev-ref HEAD", OK("dev\n")],
    ]);
    const result = ws.mergeWorkspace({
      workspace: { path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001", project_dir: "/p", identifier: "TP-0001" },
      entry: { merge_ref: "release/1.x" },
      run,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_MERGE_TARGET_MISMATCH");
    assert.match(result.message, /release\/1\.x/);
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

  it("lists only earlier rounds as previous workspaces, highest first", () => {
    const dir = stateDir();
    for (const round of [1, 2, 3]) {
      ws.upsertWorkspaceRecord(dir, {
        identifier: "TP-0001",
        round,
        path: `/p/.worktrees/TP-0001-r${round}`,
        branch: `lane/TP-0001-r${round}`,
        project_dir: "/p",
      });
    }
    assert.deepEqual(
      ws.listPreviousWorkspaces(dir, { identifier: "TP-0001", round: 3 }).map((record) => record.round),
      [2, 1],
    );
    assert.deepEqual(ws.listPreviousWorkspaces(dir, { identifier: "TP-0001", round: 1 }), []);
    assert.deepEqual(ws.listPreviousWorkspaces(dir, { identifier: "NOPE", round: 3 }), []);
  });

  it("judges a record usable only when its tree is a checkout of this project", () => {
    const record = {
      identifier: "TP-0001",
      round: 1,
      path: "/p/.worktrees/TP-0001",
      branch: "lane/TP-0001",
      project_dir: "/p",
    };
    assert.equal(
      ws.isUsableWorkspaceRecord(record, {
        exists: (path) => path === "/p/.worktrees/TP-0001/.git",
        projectDir: "/p",
      }),
      true,
    );
    assert.equal(ws.isUsableWorkspaceRecord(record, { exists: () => false, projectDir: "/p" }), false);
    assert.equal(
      ws.isUsableWorkspaceRecord(
        { ...record, project_dir: "/other" },
        { exists: () => true, projectDir: "/p" },
      ),
      false,
    );
  });

  it("picks the latest usable earlier round for a rework", () => {
    const dir = stateDir();
    const base = { identifier: "TP-0001", project_dir: "/p", path: "/p/.worktrees/TP-0001", branch: "lane/TP-0001" };
    ws.upsertWorkspaceRecord(dir, { ...base, round: 1 });
    ws.upsertWorkspaceRecord(dir, { ...base, round: 2, path: "/p/.worktrees/TP-0001-r2", branch: "lane/TP-0001-r2" });
    const branchExists = (cmd, argv) =>
      argv.join(" ").includes("rev-parse --verify --quiet") ? OK("abc\n") : OK("");
    const exists = (path) =>
      path === "/p/.worktrees/TP-0001/.git" ? true : path === "/p/.worktrees/TP-0001-r2/.git";
    const reused = ws.reusableReworkWorkspace({
      stateDir: dir,
      identifier: "TP-0001",
      round: 3,
      projectDir: "/p",
      exists,
      run: branchExists,
    });
    assert.equal(reused.round, 2, "the latest usable round wins");
    assert.equal(reused.path, "/p/.worktrees/TP-0001-r2");

    const missingTree = ws.reusableReworkWorkspace({
      stateDir: dir,
      identifier: "TP-0001",
      round: 3,
      projectDir: "/p",
      exists: () => false,
      run: branchExists,
    });
    assert.equal(missingTree, null, "a dead tree is not a reuse source");

    const missingBranch = ws.reusableReworkWorkspace({
      stateDir: dir,
      identifier: "TP-0001",
      round: 3,
      projectDir: "/p",
      exists,
      run: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    assert.equal(missingBranch, null, "a deleted branch is not a reuse source");
  });

  it("calls a record stale only when the tree is not usable and the branch is absent", () => {
    const record = {
      identifier: "TP-0001",
      round: 1,
      path: "/p/.worktrees/TP-0001",
      branch: "lane/TP-0001",
      project_dir: "/p",
    };
    const exists = (path) => path === "/p/.git";
    const probe = (status) => (cmd, argv) =>
      argv.join(" ").includes("rev-parse --verify --quiet")
        ? { status, stdout: status === 0 ? "abc\n" : "", stderr: "" }
        : OK("");

    assert.equal(ws.isStaleWorkspaceRecord(record, { exists, run: probe(1) }), true);
    assert.equal(ws.isStaleWorkspaceRecord(record, { exists, run: probe(0) }), false);
    assert.equal(ws.isStaleWorkspaceRecord(record, { exists, run: () => null }), false);
    assert.equal(ws.isStaleWorkspaceRecord(record, { exists: () => false, run: probe(1) }), false);
    assert.equal(
      ws.isStaleWorkspaceRecord(record, {
        exists: (path) => path === "/p/.git" || path === "/p/.worktrees/TP-0001/.git",
        run: probe(1),
      }),
      false,
      "a usable tree outlives a deleted branch",
    );
  });
});

describe("orchestrator/workspace — sweeping the registry", () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const stateDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-sweep-"));
    dirs.push(dir);
    return dir;
  };
  const record = {
    identifier: "TP-0001",
    round: 1,
    path: "/p/.worktrees/TP-0001",
    branch: "lane/TP-0001",
    project_dir: "/p",
  };
  const probe = (status) => (cmd, argv) =>
    argv.join(" ").includes("rev-parse --verify --quiet")
      ? { status, stdout: status === 0 ? "abc\n" : "", stderr: "" }
      : OK("");
  const tasks = [{ identifier: "TP-0001", status: "todo" }];

  it("drops a non-terminal record whose tree and branch are both gone", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, record);
    const lines = [];
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks,
      run: probe(1),
      exists: (path) => path === "/p/.git",
      log: (line) => lines.push(line),
    });
    assert.equal(result.removed.length, 1);
    assert.equal(ws.findWorkspace(dir, { identifier: "TP-0001" }), null);
    assert.match(lines.join("\n"), /dropping TP-0001 r1/);
  });

  it("keeps a non-terminal record whose branch still exists", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, record);
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks,
      run: probe(0),
      exists: (path) => path === "/p/.git",
    });
    assert.equal(result.removed.length, 0);
    assert.notEqual(ws.findWorkspace(dir, { identifier: "TP-0001" }), null);
  });

  it("keeps a record when git cannot be probed", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, record);
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks,
      run: () => null,
      exists: (path) => path === "/p/.git",
    });
    assert.equal(result.removed.length, 0);
    assert.notEqual(ws.findWorkspace(dir, { identifier: "TP-0001" }), null);
  });

  it("keeps a busy record even when its tree is gone", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, record);
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks,
      run: probe(1),
      exists: (path) => path === "/p/.git",
      isBusy: () => true,
    });
    assert.equal(result.removed.length, 0);
    assert.notEqual(ws.findWorkspace(dir, { identifier: "TP-0001" }), null);
  });

  const doneRun = (branch) => {
    const calls = [];
    const run = (cmd, argv) => {
      const line = argv.join(" ");
      calls.push(line);
      if (line.includes("status --porcelain")) return { status: 0, stdout: "", stderr: "" };
      if (line.includes("rev-parse --abbrev-ref HEAD")) {
        return { status: 0, stdout: `${branch}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  };

  it("keeps a done record when its project has no registered merge target", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, { ...record, project: "P" });
    const { calls, run } = doneRun("dev");
    const lines = [];
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks: [{ identifier: "TP-0001", status: "done" }],
      run,
      exists: (path) => path === record.path,
      entryFor: () => null,
      log: (line) => lines.push(line),
    });
    assert.equal(result.removed.length, 0);
    assert.match(lines.join("\n"), /has no registered merge target/);
    assert.equal(calls.some((line) => line.includes("merge --no-ff")), false);
  });

  it("refuses to land a done record when the project is on another branch", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, { ...record, project: "P" });
    const { calls, run } = doneRun("feature");
    const lines = [];
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks: [{ identifier: "TP-0001", status: "done" }],
      run,
      exists: (path) => path === record.path,
      entryFor: () => ({ merge_ref: "dev" }),
      log: (line) => lines.push(line),
    });
    assert.equal(result.removed.length, 0);
    assert.match(lines.join("\n"), /MERGE_TARGET_MISMATCH/);
    assert.equal(calls.some((line) => line.includes("merge --no-ff")), false);
    assert.notEqual(ws.findWorkspace(dir, { identifier: "TP-0001" }), null);
  });

  it("lands a done record through the project's declared merge_ref", () => {
    const dir = stateDir();
    ws.upsertWorkspaceRecord(dir, { ...record, project: "P" });
    const { calls, run } = doneRun("dev");
    const result = ws.sweepWorkspaces({
      stateDir: dir,
      tasks: [{ identifier: "TP-0001", status: "done" }],
      run,
      exists: (path) => path === record.path,
      entryFor: () => ({ merge_ref: "dev" }),
    });
    assert.equal(result.removed.length, 1);
    assert.equal(calls.some((line) => line.includes("merge --no-ff")), true);
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
