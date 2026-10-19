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

/** The repository root — `test/install/helpers/` is three levels down. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const INSTALL = join(ROOT, "install.sh");

/**
 * @param {{prefix?: string, installDefaults?: Record<string, string>}} [options]
 * @returns {{makeTempDir: (prefix?: string) => string, runInstall: (args: string[], env?: Record<string, string>) => import('node:child_process').SpawnSyncReturns<string>, cleanup: () => void}}
 */
export function createInstallHarness({
  prefix = "meerkat-taskpanel-",
  // The contract's test-only bypass (`docs/scheduling.md`): an install really
  // does load an OS unit for the taskd guard, and a test must never do that.
  installDefaults = { MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1" },
} = {}) {
  const dirs = [];

  const makeTempDir = (override = prefix) => {
    const dir = mkdtempSync(join(tmpdir(), override));
    dirs.push(dir);
    return dir;
  };

  const runInstall = (args, env = {}) =>
    spawnSync("bash", [INSTALL, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...installDefaults, ...env },
    });

  const cleanup = () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };

  return { makeTempDir, runInstall, cleanup };
}
