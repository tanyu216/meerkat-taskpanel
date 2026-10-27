/**
 * The environment a test gives a spawned board process.
 *
 * A developer machine has `TASKCTL_*` / `TASKD_*` exported (installed shims, a
 * running board, a `.env` in the checkout), and a test that inherits them stops
 * testing what it names: `setup-meerkat` reads the caller's identity, a CLI test
 * talks to the caller's board. Every suite that spawns a process therefore builds
 * its environment here — PATH and HOME survive, board configuration does not.
 *
 * `MEERKAT_TASKPANEL_ENV_FILE` points at a shared *empty* file: naming a missing
 * path is an error by design, naming an empty one is the supported spelling of
 * "no configuration". `MEERKAT_TASKPANEL_CONFIG_DIR` points at an empty
 * directory for the same reason: it keeps a spawned CLI from reading the
 * checkout's `.env.<kind>` (a developer's per-kind config).
 *
 * Not a test file itself (`node --test` only runs `*.test.mjs`).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubEnv } from "../../scripts/verify/lib/scrub-env.mjs";

const EMPTY_ENV_DIR = mkdtempSync(join(tmpdir(), `meerkat-taskpanel-base-env-${process.pid}-`));
mkdirSync(EMPTY_ENV_DIR, { recursive: true });
export const EMPTY_ENV_FILE = join(EMPTY_ENV_DIR, ".env");
writeFileSync(EMPTY_ENV_FILE, "");
export const EMPTY_KIND_CONFIG_DIR = join(EMPTY_ENV_DIR, "kind");
mkdirSync(EMPTY_KIND_CONFIG_DIR, { recursive: true });

/**
 * `process.env` without board configuration, pointed at an empty config file.
 *
 * @param {Record<string, string|undefined>} [overrides]
 * @returns {Record<string, string|undefined>}
 */
export function baseEnv(overrides = {}) {
  return {
    ...scrubEnv(process.env),
    MEERKAT_TASKPANEL_ENV_FILE: EMPTY_ENV_FILE,
    MEERKAT_TASKPANEL_CONFIG_DIR: EMPTY_KIND_CONFIG_DIR,
    ...overrides,
  };
}
