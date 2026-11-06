/**
 * The lane → tools table: one source for every surface that gives an agent a
 * tool allowlist.
 *
 * The session adapters (`orchestrator/actor-kinds/*`) pass these strings to the
 * CLI, and the installer writes the native agent frontmatter/Toml; before this
 * file each had its own copy, so a lane's surface depended on which door the
 * session came through. The kind names match the adapters' actor kinds.
 *
 * Node builtins only; this file must not import from `src/orchestrator`.
 */

/** The lanes a role may be installed for; `role.json` carries the same names. */
export const TOOL_LANES = Object.freeze(["director", "reviewer", "worker"]);

/**
 * One entry per lane and actor kind.
 *
 * The reviewer may spawn one fresh-context review subagent (ADR 0019) when its
 * session shares the delivery's context; every other lane owns its whole card
 * and carries no subagent tool. The reviewer runs the project's gate itself
 * (hence the command entries) and never edits; the worker edits its own tree;
 * the director only reads and drives the board. The Claude strings use the CLI's
 * scoped `Bash(...)` form.
 */
export const LANE_TOOLS = Object.freeze({
  director: Object.freeze({
    claude: "Read,Grep,Glob,Bash(taskctl *),Bash(node *)",
    pi: "read,bash",
  }),
  reviewer: Object.freeze({
    claude:
      "Read,Grep,Glob,Agent,Bash(taskctl *),Bash(git *),Bash(npm run *),Bash(node *),Bash(bash *)",
    pi: "read,bash",
  }),
  worker: Object.freeze({
    claude: "Read,Edit,Write,Grep,Glob,Bash(taskctl *),Bash(node *),Bash(git *)",
    pi: "read,bash,edit,write",
  }),
});

/**
 * The Claude tool surface for a lane; an unknown lane behaves as a worker,
 * which is the adapter's long-standing fallback.
 *
 * @param {string} [lane]
 * @returns {string}
 */
export function claudeAllowedTools(lane) {
  return LANE_TOOLS[lane]?.claude ?? LANE_TOOLS.worker.claude;
}

/**
 * The Pi tool surface for a lane; an unknown lane behaves as a worker.
 *
 * @param {string} [lane]
 * @returns {string}
 */
export function piAllowedTools(lane) {
  return LANE_TOOLS[lane]?.pi ?? LANE_TOOLS.worker.pi;
}

/**
 * The tool string for a native agent definition of one kind, or `null` when the
 * table carries no surface for that lane/kind pair (the caller must not invent
 * one).
 *
 * @param {string} lane
 * @param {string} kind
 * @returns {string|null}
 */
export function nativeAgentTools(lane, kind) {
  return LANE_TOOLS[lane]?.[kind] ?? null;
}
