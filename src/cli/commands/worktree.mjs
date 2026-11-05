/**
 * `taskctl worktree` — the local lifecycle for a **session** worktree.
 *
 * The loop owns card worktrees (`lane/<ref>[-r<round>][-<slug>]`, registered in
 * `workspaces.json`).
 * This command owns the other half: `.worktrees/<slug>` on a session branch,
 * with `git worktree list` as the only registry. It is local by construction —
 * no identity, no token, no board — exactly like `project map`.
 *
 * Removal is deliberately conservative: only a clean tree whose branch is
 * already an ancestor of the integration branch is removed. A dirty or
 * unmerged tree is reported to its owner; there is no `--force`.
 *
 * `guard` (the hook-facing policy) lives beside this command in phase 3; the
 * actions here are the lifecycle a person or a session runs directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { DomainError } from "../../foundation/errors.mjs";
import {
  WORKTREE_CODES,
  createSessionWorktree,
  dirtyPaths,
  isMerged,
  isUnder,
  leaveSessionWorktree,
  listSessionWorktrees,
  primaryRoot,
  resolveIntegrationRef,
  sweepSessionWorktrees,
} from "../../foundation/worktree.mjs";
import { defaultProjectsJson, readProjectMapForEdit } from "../../foundation/project-dir.mjs";
import { GUARD_RUNTIMES, decideGuard } from "../../foundation/worktree-guard.mjs";
import { table } from "../output/human.mjs";

/** The process boundary; the foundation decision functions take it injected. */
function runGit(cmd, argv) {
  try {
    const result = spawnSync(cmd, argv, { encoding: "utf8", timeout: 10_000 });
    if (result.error !== undefined && result.error !== null) return null;
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch {
    return null;
  }
}

function usageError(message) {
  return new DomainError("CLI_USAGE", {
    message,
    hint: { fix: "run `taskctl worktree --help`" },
  });
}

/** A local git failure, raised with the code's next action. */
function worktreeFailure(result) {
  const fixes = {
    [WORKTREE_CODES.NOT_GIT]: "run it inside a git checkout",
    [WORKTREE_CODES.GIT_UNAVAILABLE]: "check that `git --version` works, then retry",
    [WORKTREE_CODES.INVALID]: "check the slug, branch and base ref",
    [WORKTREE_CODES.EXISTS]: "pick another slug or branch, or inspect it with `taskctl worktree status`",
    [WORKTREE_CODES.NOT_FOUND]: "run `taskctl worktree status` to list the session worktrees",
    [WORKTREE_CODES.DIRTY]: "commit or discard the listed files, then retry",
    [WORKTREE_CODES.UNMERGED]: "merge the branch into the integration branch first",
    [WORKTREE_CODES.LOOP_OWNED]: "the loop owns lane/ worktrees; use the loop's acceptance or patrol sweep",
    [WORKTREE_CODES.NOT_IGNORED]: "add `.worktrees/` to .gitignore, commit it, then retry",
    [WORKTREE_CODES.COMMAND_FAILED]: "run `git worktree list` to inspect the repository, then retry",
  };
  return new DomainError(result.code, {
    message: result.message,
    ...(fixes[result.code] ? { hint: { fix: fixes[result.code] } } : {}),
  });
}

/**
 * The project entry named by `--project`. Without the flag the command uses the
 * primary checkout's current branch, not a guess from the directory: the map
 * deliberately has no reverse lookup.
 */
function projectEntryFor(ctx) {
  const id = typeof ctx.flags.project === "string" ? ctx.flags.project.trim() : "";
  if (id === "") return null;
  const file = defaultProjectsJson(ctx.env ?? {}, { cwd: ctx.cwd });
  const map = readProjectMapForEdit(file, { read: ctx.readFile });
  if (!map.ok) {
    throw new DomainError(map.code, { message: map.message, details: { file } });
  }
  const entry = map.projects.find(
    (candidate) => candidate !== null && typeof candidate === "object" && candidate.project === id,
  );
  if (entry === undefined) {
    throw new DomainError("PROJECT_DIR_UNMAPPED", {
      message: `no project map entry for '${id}' in ${file}`,
      details: { project: id, file },
      hint: { fix: `register it with \`taskctl project map set ${id} --local-path <dir>\`` },
    });
  }
  return entry;
}

function requireSlug(ctx, action) {
  const slug = typeof ctx.args.slug === "string" ? ctx.args.slug.trim() : "";
  if (slug === "") throw usageError(`\`taskctl worktree ${action}\` needs a <slug>`);
  return slug;
}

function positiveNumber(value, flag) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw usageError(`\`${flag}\` must be a non-negative number, got '${value}'`);
  }
  return number;
}

function runStatus(ctx) {
  const rootResult = primaryRoot({ cwd: ctx.cwd, run: runGit });
  if (rootResult.ok !== true) throw worktreeFailure(rootResult);
  const root = rootResult.root;
  const listed = listSessionWorktrees({ root, run: runGit });
  if (listed.ok !== true) throw worktreeFailure(listed);

  const entry = projectEntryFor(ctx);
  const into = typeof ctx.flags.into === "string" ? ctx.flags.into.trim() : null;
  const integration = resolveIntegrationRef({ root, projectEntry: entry, into, run: runGit });
  if (integration.ok !== true) throw worktreeFailure(integration);

  const worktrees = listed.worktrees.map((tree) => {
    const dirty = dirtyPaths({ path: tree.path, run: runGit });
    const merged =
      tree.branch === null
        ? { ok: true, merged: null }
        : isMerged({ root, branch: tree.branch, into: integration.ref, run: runGit });
    return {
      slug: tree.slug,
      path: tree.path,
      branch: tree.branch,
      loop_owned: tree.loop_owned,
      detached: tree.detached,
      current: resolve(tree.path) === resolve(ctx.cwd) || isUnder(ctx.cwd, tree.path),
      dirty: dirty === null ? null : dirty.length > 0,
      merged: merged.ok === true ? merged.merged : null,
    };
  });

  const human = worktrees.length === 0
    ? `no session worktrees under ${joinDisplay(root)}`
    : table(
        ["slug", "branch", "dirty", "merged", "owner"],
        worktrees.map((tree) => [
          tree.slug,
          tree.branch ?? "(detached)",
          tree.dirty === null ? "?" : tree.dirty ? "yes" : "no",
          tree.merged === null ? "?" : tree.merged ? "yes" : "no",
          tree.loop_owned ? "loop" : "session",
        ]),
      );
  return {
    data: { root, into: integration.ref, worktrees },
    human,
  };
}

function runCreate(ctx) {
  const slug = requireSlug(ctx, "create");
  const entry = projectEntryFor(ctx);
  const result = createSessionWorktree({
    cwd: ctx.cwd,
    run: runGit,
    exists: existsSync,
    mkdir: mkdirSync,
    slug,
    branch: typeof ctx.flags.branch === "string" ? ctx.flags.branch : null,
    base: typeof ctx.flags.base === "string" ? ctx.flags.base : null,
    projectEntry: entry,
  });
  if (result.ok !== true) throw worktreeFailure(result);
  const { workspace } = result;
  return {
    data: workspace,
    human: `created ${workspace.path} on ${workspace.branch} from ${workspace.base}`,
  };
}

function runLeave(ctx) {
  const slug = requireSlug(ctx, "leave");
  if (ctx.flags.keep === true && ctx.flags.remove === true) {
    throw usageError("`--keep` and `--remove` are mutually exclusive");
  }
  const remove = ctx.flags.remove === true;
  const entry = projectEntryFor(ctx);
  const result = leaveSessionWorktree({
    cwd: ctx.cwd,
    run: runGit,
    slug,
    remove,
    projectEntry: entry,
    into: typeof ctx.flags.into === "string" ? ctx.flags.into.trim() : null,
  });
  if (result.ok !== true) throw worktreeFailure(result);
  const { worktree } = result;
  if (result.removed !== true) {
    return {
      data: { slug, path: worktree.path, branch: worktree.branch, removed: false },
      human: `kept ${worktree.path} on ${worktree.branch ?? "(detached)"}`,
    };
  }
  return {
    data: {
      slug,
      path: worktree.path,
      branch: worktree.branch,
      removed: true,
      branch_removed: result.branch_removed === true,
    },
    human:
      `removed ${worktree.path}` +
      (result.branch_removed === true
        ? ` and branch ${worktree.branch}`
        : `; branch ${worktree.branch} was left in place`),
  };
}

function runSweep(ctx) {
  const entry = projectEntryFor(ctx);
  const olderThanHours = positiveNumber(ctx.flags.olderThan, "--older-than");
  const result = sweepSessionWorktrees({
    cwd: ctx.cwd,
    run: runGit,
    stat: statSync,
    olderThanHours,
    projectEntry: entry,
    into: typeof ctx.flags.into === "string" ? ctx.flags.into.trim() : null,
    dryRun: ctx.flags.dryRun === true,
  });
  if (result.ok !== true) throw worktreeFailure(result);

  const wouldRemove = result.would_remove ?? [];
  const lines = [];
  for (const tree of result.removed) lines.push(`removed ${tree.path} (${tree.branch})`);
  for (const tree of wouldRemove) lines.push(`would remove ${tree.path} (${tree.branch})`);
  for (const tree of result.kept) lines.push(`kept ${tree.path}: ${tree.reason}`);
  for (const branch of result.branches_kept ?? []) {
    lines.push(`kept branch ${branch.branch}: ${branch.reason}`);
  }
  const human = lines.length === 0 ? `nothing to sweep in ${joinDisplay(result.root)}` : lines.join("\n");
  return {
    data: {
      root: result.root,
      into: result.into,
      removed: result.removed.map((tree) => ({ slug: tree.slug, path: tree.path, branch: tree.branch })),
      would_remove: wouldRemove.map((tree) => ({ slug: tree.slug, path: tree.path, branch: tree.branch })),
      kept: result.kept.map((tree) => ({ slug: tree.slug, path: tree.path, branch: tree.branch, reason: tree.reason })),
      branches_kept: result.branches_kept ?? [],
    },
    human,
  };
}

function joinDisplay(root) {
  return resolve(root);
}

/**
 * The hook adapter. It reads one runtime payload from stdin and prints that
 * runtime's decision shape verbatim (the envelope would corrupt a hook):
 *
 *   claude / codex → `{"hookSpecificOutput":{...}}` on deny, nothing on allow
 *   pi             → `{"block":true,"reason":…}` / `{"block":false}`
 *
 * `--json` still yields the ordinary envelope for a person or a test.
 */
async function runGuard(ctx) {
  const runtime = typeof ctx.flags.runtime === "string" ? ctx.flags.runtime.trim() : "";
  if (!GUARD_RUNTIMES.includes(runtime)) {
    throw usageError(`\`--runtime\` must be one of ${GUARD_RUNTIMES.join(", ")}`);
  }
  const raw = await ctx.readStdin();
  let payload = {};
  try {
    payload = raw === "" ? {} : JSON.parse(raw);
  } catch {
    // An unreadable payload is the runtime's problem, not a reason to block a
    // session: the decision below sees an empty tool and allows.
    payload = {};
  }
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : ctx.cwd;
  const result = decideGuard({
    runtime,
    payload,
    cwd,
    run: runGit,
    exists: existsSync,
    realpath: realpathSync,
  });

  const human =
    runtime === "pi"
      ? JSON.stringify(result.decision === "deny" ? { block: true, reason: result.reason } : { block: false })
      : result.decision === "deny"
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: result.reason,
            },
          })
        : "";

  return {
    data: {
      runtime,
      decision: result.decision,
      reason: result.reason,
      target: result.target ?? null,
    },
    human,
  };
}

const projectFlag = {
  flag: "project",
  key: "project",
  as: "string",
  value: "<id>",
  summary: "Read base_ref/merge_ref from this project's map entry (loop rules).",
};

const intoFlag = {
  flag: "into",
  key: "into",
  as: "string",
  value: "<ref>",
  summary: "The integration branch to compare against; beats the project's merge_ref.",
};

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a session worktree under .worktrees/ (local; never the board).",
    usage:
      "worktree create <slug> [--project <id>] [--base <ref>] [--branch <name>]",
    positionals: [{ name: "slug", summary: "One path segment: letters, digits, '.', '_' or '-'." }],
    local: true,
    flags: [
      projectFlag,
      {
        flag: "base",
        key: "base",
        as: "string",
        value: "<ref>",
        summary: "The ref a new worktree branches from; beats the project's base_ref.",
      },
      {
        flag: "branch",
        key: "branch",
        as: "string",
        value: "<name>",
        summary: "The new branch name; defaults to the slug.",
      },
    ],
    run: runCreate,
  },
  {
    name: "status",
    summary: "List session worktrees with dirty/merged state (local; never the board).",
    usage: "worktree status [--project <id>] [--into <ref>]",
    positionals: [],
    local: true,
    flags: [projectFlag, intoFlag],
    run: runStatus,
  },
  {
    name: "leave",
    summary: "Keep or remove one session worktree; removal needs a clean, merged tree.",
    usage: "worktree leave <slug> [--keep|--remove] [--project <id>] [--into <ref>]",
    positionals: [{ name: "slug", summary: "Session worktree slug." }],
    local: true,
    flags: [
      projectFlag,
      intoFlag,
      {
        flag: "keep",
        key: "keep",
        as: "boolean",
        summary: "Leave the worktree in place (the default).",
      },
      {
        flag: "remove",
        key: "remove",
        as: "boolean",
        summary: "Remove the worktree and its merged branch; refuses a dirty or unmerged tree.",
      },
    ],
    run: runLeave,
  },
  {
    name: "guard",
    summary: "Hook adapter: read one tool payload and print the runtime's allow/deny shape.",
    usage: "worktree guard --runtime claude|codex|pi",
    positionals: [],
    local: true,
    flags: [
      {
        flag: "runtime",
        key: "runtime",
        as: "string",
        value: "<kind>",
        required: true,
        summary: "The hook's runtime: claude, codex or pi.",
      },
    ],
    run: runGuard,
  },
  {
    name: "sweep",
    summary: "Remove every clean, merged session worktree; report the rest.",
    usage:
      "worktree sweep [--older-than <hours>] [--project <id>] [--into <ref>] [--dry-run]",
    positionals: [],
    local: true,
    flags: [
      projectFlag,
      intoFlag,
      {
        flag: "older-than",
        key: "olderThan",
        as: "string",
        value: "<hours>",
        summary: "Skip trees younger than this many hours.",
      },
      {
        flag: "dry-run",
        key: "dryRun",
        as: "boolean",
        summary: "Report what would be removed, change nothing.",
      },
    ],
    run: runSweep,
  },
];

/** Re-exported for the command's own tests. */
export { worktreeFailure };
