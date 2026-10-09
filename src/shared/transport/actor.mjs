/**
 * Who is running the command.
 *
 * Every write records an actor, and the CLI is the only place that knows how a
 * caller identified itself. The rule (§3.1): **identity and attribution are
 * separate.** `--agent-platform` / `--session-id` (and their
 * `$TASKCTL_AGENT_PLATFORM` / `$TASKCTL_SESSION_ID` fallbacks) say *which
 * conversation* a write came from — they are attribution, not a name, so they
 * never become the id:
 *
 *   kind = --agent-platform | --session-id  →  "agent", otherwise "human"
 *   id   = --agent ?? $TASKCTL_AGENT ?? $USER ?? LOGNAME ?? "local"
 *
 * The id must be stable and name-like: two agents sharing one host must not
 * collapse onto the same `$USER`, and a `--session-id` must not shadow the
 * `$TASKCTL_AGENT` the host named (the old chain's bug — the session or platform
 * string became the id and never matched an assignee name).
 *
 * `--agent <name>` names the actor without claiming to be an agent platform, so
 * a human running `taskctl --agent Terry issue move …` is recorded as a human.
 * `$USER`/`LOGNAME` are reached only when nothing names an agent; they are the
 * human fallback and are never used to pass an agent's identity check.
 *
 * Pure. It lives in `src/shared` (extracted from `src/cli`) so the MCP surface
 * reaches the same derivation without importing `src/cli`.
 */

/**
 * Env fallbacks. Only `agent` feeds the identity; `platform`/`session` are
 * attribution and are read into the returned `platform`/`session` fields only.
 */
export const ACTOR_ENV_KEYS = Object.freeze({
  agent: "TASKCTL_AGENT",
  platform: "TASKCTL_AGENT_PLATFORM",
  session: "TASKCTL_SESSION_ID",
});

/**
 * @param {{flags?: object, env?: NodeJS.ProcessEnv}} [input]
 * @returns {{actor: {kind: string, id: string}, platform: string|null, session: string|null, kind: string, id: string}}
 */
export function resolveActor(input = {}) {
  const flags = input.flags ?? {};
  const env = input.env ?? process.env;

  const platform = flags.agentPlatform ?? env[ACTOR_ENV_KEYS.platform] ?? null;
  const session = flags.sessionId ?? env[ACTOR_ENV_KEYS.session] ?? null;

  // Identity only: an agent name (flag, then env) beats the ambient OS user, and
  // the attribution above is deliberately absent from this chain.
  const id =
    flags.agent ??
    env[ACTOR_ENV_KEYS.agent] ??
    env.USER ??
    env.LOGNAME ??
    "local";

  const kind = flags.agentPlatform !== undefined || flags.sessionId !== undefined ? "agent" : "human";

  return { actor: { kind, id: String(id) }, platform, session, kind, id: String(id) };
}
