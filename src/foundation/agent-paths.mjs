/**
 * Where an installed agent's files live, and where the machine-local config
 * root is.
 *
 * Two related facts, one module: `agentPaths` derives a kind's directories from
 * `--home`, and `resolveConfigDir` / `resolveKindConfigPath` name the one
 * directory that holds the machine-local config (`.env.<kind>`, `projects.json`).
 * The map itself lives in `project-dir.mjs`; this module only says *where*.
 *
 * Pure path arithmetic: the home directory and the program root are arguments,
 * so this module needs no `os.homedir()` and stays deterministic in tests.
 *
 * Node builtins only; no I/O.
 */

import { join, resolve } from "node:path";

import { STATE_FILES } from "./loop-state.mjs";
import { repoRoot } from "./runtime-locator.mjs";

/** Actor kind -> the agent's config directory under the target home. */
export const AGENT_DIRS = Object.freeze({
  claude: ".claude",
  codex: ".codex",
  pi: ".agents",
});

/** The directory holding the machine-local config; overrides the program root. */
export const KIND_CONFIG_DIR_ENV = "MEERKAT_TASKPANEL_CONFIG_DIR";

/** Per-kind config files are `<program root>/.env.<actor-kind>`. */
export const KIND_CONFIG_FILE_PREFIX = ".env.";

/** A kind that can safely be spliced into a file name. */
const KIND_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * The one directory holding machine-local config: the program root, unless
 * `MEERKAT_TASKPANEL_CONFIG_DIR` names another (resolved against `cwd`).
 *
 * Every local file derives from it — `.env.<kind>` and `projects.json` — so a
 * test, a container or a read-only install root relocates all of them at once.
 *
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, root?: string }} [options]
 * @returns {string} absolute directory
 */
export function resolveConfigDir(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const override = env[KIND_CONFIG_DIR_ENV];
  if (typeof override === "string" && override.trim() !== "") {
    return resolve(cwd, override.trim());
  }
  return resolve(options.root ?? repoRoot());
}

/**
 * `<config root>/.env.<kind>`.
 *
 * The kind is a file-name segment, never a path: a token that is not one plain
 * segment is refused rather than silently normalized. `human` has no per-kind
 * file (a human is not an installed agent kind), and an absent kind returns
 * `null` so callers can decide whether to look.
 *
 * @param {{
 *   actorKind?: string, root?: string, env?: NodeJS.ProcessEnv, cwd?: string,
 * }} [options]
 * @returns {string|null} absolute file path, or null for no kind / the human
 */
export function resolveKindConfigPath(options = {}) {
  const kind = typeof options.actorKind === "string" ? options.actorKind.trim() : "";
  if (kind === "" || kind === "human") return null;
  if (!KIND_TOKEN.test(kind)) {
    throw new Error(`invalid actor kind '${kind}' for a per-kind config path`);
  }
  const dir = resolveConfigDir(options);
  return join(dir, `${KIND_CONFIG_FILE_PREFIX}${kind}`);
}

/**
 * The agent-local files derived from `--home` and `--actor-kind`.
 *
 * The machine-local config root is deliberately *not* derived here: it is one
 * per installation, not one per agent home, so callers use `resolveConfigDir`.
 *
 * @param {string} home
 * @param {string} actorKind
 * @returns {{
 *   log: string, state: string, agentDir: string,
 *   loopSkill: string, boardSkill: string, stateDir: string,
 *   loopRoles: string,
 * }}
 */
export function agentPaths(home, actorKind) {
  const dir = join(home, AGENT_DIRS[actorKind]);
  const loopSkill = join(dir, "skills", "meerkat-loop");
  const stateDir = join(dir, "meerkat-taskpanel");
  return {
    log: join(dir, "meerkat-taskpanel", STATE_FILES.log),
    state: join(dir, "meerkat-taskpanel", STATE_FILES.supervisor),
    agentDir: AGENT_DIRS[actorKind],
    // The two skills the resident sessions need: the loop expands
    // `/meerkat-loop` in the control session; project subagents use the board
    // skill. Checked at `--session` start, never assumed.
    loopSkill,
    boardSkill: join(dir, "skills", "meerkat"),
    // The loop's state directory. Runtime state only — a roles root travels
    // with the skill, never here.
    stateDir,
    loopRoles: join(loopSkill, "roles"),
  };
}
