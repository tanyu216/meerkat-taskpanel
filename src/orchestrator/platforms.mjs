/**
 * Whether an actor kind can actually start a session.
 *
 * "Available" is a claim about the CLI, not about the skill tree: a role whose
 * skill is installed but whose CLI is missing would be dispatched onto a
 * platform that cannot run, so the supervisor probes the command it would spawn.
 *
 * The probe is deliberately small and offline — a PATH lookup with no process
 * spawn (spawning `--version` would be slower and can hang). An operator whose
 * CLI lives outside PATH uses the loop's `--cli` escape hatch, which the caller
 * passes as `bins`.
 *
 * Node builtins only.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** The command each resident adapter spawns when `--cli` is not given. */
const KIND_COMMANDS = Object.freeze({
  claude: "claude",
  codex: "codex",
  pi: "pi",
});

/** @param {string} path */
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one command against PATH. An absolute path is checked as given.
 *
 * @param {string} command
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string|null} the executable path, or null
 */
function resolveCommand(command, options = {}) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (command.includes("/") || isAbsolute(command)) return isExecutable(command) ? command : null;
  const env = options.env ?? process.env;
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether a kind can start: its `--cli` override, else its default command.
 *
 * @param {string} kind
 * @param {{env?: NodeJS.ProcessEnv, bins?: Record<string, string>}} [options]
 * @returns {boolean}
 */
export function isKindAvailable(kind, options = {}) {
  const command = options.bins?.[kind] ?? KIND_COMMANDS[kind];
  if (command === undefined) return false;
  return resolveCommand(command, options) !== null;
}

/**
 * The set of kinds that can start right now, for `resolveRolePlatforms`.
 *
 * @param {{env?: NodeJS.ProcessEnv, bins?: Record<string, string>}} [options]
 * @returns {Set<string>}
 */
export function availableKinds(options = {}) {
  const kinds = new Set();
  for (const kind of Object.keys(KIND_COMMANDS)) {
    if (isKindAvailable(kind, options)) kinds.add(kind);
  }
  return kinds;
}
