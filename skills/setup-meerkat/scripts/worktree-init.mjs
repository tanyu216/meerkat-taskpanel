#!/usr/bin/env node
/**
 * Initialize the worktree guard for the selected agent kinds.
 *
 * This is setup-meerkat's round-4 sub-step, not an installer feature: the user
 * opt-in lives in `docs/agents/worktrees.md`, and the mechanism is the installed
 * `taskctl worktree` command. Here we only merge the thin hook adapters that
 * call it. Every write preserves unrelated content and is idempotent.
 *
 * Claude and Codex share one hook shape (`hooks.PreToolUse` / `hooks.SessionStart`);
 * pi loads a TypeScript extension instead. Codex additionally requires the user
 * to review and trust the hook in `/hooks`; this script never bypasses that.
 *
 * Exit: 0 written/unchanged/skipped, 3 conflict (different content without
 * --force), 2 usage.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { writeAtomic } from "./lib/atomic.mjs";
import { isEntryPoint } from "./lib/entry-guard.mjs";

const USAGE = `worktree-init — install the worktree guard adapters (setup-meerkat round 4)

  node worktree-init.mjs --cli <taskctl-shim> [--home <dir>] [--project <dir>]
                         [--runtime claude,codex,pi]
                         [--claude-settings <file>] [--codex-hooks <file>]
                         [--pi-extension <file>] [--dry-run] [--force] [--json]

Writes no installer files. Codex hooks must be reviewed and trusted in /hooks
afterward; this script never bypasses that.`;

/** Shell-quote one path for a hook command string. */
function quote(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

/** Read a JSON file, or `{}` when absent. */
function readJson(path) {
  if (!existsSync(path)) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, message: `${path} is not valid JSON: ${err?.message ?? err}` };
  }
}

/** The hand-installed hook this round supersedes, when one is still present. */
const LEGACY_GUARD = "meerkat-taskpanel-worktree-guard.sh";

/** Does this settings document still carry the older ad-hoc guard? */
export function hasLegacyGuard(path) {
  const read = readJson(path);
  return read.ok && JSON.stringify(read.data).includes(LEGACY_GUARD);
}

/** Does this hook list already carry our command? */
function hasCommand(list, command) {
  return Array.isArray(list) && list.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) => hook?.type === "command" && hook?.command === command),
  );
}

/**
 * Merge the two hook entries into a settings/hooks document.
 *
 * @param {object} data
 * @param {{guardCommand: string, statusCommand: string, matcher: string}} opts
 * @returns {{ok: true, data: object, changed: boolean} | {ok: false, message: string}}
 */
export function mergeHooksData(data, { guardCommand, statusCommand, matcher }) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, message: "the document is not a JSON object" };
  }
  const out = structuredClone(data);
  if (out.hooks === undefined || out.hooks === null) out.hooks = {};
  if (typeof out.hooks !== "object" || Array.isArray(out.hooks)) {
    return { ok: false, message: "`hooks` is not an object; fix it or pass --force" };
  }
  let changed = false;

  const ensure = (event, entry) => {
    const current = out.hooks[event];
    if (current === undefined) out.hooks[event] = [entry];
    else if (!Array.isArray(current)) {
      return `${event} is not an array; fix it or pass --force`;
    } else if (hasCommand(current, entry.hooks[0].command)) {
      return null;
    } else {
      current.push(entry);
    }
    changed = true;
    return null;
  };

  const guardError = ensure("PreToolUse", {
    matcher,
    hooks: [{ type: "command", command: guardCommand, timeout: 10 }],
  });
  if (guardError) return { ok: false, message: guardError };
  const statusError = ensure("SessionStart", {
    matcher: "*",
    hooks: [{ type: "command", command: statusCommand, timeout: 10 }],
  });
  if (statusError) return { ok: false, message: statusError };

  return { ok: true, data: out, changed };
}

/** Merge one hooks file, or report why it was left alone. */
export function mergeHooksFile(path, opts, { dryRun = false } = {}) {
  const read = readJson(path);
  if (!read.ok) return { status: "conflict", file: path, detail: read.message };
  const merged = mergeHooksData(read.data, opts);
  if (!merged.ok) return { status: "conflict", file: path, detail: merged.message };
  if (!merged.changed) return { status: "unchanged", file: path };
  if (dryRun) return { status: "would-write", file: path };
  writeAtomic(path, `${JSON.stringify(merged.data, null, 2)}\n`);
  return { status: "written", file: path };
}

/** The pi extension source. The CLI path is embedded; the import type is Pi's. */
export function renderPiExtension(cli) {
  return `/**
 * Meerkat TaskPanel worktree guard — generated by setup-meerkat.
 *
 * The policy lives in the installed CLI. This extension only forwards pi's
 * tool_call event and maps the decision to pi's { block, reason } shape. It is
 * a guardrail, not a sandbox: invalid tool calls skip the event.
 */
import { spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = ${JSON.stringify(cli)};

export default function meerkatWorktreeGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    const payload = JSON.stringify({
      toolName: event.toolName,
      input: event.input,
      cwd: process.cwd(),
    });
    const result = spawnSync(CLI, ["worktree", "guard", "--runtime", "pi"], {
      input: payload,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error !== undefined || result.status !== 0) return undefined;
    try {
      const decision = JSON.parse(result.stdout);
      return decision.block === true
        ? { block: true, reason: decision.reason }
        : undefined;
    } catch {
      return undefined;
    }
  });
}
`;
}

/** Write one generated file under the same merge-never-clobber rule. */
export function writeGenerated(path, text, { dryRun = false, force = false } = {}) {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === text) return { status: "unchanged", file: path };
    if (!force) {
      return { status: "conflict", file: path, detail: "exists with different content; use --force" };
    }
  }
  if (dryRun) return { status: "would-write", file: path };
  writeAtomic(path, text);
  return { status: "written", file: path };
}

function parse(argv) {
  const opts = {
    home: process.env.HOME ?? homedir(),
    project: process.cwd(),
    cli: null,
    runtimes: null,
    claudeSettings: null,
    codexHooks: null,
    piExtension: null,
    dryRun: false,
    force: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--home": opts.home = take(); break;
      case "--project": opts.project = take(); break;
      case "--cli": opts.cli = take(); break;
      case "--runtime": opts.runtimes = take().split(",").map((name) => name.trim()).filter(Boolean); break;
      case "--claude-settings": opts.claudeSettings = take(); break;
      case "--codex-hooks": opts.codexHooks = take(); break;
      case "--pi-extension": opts.piExtension = take(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** The kinds that look installed under this home. */
function detectRuntimes(home) {
  const kinds = [];
  if (existsSync(join(home, ".claude"))) kinds.push("claude");
  if (existsSync(join(home, ".codex"))) kinds.push("codex");
  if (existsSync(join(home, ".pi", "agent"))) kinds.push("pi");
  return kinds;
}

export function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`worktree-init: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.cli === null || opts.cli.trim() === "") {
    console.error("worktree-init: --cli <taskctl-shim> is required (run the install round first)");
    console.error(USAGE);
    return 2;
  }
  const cli = resolve(opts.cli);
  if (!existsSync(cli)) {
    console.error(`worktree-init: the CLI shim does not exist: ${cli}`);
    return 2;
  }

  const home = resolve(opts.home);
  const project = resolve(opts.project);
  const runtimes = opts.runtimes ?? detectRuntimes(home);
  if (runtimes.length === 0) {
    console.error("worktree-init: no agent kind found; pass --runtime claude,codex,pi");
    return 2;
  }
  for (const runtime of runtimes) {
    if (!["claude", "codex", "pi"].includes(runtime)) {
      console.error(`worktree-init: unknown runtime '${runtime}'`);
      return 2;
    }
  }

  const guard = `${quote(cli)} worktree guard`;
  const status = `${quote(cli)} worktree status`;
  const results = {};
  const warnings = [];

  if (runtimes.includes("claude")) {
    const file = opts.claudeSettings ?? join(home, ".claude", "settings.json");
    const legacy = hasLegacyGuard(file);
    results.claude = mergeHooksFile(
      file,
      {
        guardCommand: `${guard} --runtime claude`,
        statusCommand: status,
        matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|EnterWorktree",
      },
      { dryRun: opts.dryRun },
    );
    if (legacy) {
      warnings.push(
        `claude: the older ad-hoc guard (${LEGACY_GUARD}) is still installed; ` +
          "remove its entry or keep it as a second layer",
      );
    }
  }

  if (runtimes.includes("codex")) {
    const file = opts.codexHooks ?? join(home, ".codex", "hooks.json");
    results.codex = mergeHooksFile(
      file,
      {
        guardCommand: `${guard} --runtime codex`,
        statusCommand: status,
        matcher: "Bash|apply_patch|Edit|Write",
      },
      { dryRun: opts.dryRun },
    );
  }

  if (runtimes.includes("pi")) {
    const file =
      opts.piExtension ?? join(home, ".pi", "agent", "extensions", "meerkat-worktree-guard.ts");
    results.pi = writeGenerated(file, renderPiExtension(cli), {
      dryRun: opts.dryRun,
      force: opts.force,
    });
  }

  if (results.codex !== undefined && results.codex.status !== "unchanged") {
    warnings.push(
      "codex: open /hooks, review the entry, and trust it; until then the guard is inert",
    );
  }
  if (results.pi !== undefined) {
    warnings.push(
      `pi: launch from the worktree (cd ${join(project, ".worktrees", "<slug>")} && pi); pi has no --cwd`,
    );
  }

  const conflicted = Object.values(results).some((entry) => entry.status === "conflict");
  const report = {
    ok: !conflicted,
    home,
    project,
    cli,
    runtimes,
    results,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [kind, entry] of Object.entries(results)) {
      console.log(`${kind}: ${entry.status} ${entry.file ?? ""}`.trim());
    }
    for (const warning of warnings) console.log(`warning: ${warning}`);
  }
  return conflicted ? 3 : 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
