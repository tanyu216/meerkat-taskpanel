#!/usr/bin/env node
/**
 * Migrate an old skill-beside `projects.json` into the config-root map.
 *
 * The map used to live next to each installed board skill; it is now one file
 * per install at the config root (`<config root>/projects.json`). This helper is
 * the installer's only writer for that move:
 *
 *   * the target wins on the same `project` — an entry the installer already has
 *     is never overwritten by an older copy;
 *   * source-only entries are appended, and every entry is copied whole so its
 *     unknown keys survive;
 *   * the source is removed **only after** the merged map is safely written;
 *   * a source that is not the documented shape is left exactly where it is,
 *     with a warning and exit 3, so the install continues and the operator can
 *     repair it by hand.
 *
 * The schema and the merge rule live in `src/foundation/project-dir.mjs`; this
 * module only supplies the install-time I/O around them. Node builtins only.
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { isEntryPoint } from "../../../src/foundation/entry-guard.mjs";
import {
  mergeProjectEntries,
  readProjectMapForEdit,
  writeProjectMap,
} from "../../../src/foundation/project-dir.mjs";

export const PROJECT_MAP_FILENAME = "projects.json";

/**
 * Merge `from` into `<into>/projects.json`, then remove `from`.
 *
 * @param {{into: string, from: string, label?: string, dryRun?: boolean}} options
 * @returns {{ok: boolean, status: number, message: string}}
 */
export function migrateProjectMap(options) {
  const { into, from } = options;
  const label = options.label ?? "project map";
  const dryRun = options.dryRun === true;
  const target = join(into, PROJECT_MAP_FILENAME);

  if (resolve(from) === resolve(target)) return { ok: true, status: 0, message: "" };
  if (!existsSync(from)) return { ok: true, status: 0, message: "" };

  const source = readProjectMapForEdit(from);
  if (!source.ok) {
    return {
      ok: false,
      status: 3,
      message: `${label}: warning: ${from} is not a project map (${source.message}); left in place`,
    };
  }

  const targetExists = existsSync(target);
  const existing = targetExists
    ? readProjectMapForEdit(target)
    : { ok: true, present: false, root: {}, projects: [] };
  if (!existing.ok) {
    return {
      ok: false,
      status: 3,
      message: `${label}: warning: ${target} is not a project map (${existing.message}); ${from} left in place`,
    };
  }

  const merged = mergeProjectEntries(existing.projects, source.projects);
  const counts = `${merged.added} added, ${merged.kept} kept, ${merged.skipped} skipped`;

  if (dryRun) {
    return {
      ok: true,
      status: 0,
      message: `${label}: would migrate ${from} -> ${target} (${counts})`,
    };
  }

  // An absent target adopts the source's top-level object too, so keys this
  // installer does not interpret survive the move.
  const root = targetExists ? existing.root : source.root;
  const written = writeProjectMap(target, merged.entries, { root });
  if (!written.ok) {
    return {
      ok: false,
      status: 3,
      message: `${label}: warning: ${written.message} ${from} left in place`,
    };
  }

  try {
    rmSync(from);
  } catch (err) {
    return {
      ok: false,
      status: 3,
      message: `${label}: warning: merged into ${target} but could not remove ${from} (${err?.code ?? err})`,
    };
  }

  return { ok: true, status: 0, message: `${label}: migrated ${from} -> ${target} (${counts})` };
}

/**
 * `merge --into <dir> --from <file> [--label <text>] [--dry-run]`
 *
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv = process.argv.slice(2)) {
  const usage =
    "usage: project-map.mjs merge --into <config-root> --from <projects.json> [--label <text>] [--dry-run]";
  const [command, ...rest] = argv;
  if (command !== "merge") {
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  const options = { into: null, from: null, label: "project map", dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--into" || token === "--from" || token === "--label") {
      const value = rest[index + 1];
      if (value === undefined) {
        process.stderr.write(`${usage}\n`);
        return 2;
      }
      index += 1;
      if (token === "--into") options.into = value;
      else if (token === "--from") options.from = value;
      else options.label = value;
      continue;
    }
    process.stderr.write(`unknown argument '${token}'\n${usage}\n`);
    return 2;
  }
  if (options.into === null || options.from === null) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  const result = migrateProjectMap(options);
  if (result.message !== "") {
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${result.message}\n`);
  }
  return result.status;
}

if (isEntryPoint(import.meta.url)) process.exit(main());
