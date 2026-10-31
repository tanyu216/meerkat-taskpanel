/** Atomic file writes for the setup scripts: temp file in the same directory + rename. */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * @param {string} path
 * @param {string} text
 * @param {{mode?: number}} [options]
 */
export function writeAtomic(path, text, options = {}) {
  const mode = options.mode ?? 0o644;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, text, { encoding: "utf8", mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}
