/**
 * Who the MCP process is (plan G3).
 *
 * The answer is "an agent", always. A host that speaks MCP over stdio *is* an
 * agent — there is no terminal and no human typing — so unlike `src/cli/actor.mjs`
 * there is no `--agent-platform` flag to flip the kind, and the `kind` is a
 * constant rather than a derivation. Saying `human` here would be a lie the audit
 * trail would carry forever.
 *
 * The id is the interesting half, and it is resolved widest-name-first:
 *
 *   $TASKCTL_AGENT      what the host says this agent is called
 *   $TASKCTL_SESSION_ID the conversation it belongs to
 *   clientInfo.name     the name the client sent during `initialize`
 *   "mcp"               no name at all — better a stable placeholder than a throw
 *
 * `clientInfo` is the fallback rather than the first choice on purpose: an env
 * var is set deliberately by whoever configured the host, while `clientInfo.name`
 * is often the *product* (`"Claude Code"`), which is a poor actor.
 *
 * Pure: no I/O beyond reading the `env` it is handed.
 */

/** Actor kind — constant. See above. */
export const MCP_ACTOR_KIND = "agent";

/** The id used when nothing names this agent. */
export const MCP_DEFAULT_ACTOR_ID = "mcp";

/**
 * The actor, session and segment every request from this process carries.
 *
 * `session`/`seg` ride along as `X-Taskctl-Session` / `X-Taskctl-Seg` headers,
 * the same two headers the CLI sends, so a session started by a host is
 * indistinguishable from one started by `taskctl session set`.
 *
 * @param {{env?: NodeJS.ProcessEnv, clientInfo?: {name?: string}|null}} [input]
 * @returns {{actor: {kind: string, id: string}, session: string|null, seg: string|null}}
 */
export function mcpIdentity(input = {}) {
  const env = input.env ?? process.env;
  const clientInfo = input.clientInfo ?? null;

  const id = env.TASKCTL_AGENT ?? env.TASKCTL_SESSION_ID ?? clientInfo?.name ?? MCP_DEFAULT_ACTOR_ID;

  return {
    actor: { kind: MCP_ACTOR_KIND, id: String(id) },
    session: env.TASKCTL_SESSION_ID ?? null,
    seg: env.TASKCTL_SEG ?? null,
  };
}
