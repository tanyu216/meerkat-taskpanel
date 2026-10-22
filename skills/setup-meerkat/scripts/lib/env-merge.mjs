/**
 * `KEY=VALUE` merging for the setup skill.
 *
 * Mirrors the board's grammar (`src/foundation/env-file.mjs`): comments, blank lines
 * and unknown keys survive; a named key is replaced in place; a new key is appended.
 * The caller decides what a different existing value means — `mergeEnvKey` reports
 * `conflict` and leaves the text unchanged unless `force` is set.
 */

/** @param {string} text @returns {Map<string, string>} */
export function parseEnvText(text) {
  const values = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim().replace(/^export\s+/, "");
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2) {
      const double = value.startsWith('"') && value.endsWith('"');
      const single = value.startsWith("'") && value.endsWith("'");
      if (double || single) value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

/** @param {unknown} value */
export function formatEnvValue(value) {
  const text = String(value ?? "");
  return /^[^\s#"'`\\]*$/.test(text)
    ? text
    : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @param {{force?: boolean}} [options]
 * @returns {{action: "written"|"unchanged"|"conflict", text: string, existing: string|null}}
 */
export function mergeEnvKey(text, key, value, options = {}) {
  const target = String(key ?? "").trim();
  if (target === "" || target.includes("=")) {
    throw new Error("mergeEnvKey needs a non-empty key without '='");
  }
  const source = String(text ?? "");
  const lines = source === "" ? [] : source.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const nextValue = String(value ?? "");
  const rendered = `${target}=${formatEnvValue(nextValue)}`;
  let found = false;
  let existing = null;
  let conflict = false;
  let written = false;

  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) return line;
    const lineKey = trimmed.slice(0, equals).trim().replace(/^export\s+/, "");
    if (lineKey !== target) return line;
    found = true;
    let current = trimmed.slice(equals + 1).trim();
    if (current.length >= 2) {
      const double = current.startsWith('"') && current.endsWith('"');
      const single = current.startsWith("'") && current.endsWith("'");
      if (double || single) current = current.slice(1, -1);
    }
    existing = current;
    if (current === nextValue) return line;
    if (options.force !== true) {
      conflict = true;
      return line;
    }
    written = true;
    return rendered;
  });

  if (!found) {
    next.push(rendered);
    written = true;
  }

  return {
    action: conflict ? "conflict" : written ? "written" : "unchanged",
    text: next.length === 0 ? "" : `${next.join("\n")}\n`,
    existing: found ? existing : null,
  };
}
