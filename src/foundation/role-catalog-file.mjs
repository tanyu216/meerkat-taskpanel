/**
 * The local role catalog's file — `<config root>/roles.json`, beside
 * `projects.json` and the per-kind `.env.<kind>` files.
 *
 * It is host-local state, not a board table: `MEERKAT_TASKPANEL_CONFIG_DIR`
 * relocates it, `/roles.json` is gitignored and dockerignored, and nothing in
 * this module ever contacts a board. Reads are bounded (the projection is small
 * by construction) and writes are atomic (temp file then rename), the same rules
 * `project-dir.mjs` applies to the project map.
 *
 * A missing file is not an error — it is the bootstrap state, before the
 * supervisor's first sync. A malformed or oversized one is reported and treated
 * as absent by every caller; it is never half-applied.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveConfigDir } from "./agent-paths.mjs";
import {
  ROLE_CATALOG_FILENAME,
  ROLE_CATALOG_MAX_BYTES,
  normalizeRoleCatalog,
} from "./role-catalog.mjs";

/**
 * The one machine-local catalog path: under the config root (the program root,
 * or `MEERKAT_TASKPANEL_CONFIG_DIR`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{cwd?: string, root?: string}} [options]
 * @returns {string} an absolute path
 */
export function defaultRoleCatalogPath(env = process.env, options = {}) {
  return join(resolveConfigDir({ env, cwd: options.cwd, root: options.root }), ROLE_CATALOG_FILENAME);
}

/**
 * Read and validate the catalog.
 *
 * Three shapes, so a caller can tell "no catalog yet" from "a broken one":
 *   * `{ok: true, present: false, catalog: null}` — not written yet;
 *   * `{ok: true, present: true, catalog}` — valid;
 *   * `{ok: false, present: true, code, message, file}` — present but unusable.
 *
 * @param {string} file
 * @param {{
 *   readFile?: (path: string) => string,
 *   stat?: (path: string) => {size: number},
 *   maxBytes?: number,
 * }} [deps]
 * @returns {{ok: true, present: false, catalog: null, file: string}
 *   | {ok: true, present: true, catalog: object, file: string}
 *   | {ok: false, present: true, code: string, message: string, file: string}}
 */
export function readRoleCatalog(file, deps = {}) {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const stat = deps.stat ?? ((path) => statSync(path));
  const maxBytes = deps.maxBytes ?? ROLE_CATALOG_MAX_BYTES;

  let size;
  try {
    size = stat(file).size;
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, present: false, catalog: null, file };
    return {
      ok: false,
      present: true,
      code: "unreadable",
      message: `cannot read the role catalog at ${file} (${err?.code ?? err?.message ?? "unknown error"})`,
      file,
    };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      present: true,
      code: "too_large",
      message: `the role catalog at ${file} is larger than ${maxBytes} bytes`,
      file,
    };
  }

  let text;
  try {
    text = readFile(file);
  } catch (err) {
    return {
      ok: false,
      present: true,
      code: "unreadable",
      message: `cannot read the role catalog at ${file} (${err?.code ?? err?.message ?? "unknown error"})`,
      file,
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      present: true,
      code: "malformed",
      message: `the role catalog at ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      file,
    };
  }

  const normalized = normalizeRoleCatalog(raw);
  if (!normalized.ok) {
    return {
      ok: false,
      present: true,
      code: normalized.code,
      message: `the role catalog at ${file} is unusable: ${normalized.message}`,
      file,
    };
  }
  return { ok: true, present: true, catalog: normalized.catalog, file };
}

/** Distinguishes concurrent temp files in one process. */
let writeCounter = 0;

/**
 * Write the catalog atomically: a same-directory temp file, then a rename over
 * the target. A reader never sees a half-written document, and a failed write
 * leaves the previous one untouched. An existing file's mode is preserved.
 *
 * @param {string} file
 * @param {object} catalog
 * @param {{deps?: {
 *   mkdirSync?: Function, writeFileSync?: Function, renameSync?: Function,
 *   unlinkSync?: Function, statSync?: Function,
 * }}} [options]
 * @returns {{ok: true, file: string, bytes: number} | {ok: false, code: string, message: string, file: string}}
 */
export function writeRoleCatalog(file, catalog, options = {}) {
  const deps = {
    mkdirSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    statSync,
    ...(options.deps ?? {}),
  };
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}-${writeCounter}`;
  writeCounter += 1;

  let mode;
  try {
    mode = deps.statSync(file).mode & 0o777;
  } catch {
    mode = null;
  }

  try {
    deps.mkdirSync(dirname(file), { recursive: true });
    deps.writeFileSync(temp, text, mode === null ? "utf8" : { encoding: "utf8", mode });
    deps.renameSync(temp, file);
    return { ok: true, file, bytes: Buffer.byteLength(text, "utf8") };
  } catch (err) {
    try {
      deps.unlinkSync(temp);
    } catch {
      // The temp file was never created (or is already gone): nothing to clean.
    }
    return {
      ok: false,
      code: "CLI_IO",
      message:
        `cannot write the role catalog at ${file} (${err?.code ?? err?.message ?? "unknown error"}). ` +
        "Point MEERKAT_TASKPANEL_CONFIG_DIR at a writable directory, or fix the file's permissions.",
      file,
    };
  }
}
