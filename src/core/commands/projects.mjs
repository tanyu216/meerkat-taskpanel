/**
 * Project use-cases. Small on purpose: a project is a name, a label set and
 * free-form meta — the board does no directory management, so there is no path
 * rule left to enforce here.
 *
 * The identity rule that lives here is the **identifier prefix** (C-PREFIX-1).
 * A project numbers its cards with a prefix, and that prefix has two possible
 * sources, in this order:
 *
 *   1. the project's own, declared at creation as `meta.prefix` and normalized
 *      once, here, on the way in (the UI's only prefix input);
 *   2. otherwise the project's **id**, normalized (`identifierPrefix`) — the
 *      legacy path, which is every row that predates the slot and every project
 *      the CLI creates from `--id`.
 *
 * The read side of that order is `projectPrefix` (shared/ids.mjs), used by both
 * the identifier allocator and the collision check below, so the two can never
 * disagree about what a project's prefix is.
 *
 * Two projects whose prefix resolves to the same token are indistinguishable on
 * the board — both would hand out `OPENCLAW-TEAM-0007` — so creation refuses a
 * prefix another project already owns. A declared prefix that normalizes to
 * *nothing* is refused too: it would leave a project that can never mint a card.
 */

import { DomainError } from "../../shared/errors.mjs";
import { PROJECT_PREFIX_META_KEY, identifierPrefix, projectPrefix } from "../../shared/ids.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/** The request field a declared prefix arrives as — named in every refusal. */
const PROJECT_PREFIX_FIELD = `meta.${PROJECT_PREFIX_META_KEY}`;

/**
 * Refuse a project whose **effective prefix** an existing project already uses.
 * Runs inside the caller's create transaction, so the read and the insert
 * cannot be split by another writer (`BEGIN IMMEDIATE`), and a refusal leaves no
 * row behind.
 *
 * Both sides of the comparison are effective prefixes (M5): the candidate's and
 * each existing project's, so a project created with an explicit `meta.prefix`
 * of `demo` collides with one whose id is `demo` — the two differ only in
 * *where* the prefix came from, and the board cannot tell their cards apart.
 *
 * The comparison is against **every** project, archived included: archiving does
 * not retire a prefix, because the identifiers it handed out are still on cards.
 * A row whose id is *exactly* the requested id is not a collision — that is the
 * same project, and `repos.projects.create` already answers it with
 * `ID_CONFLICT` (409), not with a prefix refusal (400).
 *
 * An **undeclared** prefix that normalizes to nothing (`--id ###`) is left to
 * the pre-existing guard in `identifierForPrefix`, which refuses to allocate an
 * identifier for it; this check is about collisions, not emptiness, so it steps
 * aside when the prefix is "". A **declared** one never reaches this function
 * empty — `normalizeDeclaredPrefix` refuses it first (M4).
 *
 * @param {object} repos
 * @param {{id?: string, prefix: string, field: string}} candidate the effective
 *   prefix to claim, and the request field it came from (for the refusal)
 */
function assertPrefixAvailable(repos, candidate) {
  const { id, prefix, field } = candidate;
  if (prefix === "") return;
  const conflict = repos.projects
    .list({ includeArchived: true })
    .filter((project) => project.id !== id && projectPrefix(project) === prefix)
    // Several projects can already share a prefix (history the board never
    // rejected). Name the same one every time so the refusal is deterministic.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (conflict === undefined) return;
  throw new DomainError("VALIDATION_FAILED", {
    message:
      field === PROJECT_PREFIX_FIELD
        ? `identifier prefix ${JSON.stringify(prefix)} is already used by project ` +
          `${JSON.stringify(conflict.id)}`
        : `project id ${JSON.stringify(id)} normalizes to identifier prefix ` +
          `${JSON.stringify(prefix)}, already used by project ${JSON.stringify(conflict.id)}`,
    details: { field, projectId: id, prefix, conflictProjectId: conflict.id },
  });
}

/**
 * The prefix a create **declares**, or `undefined` when it declares none.
 *
 * "Declared" is deliberately about the **key being present**, not about the
 * value being usable: `####` normalizes to nothing and must be refused (M4),
 * not quietly read as "no prefix declared" — the difference between those two
 * readings is precisely the zombie project that a stored-but-empty prefix
 * creates.
 *
 * @param {unknown} meta
 */
function declaredPrefix(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  return Object.prototype.hasOwnProperty.call(meta, PROJECT_PREFIX_META_KEY)
    ? meta[PROJECT_PREFIX_META_KEY]
    : undefined;
}

/**
 * Normalize a declared `meta.prefix` into what the project will store, or
 * refuse it (M4).
 *
 * Two shapes are refused, and they are the same defect one type apart: a value
 * that is not a string (there is no sensible normalization of `null` — `String`
 * would happily mint the prefix `NULL`), and a string that does not survive
 * normalization (`####`, `"   "`, `---`). Both would otherwise leave a project
 * that stores an unusable prefix and can therefore never mint a card.
 *
 * The refusal happens **before** the insert, so no row lands: this is checked on
 * the way in, not discovered on the first card.
 *
 * @param {unknown} value
 */
function normalizeDeclaredPrefix(value) {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `project prefix must be a string, got ${value === null ? "null" : typeof value}`,
      details: { field: PROJECT_PREFIX_FIELD, received: value },
    });
  }
  const prefix = identifierPrefix(value);
  if (prefix === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `project prefix ${JSON.stringify(value)} has no usable identifier prefix`,
      details: { field: PROJECT_PREFIX_FIELD, received: value },
    });
  }
  return prefix;
}

/**
 * The reserved key is not the client's to write (M6): a project's prefix is
 * fixed at creation, so an update neither replaces it nor introduces one. A
 * project that numbers its cards off its id keeps doing so however a
 * `--meta prefix=…` or a PATCH body asks; a project created with a prefix keeps
 * that prefix even if the update's meta merge carried a different one in.
 *
 * Dropping the key rather than refusing the update keeps `meta` what it is
 * everywhere else — a merge **delta**: the rest of the patch still lands.
 *
 * @param {unknown} meta
 */
function withoutPrefix(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const { [PROJECT_PREFIX_META_KEY]: _reserved, ...rest } = meta;
  return rest;
}

/**
 * @param {object} ctx
 * @param {{id?: string, name: string, labels?: string[], meta?: object, readme?: string, actor?: object}} input
 */
export function createProject(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  return transaction(
    ctx.db,
    () => {
      const declared = declaredPrefix(input.meta);
      // The prefix this project will number its cards with. A declared one is
      // normalized (and may be refused) here; otherwise an explicit id supplies
      // it; otherwise the project gets a freshly minted UUID, whose prefix is
      // unique by construction and therefore needs no check before the insert.
      const prefix = declared !== undefined
        ? normalizeDeclaredPrefix(declared)
        : input.id === undefined
          ? undefined
          : identifierPrefix(input.id);
      if (prefix !== undefined) {
        assertPrefixAvailable(ctx.repos, {
          id: input.id,
          prefix,
          field: declared === undefined ? "id" : PROJECT_PREFIX_FIELD,
        });
      }
      // Store the prefix **normalized**, once, at the boundary (M2) — it is
      // written back into the meta the caller sent, so what the row carries is
      // already the value the allocator will read. An undeclared prefix is not
      // written at all: an *absent* key is what keeps the id fallback reachable,
      // where a stored `""` would be a prefix that mints nothing.
      const meta = declared === undefined
        ? input.meta
        : { ...(input.meta ?? {}), [PROJECT_PREFIX_META_KEY]: prefix };
      const project = ctx.repos.projects.create({ ...input, meta, now: ctx.now() });
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "project_created",
        changes: { project: project.id },
        createdAt: ctx.now(),
      });
      return project;
    },
    { op: "projects.create" },
  );
}

/**
 * @param {object} ctx
 * @param {{id: string, patch: {name?: string, labels?: string[], meta?: object, readme?: string|null}, actor?: object}} input
 */
export function updateProject(ctx, input) {
  const patch = { ...input.patch };
  if (patch.meta !== undefined) {
    // The stored prefix survives whatever the patch carried (M6).
    // The slot is read from the row, not from the patch — including when the
    // HTTP layer already merged the current meta into the patch, which is what
    // makes "restore it" the same operation on both entries.
    const stored = declaredPrefix(ctx.repos.projects.get(input.id)?.meta);
    patch.meta = withoutPrefix(patch.meta);
    if (stored !== undefined) patch.meta = { ...patch.meta, [PROJECT_PREFIX_META_KEY]: stored };
  }
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  return transaction(
    ctx.db,
    () => {
      const project = ctx.repos.projects.update(input.id, { ...patch, now: ctx.now() });
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "project_updated",
        changes: { project: input.id, fields: Object.keys(patch) },
        createdAt: ctx.now(),
      });
      return project;
    },
    { op: "projects.update" },
  );
}

/** @param {object} ctx @param {{id: string}} input */
export function getProject(ctx, input) {
  return ctx.repos.projects.get(input.id);
}

/** @param {object} ctx @param {{includeArchived?: boolean}} [filter] */
export function listProjects(ctx, filter = {}) {
  return ctx.repos.projects.list(filter);
}

/** @param {object} ctx @param {{id: string, readme: string|null, actor?: object}} input */
export function readmeSet(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  return transaction(
    ctx.db,
    () => {
      const project = ctx.repos.projects.update(input.id, { readme: input.readme, now: ctx.now() });
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "project_updated",
        changes: { project: input.id, fields: ["readme"] },
        createdAt: ctx.now(),
      });
      return project;
    },
    { op: "projects.update" },
  );
}

/** @param {object} ctx @param {{id: string}} input */
export function readmeGet(ctx, input) {
  const project = ctx.repos.projects.get(input.id);
  if (project === null) {
    throw new DomainError("NOT_FOUND", { message: `no project ${input.id}`, details: { projectId: input.id } });
  }
  return project.readme;
}
