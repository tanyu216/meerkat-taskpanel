/**
 * Where the loop keeps its runtime state, and which source named it.
 *
 *   explicit  `--state` / `--state-dir` (the CLI normalizes `--state-dir` to a
 *             registry file before this resolver sees it)
 *   env       `MEERKAT_TASKPANEL_STATE_DIR` in the process environment
 *   config    the same key in the per-kind config (`<config root>/.env.<kind>`)
 *   default   `<config root>/loop` — `loopStateDir(resolveConfigDir(...))`
 *   legacy    the pre-migration `<home>/<agent-dir>/meerkat-taskpanel`, used
 *             only as a read fallback when the default has no state yet
 *
 * The legacy fallback is deliberately limited to reads: the orchestrator's
 * write verbs refuse a legacy-only directory and print the migration command, so
 * two directories can never be written at once. The verb check lives in
 * `src/orchestrator/dispatch.mjs`, where the verb is known; this module is pure
 * path arithmetic plus one injected existence probe.
 *
 * Node builtins only; the `exists` seam keeps tests off the filesystem.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { legacyLoopStateDir, resolveConfigDir } from "./agent-paths.mjs";
import { loopStateDir, QUEUE_FILES, STATE_FILES } from "./loop-state.mjs";

/** The one key that names the state directory. */
export const STATE_DIR_ENV = "MEERKAT_TASKPANEL_STATE_DIR";

/**
 * Files whose presence means a directory holds loop state.
 *
 * A fresh install creates the directory before the pool writes anything, so
 * directory existence alone is not evidence. `supervisor.state.json` alone is
 * not enough either: the resident pool writes `sessions.state.json` and the
 * queue long before the legacy registry exists.
 */
const STATE_MARKERS = Object.freeze([
  STATE_FILES.supervisor,
  QUEUE_FILES.cards,
  QUEUE_FILES.sessions,
  QUEUE_FILES.ledger,
  QUEUE_FILES.workspaces,
  STATE_FILES.continueState,
]);

/**
 * @param {string|null|undefined} dir
 * @param {{exists?: (path: string) => boolean}} [options]
 * @returns {boolean}
 */
export function hasLoopState(dir, options = {}) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  const exists = options.exists ?? existsSync;
  return STATE_MARKERS.some((name) => exists(join(String(dir), name)));
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Resolve a configured path; relative values resolve against cwd like `resolveConfigDir`. */
function configuredDir(value) {
  return resolve(value);
}

/**
 * @param {{
 *   stateFile?: string|null,
 *   home?: string|null,
 *   actorKind?: string|null,
 *   env?: NodeJS.ProcessEnv,
 *   config?: Record<string, string>|null,
 *   exists?: (path: string) => boolean,
 * }} [input]
 * @returns {{dir: string, source: "explicit"|"env"|"config"|"default"|"legacy", legacyDir: string|null}}
 */
export function resolveLoopState(input = {}) {
  const env = input.env ?? process.env;
  const config = input.config ?? {};
  const exists = input.exists ?? existsSync;

  const stateFile = nonEmpty(input.stateFile);
  if (stateFile !== null) {
    return { dir: dirname(configuredDir(stateFile)), source: "explicit", legacyDir: null };
  }

  const fromEnv = nonEmpty(env[STATE_DIR_ENV]);
  const fromConfig = nonEmpty(config[STATE_DIR_ENV]);
  if (fromEnv !== null) {
    return { dir: configuredDir(fromEnv), source: "env", legacyDir: null };
  }
  if (fromConfig !== null) {
    return { dir: configuredDir(fromConfig), source: "config", legacyDir: null };
  }

  const dir = loopStateDir(resolveConfigDir({ env }));
  const legacyDir = legacyLoopStateDir(input.home ?? null, input.actorKind ?? null);
  if (legacyDir !== null && !hasLoopState(dir, { exists }) && hasLoopState(legacyDir, { exists })) {
    return { dir: legacyDir, source: "legacy", legacyDir };
  }
  return { dir, source: "default", legacyDir };
}

/**
 * The default state directory, for callers that only need the path (the
 * installer's status probes, the `loop` fallback).
 *
 * @param {{env?: NodeJS.ProcessEnv, home?: string|null, actorKind?: string|null, exists?: (path: string) => boolean}} [input]
 * @returns {{dir: string, source: "explicit"|"env"|"config"|"default"|"legacy", legacyDir: string|null}}
 */
export function resolveLoopStateDir(input = {}) {
  const resolved = resolveLoopState(input);
  return { dir: resolved.dir, source: resolved.source, legacyDir: resolved.legacyDir };
}
