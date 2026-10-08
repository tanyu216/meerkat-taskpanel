/**
 * The command context.
 *
 * Commands are the use-case layer: they own the transaction boundary, the
 * domain checks and the audit row — in that order, always. Everything they need
 * (connection, repositories, clock, id source) arrives here, so a command is
 * trivially testable with a frozen clock and a temp database.
 */

import { DomainError } from "../../shared/errors.mjs";
import { newId } from "../../shared/ids.mjs";
import { toIsoMillis } from "../domain/task.mjs";

/**
 * @param {{db: import('node:sqlite').DatabaseSync, repos: object, clock?: () => Date|string, idFactory?: () => string, logger?: Function}} input
 */
export function createContext(input) {
  const { db, repos, clock, idFactory = newId, logger } = input;
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
  const { defaultKind = "agent" } = options;
  if (actor === null || actor === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "an actor is required for every write (who did this must be recorded)",
      details: { field: "actor" },
    });
  }
  if (typeof actor === "string") {
    return { kind: defaultKind, id: actor };
  }
  if (typeof actor.id !== "string" || actor.id.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "actor.id is required",
      details: { field: "actor.id", received: actor.id },
    });
  }
  const kind = actor.kind ?? defaultKind;
  if (!["agent", "human", "system"].includes(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `actor.kind must be agent, human or system (got ${JSON.stringify(kind)})`,
      details: { field: "actor.kind", received: kind, allowed: ["agent", "human", "system"] },
    });
  }
  return { kind, id: actor.id };
}

/** The actor for automated housekeeping (the board itself). */
export const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "taskd" });
