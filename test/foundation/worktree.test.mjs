/**
 * The session-worktree lifecycle (`src/foundation/worktree.mjs`).
 *
 * The decisions are pure and injected; the cases here use both a fake runner
 * (for the error branches a real repository cannot produce) and a real git
 * repository (for the create/merge/remove path). The safety rule under test is
 * removal: only a clean tree whose branch is already an ancestor of the
 * integration ref goes, and a `lane/` tree is never touched.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  WORKTREE_CODES,
  createSessionWorktree,
  findSessionWorktree,
  isMerged,
  leaveSessionWorktree,
  listSessionWorktrees,
  parseWorktreeList,
  primaryRoot,
  resolveIntegrationRef,
  sweepSessionWorktrees,
} from "../../src/foundation/worktree.mjs";

/**
 * The verification image is the *runtime* image and ships no git, so only the
 * real-repository cases skip there (visible in the run's `skipped` count); the
 * pure, injected-runner cases above run everywhere — the rule
 * `test/release/prep.test.mjs` already follows.
 */
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const gitDescribe = hasGit ? describe : describe.skip;

const tempDirs = [];
function tempDir(prefix = "worktree-foundation-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const run = (cmd, argv) => {
  const result = spawnSync(cmd, argv, { encoding: "utf8", timeout: 10_000 });
  if (result.error !== undefined && result.error !== null) return null;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const no = (stdout = "", stderr = "") => ({ status: 1, stdout, stderr });

/** A real repository on `dev`, `.worktrees/` ignored, one commit. */
function makeRepo({ ignoreWorktrees = true } = {}) {
  const dir = join(tempDir(), "checkout");
  mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  };
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ignoreWorktrees ? ".worktrees/\n" : "");
  writeFileSync(join(dir, "README.md"), "base\n");
  git("add", ".gitignore", "README.md");
  git("commit", "-q", "-m", "base");
  return { dir: realpathSync(dir), git };
}

function create(dir, slug, extra = {}) {
  return createSessionWorktree({
    cwd: dir,
    run,
    exists: existsSync,
    mkdir: mkdirSync,
    slug,
    ...extra,
  });
}

function commitIn(tree, file = "work.txt") {
  writeFileSync(join(tree, file), "work\n");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("add", file);
  git("commit", "-q", "-m", "work");
}

describe("parseWorktreeList", () => {
  it("parses normal, detached and bare records", () => {
    const entries = parseWorktreeList(
      [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/dev",
        "",
        "worktree /repo/.worktrees/a",
        "HEAD def",
        "detached",
        "",
        "worktree /bare",
        "HEAD 123",
        "bare",
        "",
      ].join("\n"),
    );
    assert.equal(entries.length, 3);
    assert.equal(entries[0].branch, "dev");
    assert.equal(entries[1].detached, true);
    assert.equal(entries[2].bare, true);
  });
});

describe("primaryRoot", () => {
  it("refuses a non-repository and a bare repository", () => {
    const notGit = primaryRoot({
      cwd: "/x",
      run: () => no("", "fatal: not a git repository"),
    });
    assert.equal(notGit.code, WORKTREE_CODES.NOT_GIT);

    const bare = primaryRoot({
      cwd: "/x",
      run: (cmd, argv) => (argv.join(" ").includes("--show-toplevel") ? ok("/bare\n") : ok("/bare\n")),
    });
    assert.equal(bare.code, WORKTREE_CODES.NOT_GIT);
  });

  it("returns the primary root from the common git directory", () => {
    const result = primaryRoot({
      cwd: "/repo/.worktrees/a",
      run: (cmd, argv) => {
        const joined = argv.join(" ");
        if (joined.includes("--show-toplevel")) return ok("/repo/.worktrees/a\n");
        if (joined.includes("--git-common-dir")) return ok("/repo/.git\n");
        return no();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.root, "/repo");
  });

  it("reports git that did not start", () => {
    const result = primaryRoot({ cwd: "/x", run: () => null });
    assert.equal(result.code, WORKTREE_CODES.GIT_UNAVAILABLE);
  });
});

describe("resolveIntegrationRef", () => {
  it("prefers --into, then the project rule, then the current branch", () => {
    const runFake = () => ok("dev\n");
    assert.equal(
      resolveIntegrationRef({ root: "/r", into: "main", projectEntry: { merge_ref: "dev" }, run: runFake }).ref,
      "main",
    );
    assert.equal(
      resolveIntegrationRef({ root: "/r", projectEntry: { merge_ref: "release" }, run: runFake }).ref,
      "release",
    );
    assert.equal(resolveIntegrationRef({ root: "/r", run: runFake }).ref, "dev");
    assert.equal(
      resolveIntegrationRef({ root: "/r", run: () => ok("HEAD\n") }).code,
      WORKTREE_CODES.INVALID,
    );
    assert.equal(
      resolveIntegrationRef({ root: "/r", run: () => null }).code,
      WORKTREE_CODES.GIT_UNAVAILABLE,
    );
  });
});

describe("isMerged", () => {
  it("keeps the three answers distinct", () => {
    assert.deepEqual(isMerged({ root: "/r", branch: "a", into: "dev", run: () => ok() }), {
      ok: true,
      merged: true,
    });
    assert.deepEqual(isMerged({ root: "/r", branch: "a", into: "dev", run: () => no() }), {
      ok: true,
      merged: false,
    });
    assert.equal(
      isMerged({ root: "/r", branch: "a", into: "dev", run: () => ({ status: 128, stdout: "", stderr: "bad" }) }).code,
      WORKTREE_CODES.COMMAND_FAILED,
    );
    assert.equal(
      isMerged({ root: "/r", branch: "a", into: "dev", run: () => null }).code,
      WORKTREE_CODES.GIT_UNAVAILABLE,
    );
  });
});

gitDescribe("create/leave/sweep — real git", () => {
  it("creates, lists, keeps, then removes a merged tree", () => {
    const { dir, git } = makeRepo();
    const created = create(dir, "a", { projectEntry: { base_ref: "dev" } });
    assert.equal(created.ok, true);
    assert.equal(created.workspace.base, "dev");
    assert.equal(created.workspace.branch, "a");

    const listed = listSessionWorktrees({ root: dir, run });
    assert.equal(listed.ok, true);
    assert.equal(listed.worktrees[0].slug, "a");
    assert.equal(listed.worktrees[0].loop_owned, false);
    assert.equal(findSessionWorktree({ root: dir, run, slug: "a" }).ok, true);

    const kept = leaveSessionWorktree({ cwd: dir, run, slug: "a", remove: false });
    assert.equal(kept.ok, true);
    assert.equal(kept.removed, false);

    commitIn(created.workspace.path);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");
    const removed = leaveSessionWorktree({ cwd: dir, run, slug: "a", remove: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(removed.branch_removed, true);
    assert.equal(existsSync(created.workspace.path), false);
  });

  it("refuses a dirty tree, an unmerged branch, and a loop lane", () => {
    const { dir, git } = makeRepo();
    const dirty = create(dir, "dirty").workspace.path;
    writeFileSync(join(dirty, "README.md"), "dirty\n");
    assert.equal(
      leaveSessionWorktree({ cwd: dir, run, slug: "dirty", remove: true }).code,
      WORKTREE_CODES.DIRTY,
    );

    const unmerged = create(dir, "unmerged").workspace.path;
    commitIn(unmerged);
    assert.equal(
      leaveSessionWorktree({ cwd: dir, run, slug: "unmerged", remove: true }).code,
      WORKTREE_CODES.UNMERGED,
    );

    git("worktree", "add", "-q", join(dir, ".worktrees", "lane1"), "-b", "lane/TP-1", "dev");
    assert.equal(
      leaveSessionWorktree({ cwd: dir, run, slug: "lane1", remove: true }).code,
      WORKTREE_CODES.LOOP_OWNED,
    );
  });

  it("refuses invalid input and a missing ignore rule", () => {
    const { dir } = makeRepo();
    assert.equal(create(dir, "../escape").code, WORKTREE_CODES.INVALID);
    assert.equal(create(dir, "a", { branch: "lane/TP-1" }).code, WORKTREE_CODES.LOOP_OWNED);
    assert.equal(create(dir, "a", { branch: "bad branch" }).code, WORKTREE_CODES.INVALID);
    assert.equal(create(dir, "a", { base: "missing" }).code, WORKTREE_CODES.INVALID);
    assert.equal(create(dir, "a").ok, true);
    assert.equal(create(dir, "a").code, WORKTREE_CODES.EXISTS);
    assert.equal(create(dir, "b", { branch: "a" }).code, WORKTREE_CODES.EXISTS);

    const bare = makeRepo({ ignoreWorktrees: false });
    assert.equal(create(bare.dir, "c").code, WORKTREE_CODES.NOT_IGNORED);
  });

  it("sweeps clean+merged trees, keeps the rest, and never touches the current tree", () => {
    const { dir, git } = makeRepo();
    const clean = create(dir, "clean").workspace.path;
    const dirty = create(dir, "dirty").workspace.path;
    commitIn(clean);
    git("merge", "--no-ff", "-q", "clean", "-m", "merge clean");
    writeFileSync(join(dirty, "README.md"), "dirty\n");

    const result = sweepSessionWorktrees({ cwd: dir, run, stat: () => ({ mtimeMs: 0 }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed.map((tree) => tree.slug), ["clean"]);
    assert.deepEqual(result.kept.map((tree) => tree.slug), ["dirty"]);
    assert.equal(existsSync(clean), false);
    assert.equal(existsSync(dirty), true);

    const dry = sweepSessionWorktrees({ cwd: dirty, run, stat: () => ({ mtimeMs: 0 }), dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.removed.length, 0);
    assert.ok(dry.kept.some((tree) => tree.slug === "dirty" && /current/.test(tree.reason)));
  });

  it("honours the age bound and skips a tree whose status cannot be read", () => {
    const { dir, git } = makeRepo();
    const a = create(dir, "a").workspace.path;
    commitIn(a);
    git("merge", "--no-ff", "-q", "a", "-m", "merge a");
    const young = sweepSessionWorktrees({
      cwd: dir,
      run,
      stat: () => ({ mtimeMs: 1000 }),
      olderThanHours: 1,
      now: 1000 + 60_000,
    });
    assert.equal(young.removed.length, 0);
    assert.match(young.kept[0].reason, /younger/);
  });
});
