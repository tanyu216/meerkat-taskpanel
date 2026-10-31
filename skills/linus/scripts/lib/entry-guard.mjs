/**
 * A symlink-safe entry guard for the setup scripts.
 *
 * The installed skill may live behind a symlinked directory (a checkout linked into
 * `~/.claude/skills`, `/tmp` on macOS), so both sides are realpath'd. The three shapes
 * the repository's `apply-guard` scan rejects are deliberately avoided:
 * `pathToFileURL(argv[1])`, `resolve(argv[1])` and a `file://${argv[1]}` template.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @param {string} [metaUrl] */
export function isEntryPoint(metaUrl = import.meta.url) {
  const invoked = process.argv[1];
  if (typeof invoked !== "string" || invoked === "") return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
