/**
 * The atomic-replace discipline behind `.meerkat/<identifier>/card.md`.
 *
 * Two writers share it, and neither can reach the other's layer:
 *
 *   * the loop asks the CLI to render
 *     (`taskctl export md <ref> --out <temp>`) and commits that temp file
 *     (`taskctl export md` and the hub watch);
 *   * the CLI watchers already hold the board's markdown in memory and write it
 *     through the same temp (`src/cli/watch-core.mjs`).
 *
 * This module is deliberately **not** an exporter and not a generic atomic-file
 * utility. It owns one question — how an already-rendered card becomes
 * `card.md` — and the three invariants both writers must agree on:
 *
 *   1. create the parent and a unique temp beside the final file;
 *   2. leave a byte-identical file untouched (no mtime churn);
 *   3. remove the temp on every path that does not rename it.
 *
 * The `.tmp.md` suffix is load-bearing: `export md --out` treats a `.md` path
 * as a single file target and writes exactly one file there.
 *
 * **No growth guard here, deliberately.** `export md`'s `MD_GROWTH_GUARD` only
 * inspects an existing target; a fresh temp path bypasses it on purpose,
 * because a machine-generated brief legitimately grows when comments or a
 * report land (see `src/cli/commands/export.mjs#assertGrowthGuard`).
 *
 * No locking: two writers may still race and the last rename wins, exactly as
 * before. The unique temp name only keeps their temps apart.
 *
 * Node builtins only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The unique temp path beside `finalPath`.
 *
 * @param {string} finalPath
 * @returns {string}
 */
export function cardTempPath(finalPath) {
  return join(
    dirname(finalPath),
    `card.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp.md`,
  );
}

/**
 * Best-effort temp removal. A leftover temp is never the caller's problem.
 *
 * @param {string} path
 * @returns {void}
 */
export function removeCardTemp(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Commit a producer's temp file over its final path.
 *
 * `reason` distinguishes the two "the producer did not deliver" cases so each
 * caller keeps its own error contract: the loop maps them to `{ok:false}`, while
 * the CLI has already rejected an empty render with a `DomainError`. Unexpected
 * fs errors (read/rename) propagate to the caller.
 *
 * @param {{temp: string, final: string}} input
 * @returns {{ok: true, path: string, changed: boolean} | {ok: false, reason: "missing" | "empty"}}
 */
export function commitCardTemp({ temp, final }) {
  if (!existsSync(temp)) return { ok: false, reason: "missing" };
  const next = readFileSync(temp, "utf8");
  if (next.length === 0) {
    removeCardTemp(temp);
    return { ok: false, reason: "empty" };
  }
  if (existsSync(final) && readFileSync(final, "utf8") === next) {
    removeCardTemp(temp);
    return { ok: true, path: final, changed: false };
  }
  renameSync(temp, final);
  return { ok: true, path: final, changed: true };
}

/**
 * Write markdown the caller already holds.
 *
 * The byte comparison happens before a temp is created, so a no-op refresh does
 * not touch the directory at all.
 *
 * @param {{file: string, content: string}} input
 * @returns {{path: string, changed: boolean}}
 */
export function writeCardFileAtomic({ file, content }) {
  if (typeof content !== "string" || content === "") {
    throw new TypeError("card content must be a non-empty string");
  }
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === content) {
    return { path: file, changed: false };
  }

  const temp = cardTempPath(file);
  try {
    writeFileSync(temp, content, "utf8");
    const outcome = commitCardTemp({ temp, final: file });
    if (!outcome.ok) throw new Error(`card write: temp ${outcome.reason} (${temp})`);
    return { path: outcome.path, changed: outcome.changed };
  } finally {
    removeCardTemp(temp);
  }
}
