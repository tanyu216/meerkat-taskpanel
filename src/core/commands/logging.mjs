/**
 * One wrapper over the command table.
 *
 * The use-case layer is where "a write was asked for and either happened or was
 * refused" becomes a fact, and every command passes through `createCommands`.
 * Wrapping the table there gives full coverage without editing ~45 command
 * modules, and it keeps severity in one place:
 *
 *   - **success** is `debug` — the board's own activity rows are the durable
 *     record of what changed, so a successful write is diagnostic detail, not
 *     news. It is emitted only when the logger says debug is enabled, which also
 *     keeps an injected test logger from collecting noise;
 *   - **a refusal** (a 4xx `DomainError`) is `warn` — the caller asked for
 *     something the board would not do. That is not an exception;
 *   - **a fault** (a 5xx `DomainError`, or anything that is not a `DomainError`)
 *     is `error` — this is the boundary the user asked error logs for.
 *
 * The wrapper never changes the command's result: the original value or the
 * original error is what the caller sees, even if the logger itself throws.
 */

import { isDomainError } from "../../foundation/errors.mjs";
import { currentLogContext } from "../../foundation/log.mjs";

/** Emit without ever letting the log change control flow. */
function emit(logger, record) {
  try {
    logger(record);
  } catch {
    /* a broken logger must not fail the command it was describing */
  }
}

/** Who is acting, from the ambient request context, when there is one. */
function contextActor() {
  const actor = currentLogContext()?.actor;
  if (actor === null || typeof actor !== "object" || typeof actor.kind !== "string") return null;
  return `${actor.kind}:${actor.id}`;
}

/** The severity, code and status of a thrown value. */
function describeFailure(error) {
  if (isDomainError(error)) {
    const http = Number.isFinite(error.http) ? error.http : 500;
    return { level: http >= 500 ? "error" : "warn", code: error.code, http };
  }
  return { level: "error", code: null, http: null };
}

/**
 * @param {Record<string, Function>} commands
 * @param {Function|undefined} logger a plain `(record) => void`; `createLogger`
 *   also answers `isLevelEnabled`
 * @returns {Record<string, Function>} a new table, or `commands` unchanged
 */
export function withCommandLogging(commands, logger) {
  if (typeof logger !== "function") return commands;

  const debug = typeof logger.isLevelEnabled === "function" && logger.isLevelEnabled("debug");
  const wrapped = {};

  for (const [name, command] of Object.entries(commands)) {
    if (typeof command !== "function") {
      wrapped[name] = command;
      continue;
    }
    wrapped[name] = (...args) => {
      const started = Date.now();
      try {
        const result = command(...args);
        if (debug) {
          emit(logger, { event: "command", command: name, duration_ms: Date.now() - started });
        }
        return result;
      } catch (error) {
        const failure = describeFailure(error);
        emit(logger, {
          event: "command_failed",
          level: failure.level,
          command: name,
          code: failure.code,
          http: failure.http,
          duration_ms: Date.now() - started,
          actor: contextActor(),
        });
        throw error;
      }
    };
  }

  return wrapped;
}
