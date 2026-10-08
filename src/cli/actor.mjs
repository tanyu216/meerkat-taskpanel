/**
 * Who is running the command.
 *
 * Every write records an actor, and the CLI is the only place that knows how a
 * caller identified itself. The rule (§3.1):
 *
 *   kind = --agent-platform | --session-id  →  "agent", otherwise "human"
 *   id   = --agent ?? --session-id ?? --agent-platform ?? $TASKCTL_AGENT ?? $USER ?? "local"
 *
 * `--agent <name>` names the actor without claiming to be an agent platform, so
 * a human running `taskctl --agent Terry issue move …` is recorded as a human.
 */

/** Env fallbacks, in the order the id resolution uses them. */
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

  const id =
    flags.agent ??
    session ??
    platform ??
    env[ACTOR_ENV_KEYS.agent] ??
    env.USER ??
    env.LOGNAME ??
    "local";

  const kind = flags.agentPlatform !== undefined || flags.sessionId !== undefined ? "agent" : "human";

  return { actor: { kind, id: String(id) }, platform, session, kind, id: String(id) };
}
