/**
 * The command context.
 *
 * Commands are the use-case layer: they own the transaction boundary, the
 * domain checks and the audit row — in that order, always. Everything they need
 * (connection, repositories, clock, id source) arrives here, so a command is
 * trivially testable with a frozen clock and a temp database.
 */

import { SYSTEM_KIND } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { newId } from "../../foundation/ids.mjs";
import { DEFAULT_SLA_CONFIG } from "../../foundation/sla-config.mjs";
import { isActorKind } from "../domain/enums.mjs";
import { toIsoMillis } from "../domain/task.mjs";

/**
 * @param {{db: import('node:sqlite').DatabaseSync, repos: object, clock?: () => Date|string, idFactory?: () => string, logger?: Function, slaConfig?: () => object}} input
 */
export function createContext(input) {
  const { db, repos, clock, idFactory = newId, logger } = input;
  if (db === undefined || repos === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "createContext needs a database and a repository bag",
      details: { hasDb: db !== undefined, hasRepos: repos !== undefined },
    });
  }
  // The SLA policy resolver — re-read per call, so a hand edit to `.env` must
  // apply without a restart. A context built without one (tests, embedding
  // callers) runs the defaults.
  const slaConfig =
    typeof input.slaConfig === "function" ? input.slaConfig : () => DEFAULT_SLA_CONFIG;
  return {
    db,
    repos,
    logger,
    /** The effective SLA table in force for the next SLA read. */
    slaConfig,
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
  // whatever an actor kind calls itself — the schema has no CHECK on it and neither
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
 * Both halves are the board's own kind: what the reader needs to know is that
 * no person and no agent wrote this, and `system` says so without naming a
 * process the user has never heard of.
 */
export const BOARD_ACTOR = Object.freeze({ kind: SYSTEM_KIND, id: SYSTEM_KIND });
