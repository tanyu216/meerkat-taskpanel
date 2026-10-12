#!/usr/bin/env node
/**
 * The board gate — "is the board this loop is pointed at a generation I can drive?".
 *
 * The loop and the board are released independently, so the loop has to state, and
 * check, what it needs. `SKILL.md` §Required board interface states it in the terms a
 * reader reasons about — board `task-interface v1`, which the board first shipped in
 * release 1.0.0 — and this script is the machine half of that statement.
 *
 * The board publishes both numbers at runtime:
 *
 *   taskctl --version --json  →  {"ok":true,"data":{"version":"1.0.0","schema_version":4}}
 *
 * so the check is a real query against the board, not a comparison against a constant
 * somebody typed here twice. What it proves is deliberately narrow:
 *
 *   * a taskctl-shaped board answered at the location we asked;
 *   * its declared release is at least the floor this loop was written against.
 *
 * What it does **not** prove: that every command the loop calls still behaves the same
 * way. That is a release-time concern (see `references/operation.md` §Compatibility); this
 * gate exists to catch the coarse, common mistake — pointing a loop at an old board — and
 * it says so rather than implying more.
 *
 *   node scripts/board-check.mjs                     # taskctl on PATH
 *   node scripts/board-check.mjs --repo <checkout>    # <checkout>/src/cli/index.mjs
 *   node scripts/board-check.mjs --cli <path>         # that executable, verbatim
 *   node scripts/board-check.mjs --json               # machine-readable verdict
 *
 * Exit codes: 0 compatible · 2 the command line is wrong · 3 no verdict (the board could
 * not be asked, or it answered with a version below the floor).
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The board interface generation this loop drives.
 *
 * `task-interface v1` is the CLI surface (`issue candidates`, `issue move`,
 * `issue list`) the supervisor's scan / claim / patrol passes are written against.
 */
export const REQUIRED_BOARD_INTERFACE = "task-interface v1";

/** The board release that first shipped that generation — the floor this gate enforces. */
export const REQUIRED_BOARD_VERSION = "1.0.0";

const USAGE = `Usage: node scripts/board-check.mjs [options]

Refuse to point this loop at a board older than the generation it drives
(${REQUIRED_BOARD_INTERFACE}, board release >= ${REQUIRED_BOARD_VERSION}).

Options:
  --cli <path>    the board CLI to run (verbatim)
  --repo <dir>    a board checkout; runs <dir>/src/cli/index.mjs
  --json          print the verdict as JSON
  --quiet         print nothing on success
  -h, --help      Show this help

Exit: 0 compatible · 2 usage · 3 no verdict (unreachable board, or too old)`;

/**
 * Parse `x.y.z[-pre][+build]` into numbers. Returns `null` when it is not a version.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, prerelease: boolean}|null}
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

/**
 * Is `candidate` at least `floor`?
 *
 * Compared on the numeric triple, with one deliberate wrinkle at the boundary: a
 * prerelease that *equals* the floor triple (`1.0.0-rc.1` against a floor of `1.0.0`)
 * does **not** satisfy it. A release candidate is not the release, and "we are on 1.0.0"
 * is exactly the claim a floor exists to check.
 *
 * @param {string} candidate
 * @param {string} floor
 * @returns {boolean}
 */
export function atLeastVersion(candidate, floor) {
  const left = parseVersion(candidate);
  const right = parseVersion(floor);
  if (left === null || right === null) return false;

  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] > right[field];
  }
  return !left.prerelease;
}

/**
 * Ask a board what it is, and judge the answer.
 *
 * The `run` seam exists so the decision can be tested without a board.
 *
 * @param {object} options
 * @param {string} options.command executable / interpreter to spawn
 * @param {string[]} options.args arguments that make it print `--version --json`
 * @param {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} [options.run]
 * @returns {{ok: true, version: string, schemaVersion: unknown, boardInterface: string}
 *          | {ok: false, code: string, message: string}}
 */
export function checkBoard({ command, args, run = defaultRun }) {
  const result = run(command, args);

  if (result.error) {
    return {
      ok: false,
      code: "BOARD_UNREACHABLE",
      message: `cannot run the board CLI (${command}): ${result.error.message}`,
    };
  }
  if (!result.stdout) {
    return {
      ok: false,
      code: "BOARD_UNREADABLE",
      message:
        `the board CLI (${command} ${args.join(" ")}) printed nothing on stdout` +
        `${typeof result.status === "number" ? ` (exit ${result.status})` : ""}` +
        `${result.stderr ? `; stderr: ${result.stderr.trim()}` : ""}`,
    };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      code: "BOARD_UNREADABLE",
      message: `the board CLI did not answer with JSON (${err.message}): ${result.stdout.trim().slice(0, 200)}`,
    };
  }

  const version = payload?.data?.version;
  if (typeof version !== "string") {
    return {
      ok: false,
      code: "BOARD_UNREADABLE",
      message: `the board CLI's version payload has no \`data.version\`: ${JSON.stringify(payload).slice(0, 200)}`,
    };
  }

  if (!atLeastVersion(version, REQUIRED_BOARD_VERSION)) {
    return {
      ok: false,
      code: "BOARD_TOO_OLD",
      message:
        `the board at ${command} is ${version}; this loop drives ${REQUIRED_BOARD_INTERFACE}, ` +
        `first shipped in ${REQUIRED_BOARD_VERSION}. Upgrade the board, or install the loop ` +
        `that matches it.`,
    };
  }

  return {
    ok: true,
    version,
    schemaVersion: payload?.data?.schema_version ?? null,
    boardInterface: REQUIRED_BOARD_INTERFACE,
  };
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * Work out the command that asks a board what it is.
 *
 * Precedence: `--cli` (verbatim) → `--repo` → `$MEERKAT_TASKPANEL_REPO` (the key the
 * installer records in the host config) → `taskctl` on `PATH`.
 *
 * @param {{cli?: string|null, repo?: string|null, env?: Record<string, string|undefined>, node?: string}} options
 * @returns {{command: string, args: string[]}}
 */
export function resolveBoardCommand({ cli = null, repo = null, env = process.env, node = process.execPath } = {}) {
  if (cli) return { command: cli, args: ["--version", "--json"] };

  const fromEnv = typeof env.MEERKAT_TASKPANEL_REPO === "string" ? env.MEERKAT_TASKPANEL_REPO.trim() : "";
  const root = repo ?? (fromEnv === "" ? null : fromEnv);
  if (root) {
    return { command: node, args: [join(resolve(root), "src", "cli", "index.mjs"), "--version", "--json"] };
  }

  return { command: "taskctl", args: ["--version", "--json"] };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { cli: null, repo: null, json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (flag) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (arg === "--cli") opts.cli = take("--cli");
    else if (arg.startsWith("--cli=")) opts.cli = arg.slice("--cli=".length);
    else if (arg === "--repo") opts.repo = take("--repo");
    else if (arg.startsWith("--repo=")) opts.repo = arg.slice("--repo=".length);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @param {{out?: (text: string) => void, err?: (text: string) => void, env?: Record<string, string|undefined>, run?: typeof defaultRun, node?: string}} [io]
 * @returns {number} process exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    err(`board-check: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    out(`${USAGE}\n`);
    return 0;
  }

  // A path the caller named explicitly and that is not there is a typo, not a verdict.
  if (opts.cli && !existsSync(opts.cli)) {
    err(`board-check: --cli not found: ${opts.cli}\n`);
    return 2;
  }

  const { command, args } = resolveBoardCommand(opts);
  const result = checkBoard({ command, args, run: io.run ?? defaultRun });

  if (opts.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 3;
  }

  if (result.ok) {
    if (!opts.quiet) {
      out(
        `board-check: OK — board ${result.version} ` +
          `(contract schema_version ${result.schemaVersion ?? "?"}) satisfies ${result.boardInterface}\n`,
      );
    }
    return 0;
  }

  err(`board-check: ${result.code}: ${result.message}\n`);
  return 3;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
