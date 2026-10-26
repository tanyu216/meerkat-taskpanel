/**
 * The board-interface gate, as a decision over an injected command runner.
 *
 * `task-interface v1` is the CLI surface the loop's scan / claim / patrol passes
 * are written against; `REQUIRED_BOARD_VERSION` is the first board release that
 * shipped it. The gate proves one thing only: a taskctl-shaped board answered,
 * and it is at least that generation.
 *
 * No process is spawned here: `checkBoard` takes a `run(command, args)` seam, so
 * the decision is testable and the orchestrator/CLI owns the spawn. Until
 * `taskctl loop compat` is the only implementation.
 *
 * Node builtins only; no I/O.
 */

import { join, resolve } from "node:path";

/** The board interface generation the loop drives. */
export const REQUIRED_BOARD_INTERFACE = "task-interface v1";

/** The board release that first shipped that generation — the floor this gate enforces. */
export const REQUIRED_BOARD_VERSION = "0.1.0";

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
 * Compared on the numeric triple; a prerelease equal to the floor (`0.1.0-rc.1`
 * against `0.1.0`) does not satisfy it.
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
 * @param {{
 *   command: string,
 *   args: string[],
 *   run: (command: string, args: string[]) => {
 *     status: number|null, stdout: string, stderr: string, error?: Error,
 *   },
 * }} input
 * @returns {{ok: true, version: string, schemaVersion: unknown, boardInterface: string}
 *          | {ok: false, code: string, message: string}}
 */
export function checkBoard({ command, args, run }) {
  if (typeof run !== "function") {
    throw new TypeError("checkBoard needs a run(command, args) function");
  }
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

/**
 * Work out the command that asks a board what it is.
 *
 * Precedence: `--cli` (verbatim) → `--repo` → `$MEERKAT_TASKPANEL_REPO` (the key
 * the installer records in the agent config) → `taskctl` on `PATH`.
 *
 * @param {{
 *   cli?: string|null,
 *   repo?: string|null,
 *   env?: Record<string, string|undefined>,
 *   node?: string,
 * }} [input]
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
