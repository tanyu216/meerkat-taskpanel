/**
 * Who is running the command.
 *
 * Every write records an actor — a **kind** and an **id** — and this is the only
 * place that knows how a caller identified itself.
 *
 *   kind = --actor-kind (or `$TASKCTL_ACTOR_KIND`), else `human` when `--as-human`
 *   id   = --agent ?? `$TASKCTL_AGENT` ?? (`human` kind ⇒ `$TASKCTL_HUMAN`) ?? `$USER` ?? LOGNAME ?? "local"
 *
 * The CLI *requires* a kind before calling this (`--help` / `--version` are the
 * only exemptions), so the `human` default above is a library-level fallback for
 * direct callers — never how a `taskctl` command gets its kind.
 *
 * **There is no separate "platform" axis.** A writer's platform and its kind are
 * one fact; splitting them produced a `platform` field nothing read and a
 * `--agent-platform` flag no installed artifact ever passed. The kind carries
 * `claude`, `codex`, `pi` — or `human`.
 *
 * **`human` is reserved.** It is the one kind the rest of the board reasons
 * about, so a caller may not *declare* it: `--actor-kind human` is refused. That
 * is what stops an agent stamping its own work as a person's — which would put it
 * on the record as a decision (I5) and let it resume an `awaiting` card.
 *
 * **Writing as the human is explicit.** `--as-human` takes the id from
 * `$TASKCTL_HUMAN` and forces `kind = human` whatever else is on the line. That
 * is how an agent records something the user said, in the user's voice, while
 * every one of its own writes stays its own — and it has to be explicit, because
 * the alternative (a precedence rule between two env vars) cannot tell a
 * transcript from a claim.
 *
 * **A session with no kind is a usage error.** A session id is emitted by an agent kind,
 * so a write carrying one is an agent's write; with no kind there is nothing left
 * to record but `human`, which would be a lie with consequences. Agent kinds pass both
 * (`--actor-kind claude --session-id …`).
 *
 * The id must be stable and name-like: two agents sharing one agent kind must not
 * collapse onto the same `$USER`, and a `--session-id` must not shadow the
 * `$TASKCTL_AGENT` the agent kind named.
 *
 * Pure. It lives in `src/foundation` (extracted from `src/cli`) so the derivation
 * sits below the CLI surface rather than inside it.
 */

import { HUMAN_KIND } from "../constants.mjs";
import { DomainError } from "../errors.mjs";

/**
 * Env fallbacks. `kind` says who is writing; `agent` and `human` name the two
 * identities an agent kind may configure; `session` is attribution.
 */
export const ACTOR_ENV_KEYS = Object.freeze({
  agent: "TASKCTL_AGENT",
  kind: "TASKCTL_ACTOR_KIND",
  human: "TASKCTL_HUMAN",
  session: "TASKCTL_SESSION_ID",
});

/**
 * @param {{flags?: object, env?: NodeJS.ProcessEnv}} [input]
 * @returns {{actor: {kind: string, id: string}, session: string|null, kind: string, id: string}}
 * @throws {DomainError} VALIDATION_FAILED on a declared `human`, or a session with no kind
 */
export function resolveActor(input = {}) {
  const flags = input.flags ?? {};
  const env = input.env ?? process.env;

  const session = flags.sessionId ?? env[ACTOR_ENV_KEYS.session] ?? null;
  const declared = flags.actorKind ?? env[ACTOR_ENV_KEYS.kind] ?? null;

  if (declared === HUMAN_KIND) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `--actor-kind ${HUMAN_KIND} is reserved — a caller may not claim to be the human`,
      details: { field: "actorKind", received: declared, reserved: HUMAN_KIND },
      hint: {
        fix: `--as-human writes as the configured human (${ACTOR_ENV_KEYS.human}); --actor-kind takes a platform`,
      },
    });
  }

  // Flags only, deliberately: an ambient `$TASKCTL_SESSION_ID` in a shell must not
  // turn an unrelated command into a usage error.
  if (flags.sessionId !== undefined && declared === null && flags.asHuman !== true) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a session id without a kind cannot be attributed — the board has no word for an agent of unknown platform",
      details: { field: "sessionId", received: flags.sessionId, missing: "actorKind" },
      hint: { fix: "pass --actor-kind <platform> alongside --session-id" },
    });
  }

  const asHuman = flags.asHuman === true;
  const kind = asHuman ? HUMAN_KIND : (declared ?? HUMAN_KIND);
  // `TASKCTL_HUMAN` names the person, not a role. An agent that forgets
  // `--agent` must not inherit it as its own id — two roles sharing one agent kind
  // would both be recorded as the human. Only a human write takes that name;
  // an agent falls through to its configured agent name or the OS user.
  const id = kind === HUMAN_KIND
    ? (env[ACTOR_ENV_KEYS.human] ?? flags.agent ?? env[ACTOR_ENV_KEYS.agent] ?? env.USER ?? env.LOGNAME ?? "local")
    : (flags.agent ?? env[ACTOR_ENV_KEYS.agent] ?? env.USER ?? env.LOGNAME ?? "local");

  return { actor: { kind, id: String(id) }, session, kind, id: String(id) };
}
