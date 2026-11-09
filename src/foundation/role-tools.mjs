/**
 * The lane → tool surface: one source for the session adapters and the installer.
 *
 * Worker lanes run with every tool, so they pass no tool list at all. The
 * director and reviewer lanes are read-only: their write tools are denied, and
 * that one deny list is rendered both into the adapters' argv and into the
 * generated native agent definitions.
 *
 * The kind names match the adapters' actor kinds. Node builtins only; this file
 * must not import from `src/orchestrator`.
 */

/** The lanes that may not write. Every other lane passes no tool list at all. */
export const READ_ONLY_LANES = Object.freeze(["director", "reviewer"]);

/** The write tools each actor kind can deny. */
export const READ_ONLY_DENIED_TOOLS = Object.freeze({
  claude: "Edit,Write,NotebookEdit",
  pi: "edit,write",
});

/**
 * Whether a lane is read-only.
 *
 * @param {string} [lane]
 * @returns {boolean}
 */
export function isReadOnlyLane(lane) {
  return READ_ONLY_LANES.includes(String(lane ?? ""));
}

/**
 * A read-only lane's deny list for one actor kind, or `null` when the lane may
 * write or the kind has no per-role tool surface (Codex, and any future kind
 * that cannot enforce one).
 *
 * @param {string} [lane]
 * @param {string} kind
 * @returns {string|null}
 */
export function readOnlyDeniedTools(lane, kind) {
  if (!isReadOnlyLane(lane)) return null;
  return READ_ONLY_DENIED_TOOLS[kind] ?? null;
}

/**
 * The native agent definition's tool lines for a lane. A full lane adds none:
 * omitting `tools` is what makes Claude and Pi inherit their whole tool pool.
 * A read-only lane carries a deny line instead of an allowlist.
 *
 * @param {string} [lane]
 * @param {string} kind
 * @returns {string[]}
 */
export function nativeAgentToolLines(lane, kind) {
  const denied = readOnlyDeniedTools(lane, kind);
  if (denied === null) return [];
  if (kind === "claude") return [`disallowedTools: ${denied}`];
  if (kind === "pi") return [`excludeTools: ${denied}`];
  return [];
}
