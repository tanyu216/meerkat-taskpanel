/**
 * The session worktree lifecycle: create, inspect, land and remove a human
 * session's own tree.
 *
 * The loop owns card worktrees and registers them in `workspaces.json`. This
 * module owns the other half — the tree a person or a live session makes for
 * parallel work — and deliberately keeps **no registry**: `git worktree list`
 * is the record, so a crashed session leaves nothing to reconcile. The naming
 * partition is the ownership rule: `lane/` belongs to the loop and is never
 * touched here; a session branch is `<type>/<slug>`.
 *
 * Every decision is pure: git calls, filesystem checks and clock/stat are
 * injected by the caller. Failure is a coded result, never a throw; the CLI
 * turns it into a `DomainError`.
 *
 * Safety is the removal rule: a session tree is removed only when its working
 * tree is clean and its branch is already an ancestor of the integration
 * branch. There is no `--force` here — a dirty or unmerged tree is reported to
 * its owner, which is what keeps this from becoming a second way to lose work.
 */

import { basename, dirname, join, resolve, sep } from "node:path";

/** Every way the session lifecycle can refuse, as a stable code. */
export const WORKTREE_CODES = Object.freeze({
  NOT_GIT: "WORKTREE_NOT_GIT",
  GIT_UNAVAILABLE: "WORKTREE_GIT_UNAVAILABLE",
  INVALID: "WORKTREE_INVALID",
  EXISTS: "WORKTREE_EXISTS",
  NOT_FOUND: "WORKTREE_NOT_FOUND",
  DIRTY: "WORKTREE_DIRTY",
  UNMERGED: "WORKTREE_UNMERGED",
  LOOP_OWNED: "WORKTREE_LOOP_OWNED",
  NOT_IGNORED: "WORKTREE_NOT_IGNORED",
  COMMAND_FAILED: "WORKTREE_COMMAND_FAILED",
});

/** The one root, shared with the loop's `.worktrees/` convention. */
export const SESSION_WORKTREE_ROOT = ".worktrees";

/** A session slug is one path segment: letters, digits, `.`, `_`, `-`. */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The loop's branch namespace. Never created, removed or landed here. */
export function isLoopBranch(branch) {
  return typeof branch === "string" && branch.startsWith("lane/");
}

/** `true` when `path` is strictly under `parent` (both physically resolved). */
export function isUnder(path, parent) {
  const child = resolve(String(path));
  const root = resolve(String(parent));
  return child !== root && child.startsWith(`${root}${sep}`);
}

/** A coded failure. */
function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * The primary checkout root, even when `cwd` is itself a linked worktree.
 *
 * `git rev-parse --git-common-dir` names the shared git directory; for a normal
 * checkout that is `<root>/.git`, so its parent is the root a session worktree
 * must live under. A bare repository has no primary checkout to attach to.
 *
 * @param {{cwd: string, run: Function}} input
 * @returns {{ok: true, root: string, current: string} | {ok: false, code: string, message: string}}
 */
export function primaryRoot({ cwd, run }) {
  const top = run("git", ["-C", String(cwd), "rev-parse", "--show-toplevel"]);
  if (top === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (top.status !== 0) {
    return failure(WORKTREE_CODES.NOT_GIT, `${cwd} is not a git checkout`);
  }
  const current = resolve(String(top.stdout ?? "").trim());
  if (current === "") return failure(WORKTREE_CODES.NOT_GIT, `${cwd} has no checkout root`);

  const common = run("git", [
    "-C",
    current,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (common.status !== 0) {
    return failure(WORKTREE_CODES.NOT_GIT, `${current} is not a git checkout`);
  }
  const commonDir = resolve(String(common.stdout ?? "").trim());
  if (basename(commonDir) !== ".git") {
    return failure(
      WORKTREE_CODES.NOT_GIT,
      `${current} has no primary checkout (a bare repository cannot host session worktrees)`,
    );
  }
  return { ok: true, root: dirname(commonDir), current };
}

/**
 * Parse `git worktree list --porcelain` into flat records.
 *
 * @param {string} text
 * @returns {Array<{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean}>}
 */
export function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
      };
      entries.push(current);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current !== null && line === "detached") {
      current.detached = true;
    } else if (current !== null && line === "bare") {
      current.bare = true;
    }
  }
  return entries;
}

/** Every session worktree under `<root>/.worktrees/`, the loop's lanes included. */
export function listSessionWorktrees({ root, run }) {
  const listed = run("git", ["-C", String(root), "worktree", "list", "--porcelain"]);
  if (listed === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (listed.status !== 0) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `cannot list worktrees in ${root}: ${String(listed.stderr ?? "").trim()}`,
    );
  }
  const sessionRoot = join(String(root), SESSION_WORKTREE_ROOT);
  return {
    ok: true,
    worktrees: parseWorktreeList(listed.stdout)
      .filter((entry) => isUnder(entry.path, sessionRoot))
      .map((entry) => ({
        ...entry,
        slug: basename(entry.path),
        loop_owned: isLoopBranch(entry.branch),
      })),
  };
}

/** Find one session worktree by its slug. */
export function findSessionWorktree({ root, run, slug }) {
  const listed = listSessionWorktrees({ root, run });
  if (listed.ok !== true) return listed;
  const wanted = resolve(join(String(root), SESSION_WORKTREE_ROOT, String(slug)));
  const found = listed.worktrees.find((entry) => resolve(entry.path) === wanted) ?? null;
  if (found === null) {
    return failure(WORKTREE_CODES.NOT_FOUND, `no session worktree at ${wanted}`);
  }
  return { ok: true, worktree: found };
}

/**
 * The integration branch this tree's work must be merged into: an explicit
 * `--into`, else the project's declared `merge_ref`, else the primary
 * checkout's current branch.
 */
export function resolveIntegrationRef({ root, projectEntry = null, into = null, run }) {
  if (typeof into === "string" && into.trim() !== "") {
    return { ok: true, ref: into.trim(), source: "explicit" };
  }
  const declared = projectEntry !== null && projectEntry !== undefined ? projectEntry.merge_ref : null;
  if (typeof declared === "string" && declared.trim() !== "") {
    return { ok: true, ref: declared.trim(), source: "project" };
  }
  const current = run("git", ["-C", String(root), "rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === null || current.status !== 0) {
    return failure(
      WORKTREE_CODES.GIT_UNAVAILABLE,
      `cannot read the current branch of ${root}; pass --into <ref>`,
    );
  }
  const ref = String(current.stdout ?? "").trim();
  if (ref === "" || ref === "HEAD") {
    return failure(
      WORKTREE_CODES.INVALID,
      `${root} is on a detached HEAD; pass --into <ref>`,
    );
  }
  return { ok: true, ref, source: "current" };
}

/** Porcelain status lines for one worktree; `null` when git cannot answer. */
export function dirtyPaths({ path, run }) {
  const status = run("git", ["-C", String(path), "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === null || status.status !== 0) return null;
  return String(status.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

/**
 * Is `branch` already an ancestor of `into`? Exit 1 is "not merged"; anything
 * else non-zero is "git could not answer", which must never be read as merged.
 */
export function isMerged({ root, branch, into, run }) {
  const result = run("git", [
    "-C",
    String(root),
    "merge-base",
    "--is-ancestor",
    String(branch),
    String(into),
  ]);
  if (result === null) return { ok: false, code: WORKTREE_CODES.GIT_UNAVAILABLE };
  if (result.status === 0) return { ok: true, merged: true };
  if (result.status === 1) return { ok: true, merged: false };
  return {
    ok: false,
    code: WORKTREE_CODES.COMMAND_FAILED,
    message: `cannot compare ${branch} with ${into}: ${String(result.stderr ?? "").trim()}`,
  };
}

/** Zero-padded refused result for a dirty tree, naming its files. */
function dirtyFailure(path, paths) {
  const shown = paths.slice(0, 10).join(", ");
  const more = paths.length > 10 ? ` (+${paths.length - 10} more)` : "";
  return failure(
    WORKTREE_CODES.DIRTY,
    `${path} has uncommitted changes: ${shown}${more}; commit or discard them first`,
  );
}

/**
 * Create `<root>/.worktrees/<slug>` on a new branch from `base`.
 *
 * `base` precedence: explicit `--base`, else the project's `base_ref`, else the
 * primary checkout's current branch. The root must already be ignored: this
 * command never edits `.gitignore` on the user's behalf.
 *
 * @param {{
 *   cwd: string, run: Function, exists: Function, mkdir: Function,
 *   slug: string, branch?: string|null, base?: string|null, projectEntry?: object|null,
 * }} input
 */
export function createSessionWorktree(input) {
  const {
    cwd,
    run,
    exists,
    mkdir,
    slug,
    branch = null,
    base = null,
    projectEntry = null,
  } = input;

  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    return failure(
      WORKTREE_CODES.INVALID,
      `slug '${slug}' must be one path segment of letters, digits, '.', '_' or '-'`,
    );
  }
  const rootResult = primaryRoot({ cwd, run });
  if (rootResult.ok !== true) return rootResult;
  const root = rootResult.root;

  const path = join(root, SESSION_WORKTREE_ROOT, slug);
  if (exists(path)) {
    return failure(WORKTREE_CODES.EXISTS, `${path} already exists`);
  }

  const branchName = typeof branch === "string" && branch.trim() !== "" ? branch.trim() : slug;
  if (isLoopBranch(branchName)) {
    return failure(
      WORKTREE_CODES.LOOP_OWNED,
      `branch '${branchName}' is the loop's namespace; a session branch must not use lane/`,
    );
  }
  const format = run("git", ["check-ref-format", "--branch", branchName]);
  if (format === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (format.status !== 0) {
    return failure(WORKTREE_CODES.INVALID, `'${branchName}' is not a valid branch name`);
  }

  const branchProbe = run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]);
  if (branchProbe === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (branchProbe.status === 0) {
    return failure(WORKTREE_CODES.EXISTS, `branch '${branchName}' already exists`);
  }
  if (branchProbe.status !== 1) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `cannot probe branch '${branchName}': ${String(branchProbe.stderr ?? "").trim()}`,
    );
  }

  const declared = projectEntry !== null && projectEntry !== undefined ? projectEntry.base_ref : null;
  const baseRef =
    typeof base === "string" && base.trim() !== ""
      ? base.trim()
      : typeof declared === "string" && declared.trim() !== ""
        ? declared.trim()
        : null;
  let resolvedBase = baseRef;
  if (resolvedBase === null) {
    const current = run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (current === null || current.status !== 0) {
      return failure(WORKTREE_CODES.GIT_UNAVAILABLE, `cannot read the current branch of ${root}`);
    }
    resolvedBase = String(current.stdout ?? "").trim();
    if (resolvedBase === "" || resolvedBase === "HEAD") {
      return failure(WORKTREE_CODES.INVALID, `${root} is on a detached HEAD; pass --base <ref>`);
    }
  }
  const baseProbe = run("git", [
    "-C",
    root,
    "rev-parse",
    "--verify",
    "--quiet",
    `${resolvedBase}^{commit}`,
  ]);
  if (baseProbe === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (baseProbe.status === 1) {
    return failure(WORKTREE_CODES.INVALID, `base '${resolvedBase}' does not resolve in ${root}`);
  }
  if (baseProbe.status !== 0) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `cannot resolve base '${resolvedBase}': ${String(baseProbe.stderr ?? "").trim()}`,
    );
  }

  // The directory must exist before `check-ignore` sees a directory-only
  // pattern (`.worktrees/` does not match a path that is not there yet).
  mkdir(join(root, SESSION_WORKTREE_ROOT), { recursive: true });
  const ignored = run("git", ["-C", root, "check-ignore", "-q", SESSION_WORKTREE_ROOT]);
  if (ignored === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (ignored.status === 1) {
    return failure(
      WORKTREE_CODES.NOT_IGNORED,
      `${join(root, SESSION_WORKTREE_ROOT)} is not ignored; add '${SESSION_WORKTREE_ROOT}/' to .gitignore first`,
    );
  }
  if (ignored.status !== 0) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `cannot check whether ${SESSION_WORKTREE_ROOT} is ignored: ${String(ignored.stderr ?? "").trim()}`,
    );
  }

  const added = run("git", [
    "-C",
    root,
    "worktree",
    "add",
    "-b",
    branchName,
    path,
    resolvedBase,
  ]);
  if (added === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (added.status !== 0) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `git worktree add failed: ${String(added.stderr ?? "").trim()}`,
    );
  }
  return {
    ok: true,
    workspace: { root, path, slug, branch: branchName, base: resolvedBase },
  };
}

/**
 * Keep or remove one session worktree.
 *
 * Removal is refused for a loop lane, a dirty tree, or a branch not yet merged
 * into the integration ref. The branch goes only after the directory, because
 * git refuses to delete a branch that is still checked out.
 *
 * @param {{
 *   cwd: string, run: Function, slug: string, remove: boolean,
 *   projectEntry?: object|null, into?: string|null,
 * }} input
 */
export function leaveSessionWorktree(input) {
  const { cwd, run, slug, remove, projectEntry = null, into = null } = input;
  const rootResult = primaryRoot({ cwd, run });
  if (rootResult.ok !== true) return rootResult;
  const root = rootResult.root;

  const found = findSessionWorktree({ root, run, slug });
  if (found.ok !== true) return found;
  const tree = found.worktree;

  if (tree.loop_owned) {
    return failure(
      WORKTREE_CODES.LOOP_OWNED,
      `${tree.path} is on ${tree.branch}, the loop's namespace; use the loop's acceptance/sweep`,
    );
  }
  if (remove !== true) {
    return { ok: true, worktree: tree, removed: false };
  }
  if (tree.detached || tree.branch === null) {
    return failure(
      WORKTREE_CODES.INVALID,
      `${tree.path} is not on a branch; remove it with the loop/owner that created it`,
    );
  }

  const dirty = dirtyPaths({ path: tree.path, run });
  if (dirty === null) {
    return failure(WORKTREE_CODES.GIT_UNAVAILABLE, `cannot read the status of ${tree.path}`);
  }
  if (dirty.length > 0) return dirtyFailure(tree.path, dirty);

  const integration = resolveIntegrationRef({ root, projectEntry, into, run });
  if (integration.ok !== true) return integration;
  const merged = isMerged({ root, branch: tree.branch, into: integration.ref, run });
  if (merged.ok !== true) return merged;
  if (merged.merged !== true) {
    return failure(
      WORKTREE_CODES.UNMERGED,
      `${tree.branch} is not merged into ${integration.ref}; merge it before removing ${tree.path}`,
    );
  }

  const removed = run("git", ["-C", root, "worktree", "remove", tree.path]);
  if (removed === null) return failure(WORKTREE_CODES.GIT_UNAVAILABLE, "git did not start");
  if (removed.status !== 0) {
    return failure(
      WORKTREE_CODES.COMMAND_FAILED,
      `git worktree remove failed: ${String(removed.stderr ?? "").trim()}`,
    );
  }
  const branchRemoved = run("git", ["-C", root, "branch", "-d", tree.branch]);
  return {
    ok: true,
    worktree: tree,
    removed: true,
    branch_removed: branchRemoved !== null && branchRemoved.status === 0,
  };
}

/**
 * Remove every session worktree that is provably safe: clean, merged, and (when
 * an age bound is given) old enough. Loop lanes, the current tree, dirty trees
 * and unmerged branches are reported, never removed.
 *
 * @param {{
 *   cwd: string, run: Function, stat: Function,
 *   olderThanHours?: number|null, projectEntry?: object|null, into?: string|null,
 *   dryRun?: boolean, now?: number,
 * }} input
 */
export function sweepSessionWorktrees(input) {
  const {
    cwd,
    run,
    stat,
    olderThanHours = null,
    projectEntry = null,
    into = null,
    dryRun = false,
    now = Date.now(),
  } = input;

  const rootResult = primaryRoot({ cwd, run });
  if (rootResult.ok !== true) return rootResult;
  const root = rootResult.root;

  const listed = listSessionWorktrees({ root, run });
  if (listed.ok !== true) return listed;

  const integration = resolveIntegrationRef({ root, projectEntry, into, run });
  if (integration.ok !== true) return integration;

  const removed = [];
  const kept = [];
  const wouldRemove = [];
  const branchesKept = [];

  for (const tree of listed.worktrees) {
    if (resolve(tree.path) === resolve(cwd) || isUnder(cwd, tree.path)) {
      kept.push({ ...tree, reason: "the current session's tree" });
      continue;
    }
    if (tree.loop_owned) {
      kept.push({ ...tree, reason: "loop-owned lane" });
      continue;
    }
    if (tree.detached || tree.branch === null) {
      kept.push({ ...tree, reason: "detached; no branch to compare" });
      continue;
    }
    if (olderThanHours !== null) {
      let mtime = null;
      try {
        mtime = stat(tree.path).mtimeMs;
      } catch {
        mtime = null;
      }
      if (mtime === null) {
        kept.push({ ...tree, reason: "cannot read its age" });
        continue;
      }
      const ageHours = (now - mtime) / 3_600_000;
      if (ageHours < olderThanHours) {
        kept.push({ ...tree, reason: `younger than ${olderThanHours}h` });
        continue;
      }
    }

    const dirty = dirtyPaths({ path: tree.path, run });
    if (dirty === null) {
      kept.push({ ...tree, reason: "cannot read its status" });
      continue;
    }
    if (dirty.length > 0) {
      kept.push({ ...tree, reason: "uncommitted changes" });
      continue;
    }
    const merged = isMerged({ root, branch: tree.branch, into: integration.ref, run });
    if (merged.ok !== true) {
      kept.push({ ...tree, reason: merged.message ?? merged.code });
      continue;
    }
    if (merged.merged !== true) {
      kept.push({ ...tree, reason: `not merged into ${integration.ref}` });
      continue;
    }

    if (dryRun) {
      wouldRemove.push(tree);
      continue;
    }
    const gone = run("git", ["-C", root, "worktree", "remove", tree.path]);
    if (gone === null || gone.status !== 0) {
      kept.push({
        ...tree,
        reason: `git worktree remove failed: ${String(gone?.stderr ?? "git did not start").trim()}`,
      });
      continue;
    }
    const branchGone = run("git", ["-C", root, "branch", "-d", tree.branch]);
    if (branchGone === null || branchGone.status !== 0) {
      branchesKept.push({
        branch: tree.branch,
        reason: String(branchGone?.stderr ?? "git did not start").trim(),
      });
    }
    removed.push(tree);
  }

  return {
    ok: true,
    root,
    into: integration.ref,
    removed,
    would_remove: wouldRemove,
    kept,
    branches_kept: branchesKept,
  };
}
