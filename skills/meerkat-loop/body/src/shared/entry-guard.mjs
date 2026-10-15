/**
 * Was this module started as the process's entry point?
 *
 * Every CLI in this repository needs the same decision — run `main()` when it was executed,
 * stay inert when it was imported — and it used to be written as a comparison of
 * `import.meta.url` against `pathToFileURL(process.argv[1]).href`. That comparison is **wrong
 * whenever the invoked path carries a symlink**: Node resolves `import.meta.url` through
 * `realpath`, but `process.argv[1]` is kept exactly as the caller spelled it, so an absolute
 * path with a symlinked ancestor never matches. The guard is then silently false — nothing
 * runs, nothing is written, and the process still exits **0**. A no-op reported as success.
 *
 * It is not theoretical. `script_dir()` in `scripts/install/_common.sh` prints the logical
 * path; macOS's `/tmp` is itself a symlink to `/private/tmp`; a host whose home directory is
 * mounted elsewhere commonly has a symlinked `$HOME`. Reached that way, a `scripts/verify/*`
 * checker reports success without looking at anything, and `wake-cwd.mjs` prints an empty
 * directory that its caller takes for a resolved one.
 *
 * So compare **canonical paths**, not URLs: `pathToFileURL` and `resolve` both leave symlinks
 * in place, and only `realpath` removes them. `fileURLToPath` additionally percent-decodes,
 * which is the part the naive `file://` template form never handled.
 *
 * Importable from `src/cli`, `src/server`, `src/core`, `scripts/**` and the loop body (whose
 * closure vendors it). Four files carry a private copy instead, for three reasons:
 *
 *   * the board skill's `scripts/report.mjs` and the loop skill's `scripts/board-check.mjs` ship
 *     on their own, so a relative import out of their directory would dangle once they are copied;
 *   * `web/scripts/dom-smoke.mjs` lives in a separate workspace with its own lockfile;
 *   * `scripts/security/scan-gate.mjs` may import **Node builtins only**, because a security gate
 *     cannot depend on the code it exists to clear.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The canonical, symlink-free form of `path`.
 *
 * An unresolvable path falls back to `resolve()`. The fallback can only make
 * {@link isEntryPoint} *under*-fire — both sides then compare as spelled — which is the safe
 * direction: it can never make the guard fire for a different file.
 *
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Was this process started on `moduleUrl`?
 *
 * Pass the caller's own `import.meta.url`: a default here would resolve to *this* file rather
 * than to the caller, which is why there deliberately is not one.
 *
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @param {string} [argv1] the invoked path; defaults to the live `process.argv[1]`
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  // `undefined` (a REPL, or `node -e`) is the real case; the broader `typeof` also refuses a
  // stray `null`/number rather than letting it reach `realpathSync` and throw.
  if (typeof argv1 !== "string") return false;
  return canonicalPath(argv1) === canonicalPath(fileURLToPath(moduleUrl));
}
