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
 * `.worktrees/<ref>[-r<round>][-<slug>]`, branch `lane/<ref>[-r<round>][-<slug>]`.
 * `taskDirName` sanitizes the identifier, so a card id cannot escape the
 * directory; `laneSlug` derives the readable segment from the card title and
 * yields nothing when the title has no ASCII word, leaving the older
 * `<ref>[-r<round>]` name.
 *
 * Failure is always a coded result, never a throw: a card whose workspace
 * cannot be created is deferred by the caller, never moved into the shared
 * tree.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { MEERKAT_PROCESS_DIR, taskDirName } from "../foundation/card-brief.mjs";
import { probeGitRef, readCurrentBranch } from "../foundation/git-ref.mjs";
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
  REVIEW_TARGET_MISSING: "WORKSPACE_REVIEW_TARGET_MISSING",
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

/**
 * A record whose tree is still this project's checkout.
 *
 * The path is the loop's own slot, but it can outlive its registration (a
 * removed worktree leaves a bare directory behind). A directory without `.git`
 * is not a usable target; a record from another project is not this card's.
 */
export function isUsableWorkspaceRecord(record, { exists = existsSync, projectDir = null } = {}) {
  if (record === null || typeof record !== "object") return false;
  const path = String(record.path ?? "");
  if (path === "") return false;
  const wanted = String(projectDir ?? "");
  const recorded = String(record.project_dir ?? "");
  if (wanted !== "" && recorded !== "" && wanted !== recorded) return false;
  return isGitCheckout(path, { exists });
}

/**
 * A record whose tree is gone *and* whose branch is absent.
 *
 * Both halves are required: a surviving branch still holds the rejected work a
 * rework starts from, and a probe that could not run (git missing, not a repo)
 * is not evidence of absence. Dropping on either would destroy recoverable state.
 */
export function isStaleWorkspaceRecord(record, { exists = existsSync, run = runGit } = {}) {
  if (record === null || typeof record !== "object") return false;
  const projectDir = String(record.project_dir ?? "");
  const path = String(record.path ?? "");
  const branch = String(record.branch ?? "");
  if (projectDir === "" || path === "" || branch === "") return false;
  if (!isGitCheckout(projectDir, { exists })) return false;
  if (isUsableWorkspaceRecord(record, { exists })) return false;
  const probe = probeRef({ projectDir, ref: branch, run });
  return probe.ok === true && probe.exists === false;
}

/**
 * The readable segment's cap: a title contributes at most this many characters,
 * so a long title cannot push a lane past a filesystem name limit.
 */
const LANE_SLUG_MAX = 40;

/**
 * A card title as one ref-safe segment.
 *
 * Lower-case ASCII words joined by `-`; every other run of characters is a
 * separator. A title with no ASCII word (CJK, symbols) yields `""` — the caller
 * then keeps the identifier-only name rather than inventing a marker. The cap
 * is a hard cut, then any dangling separator is trimmed.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function laneSlug(title) {
  const words = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words === "") return "";
  return words.slice(0, LANE_SLUG_MAX).replace(/-+$/g, "");
}

/**
 * `TP-0001` round 1 → `TP-0001`; round 2 → `TP-0001-r2`; a titled card adds
 * `-<slug>` after the round (`TP-0001-r2-fix-the-rail`).
 */
export function worktreeName(identifier, round, title = null) {
  const slug = laneSlug(title);
  const n = Number(round);
  const roundPart = Number.isInteger(n) && n > 1 ? `-r${n}` : "";
  const slugPart = slug === "" ? "" : `-${slug}`;
  return `${taskDirName(identifier)}${roundPart}${slugPart}`;
}

/** The same name behind the loop's branch namespace: `lane/<name>`. */
export function laneBranch(identifier, round, title = null) {
  return `lane/${worktreeName(identifier, round, title)}`;
}

/** `<project>/.worktrees/<name>`, naming the directory exactly as the branch. */
export function workspacePath(projectDir, identifier, round, title = null) {
  return join(String(projectDir), ".worktrees", worktreeName(identifier, round, title));
}

/**
 * The project directory's current branch. A detached HEAD is refused: merging a
 * lane into a detached checkout would leave the work unreachable.
 *
 * @param {{projectDir: string, run?: Function}} input
 */
export function currentBranch({ projectDir, run = runGit }) {
  const result = readCurrentBranch({ projectDir, run });
  if (result.ok === true) return result;
  if (result.reason === "detached") {
    return {
      ok: false,
      code: WORKSPACE_CODES.DETACHED_HEAD,
      message: `${projectDir} is on a detached HEAD; check out a branch first`,
    };
  }
  return {
    ok: false,
    code: WORKSPACE_CODES.BASE_UNRESOLVED,
    message: `cannot read the current branch of ${projectDir}`,
  };
}

/**
 * Probe a candidate base ref.
 *
 * The exit code is load-bearing: `rev-parse --verify --quiet` exits 1 for an
 * absent ref, but 128 when git could not answer at all (not a repository, a
 * broken checkout). An absent ref may fall back; an unprobeable one must not be
 * treated as absent — that would let a transient git failure delete a live
 * workspace record.
 *
 * @param {{projectDir: string, ref: string, run?: Function}} input
 * @returns {{ok: true, exists: boolean} | {ok: false, code: string, message: string}}
 */
export function probeRef({ projectDir, ref, run = runGit }) {
  const value = typeof ref === "string" ? ref.trim() : "";
  const probe = probeGitRef({ projectDir, ref: value, run });
  if (probe.ok === true) return probe;
  if (probe.reason === "empty") {
    return {
      ok: false,
      code: WORKSPACE_CODES.BASE_UNRESOLVED,
      message: "the base ref is empty",
    };
  }
  if (probe.reason === "unavailable") {
    return {
      ok: false,
      code: WORKSPACE_CODES.BASE_UNRESOLVED,
      message: `git did not start while probing ${value}`,
    };
  }
  return {
    ok: false,
    code: WORKSPACE_CODES.BASE_UNRESOLVED,
    message: `git could not resolve ${value}: ${probe.stderr ?? ""}`,
  };
}

/**
 * The commit a new round starts from.
 *
 * Precedence, in this order:
 *   1. the project's own rule (`projects.json` entry `base_ref`);
 *   2. the previous round's lane branch (a rework keeps the rejected work);
 *   3. the project directory's current branch.
 *
 * A recorded ref is a hint, not a promise: a previous lane branch whose work was
 * merged and then deleted falls back to the current branch instead of failing
 * every pass on `invalid reference`. A declared `base_ref` is configuration and
 * does not fall back — a missing one is a coded error the operator must fix.
 *
 * The ref is not hard-coded: a project that lands on `main`, or on a release
 * branch, gets what it asked for.
 *
 * @param {{projectDir: string, entry: object|null, previousBranch?: string|null, run?: Function}} input
 */
export function resolveBaseRef({ projectDir, entry, previousBranch = null, run = runGit }) {
  const declared = entry !== null && entry !== undefined ? entry.base_ref : null;
  if (typeof declared === "string" && declared.trim() !== "") {
    const ref = declared.trim();
    const probe = probeRef({ projectDir, ref, run });
    if (probe.ok !== true || probe.exists !== true) {
      return {
        ok: false,
        code: WORKSPACE_CODES.BASE_UNRESOLVED,
        message: `the project declares base_ref '${ref}', but ${projectDir} has no such commit`,
      };
    }
    return { ok: true, ref, source: "project" };
  }
  if (typeof previousBranch === "string" && previousBranch.trim() !== "") {
    const ref = previousBranch.trim();
    const probe = probeRef({ projectDir, ref, run });
    if (probe.ok === true && probe.exists === true) {
      return { ok: true, ref, source: "previous" };
    }
    const current = currentBranch({ projectDir, run });
    if (!current.ok) return current;
    return { ok: true, ref: current.ref, source: "current", skipped_previous: ref };
  }
  const current = currentBranch({ projectDir, run });
  if (!current.ok) return current;
  return { ok: true, ref: current.ref, source: "current" };
}

/**
 * Create the card's worktree and lane branch.
 *
 * A repair round passes `reuseExistingBranch`: the current round's lane branch
 * may have outlived its directory, and re-attaching it keeps unmerged work the
 * card still owns. The base is not resolved on that path — there is nothing to
 * base from. If the branch is gone too, the call falls through to a fresh
 * create from the resolved base.
 *
 * A directory the loop does not own can occupy the slot (a removed worktree
 * leaves its `.meerkat` behind). It is not a checkout, so nothing tracked is
 * lost; it is moved aside instead of failing every pass on "already exists".
 *
 * @param {{
 *   projectDir: string,
 *   entry: object|null,
 *   identifier: string,
 *   round?: number,
 *   title?: string|null,
 *   previousBranch?: string|null,
 *   reuseExistingBranch?: boolean,
 *   project?: string|null,
 *   run?: Function,
 *   mkdir?: Function,
 *   exists?: Function,
 *   rename?: Function,
 *   now?: Function,
 *   log?: (line: string) => void,
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
    title = null,
    previousBranch = null,
    reuseExistingBranch = false,
    run = runGit,
    mkdir = mkdirSync,
    exists = existsSync,
    rename = renameSync,
    now = Date.now,
    log = () => {},
  } = input;

  if (!isGitCheckout(projectDir, { exists })) {
    return {
      ok: false,
      code: WORKSPACE_CODES.NOT_GIT,
      message: `${projectDir} is not a git checkout; there is nothing to branch from`,
    };
  }

  const path = workspacePath(projectDir, identifier, round, title);
  const branch = laneBranch(identifier, round, title);
  try {
    mkdir(join(String(projectDir), ".worktrees"), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: WORKSPACE_CODES.CREATE_FAILED,
      message: `cannot create ${join(String(projectDir), ".worktrees")}: ${err.message}`,
    };
  }

  if (exists(path) && !isGitCheckout(path, { exists })) {
    const orphan = `${path}.orphan-${now()}`;
    try {
      rename(path, orphan);
      log(`workspace: moved ${path} aside to ${orphan}`);
    } catch (err) {
      return {
        ok: false,
        code: WORKSPACE_CODES.CREATE_FAILED,
        message: `cannot move ${path} aside: ${err.message}`,
      };
    }
  }

  if (reuseExistingBranch) {
    // A registration left behind by an externally removed directory makes git
    // read the branch as still checked out; prune clears it before the add.
    run("git", ["-C", String(projectDir), "worktree", "prune"]);
    const probe = probeRef({ projectDir, ref: branch, run });
    if (probe.ok === true && probe.exists === true) {
      const attached = run("git", ["-C", String(projectDir), "worktree", "add", path, branch]);
      if (attached === null || attached.status !== 0) {
        return {
          ok: false,
          code: WORKSPACE_CODES.CREATE_FAILED,
          message: `git worktree add failed for ${identifier}: ${String(attached?.stderr ?? "git did not start").trim()}`,
        };
      }
      return {
        ok: true,
        workspace: {
          identifier,
          project: typeof project === "string" && project !== "" ? project : null,
          round,
          path,
          branch,
          base_ref: branch,
          project_dir: String(projectDir),
          created_by_loop: true,
          reused_branch: true,
          created_at: new Date().toISOString(),
        },
      };
    }
  }

  const base = resolveBaseRef({ projectDir, entry, previousBranch, run });
  if (!base.ok) return base;
  if (typeof base.skipped_previous === "string") {
    log(
      `workspace: ${identifier} previous base ${base.skipped_previous} is gone; basing on ${base.ref}`,
    );
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
      created_at: new Date().toISOString(),
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
 * The earlier rounds of one card, highest first.
 *
 * A rework wants the most recent *usable* rejected work. The latest record is
 * only a candidate: its branch may already be gone while an older one survives,
 * and `findWorkspace`'s "latest wins" would throw that older work away.
 *
 * @param {string} stateDir @param {{identifier: string, round?: number}} input
 */
export function listPreviousWorkspaces(stateDir, { identifier, round }) {
  const current = Number(round);
  if (!Number.isFinite(current)) return [];
  const { workspaces } = readWorkspaceRegistry(stateDir);
  return workspaces
    .filter((entry) => entry.identifier === identifier && Number(entry.round) < current)
    .sort((left, right) => Number(right.round) - Number(left.round));
}

/**
 * Remove the workspaces of terminal cards. Called from the patrol pass, which
 * already reads the board; never from a turn's completion (the reviewer may
 * still need the tree).
 *
 * `entryFor` resolves the board project's rules for a record, so a human close
 * lands under the same `merge_ref` check as the acceptance pass; without it the
 * sweep would merge into whatever happens to be checked out.
 *
 * @param {{
 *   stateDir: string,
 *   tasks: object[],
 *   run?: Function,
 *   isBusy?: (path: string) => boolean,
 *   exists?: Function,
 *   entryFor?: (project: string) => object|null,
 *   log?: (line: string) => void,
 * }} input
 */
export function sweepWorkspaces({
  stateDir,
  tasks,
  run = runGit,
  isBusy = () => false,
  exists = existsSync,
  entryFor = () => null,
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
      // A non-terminal record used to be kept unconditionally, which is how a
      // deleted branch survived in the registry and became a rework's base. A
      // record whose tree and branch are both gone can no longer help anyone.
      if (isBusy(record.path)) {
        kept.push(record);
        continue;
      }
      if (isStaleWorkspaceRecord(record, { exists, run })) {
        removed.push(record);
        log(
          `workspace: dropping ${record.identifier} r${record.round} record — ` +
            `${record.path} and ${record.branch} are both gone`,
        );
        continue;
      }
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
      const entry = record.project ? entryFor(record.project) : null;
      if (record.project && entry === null) {
        // Landing needs the project's own rules. Without a registered entry the
        // checked-out branch is only a guess, and a guess here merges work into
        // whatever branch a human happens to be on.
        kept.push(record);
        log(
          `workspace: ${record.identifier} is done but project ${record.project} ` +
            `has no registered merge target; keeping ${record.path} for a human`,
        );
        continue;
      }
      const merged = mergeWorkspace({ workspace: record, run, entry });
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
