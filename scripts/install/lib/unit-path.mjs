#!/usr/bin/env node
/**
 * The `PATH` a scheduling unit runs with — one recipe, three renderings.
 *
 * A scheduler starts a unit with a **minimal** `PATH` of its own (launchd:
 * `/usr/bin:/bin:/usr/sbin:/sbin`; systemd and cron: their own documented defaults),
 * and on any machine whose node lives under nvm or Homebrew that set holds neither
 * `node` nor the agent CLI. The loop's units hit that twice (T-20261014-020103-2):
 *
 *   1. **the unit's interpreter** — `/usr/bin/env node` exits 127, so no tick ever runs;
 *   2. **the agent process the tick starts** — the resident session launches `claude` /
 *      `codex` / `pi`, and looks the CLI up on the *same* inherited `PATH`, exiting 127
 *      in turn. Fixing (1) alone makes the symptom worse, not better: the tick starts and
 *      the session still fails. Underneath both sits the worker's own process tree
 *      (`git`, `node`, `taskctl`), which is blind to a PATH that never carried their
 *      directories.
 *
 * So both layers get the same one fix: name the interpreter outright **and** hand the
 * unit a `PATH` whose head is the agent shim's directory, the agent CLI's, and node's,
 * followed by the scheduler's documented default. Prepending, never narrowing, is the
 * contract the taskd guard already follows — a child that asks for `sh` or `git` still
 * finds them.
 *
 * The shim directory is the head because every layer below the tick runs `taskctl`: the
 * control turn's board reads, the worker's card operations, the reviewer's evidence. A
 * `taskctl` installed globally (nvm's global bin sits in node's directory) would shadow
 * the per-agent shim and write the wrong actor identity, so the shim wins over it.
 *
 * This module is the **single definition** of that recipe. The installer's bash side
 * (`scripts/install/_common.sh`) and its JS side (`taskd-guard.mjs`, and the dry-run
 * cron preview in `supervisor.mjs`) both read their value from here — through the CLI
 * below or through the imported function — so the two can differ only by a bug in this
 * file, never by drift between two hand-kept copies.
 *
 * Node builtins only; no network, no dependencies.
 *
 * Run with:
 *   node scripts/install/lib/unit-path.mjs node
 *   node scripts/install/lib/unit-path.mjs path --scheduler launchd [--cli-dir <dir>] [--shim-dir <dir>]
 */

import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What each scheduler gives a unit that carries no `PATH` of its own — its documented
 * default, used as the **suffix** so the directories we prepend never narrow it.
 *
 * Only the head of this string is load-bearing (our two directories); the tail exists so
 * a child keeps resolving exactly what it resolved before. That is also why the values
 * are per-scheduler: handing a cron line systemd's default (or the reverse) would be a
 * silent claim about a machine we are not on.
 */
export const SCHEDULER_DEFAULT_PATH = Object.freeze({
  launchd: "/usr/bin:/bin:/usr/sbin:/sbin",
  systemd: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  cron: "/usr/bin:/bin",
});

/**
 * The `PATH` a unit runs with: `[dir(agent shim), dir(agent CLI), dir(node)]` —
 * deduplicated, in that order — followed by the scheduler's documented default.
 *
 * `shimDir` and `cliDir` are optional: an install whose agent CLI is not on `PATH`
 * still gets a usable `PATH` for the interpreter and the shim, and says so out loud
 * rather than pretending (see `_common.sh::export_tp_env`). `nodeDir` is the only
 * required input, which is why the taskd guard — a service that never derives another
 * executable — can call this with one argument and keep its rendered bytes exactly as
 * they were.
 *
 * @param {string} nodeDir directory holding `node` (absolute)
 * @param {{cliDir?: string, shimDir?: string, scheduler?: keyof typeof SCHEDULER_DEFAULT_PATH}} [options]
 * @returns {string}
 */
export function unitPath(nodeDir, options = {}) {
  const { cliDir, shimDir, scheduler = "launchd" } = options;
  // `Object.hasOwn`, not a truthiness/undefined test: a bare lookup answers for the
  // prototype chain too, so `--scheduler constructor` would otherwise render
  // `function Object() { … }` as a "default" instead of being refused.
  if (!Object.hasOwn(SCHEDULER_DEFAULT_PATH, scheduler)) {
    throw new Error(`unitPath: unknown scheduler '${scheduler}' (expected ${Object.keys(SCHEDULER_DEFAULT_PATH).join("|")})`);
  }
  const defaults = SCHEDULER_DEFAULT_PATH[scheduler];
  // A `Set` deduplicates and keeps insertion order, so a machine where the agent CLI and
  // node share a directory (nvm puts its global bin there) gets one entry, not two.
  const dirs = [...new Set([shimDir, cliDir, nodeDir].filter((dir) => typeof dir === "string" && dir !== ""))];
  return [...dirs, defaults].join(":");
}

const USAGE = `Usage: node scripts/install/lib/unit-path.mjs <what> [options]

  node                      print the absolute interpreter that rendered this file
  path --scheduler <name>   print the unit PATH for that scheduler
       [--shim-dir <dir>]   the agent shim's directory (head of the PATH)
       [--cli-dir <dir>]    the agent CLI's directory
       [--node-dir <dir>]   node's directory (defaults to this interpreter's)

<name> is one of ${Object.keys(SCHEDULER_DEFAULT_PATH).join(", ")}.
`;

/** Canonical (symlink-free) path, so a symlinked checkout still self-dispatches. */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * @param {string[]} argv
 * @returns {number} exit status
 */
function main(argv) {
  const [what, ...rest] = argv;
  if (what === undefined || what === "-h" || what === "--help") {
    process.stdout.write(USAGE);
    return what === undefined ? 2 : 0;
  }

  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => rest[++i];
    if (arg === "--scheduler") opts.scheduler = value();
    else if (arg === "--shim-dir") opts.shimDir = value();
    else if (arg === "--cli-dir") opts.cliDir = value();
    else if (arg === "--node-dir") opts.nodeDir = value();
    else {
      process.stderr.write(`unit-path: unknown option: ${arg}\n`);
      return 2;
    }
  }

  const nodeDir = opts.nodeDir ?? dirname(process.execPath);
  if (what === "node") {
    process.stdout.write(`${process.execPath}\n`);
    return 0;
  }
  if (what === "path") {
    if (opts.scheduler === undefined) {
      process.stderr.write("unit-path: path needs --scheduler\n");
      return 2;
    }
    try {
      process.stdout.write(`${unitPath(nodeDir, { cliDir: opts.cliDir, shimDir: opts.shimDir, scheduler: opts.scheduler })}\n`);
    } catch (error) {
      process.stderr.write(`unit-path: ${error.message}\n`);
      return 2;
    }
    return 0;
  }
  process.stderr.write(`unit-path: unknown argument: ${what} (expected node|path)\n`);
  return 2;
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
