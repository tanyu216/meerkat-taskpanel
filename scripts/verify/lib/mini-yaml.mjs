/**
 * A deliberately tiny YAML reader.
 *
 * The container profiles (`docker/profiles/*.yml`) are flat `key: value` maps, so the
 * verification tooling needs no more than that — and pulling in a real YAML parser would
 * break the project's zero-dependency / offline constraint. This is not a YAML
 * implementation: it is a flat-map reader that happens to accept YAML-ish input.
 *
 * Supported:
 *   - blank lines and `#` comment lines are skipped
 *   - `key: value` entries, whitespace around key and value trimmed
 *   - values wrapped in matching single or double quotes have the quotes stripped
 *   - a later duplicate key overrides an earlier one
 *
 * Anything else (a line without a colon, an empty key) throws a MiniYamlError that
 * carries the 1-based line number.
 */

/** Error thrown for input that is not a flat `key: value` mapping. */
export class MiniYamlError extends Error {
  /**
   * @param {string} reason
   * @param {number} line 1-based line number of the offending input line
   */
  constructor(reason, line) {
    super(`${reason} (line ${line})`);
    this.name = "MiniYamlError";
    this.line = line;
  }
}

/**
 * Parse a flat `key: value` document.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 * @throws {MiniYamlError} on a line that is not a flat `key: value` entry
 */
export function parseMiniYaml(text) {
  const result = {};
  const lines = String(text ?? "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new MiniYamlError(`invalid line: expected "key: value"`, lineNo);
    }

    const key = line.slice(0, colon).trim();
    if (key === "") {
      throw new MiniYamlError("invalid line: empty key", lineNo);
    }

    let value = line.slice(colon + 1).trim();
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
