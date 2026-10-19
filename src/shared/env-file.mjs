/**
 * The one `KEY=VALUE` file the board reads — `<dataDir>/taskd.env` — as pure
 * text operations.
 *
 * Two writers share the file (the Access panel's allow-list and the installer's
 * acceptance policy), so a whole-file rewrite by either would silently erase the
 * other's answer. Merging is therefore the only write this module offers:
 * unknown lines (an operator's comments included) survive, a key in the patch
 * is replaced in place, and a new key is appended.
 *
 * Pure: no `node:` imports, no filesystem. The caller reads and writes the bytes
 * (`core/acceptance-policy.mjs`, `server/access-config.mjs`).
 */

/** The key a `KEY=VALUE` line names, or `null` for a comment/blank/malformed line. */
export function envLineKey(raw) {
  const line = String(raw ?? "").trim();
  if (line === "" || line.startsWith("#")) return null;
  const equals = line.indexOf("=");
  if (equals <= 0) return null;
  return line.slice(0, equals).trim().replace(/^export\s+/, "");
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
