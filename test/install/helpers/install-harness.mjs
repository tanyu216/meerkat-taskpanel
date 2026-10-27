/**
 * The temp-directory + `install.sh` runner every install suite shares.
 *
 * Fifteen suites had grown their own `makeTempDir` (identical bodies, different
 * prefixes) and nine their own `runInstall` (two shapes: one defaulting the
 * taskd-guard bypass, one taking the env verbatim). Both are one behaviour, so
 * this module owns them and a suite names only what actually differs: its temp
 * prefix, and whether it wants the install defaults.
 *
 * `node-check.test.mjs` keeps its own runner on purpose — it builds `HOME`,
 * `PATH` and `MEERKAT_TASKPANEL_TARGET_HOME` around a fake toolchain, which is a
 * different question rather than a variation of this one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { baseEnv } from "../../helpers/base-env.mjs";

/** The repository root — `test/install/helpers/` is three levels down. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const INSTALL = join(ROOT, "install.sh");

/**
 * @param {{prefix?: string, installDefaults?: Record<string, string>}} [options]
 * @returns {{makeTempDir: (prefix?: string) => string, runInstall: (args: string[], env?: Record<string, string>) => import('node:child_process').SpawnSyncReturns<string>, runInstallWithInput: (args: string[], input: string, env?: Record<string, string>) => import('node:child_process').SpawnSyncReturns<string>, cleanup: () => void}}
 */
export function createInstallHarness({
  prefix = "meerkat-taskpanel-",
  // The contract's test-only bypass (`docs/scheduling.md`): an install really
  // does load an OS unit for the taskd guard, and a test must never do that.
  installDefaults = { MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1" },
} = {}) {
  const dirs = [];

  // The installer seeds `<repo>/.env` by default. Every test gets its own temp
  // path instead, so a run never writes the checkout (or reads a developer's
  // real config). A suite can still override it through `env`.
  const envDir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-env-"));
  dirs.push(envDir);
  const defaults = {
    ...installDefaults,
    MEERKAT_TASKPANEL_ENV_FILE: join(envDir, ".env"),
  };

  const makeTempDir = (override = prefix) => {
    const dir = mkdtempSync(join(tmpdir(), override));
    dirs.push(dir);
    return dir;
  };

  const runInstall = (args, env = {}) =>
    spawnSync("bash", [INSTALL, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: baseEnv({ ...defaults, ...env }),
    });

  /**
   * Like `runInstall`, but feeds stdin. `install.sh --interactive` reads its
   * answers from stdin even when it is a pipe, which is how the wizard is
   * tested without a pty. EOF cancels, so a truncated input cannot hang.
   */
  const runInstallWithInput = (args, input, env = {}) =>
    spawnSync("bash", [INSTALL, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      input,
      env: { ...process.env, ...defaults, ...env },
    });

  const cleanup = () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };

  return { makeTempDir, runInstall, runInstallWithInput, cleanup };
}
