/**
 * Dictionary use-cases (§4.4).
 *
 * The surface is deliberately asymmetric: resolution happens *inside* another
 * write (create/update task), and the only thing a caller can ask for directly
 * is a read. There is no add/remove/rename command, so there is nowhere for a
 * management UI to hook into — which is the requirement.
 *
 * `resolveOrCreate` does not write its own audit row: the command that needed
 * the entry records `dictionary_upsert` inside its own `changes_json`, so a
 * task creation stays one transaction with one activity.
 *
 * Since `0019` there is one `actors` table and `assignee`/`reporter` are roles
 * (the `tasks` column a task fills). Resolution is **role-agnostic**: one person
 * is one row, so both callers resolve against the whole dictionary.
 */

import { DomainError } from "../../shared/errors.mjs";
import { resolveDictionaryEntry } from "../domain/dictionary.mjs";
import { DICT_KINDS } from "../domain/enums.mjs";

/** `assignee` → the `tasks` column it fills. */
const TASK_FIELD = { assignee: "assigneeId", reporter: "reporterId" };

/** @param {unknown} kind */
export function dictionaryKind(kind) {
  if (kind !== "assignee" && kind !== "reporter") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `dictionary kind must be assignee or reporter (got ${JSON.stringify(kind)})`,
      details: { field: "kind", received: kind, allowed: ["assignee", "reporter"] },
    });
  }
  return kind;
}

/**
 * Resolve a free-text name to a dictionary row, creating it if it is new.
 * Runs in the caller's transaction.
 *
 * The first argument is a **scope**, not the full command context: it needs only
 * the repository bag and a timestamp. The markdown importer has exactly those
 * (`repos` + a card's `now`) and no `ctx`, so it can drive this same decision
 * rather than bypassing it with a direct `upsert` — which is what made the live
 * path and the import path disagree (Phase 5's whole point).
 *
 * @param {{repos: object, now: string}} scope
 * @param {{kind: "assignee"|"reporter", name: string, actorKind?: "agent"|"human", forceCreate?: boolean}} input
 * @returns {{entry: object, action: "created"|"reused", kind: string, field: string}}
 */
export function resolveOrCreate(scope, input) {
  const { repos, now } = scope;
  const kind = dictionaryKind(input.kind);
  const actorKind = input.actorKind ?? "agent";
  if (!DICT_KINDS.includes(actorKind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `actorKind must be one of ${DICT_KINDS.join(", ")}`,
      details: { field: "actorKind", received: input.actorKind, allowed: DICT_KINDS },
    });
  }

  const existing = repos.dictionary.list();
  const verdict = resolveDictionaryEntry(
    existing.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      displayName: entry.displayName,
      normalizedName: entry.normalizedName,
    })),
    input.name,
    { kind: actorKind, forceCreate: input.forceCreate === true },
  );

  const { action, entry } = repos.dictionary.upsert({
    kind,
    actorKind,
    normalizedName: verdict.normalizedName,
    displayName: verdict.displayName,
    now,
  });

  return { entry, action, kind, field: TASK_FIELD[kind] };
}

/**
 * Resolve and assign in one step, for a command that changes an assignee or a
 * reporter.
 *
 * The patch names one column (`assigneeId` / `reporterId`). It no longer carries a
 * denormalised `assigneeKind`: the actor's kind lives on the `actors` row and the
 * wire reads it from there (`wire.mjs#actorRef`).
 *
 * @param {{repos: object, now: string}} scope
 * @returns {{patch: object, audit: object[]}}
 */
export function resolveAssignment(scope, input) {
  const resolved = resolveOrCreate(scope, input);
  const patch = { [resolved.field]: resolved.entry.id };
  return {
    patch,
    audit: [
      {
        dictionary: resolved.kind,
        id: resolved.entry.id,
        displayName: resolved.entry.displayName,
        action: resolved.action,
      },
    ],
  };
}

/**
 * Read the whole dictionary. This is the *only* public entry point (§4.4: no
 * 管理入口). One read for one table — the two role reads merged with the tables.
 *
 * @param {object} ctx
 * @param {{q?: string, limit?: number}} [input]
 */
export function listActors(ctx, input = {}) {
  return ctx.repos.dictionary.search("actor", { q: input.q, limit: input.limit });
}
