/**
 * A base environment for spawned programs: the caller's PATH and HOME, and none of
 * the board's own configuration.
 *
 * A developer machine usually has `TASKCTL_*` / `TASKD_*` exported (the installed
 * shims, a running board), and a test or verification script that inherits them
 * stops testing the thing it names: it talks to the caller's board instead of the
 * throwaway one it just started. Scrubbing by prefix is deliberately broad — a new
 * `TASKD_*` key is covered the day it is added, not the day someone remembers this
 * file.
 *
 * Node builtins only; no dependencies.
 */

/** Environment-key prefixes that belong to a board instance, never to a test. */
export const SCRUB_PREFIXES = Object.freeze(["TASKCTL_", "TASKD_", "MEERKAT_TASKPANEL_"]);

/** Keys that name a board without carrying one of the prefixes. */
export const SCRUB_KEYS = Object.freeze([]);

/**
 * Return a copy of `env` without any board configuration.
 *
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {Record<string, string|undefined>}
 */
export function scrubEnv(env = process.env) {
  const copy = {};
  for (const [key, value] of Object.entries(env)) {
    if (SCRUB_KEYS.includes(key)) continue;
    if (SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    copy[key] = value;
  }
  return copy;
}
