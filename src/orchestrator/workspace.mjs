/**
 * The loop's per-card workspace: a git worktree on its own lane branch.
 *
 * A worker used to run in the project's shared checkout. Two cards could then
 * edit the same tree, and an unrelated `git stash` could take a delivery away
 * before its review read it. A card now gets a worktree created from the
 * project's current branch (or the project's declared `base_ref`), the worker
 * runs there, and acceptance merges the lane branch back into the project's
 * current branch before the card reaches `done`.
 *
 * The decisions are pure; every git call goes through an injected `run`, so the
 * unit tests never shell out. The default runner is `spawnSync` and is used by
 * the loop and by the one integration leg.
 *
 * Naming matches the repository's own convention (CLAUDE.md): directory
 * `.worktrees/<ref>[-r<round>]`, branch `lane/<ref>[-r<round>]`. `taskDirName`
 * sanitizes the identifier, so a card id cannot escape the directory.
 *
 * Failure is always a coded result, never a throw: a card whose workspace
 * cannot be created is deferred by the caller, never moved into the shared
 * tree.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { MEERKAT_PROCESS_DIR, taskDirName } from "../foundation/card-brief.mjs";
import { QUEUE_FILES } from "../foundation/loop-state.mjs";
import { readJsonFile, writeJsonFile } from "./queue.mjs";

/** Workspace failures are orchestrator-local; they never cross the board API. */
export const WORKSPACE_CODES = Object.freeze({
  NOT_GIT: "WORKSPACE_NOT_GIT",
  BASE_UNRESOLVED: "WORKSPACE_BASE_UNRESOLVED",
  DETACHED_HEAD: "WORKSPACE_DETACHED_HEAD",
  CREATE_FAILED: "WORKSPACE_CREATE_FAILED",
  TARGET_DIRTY: "WORKSPACE_TARGET_DIRTY",
  TARGET_UNREADABLE: "WORKSPACE_TARGET_UNREADABLE",
  MERGE_CONFLICT: "WORKSPACE_MERGE_CONFLICT",
  MERGE_TARGET_MISMATCH: "WORKSPACE_MERGE_TARGET_MISMATCH",
});

/** The registry's file name, beside the queue's own state files. */
export const WORKSPACES_FILE = QUEUE_FILES.workspaces;

const DEFAULT_RUN_OPTIONS = Object.freeze({ encoding: "utf8", timeout: 10_000 });

/**
 * Run one command and return `{status, stdout, stderr}`, or `null` when the
 * command could not be started. A non-zero exit is a result, not a `null`.
 *
 * @param {string} cmd @param {string[]} argv @param {object} [options]
 */
export function runGit(cmd, argv, options = DEFAULT_RUN_OPTIONS) {
  try {
    const result = spawnSync(cmd, argv, options);
    if (result.error !== undefined && result.error !== null) return null;
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch {
    return null;
  }
}

/** `.git` exists (a directory, or the `.git` file of a linked worktree). */
export function isGitCheckout(dir, { exists = existsSync } = {}) {
  return exists(join(String(dir), ".git"));
}

/** `TP-0001` round 1 → `TP-0001`; round 2 → `TP-0001-r2`. */
export function worktreeName(identifier, round) {
  const slug = taskDirName(identifier);
  const n = Number(round);
  return Number.isInteger(n) && n > 1 ? `${slug}-r${n}` : slug;
}

/** `lane/TP-0001` round 1 → `lane/TP-0001`; round 2 → `lane/TP-0001-r2`. */
export function laneBranch(identifier, round) {
  return `lane/${worktreeName(identifier, round)}`;
}

/** `<project>/.worktrees/<name>`. */
export function workspacePath(projectDir, identifier, round) {
  return join(String(projectDir), ".worktrees", worktreeName(identifier, round));
}

/**
 * The project directory's current branch. A detached HEAD is refused: merging a
 * lane into a detached checkout would leave the work unreachable.
 *
 * @param {{projectDir: string, run?: Function}} input
 */
export function currentBranch({ projectDir, run = runGit }) {
  const result = run("git", ["-C", String(projectDir), "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result === null || result.status !== 0) {
    return {
      ok: false,
      code: WORKSPACE_CODES.BASE_UNRESOLVED,
      message: `cannot read the current branch of ${projectDir}`,
    };
  }
  const ref = String(result.stdout ?? "").trim();
  if (ref === "" || ref === "HEAD") {
    return {
      ok: false,
      code: WORKSPACE_CODES.DETACHED_HEAD,
      message: `${projectDir} is on a detached HEAD; check out a branch first`,
    };
  }
  return { ok: true, ref };
}

/**
 * The commit a new round starts from.
 *
 * Precedence, in this order:
 *   1. the project's own rule (`projects.json` entry `base_ref`);
 *   2. the previous round's lane branch (a rework keeps the rejected work);
 *   3. the project directory's current branch.
 *
 * The ref is not hard-coded: a project that lands on `main`, or on a release
 * branch, gets what it asked for.
 *
 * @param {{projectDir: string, entry: object|null, previousBranch?: string|null, run?: Function}} input
 */
export function resolveBaseRef({ projectDir, entry, previousBranch = null, run = runGit }) {
  const declared = entry !== null && entry !== undefined ? entry.base_ref : null;
  if (typeof declared === "string" && declared.trim() !== "") {
    return { ok: true, ref: declared.trim(), source: "project" };
  }
  if (typeof previousBranch === "string" && previousBranch.trim() !== "") {
    return { ok: true, ref: previousBranch.trim(), source: "previous" };
  }
  const current = currentBranch({ projectDir, run });
  if (!current.ok) return current;
  return { ok: true, ref: current.ref, source: "current" };
}

/**
 * Create the card's worktree and lane branch.
 *
 * @param {{
 *   projectDir: string,
 *   entry: object|null,
 *   identifier: string,
 *   round?: number,
 *   previousBranch?: string|null,
 *   run?: Function,
 *   mkdir?: Function,
 *   exists?: Function,
 * }} input
 * @returns {{ok: true, workspace: object} | {ok: false, code: string, message: string}}
 */
export function createWorkspace(input) {
  const {
    projectDir,
    entry,
    project = null,
    identifier,
    round = 1,
    previousBranch = null,
    run = runGit,
    mkdir = mkdirSync,
    exists = existsSync,
  } = input;

  if (!isGitCheckout(projectDir, { exists })) {
    return {
      ok: false,
      code: WORKSPACE_CODES.NOT_GIT,
      message: `${projectDir} is not a git checkout; there is nothing to branch from`,
    };
  }

  const base = resolveBaseRef({ projectDir, entry, previousBranch, run });
  if (!base.ok) return base;

  const path = workspacePath(projectDir, identifier, round);
  const branch = laneBranch(identifier, round);
  try {
    mkdir(join(String(projectDir), ".worktrees"), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: WORKSPACE_CODES.CREATE_FAILED,
      message: `cannot create ${join(String(projectDir), ".worktrees")}: ${err.message}`,
    };
  }

  const result = run("git", ["-C", String(projectDir), "worktree", "add", "-b", branch, path, base.ref]);
  if (result === null || result.status !== 0) {
    return {
      ok: false,
      code: WORKSPACE_CODES.CREATE_FAILED,
      message: `git worktree add failed for ${identifier}: ${String(result?.stderr ?? "git did not start").trim()}`,
    };
  }
  return {
    ok: true,
    workspace: {
      identifier,
      // The board project, so landing can re-read its rules (`merge_ref`).
      project: typeof project === "string" && project !== "" ? project : null,
      round,
      path,
      branch,
      base_ref: base.ref,
      project_dir: String(projectDir),
      created_by_loop: true,
    },
  };
}

/** Delete a directory tree; best effort — a missing one is not a failure. */
function removeDirSync(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // The removal below reports whatever git says; this is only the loop's
    // own scratch directory.
  }
}

/**
 * Remove the worktree, then its branch. The order is load-bearing: git refuses
 * to delete a branch that is still checked out in a worktree.
 *
 * The loop's own process directory inside the tree is cleared first so a card
 * brief cannot make every cleanup fail; any *other* dirt is left in place and
 * its branch is kept — the owner may still need the changes, and a removal that
 * cannot run is never forced.
 *
 * @param {{workspace: object, run?: Function, removeDir?: Function}} input
 * @returns {{ok: boolean, worktreeRemoved: boolean, branchRemoved: boolean, reason: string|null}}
 */
export function removeWorkspace({ workspace, run = runGit, removeDir = removeDirSync }) {
  const projectDir = String(workspace.project_dir ?? "");
  const path = String(workspace.path ?? "");
  const branch = String(workspace.branch ?? "");

  let removed = run("git", ["-C", projectDir, "worktree", "remove", path]);
  if ((removed === null || removed.status !== 0) && path !== "") {
    // The loop writes the card brief into `<worktree>/.meerkat/<ref>/`, and git
    // refuses to remove a worktree that holds untracked files. Clear the loop's
    // own process directory and retry once — a dirty tree that survives the
    // retry is still left for its owner.
    removeDir(join(path, MEERKAT_PROCESS_DIR));
    removed = run("git", ["-C", projectDir, "worktree", "remove", path]);
  }
  if (removed === null || removed.status !== 0) {
    return {
      ok: false,
      worktreeRemoved: false,
      branchRemoved: false,
      reason: String(removed?.stderr ?? "git worktree remove did not start").trim(),
    };
  }

  const deleted = run("git", ["-C", projectDir, "branch", "-d", branch]);
  if (deleted === null || deleted.status !== 0) {
    return {
      ok: false,
      worktreeRemoved: true,
      branchRemoved: false,
      // `-d` refuses an unmerged branch on purpose; the lane stays for a human.
      reason: String(deleted?.stderr ?? "git branch -d did not start").trim(),
    };
  }
  return { ok: true, worktreeRemoved: true, branchRemoved: true, reason: null };
}

/**
 * The porcelain lines that name a real uncommitted change.
 *
 * The loop's own `.worktrees/` is ignored: a project that does not gitignore it
 * would otherwise look permanently dirty, and that directory is the loop's
 * workspace root, not a teammate's work.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
function dirtyPaths(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "")
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/g, "");
      return !(path === ".worktrees" || path.startsWith(".worktrees/"));
    });
}

/**
 * Merge the lane branch into the project's checked-out branch.
 *
 * The project checkout must be clean: merging into a tree someone else is
 * editing is the same class of accident this module exists to prevent. A
 * conflict is aborted and reported with its files; the lane branch and the
 * worktree survive for a human, and the caller must not move the card to `done`.
 *
 * @param {{workspace: object, run?: Function, entry?: object|null}} input
 * @returns {{ok: true, merged: true} | {ok: false, code: string, message: string, conflicts?: string[]}}
 */
export function mergeWorkspace({ workspace, run = runGit, entry = null }) {
  const projectDir = String(workspace.project_dir ?? "");
  const branch = String(workspace.branch ?? "");
  const identifier = String(workspace.identifier ?? branch);

  const status = run("git", ["-C", projectDir, "status", "--porcelain"]);
  if (status === null || status.status !== 0) {
    return {
      ok: false,
      code: WORKSPACE_CODES.TARGET_UNREADABLE,
      message: `cannot read the status of ${projectDir}`,
    };
  }
  if (dirtyPaths(status.stdout).length > 0) {
    return {
      ok: false,
      code: WORKSPACE_CODES.TARGET_DIRTY,
      message: `${projectDir} has uncommitted changes; refusing to merge into it`,
    };
  }

  const declared = entry !== null && entry !== undefined ? entry.merge_ref : null;
  if (typeof declared === "string" && declared.trim() !== "") {
    const current = currentBranch({ projectDir, run });
    if (!current.ok) return current;
    if (current.ref !== declared.trim()) {
      return {
        ok: false,
        code: WORKSPACE_CODES.MERGE_TARGET_MISMATCH,
        message:
          `${projectDir} is on ${current.ref}, but the project declares ${declared.trim()} ` +
          "as its integration branch",
      };
    }
  }

  const merged = run("git", ["-C", projectDir, "merge", "--no-ff", branch, "-m", `merge: ${identifier}`]);
  if (merged !== null && merged.status === 0) return { ok: true, merged: true };

  const conflictsResult = run("git", ["-C", projectDir, "diff", "--name-only", "--diff-filter=U"]);
  const conflicts =
    conflictsResult === null || conflictsResult.status !== 0
      ? []
      : String(conflictsResult.stdout ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
  run("git", ["-C", projectDir, "merge", "--abort"]);
  return {
    ok: false,
    code: WORKSPACE_CODES.MERGE_CONFLICT,
    message: `merging ${branch} into ${projectDir} conflicted: ${String(merged?.stderr ?? "").trim()}`,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// The registry — one record per card round, beside the queue's state files
// ---------------------------------------------------------------------------

/** @param {string} stateDir */
export function registryPath(stateDir) {
  return join(String(stateDir), WORKSPACES_FILE);
}

/** @param {string} stateDir */
export function readWorkspaceRegistry(stateDir) {
  const read = readJsonFile(registryPath(stateDir), { version: 1, workspaces: [] });
  const value = read.value;
  if (value === null || typeof value !== "object" || !Array.isArray(value.workspaces)) {
    return { version: 1, workspaces: [] };
  }
  return value;
}

/** @param {string} stateDir @param {object} record */
export function upsertWorkspaceRecord(stateDir, record) {
  const registry = readWorkspaceRegistry(stateDir);
  const kept = registry.workspaces.filter(
    (entry) =>
      !(
        entry.identifier === record.identifier &&
        Number(entry.round) === Number(record.round)
      ),
  );
  kept.push(record);
  const written = writeJsonFile(registryPath(stateDir), { version: 1, workspaces: kept });
  return { ok: written.ok, error: written.error };
}

/** @param {string} stateDir @param {{identifier: string, round?: number}} input */
export function removeWorkspaceRecord(stateDir, { identifier, round }) {
  const registry = readWorkspaceRegistry(stateDir);
  const kept = registry.workspaces.filter((entry) => {
    if (entry.identifier !== identifier) return true;
    return round === undefined ? false : Number(entry.round) !== Number(round);
  });
  const written = writeJsonFile(registryPath(stateDir), { version: 1, workspaces: kept });
  return { ok: written.ok, error: written.error };
}

/**
 * Find a card's workspace. With no `round`, the latest recorded round wins;
 * a rework starts from that branch.
 *
 * @param {string} stateDir @param {{identifier: string, round?: number}} input
 */
export function findWorkspace(stateDir, { identifier, round }) {
  const { workspaces } = readWorkspaceRegistry(stateDir);
  const matches = workspaces.filter((entry) => entry.identifier === identifier);
  if (matches.length === 0) return null;
  if (round !== undefined && round !== null) {
    return matches.find((entry) => Number(entry.round) === Number(round)) ?? null;
  }
  return matches.reduce((latest, entry) =>
    Number(entry.round) > Number(latest.round) ? entry : latest,
  );
}

/**
 * Remove the workspaces of terminal cards. Called from the patrol pass, which
 * already reads the board; never from a turn's completion (the reviewer may
 * still need the tree).
 *
 * @param {{
 *   stateDir: string,
 *   tasks: object[],
 *   run?: Function,
 *   isBusy?: (path: string) => boolean,
 *   exists?: Function,
 *   log?: (line: string) => void,
 * }} input
 */
export function sweepWorkspaces({
  stateDir,
  tasks,
  run = runGit,
  isBusy = () => false,
  exists = existsSync,
  log = () => {},
}) {
  const registry = readWorkspaceRegistry(stateDir);
  const byIdentifier = new Map((tasks ?? []).map((task) => [task.identifier, task]));
  const kept = [];
  const removed = [];
  for (const record of registry.workspaces) {
    const task = byIdentifier.get(record.identifier);
    const terminal = task !== undefined && (task.status === "done" || task.status === "canceled");
    if (!terminal) {
      kept.push(record);
      continue;
    }
    if (isBusy(record.path)) {
      kept.push(record);
      continue;
    }
    if (!exists(record.path)) {
      // The tree is already gone; drop the record, not the card.
      removed.push(record);
      continue;
    }
    // A `done` card means landed: a human close (and a crash between the merge
    // and the cleanup) is caught here. Merging an already-merged branch is a
    // no-op ("Already up to date"). A conflict keeps the tree for a human.
    if (task.status === "done") {
      const merged = mergeWorkspace({ workspace: record, run });
      if (merged.ok !== true) {
        kept.push(record);
        log(
          `workspace: ${record.identifier} is done but not landed (${merged.code}); ` +
            `keeping ${record.path} for a human`,
        );
        continue;
      }
    }
    const result = removeWorkspace({ workspace: record, run });
    if (result.ok || result.worktreeRemoved) {
      removed.push(record);
      if (!result.branchRemoved) {
        log(`workspace: ${record.branch} is unmerged; the lane branch was left in place`);
      }
    } else {
      kept.push(record);
      log(`workspace: ${record.path} was not removed (${result.reason}); left for its owner`);
    }
  }
  if (removed.length > 0) {
    writeJsonFile(registryPath(stateDir), { version: 1, workspaces: kept });
  }
  return { removed, kept };
}
