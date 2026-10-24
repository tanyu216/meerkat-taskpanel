/**
 * `KEY=VALUE` configuration files — the install-root `.env` and the per-agent-kind
 * loop config — as pure text operations.
 *
 * Two writers share the install-root file (the Access panel's allow-list and
 * the installer's acceptance policy), and the client reads the same keys, so a
 * whole-file rewrite by either would silently erase the others' answers.
 * Merging is therefore the only write this module offers: unknown lines (an
 * operator's comments included) survive, a key in the patch is replaced in
 * place, and a new key is appended.
 *
 * Pure: no `node:` imports, no filesystem. The caller reads and writes the bytes
 * (`server/access-config.mjs`).
 */

import { DomainError } from "./errors.mjs";

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/** The key a `KEY=VALUE` line names, or `null` for a comment/blank/malformed line. */
export function envLineKey(raw) {
  const line = String(raw ?? "").trim();
  if (line === "" || line.startsWith("#")) return null;
  const equals = line.indexOf("=");
  if (equals <= 0) return null;
  return line.slice(0, equals).trim().replace(/^export\s+/, "");
}

/**
 * Read a `KEY=VALUE` file into a map.
 *
 * Three readers share this grammar but not every corner of it, so the corners
 * stay options rather than a "corrected" single rule:
 *
 *   - `strict` — throw `ACCESS_CONFIG_INVALID` on a line with no `=` (the Access
 *     panel refuses a file it cannot read) instead of skipping it (the acceptance
 *     policy and the installer only care about the keys they name).
 *   - `quoteMinLength` — the shortest value that has matching quotes stripped.
 *     The default matches the panel's `startsWith/endsWith` test, which turns a
 *     lone `"` into `""`; the installer's reader requires two characters.
 *   - `skipEmptyKey` — drop a `=value` line instead of recording it under `""`.
 *
 * Comments and blank lines are ignored, `export ` is stripped from the key, and
 * a repeated key is last-write-wins.
 *
 * @param {string} text
 * @param {{strict?: boolean, quoteMinLength?: number, skipEmptyKey?: boolean}} [options]
 * @returns {Map<string, string>}
 */
export function parseEnvText(text, { strict = false, quoteMinLength = 1, skipEmptyKey = false } = {}) {
  const values = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) {
      if (strict) {
        throw new DomainError("ACCESS_CONFIG_INVALID", {
          message: `the access configuration line ${JSON.stringify(line)} is not KEY=VALUE`,
        });
      }
      continue;
    }
    const key = line.slice(0, equals).trim().replace(/^export\s+/, "");
    let value = line.slice(equals + 1).trim();
    const quoted = value.startsWith('"') && value.endsWith('"');
    const single = value.startsWith("'") && value.endsWith("'");
    if (value.length >= quoteMinLength && (quoted || single)) value = value.slice(1, -1);
    if (skipEmptyKey && key === "") continue;
    values.set(key, value);
  }
  return values;
}

/**
 * Read a yes/no-ish word, or `null` when it says nothing.
 *
 * `shortForms` adds the installer's `y`/`n`; the Access panel deliberately
 * refuses them, so it calls without the option and turns `null` into an error.
 *
 * @param {unknown} value
 * @param {{shortForms?: boolean}} [options]
 * @returns {boolean|null}
 */
export function parseEnvBool(value, { shortForms = false } = {}) {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  if (shortForms && word === "y") return true;
  if (shortForms && word === "n") return false;
  return null;
}

/**
 * Merge `patch` into the file's text.
 *
 * @param {string} text the file as it is (empty when absent)
 * @param {Record<string, string>} patch
 * @returns {string} the text to write, ending in exactly one newline
 */
export function mergeEnvText(text, patch) {
  const lines = String(text ?? "") === "" ? [] : String(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const patched = new Set();
  const out = [];
  for (const raw of lines) {
    const key = envLineKey(raw);
    if (key !== null && Object.hasOwn(patch, key)) {
      // The first occurrence is rewritten; later duplicates of the same key are
      // dropped, so the file keeps one line per patched key.
      if (!patched.has(key)) {
        out.push(`${key}=${patch[key]}`);
        patched.add(key);
      }
      continue;
    }
    out.push(raw);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!patched.has(key)) out.push(`${key}=${value}`);
  }
  out.push("");
  return out.join("\n");
}
