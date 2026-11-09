/**
 * Where an installed agent's files live, and where the machine-local config
 * root is.
 *
 * Two related facts, one module: `agentPaths` derives a kind's directories from
 * `--home`, and `resolveConfigDir` / `resolveKindConfigPath` name the one
 * directory that holds the machine-local config (`.env.<kind>`, `projects.json`).
 * `loopLogPath` is the one file that deliberately escapes the agent directory:
 * every kind's supervisor log lands together at the config root. The map itself
 * lives in `project-dir.mjs`; this module only says *where*.
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
const KIND_CONFIG_FILE_PREFIX = ".env.";

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
 * The **legacy** loop state directory, `<home>/<agent-dir>/meerkat-taskpanel`.
 *
 * The loop state now lives at the config root (`loopStateDir`); this path is the
 * pre-migration location, read only as a compatibility fallback and used as the
 * installer's migration source. It stays in this module because `AGENT_DIRS`
 * lives here — putting it in `loop-state.mjs` would create an import cycle
 * (`agent-paths -> loop-state -> agent-paths`).
 *
 * @param {string} home
 * @param {string} actorKind
 * @returns {string|null} absolute directory, or null for an unknown kind
 */
export function legacyLoopStateDir(home, actorKind) {
  const agentDir = AGENT_DIRS[actorKind];
  if (agentDir === undefined) return null;
  if (typeof home !== "string" || home.trim() === "") return null;
  return join(home, agentDir, "meerkat-taskpanel");
}

/**
 * The agent-local skill files derived from `--home` and `--actor-kind`.
 *
 * The machine-local config root and the loop state are deliberately *not*
 * derived here: they are one per installation, not one per agent home, so
 * callers use `resolveConfigDir` / `loopStateDir`.
 *
 * @param {string} home
 * @param {string} actorKind
 * @returns {{
 *   agentDir: string,
 *   directorSkill: string, boardSkill: string,
 * }}
 */
export function agentPaths(home, actorKind) {
  const dir = join(home, AGENT_DIRS[actorKind]);
  return {
    agentDir: AGENT_DIRS[actorKind],
    // The two skills the resident sessions need: the director lane runs
    // `meerkat-director`; workers and reviewers use the board skill. Checked at
    // `--session` start, never assumed.
    directorSkill: join(dir, "skills", "meerkat-director"),
    boardSkill: join(dir, "skills", "meerkat"),
  };
}

/**
 * The loop's log file: `<config root>/logs/supervisor.log`.
 *
 * Deliberately takes no actor kind. One file holds every kind's lines and each
 * carries `actor_kind=`, so the path answers "where are this product's logs"
 * without the agent-kind -> dot-directory table. The *state* directory is also
 * one per board installation, at the config root (`loopStateDir`).
 *
 * Pure arithmetic — the config root is an argument, exactly like `agentPaths`.
 *
 * @param {string} configDir the machine-local config root
 * @returns {string} absolute file path
 */
export function loopLogPath(configDir) {
  return join(configDir, "logs", STATE_FILES.log);
}
