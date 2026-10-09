/**
 * The Node runtime floor, checked at the entry points.
 *
 * The engine persists to a local SQLite database through the built-in
 * `node:sqlite` module, which the 22.x line is the first to ship — so "this
 * process is Node >= 22" is a precondition, not a nicety. Without a check, an
 * older runtime fails the moment `node:sqlite` is first imported, deep inside a
 * command, with a stack that names neither the requirement nor the fix. Both
 * client entries (`src/cli`, `src/mcp`) therefore run one cheap preflight
 * against `process.versions.node` before doing anything else.
 *
 * This module is deliberately tiny and dependency-free — not even the `errors`
 * vocabulary — because it has to be *evaluable on the very runtime it rejects*:
 * on an old Node it must be safe to load and safe to call.
 */

/**
 * Lowest supported major. Mirrors `engines.node` in `package.json`; the two must
 * move together.
 */
export const MIN_NODE_MAJOR = 22;

/**
 * @param {string} version a `process.versions.node`-style string ("22.11.0", "v20.9.0")
 * @returns {number|null} the major, or null when the string is not a version
 */
export function nodeMajor(version) {
  // Accept a bare major ("22", "v22") as well as a dotted version ("22.0.0",
  // "v22.11.0") so the runtime floor and the installer's `require_node`
  // (`scripts/install/_common.sh`) agree on the same strings. The major still
  // has to terminate at a dot or end-of-string, so "22garbage" is not a version.
  const match = /^v?(\d+)(?:\.|$)/.exec(String(version));
  return match === null ? null : Number.parseInt(match[1], 10);
}

/**
 * @param {string} version
 * @param {number} [min]
 * @returns {boolean} true when `version` is a parseable version at or above `min`
 */
export function isSupportedNode(version, min = MIN_NODE_MAJOR) {
  const major = nodeMajor(version);
  return major !== null && major >= min;
}

/**
 * The message a too-old runtime gets. One place, so every entry point names the
 * same requirement and the same fix.
 *
 * @param {string} version
 * @param {{min?: number, bin?: string}} [options]
 * @returns {string}
 */
export function unsupportedNodeMessage(version, options = {}) {
  const { min = MIN_NODE_MAJOR, bin = "task-panel" } = options;
  return [
    `${bin}: Node ${min} or newer is required — found ${version === "" ? "no version" : version}.`,
    `The engine stores to SQLite through the built-in node:sqlite module (Node ${min}+);`,
    `on an older runtime it would fail later, mid-command, rather than here.`,
    `Install or upgrade Node: https://nodejs.org/  (or with nvm: \`nvm install ${min}\`).`,
  ].join("\n");
}
