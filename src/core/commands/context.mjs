/**
 * The command context.
 *
 * Commands are the use-case layer: they own the transaction boundary, the
 * domain checks and the audit row — in that order, always. Everything they need
 * (connection, repositories, clock, id source) arrives here, so a command is
 * trivially testable with a frozen clock and a temp database.
 */

import { TASKD_KIND } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { newId } from "../../foundation/ids.mjs";
import { isActorKind } from "../domain/enums.mjs";
import { DEFAULT_ACCEPTANCE_POLICY } from "../domain/status.mjs";
import { toIsoMillis } from "../domain/task.mjs";

/**
 * @param {{db: import('node:sqlite').DatabaseSync, repos: object, clock?: () => Date|string, idFactory?: () => string, logger?: Function, acceptancePolicy?: () => string}} input
 */
export function createContext(input) {
  const { db, repos, clock, idFactory = newId, logger } = input;
  // The board's acceptance policy (`human-only` | `both` | `agent-only`). A
  // resolver rather than a value: the policy file may change while the board
  // runs, and a decision must read the policy in force *now*. A context built
  // without one (tests, embedding callers) runs the historical `both` rule.
  const acceptancePolicy =
    typeof input.acceptancePolicy === "function"
      ? input.acceptancePolicy
      : () => input.acceptancePolicy ?? DEFAULT_ACCEPTANCE_POLICY;
  if (db === undefined || repos === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "createContext needs a database and a repository bag",
      details: { hasDb: db !== undefined, hasRepos: repos !== undefined },
    });
  }
  return {
    db,
    repos,
    logger,
    /** The acceptance policy in force for the next acceptance decision. */
    acceptancePolicy,
    /** The one clock in the process. Always an ISO-8601 UTC millisecond string. */
    now() {
      return clock === undefined ? new Date().toISOString() : toIsoMillis(clock(), "clock");
    },
    newId: () => idFactory(),
  };
}

/**
 * Normalise an actor descriptor.
 *
 * @param {{kind?: string, id?: string}|null|undefined} actor
 * @param {{defaultKind?: string}} [options]
 * @returns {{kind: string, id: string}}
 */
export function actorOf(actor, options = {}) {
  const { defaultKind } = options;
  if (actor === null || actor === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "an actor is required for every write (who did this must be recorded)",
      details: { field: "actor" },
    });
  }
  if (typeof actor === "string") {
    if (defaultKind === undefined) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "a bare-string actor needs an explicit defaultKind (a platform name)",
        details: { field: "actor.kind", received: null },
      });
    }
    return { kind: defaultKind, id: actor };
  }
  if (typeof actor.id !== "string" || actor.id.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "actor.id is required",
      details: { field: "actor.id", received: actor.id },
    });
  }
  const kind = actor.kind;
  if (kind === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "actor.kind is required (human, or the platform the writer runs on)",
      details: { field: "actor.kind", received: null },
    });
  }
  // Open on purpose. A kind is `human`, or the platform an agent runs on, or
  // whatever a host calls itself — the schema has no CHECK on it and neither
  // does this. What is refused is a *blank* one, because that reads as neither.
  if (!isActorKind(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `actor.kind must be a non-empty string (got ${JSON.stringify(kind)})`,
      details: { field: "actor.kind", received: kind },
    });
  }
  return { kind, id: actor.id };
}

/**
 * The actor for automated housekeeping (the board itself).
 *
 * Both halves are the board's concrete platform name. A vague role word would
 * not name a writer; `taskd` does.
 */
export const BOARD_ACTOR = Object.freeze({ kind: TASKD_KIND, id: TASKD_KIND });
