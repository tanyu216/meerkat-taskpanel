/**
 * The lane → tool surface: one source for the session adapters and the installer.
 *
 * Worker and director lanes run with every tool, so they pass no tool list at
 * all. Only the reviewer lane is restricted: it may not write, and that one deny
 * list is rendered both into the adapters' argv and into the generated native
 * agent definitions.
 *
 * The kind names match the adapters' actor kinds. Node builtins only; this file
 * must not import from `src/orchestrator`.
 */

/** The reviewer lane may not write. Every other lane passes no tool list at all. */
export const REVIEWER_DENIED_TOOLS = Object.freeze({
  claude: "Edit,Write,NotebookEdit",
  pi: "edit,write",
});

/**
 * The reviewer's deny list for one actor kind, or `null` when the kind has no
 * per-role tool surface (Codex, and any future kind that cannot enforce one).
 *
 * @param {string} [kind]
 * @returns {string|null}
 */
export function reviewerDeniedTools(kind) {
  return REVIEWER_DENIED_TOOLS[kind] ?? null;
}

/**
 * The native agent definition's tool lines for a lane. A full lane adds none:
 * omitting `tools` is what makes Claude and Pi inherit their whole tool pool.
 * The reviewer carries a deny line instead of an allowlist.
 *
 * @param {string} [lane]
 * @param {string} kind
 * @returns {string[]}
 */
export function nativeAgentToolLines(lane, kind) {
  if (lane !== "reviewer") return [];
  if (kind === "claude") return [`disallowedTools: ${REVIEWER_DENIED_TOOLS.claude}`];
  if (kind === "pi") return [`excludeTools: ${REVIEWER_DENIED_TOOLS.pi}`];
  return [];
}
