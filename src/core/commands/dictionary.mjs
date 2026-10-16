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
import { isActorKind } from "../domain/enums.mjs";

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
 * @param {{kind: "assignee"|"reporter", name: string, actorKind?: string, forceCreate?: boolean}} input
 * @returns {{entry: object, action: "created"|"reused", kind: string, field: string, kindField: string, actorKind: string}}
 */
export function resolveOrCreate(scope, input) {
  const { repos, now } = scope;
  const kind = dictionaryKind(input.kind);
  // **The actor kind is handed back, not stored.** Since `0023` the registry row
  // holds no kind — a kind describes the act — so this resolves the *name* and
  // returns the kind the caller should record on its own reference
  // (`tasks.assignee_kind` / `reporter_kind`). Open, like every other kind on this
  // board: `human`, or the platform the caller is running on. A caller that states
  // nothing gets `agent` — a category, not a platform, and the honest answer when
  // the write did not say what it was.
  const actorKind = input.actorKind ?? "agent";
  if (!isActorKind(actorKind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "actorKind must be a non-empty string",
      details: { field: "actorKind", received: input.actorKind },
    });
  }

  const existing = repos.dictionary.list();
  const verdict = resolveDictionaryEntry(
    existing.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      normalizedName: entry.normalizedName,
    })),
    input.name,
    { forceCreate: input.forceCreate === true },
  );

  const { action, entry } = repos.dictionary.upsert({
    kind,
    normalizedName: storedKey(verdict),
    displayName: verdict.displayName,
    now,
  });

  return { entry, action, kind, field: TASK_FIELD[kind], kindField: TASK_KIND_FIELD[kind], actorKind };
}

/**
 * The `normalized_name` to key an upsert on.
 *
 * On a **reuse** the matched row's own key wins, not `norm(raw)`. The two agree
 * whenever `normalized_name === norm(display_name)`, which every row the live
 * dictionary writes satisfies — but a row a migration back-filled may not (a
 * SQL-only migration cannot reproduce `norm`; see `0020_attribution_fk.sql`). The
 * fuzzy branch of `resolveDictionaryEntry` already carries the entry's key for
 * exactly this reason; taking it for the exact branch too keeps a reuse from
 * missing the row it just matched and inserting a twin.
 *
 * @param {{action: string, entry?: object, normalizedName: string}} verdict
 */
function storedKey(verdict) {
  return verdict.entry?.normalizedName ?? verdict.normalizedName;
}

/**
 * Resolve a free-text name to an **actor row id**, for the attribution columns —
 * `tasks.claimed_by`, `comments.author_id`, `task_reports.author_id` — that name a
 * person without naming a task role.
 *
 * It is `resolveOrCreate`'s role-less sibling, driving the **same** one identity
 * decision (`resolveDictionaryEntry` + the one upsert); the only difference is
 * that it needs no `assignee`/`reporter` role, because the caller writes the id
 * into a column it already owns.
 *
 * `forceCreate` defaults to **true**: an attribution is an *identity*, not a
 * search, so a claimant or an author must not be fuzzy-matched onto somebody
 * else. An exact spelling reuses the person the board already knows; anything
 * else creates a row (the dictionary "grows by use" — §4.4).
 *
 * It records **no kind**: since `0023` the registry row holds none, and the
 * caller already owns the column that does (`comments.author_kind`, and so on).
 *
 * A **reuse is read-only**: unlike `resolveOrCreate` it does not touch
 * `last_seen_at`/`use_count`. The attribution columns ride on hot paths (every
 * claim, heartbeat, comment and report), and an `UPDATE actors` there would bump
 * the global revision on every write — a heartbeat would move the cursor, which
 * only the *task* row is supposed to do. Attribution is also not a "use" of the
 * dictionary in the sense `use_count` counts (that is a task naming a person):
 * the person wrote; the board did not name them.
 *
 * @param {{repos: object, now: string}} scope
 * @param {{name: string, forceCreate?: boolean}} input
 * @returns {string} the actor row's id
 */
export function resolveActorId(scope, input) {
  const { repos, now } = scope;
  const existing = repos.dictionary.list();
  const verdict = resolveDictionaryEntry(
    existing.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      normalizedName: entry.normalizedName,
    })),
    input.name,
    { forceCreate: input.forceCreate !== false },
  );
  if (verdict.action === "reuse") return verdict.entry.id;
  const { entry } = repos.dictionary.upsert({
    kind: "actor",
    normalizedName: storedKey(verdict),
    displayName: verdict.displayName,
    now,
  });
  return entry.id;
}

/**
 * Resolve and assign in one step, for a command that changes an assignee or a
 * reporter.
 *
 * The patch names **two** columns, and that is the point: the reference
 * (`assigneeId` / `reporterId`) and the kind it was made under
 * (`assigneeKind` / `reporterKind`). `0023` moved the kind here from the actor
 * row, where one row per person could not hold a fact about an act — so the two
 * are written together, by the one call that knows both.
 *
 * @param {{repos: object, now: string}} scope
 * @returns {{patch: object, audit: object[]}}
 */
export function resolveAssignment(scope, input) {
  const resolved = resolveOrCreate(scope, input);
  const patch = { [resolved.field]: resolved.entry.id, [resolved.kindField]: resolved.actorKind };
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
