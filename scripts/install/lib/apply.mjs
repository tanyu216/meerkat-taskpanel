#!/usr/bin/env node
/**
 * Host-bundle file writer used by the per-host installers (claude / codex).
 *
 * The installers are thin bash orchestrators; everything that is fiddly to do in
 * `sh` — JSON merging, idempotent template rendering, delimited-block upserts —
 * lives here as three small subcommands. Node >= 22 is guaranteed by the
 * installer's own runtime check (`require_node`), so the whole file uses only
 * Node builtins.
 *
 * Subcommands:
 *
 *   emit           render a `{{TOKEN}}` template into a file, idempotently
 *   snippet        append (or replace) a delimited block inside an existing file
 *   merge-settings merge Claude's `~/.claude/settings.json` (env + SessionStart)
 *
 * Every subcommand is **idempotent**: re-running with the same inputs leaves the
 * destination byte-identical and reports `unchanged`. A file that already exists
 * with *different* content is left alone unless `--force` is passed — the same
 * "merge, never clobber" contract the installers enforce for the skill copy.
 *
 * Run with: node scripts/install/lib/apply.mjs <subcommand> ...
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/install/lib/apply.mjs <subcommand> [options]

  emit <template> <dest> [--force] [--exec]
      Render a {{TOKEN}} template and write it to <dest>. Tokens are filled from
      the TP_* environment ({{AGENT}} <- TP_AGENT, {{REPO}} <- TP_REPO, …).

  snippet <file> <template> --marker <name> [--force]
      Append a <!-- name:begin -->…<!-- name:end --> block (rendered from the
      template) to <file>; replace it when --force is given.

  merge-settings <file> --agent <name> --hook <cmd> [--force]
      Merge env.TASKCTL_AGENT and a SessionStart hook into Claude settings.json,
      preserving every other key and hook.

All subcommands are idempotent and exit 0 on success (including "unchanged").
`;

// ---------------------------------------------------------------------------
// Rendering — replace every {{TOKEN}} with vars[TOKEN]
// ---------------------------------------------------------------------------

/**
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function render(template, vars) {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, name) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`unknown template token {{${name}}}`);
    }
    return value;
  });
}

/** Collect TP_* environment variables into a vars map, keyed by token name. */
function tpVars(env = process.env) {
  const vars = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("TP_") && key.length > 3) vars[key.slice(3)] = value ?? "";
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Idempotent file write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` under the merge-never-clobber contract.
 *
 * @param {string} path
 * @param {string} content
 * @param {{force?: boolean, executable?: boolean}} [opts]
 * @returns {{status: "written"|"unchanged"|"skipped", detail: string}}
 */
export function writeFileIdempotent(path, content, opts = {}) {
  const { force = false, executable = false } = opts;
  const next = content.endsWith("\n") ? content : `${content}\n`;

  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === next) {
      return { status: "unchanged", detail: `unchanged ${path}` };
    }
    if (!force) {
      return { status: "skipped", detail: `exists (differs); left unchanged — use --force to overwrite: ${path}` };
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  if (executable) chmodSync(path, 0o755);
  return { status: "written", detail: `wrote ${path}` };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function cmdEmit(argv, env = process.env) {
  const opts = parseFlags(argv, {
    boolean: new Set(["force", "exec"]),
    positionals: ["template", "dest"],
  });

  const template = readFileSync(opts.template, "utf8");
  const content = render(template, tpVars(env));
  return writeFileIdempotent(opts.dest, content, {
    force: opts.force,
    executable: opts.exec,
  });
}

// ---------------------------------------------------------------------------
// snippet — a delimited block inside an existing (or new) file
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function cmdSnippet(argv, env = process.env) {
  const opts = parseFlags(argv, {
    boolean: new Set(["force"]),
    valueFlags: new Set(["marker"]),
    positionals: ["file", "template"],
  });
  const marker = opts.marker;
  if (typeof marker !== "string" || marker === "") {
    throw new Error("snippet: --marker <name> is required");
  }

  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;

  const template = readFileSync(opts.template, "utf8");
  const body = render(template, tpVars(env)).replace(/\n$/, "");
  const block = `${begin}\n${body}\n${end}\n`;

  const current = existsSync(opts.file) ? readFileSync(opts.file, "utf8") : "";

  let next;
  if (!current.includes(begin)) {
    // Append as its own block, keeping whatever was there untouched.
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    next = `${current}${separator}${block}`;
  } else if (opts.force) {
    const start = current.indexOf(begin);
    const endIndex = current.indexOf(end);
    const cut = endIndex === -1 ? current.length : endIndex + end.length;
    const tail = current.slice(cut).replace(/^\n+/, "");
    // `block` already ends in `\n`, so no extra `\n` before `tail` — an added one
    // would leave a blank line after the block on every forced re-render.
    next = `${current.slice(0, start).replace(/\n+$/, "\n")}${block}${tail}`;
  } else {
    return { status: "unchanged", detail: `block already present: ${opts.file}` };
  }

  return writeFileIdempotent(opts.file, next, { force: true });
}

// ---------------------------------------------------------------------------
// merge-settings — Claude ~/.claude/settings.json
// ---------------------------------------------------------------------------

/**
 * Merge the two managed keys into a Claude settings document.
 *
 * `env.TASKCTL_AGENT` is set (without --force, only when absent). A SessionStart
 * hook entry running `hookCommand` is appended unless an identical one exists;
 * with --force any entry already pointing at `hookCommand` is replaced.
 *
 * Every other key — including unrelated hooks — is preserved untouched.
 *
 * @param {object} data existing settings (parsed) or `{}`
 * @param {{agent: string, hookCommand: string, force?: boolean}} [opts]
 * @returns {{data: object, changed: boolean}}
 */
export function mergeSettings(data, opts) {
  const { agent, hookCommand, force = false } = opts;
  const out = structuredClone(data);
  let changed = false;

  // env.TASKCTL_AGENT — add if missing; --force overwrites.
  const envIsObject = out.env === null || out.env === undefined || (typeof out.env === "object" && !Array.isArray(out.env));
  if (envIsObject) {
    const env = out.env && typeof out.env === "object" ? out.env : {};
    if (force || env.TASKCTL_AGENT === undefined) {
      if (env.TASKCTL_AGENT !== agent) {
        env.TASKCTL_AGENT = agent;
        changed = true;
      }
      if (Object.keys(env).length > 0) out.env = env;
    }
  } else {
    // A malformed `env` (array/string/…) is left alone rather than clobbered.
    warn(`merge-settings: env has an unexpected shape; left untouched`);
  }

  // hooks.SessionStart — append our entry if absent; --force replaces ours.
  const hooksIsObject = out.hooks === null || out.hooks === undefined || (typeof out.hooks === "object" && !Array.isArray(out.hooks));
  if (hooksIsObject) {
    const hooks = out.hooks && typeof out.hooks === "object" ? out.hooks : {};

    const ours = (entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.type === "command" && h?.command === hookCommand);

    const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : null;
    if (sessionStart === null && hooks.SessionStart !== undefined) {
      warn("merge-settings: hooks.SessionStart has an unexpected shape; left untouched");
    } else {
      const list = sessionStart ?? [];
      const has = list.some(ours);
      if (force) {
        const kept = list.filter((entry) => !ours(entry));
        kept.push({ matcher: "*", hooks: [{ type: "command", command: hookCommand }] });
        hooks.SessionStart = kept;
        changed = true;
      } else if (!has) {
        list.push({ matcher: "*", hooks: [{ type: "command", command: hookCommand }] });
        hooks.SessionStart = list;
        changed = true;
      }
      if (Object.keys(hooks).length > 0) out.hooks = hooks;
    }
  } else {
    warn("merge-settings: hooks has an unexpected shape; left untouched");
  }

  return { data: out, changed };
}

/** @param {string[]} argv */
export function cmdMergeSettings(argv) {
  const opts = parseFlags(argv, {
    boolean: new Set(["force"]),
    valueFlags: new Set(["agent", "hook"]),
    positionals: ["file"],
  });
  if (typeof opts.agent !== "string" || opts.agent === "") {
    throw new Error("merge-settings: --agent <name> is required");
  }
  if (typeof opts.hook !== "string" || opts.hook === "") {
    throw new Error("merge-settings: --hook <cmd> is required");
  }

  let data = {};
  if (existsSync(opts.file)) {
    const raw = readFileSync(opts.file, "utf8");
    if (raw.trim() !== "") {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new Error(`merge-settings: ${opts.file} is not valid JSON; refusing to overwrite it (${err.message})`);
      }
    }
  }

  const { data: merged, changed } = mergeSettings(data, {
    agent: opts.agent,
    hookCommand: opts.hook,
    force: opts.force,
  });

  if (!changed) return { status: "unchanged", detail: `unchanged ${opts.file}` };

  const next = `${JSON.stringify(merged, null, 2)}\n`;
  return writeFileIdempotent(opts.file, next, { force: true });
}

// ---------------------------------------------------------------------------
// Argument parsing + dispatch
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {{boolean?: Set<string>, valueFlags?: Set<string>, positionals?: string[]}} [spec]
 */
function parseFlags(argv, spec = {}) {
  const boolean = spec.boolean ?? new Set();
  const valueFlags = spec.valueFlags ?? new Set();
  const positionals = spec.positionals ?? [];
  const out = { force: false, exec: false, positional: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") out.force = true;
    else if (arg === "--exec") out.exec = true;
    else if (boolean.has(arg.slice(2)) && arg.startsWith("--")) out[arg.slice(2)] = true;
    else if (valueFlags.has(arg.slice(2)) && arg.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      out.positional.push(arg);
    }
  }

  for (let i = 0; i < positionals.length; i++) {
    out[positionals[i]] = out.positional[i];
  }
  return out;
}

/** Warn to stderr (used for "left untouched" notices, never fatal). */
function warn(message) {
  process.stderr.write(`${message}\n`);
}

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  let result;
  try {
    switch (subcommand) {
      case "emit":
        result = cmdEmit(argv);
        break;
      case "snippet":
        result = cmdSnippet(argv);
        break;
      case "merge-settings":
        result = cmdMergeSettings(argv);
        break;
      case undefined:
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        return 0;
      default:
        throw new Error(`unknown subcommand: ${subcommand}`);
    }
  } catch (err) {
    process.stderr.write(`apply: ${err.message}\n`);
    return 1;
  }

  if (result.status === "skipped") {
    // Not an error: the merge-never-clobber contract, reported clearly.
    process.stdout.write(`${result.detail}\n`);
  } else {
    process.stdout.write(`${result.detail}\n`);
  }
  return 0;
}

// Only run when executed directly, so tests can import the functions above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

export { main as run };
