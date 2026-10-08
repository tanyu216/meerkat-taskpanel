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
 * @param {object} ctx
 * @param {{kind: "assignee"|"reporter", name: string, actorKind?: "agent"|"human", forceCreate?: boolean, platform?: string|null}} input
 * @returns {{entry: object, action: "created"|"reused", kind: string, field: string}}
 */
export function resolveOrCreate(ctx, input) {
  const kind = dictionaryKind(input.kind);
  const actorKind = input.actorKind ?? "agent";
  if (!DICT_KINDS.includes(actorKind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `actorKind must be one of ${DICT_KINDS.join(", ")}`,
      details: { field: "actorKind", received: input.actorKind, allowed: DICT_KINDS },
    });
  }

  const existing = ctx.repos.dictionary.list(kind);
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

  const { action, entry } = ctx.repos.dictionary.upsert({
    kind,
    actorKind,
    normalizedName: verdict.normalizedName,
    displayName: verdict.displayName,
    platform: input.platform ?? null,
    now: ctx.now(),
  });

  return { entry, action, kind, field: TASK_FIELD[kind] };
}

/**
 * Resolve and assign in one step, for a command that changes an assignee.
 *
 * @returns {{patch: object, audit: object[]}}
 */
export function resolveAssignment(ctx, input) {
  const resolved = resolveOrCreate(ctx, input);
  const patch = {
    [resolved.field]: resolved.entry.id,
    ...(resolved.kind === "assignee" ? { assigneeKind: resolved.entry.kind } : {}),
  };
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
 * Read the dictionary. This is the *only* public entry point (§4.4: no管理入口).
 * @param {object} ctx
 * @param {{kind: "assignee"|"reporter", q?: string, limit?: number}} input
 */
export function listEntries(ctx, input) {
  const kind = dictionaryKind(input.kind);
  return ctx.repos.dictionary.search(kind, { q: input.q, limit: input.limit });
}

/** @param {object} ctx @param {{q?: string, limit?: number}} [input] */
export function listAssignees(ctx, input = {}) {
  return listEntries(ctx, { ...input, kind: "assignee" });
}

/** @param {object} ctx @param {{q?: string, limit?: number}} [input] */
export function listReporters(ctx, input = {}) {
  return listEntries(ctx, { ...input, kind: "reporter" });
}
