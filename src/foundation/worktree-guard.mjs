/**
 * The worktree guard: one policy for every agent runtime.
 *
 * The loop never starts a worker in the primary checkout, so it needs no guard.
 * A human session can, and different runtimes expose different interception
 * points — Claude and Codex have `PreToolUse`, pi has `tool_call`. This module
 * is the shared decision; each runtime adapter is a thin translator.
 *
 * The policy is deliberately small and honest:
 *
 *   * a project opts in by carrying `docs/agents/worktrees.md`;
 *   * a linked worktree (`.worktrees/<slug>`) is already isolated — allow;
 *   * a write/edit in the protected primary checkout is denied with the exact
 *     recovery command;
 *   * shell text is inspected best-effort. This is a guardrail, not a sandbox:
 *     `bash -c`, scripts, `eval`, `xargs` and a solver's own Node process can
 *     bypass it. Codex's `workspace-write` sandbox and a container are the real
 *     boundaries; the guard's job is to stop the ordinary mistake.
 *
 * Decisions are pure; git and the filesystem are injected. A failure to answer
 * (no git, unreadable payload) fails **open** and says so — a broken guard must
 * not brick a session. Only a positive match denies.
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const GUARD_RUNTIMES = Object.freeze(["claude", "codex", "pi"]);

/** The project's opt-in marker. */
export const WORKTREE_RULES_FILE = join("docs", "agents", "worktrees.md");

/** Paths inside the primary checkout that a session may still write. */
const EXEMPT_PREFIXES = [
  ".worktrees",
  ".meerkat",
  ".claude",
  ".git",
  "node_modules",
  "coverage",
  "dist",
  join("web", "dist"),
];

/** The one path a session may edit in place: the opt-out switch itself. */
const EXEMPT_PATHS = [WORKTREE_RULES_FILE];

/** A shell command that intends to write; best-effort, not a parser. */
const WRITE_COMMAND =
  /(^|[\s;&|(])(?:sed\s+-i|perl\s+-i|tee\b|cp\b|mv\b|rm\b|mkdir\b|rmdir\b|touch\b|chmod\b|chown\b|ln\b|truncate\b|dd\b|patch\b|git\s+(?:apply|restore|checkout\s+--|reset\s+--hard|clean\s+-[A-Za-z]*f)|>>?)/;

/** `{decision:"allow"}` with a diagnostic reason. */
function allow(reason) {
  return { decision: "allow", reason };
}

/** A positive match; the adapter turns this into its runtime's deny shape. */
function deny(reason, target) {
  return { decision: "deny", reason, target };
}

/** Resolve a tool path against the session cwd. */
function absolute(cwd, path) {
  return isAbsolute(String(path)) ? resolve(String(path)) : resolve(String(cwd), String(path));
}

/**
 * The physical path of `path`, tolerating one that does not exist yet (a new
 * file): resolve its parent and re-attach the name. macOS resolves `/var` to
 * `/private/var`, so comparing a payload's literal path with git's answer
 * without this step lets a real write slip through as "outside the checkout".
 */
function physical(path, realpath) {
  const value = resolve(String(path));
  try {
    return resolve(realpath(value));
  } catch {
    try {
      return join(resolve(realpath(dirname(value))), basename(value));
    } catch {
      return value;
    }
  }
}

/** Is `path` equal to or under `parent`? */
function within(path, parent) {
  const child = resolve(path);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}${sep}`);
}

/** A path the guard lets through even inside the primary checkout. */
function exempt(root, path) {
  const absolutePath = resolve(path);
  for (const name of EXEMPT_PATHS) {
    if (absolutePath === resolve(root, name)) return true;
  }
  for (const name of EXEMPT_PREFIXES) {
    if (within(absolutePath, resolve(root, name))) return true;
  }
  return false;
}

/**
 * Normalize a runtime payload to `{kind:"edit", paths}` or `{kind:"shell",
 * command}`. Unknown tools are `null` (allow).
 */
export function normalizeAction(runtime, payload) {
  const tool = String(payload?.tool_name ?? payload?.toolName ?? "");
  const input = payload?.tool_input ?? payload?.input ?? {};

  if (runtime === "claude") {
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const path = input.file_path ?? input.notebook_path ?? null;
      return path === null ? null : { kind: "edit", paths: [String(path)] };
    }
    if (tool === "Bash") {
      return typeof input.command === "string" ? { kind: "shell", command: input.command } : null;
    }
    if (tool === "EnterWorktree") {
      return { kind: "enter", path: typeof input.path === "string" ? input.path : null };
    }
    return null;
  }

  if (runtime === "codex") {
    if (tool === "apply_patch" || tool === "Edit" || tool === "Write") {
      const paths = [];
      if (typeof input.file_path === "string") paths.push(input.file_path);
      if (typeof input.path === "string") paths.push(input.path);
      // `apply_patch` carries a patch document, not a path field.
      if (typeof input.input === "string") {
        for (const match of input.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
          paths.push(match[1].trim());
        }
        for (const match of input.input.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
          paths.push(match[1].trim());
        }
      }
      if (typeof input.patch === "string") {
        for (const match of input.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
          paths.push(match[1].trim());
        }
      }
      return paths.length === 0 ? null : { kind: "edit", paths };
    }
    if (tool === "Bash") {
      return typeof input.command === "string" ? { kind: "shell", command: input.command } : null;
    }
    return null;
  }

  if (runtime === "pi") {
    if (tool === "edit" || tool === "write") {
      const path = input.path ?? input.file_path ?? null;
      return path === null ? null : { kind: "edit", paths: [String(path)] };
    }
    if (tool === "bash") {
      return typeof input.command === "string" ? { kind: "shell", command: input.command } : null;
    }
    return null;
  }

  return null;
}

/** The recovery text every deny carries. */
export function denyReason({ root, target }) {
  const tree = join(root, ".worktrees", "<slug>");
  return (
    `BLOCKED: ${target} would write to the primary checkout ${root}.\n` +
    `This project enforces worktrees. Create and enter one first:\n` +
    `  taskctl worktree create <slug>\n` +
    `  Claude: EnterWorktree({path: "${tree}"})\n` +
    `  Codex:  codex -C "${tree}"\n` +
    `  pi:     cd "${tree}" && pi\n` +
    `Do not bypass this with Bash or a Node script.`
  );
}

/** The reason for refusing a native `EnterWorktree` that would create its own root. */
export function enterReason({ root }) {
  const tree = join(root, ".worktrees", "<slug>");
  return (
    `BLOCKED: creating a native worktree is disabled for this project.\n` +
    `Use the project's root and base so the session and the loop agree:\n` +
    `  taskctl worktree create <slug>\n` +
    `  EnterWorktree({path: "${tree}"})`
  );
}

/**
 * Decide one tool call.
 *
 * @param {{
 *   runtime: string,
 *   payload: object,
 *   cwd: string,
 *   run: Function,
 *   exists: Function,
 *   realpath: (path: string) => string,
 * }} input
 * @returns {{decision: "allow"|"deny", reason: string, target?: string}}
 */
export function decideGuard({
  runtime,
  payload,
  cwd,
  run,
  exists,
  realpath = (path) => resolve(String(path)),
}) {
  if (!GUARD_RUNTIMES.includes(runtime)) {
    return allow(`unknown runtime '${runtime}'`);
  }
  const action = normalizeAction(runtime, payload);
  if (action === null) return allow("not a write action");

  const baseCwd = physical(cwd, realpath);
  const top = run("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
  if (top === null || top.status !== 0) return allow("not a git checkout");
  const root = physical(String(top.stdout ?? "").trim(), realpath);
  if (root === "") return allow("no checkout root");

  // A linked worktree is the isolated place the rule asks for.
  const gitDir = run("git", ["-C", baseCwd, "rev-parse", "--git-dir"]);
  const commonDir = run("git", ["-C", baseCwd, "rev-parse", "--git-common-dir"]);
  if (
    gitDir !== null &&
    commonDir !== null &&
    gitDir.status === 0 &&
    commonDir.status === 0 &&
    physical(resolve(baseCwd, String(gitDir.stdout ?? "").trim()), realpath) !==
      physical(resolve(baseCwd, String(commonDir.stdout ?? "").trim()), realpath)
  ) {
    return allow("already in a linked worktree");
  }

  if (exists(join(root, WORKTREE_RULES_FILE)) !== true) {
    return allow("the project declares no worktree rules");
  }

  if (action.kind === "enter") {
    // A path switches into a tree the project (or the tool) already made; a
    // name would create Claude's own `.claude/worktrees/` root instead.
    return action.path !== null
      ? allow("entering an existing worktree")
      : deny(enterReason({ root }), "EnterWorktree");
  }

  if (action.kind === "edit") {
    for (const path of action.paths) {
      const target = physical(absolute(baseCwd, path), realpath);
      if (within(target, root) && !exempt(root, target)) {
        return deny(denyReason({ root, target }), target);
      }
    }
    return allow("outside the protected checkout");
  }

  if (WRITE_COMMAND.test(action.command)) {
    // A write-like command is denied when its cwd is inside the protected
    // checkout, unless every absolute path it names is exempt. A relative path
    // can only resolve under cwd, so cwd decides.
    const protectedCwd = within(baseCwd, root) && !exempt(root, baseCwd);
    const absolutePaths = [...action.command.matchAll(/(?:^|\s)(\/[^\s;&|]+)/g)].map((match) =>
      physical(match[1], realpath),
    );
    const outsideOnly =
      absolutePaths.length > 0 &&
      absolutePaths.every((path) => !within(path, root) || exempt(root, path));
    if (protectedCwd && !outsideOnly) {
      return deny(denyReason({ root, target: action.command }), action.command);
    }
  }
  return allow("not a write-like shell command");
}
