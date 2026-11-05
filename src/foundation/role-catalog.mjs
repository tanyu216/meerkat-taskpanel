/**
 * The local role catalog — the discovered roles, projected for humans and the
 * `meerkat` skill. A **local projection**, never board state.
 *
 * The supervisor is the discovery authority: it scans each installed kind's
 * `skills/* /role.json`, routes by that result, and publishes the set it will
 * actually use. `taskctl role sync` writes the file and `taskctl role list` reads
 * it; both are mailboxes between the supervisor and the caller, not a second
 * source of truth. `taskd` never learns roles, and no migration, route or event
 * carries this document.
 *
 * The shape is deliberately narrower than a role skill: only the fields a caller
 * can act on (`agent`, `id`, lanes, shapes, `summary`). The role contract's prose
 * (`responsibilities`, `boundaries`, `system_prompt`) stays in each
 * `skills/<id>/role.json` — the catalog is a routing projection and never carries
 * it. Host paths (`skillDir`, the workflow/self-check files) stay on the machine
 * that discovered them.
 *
 * Validation reuses `roles.mjs`'s limits so the reader of `role.json` and the
 * reader of `roles.json` cannot drift. A malformed or newer-schema file is
 * reported and treated as **absent**, never half-applied: a stale assignee range
 * that silently drops a role is worse than falling back to the open range.
 */

import {
  ROLE_ID_PATTERN,
  ROLE_LANES,
  ROLES_LIMITS,
  ROLE_KINDS,
} from "./roles.mjs";

/** The schema marker every catalog carries. A different one is "not ours". */
export const ROLE_CATALOG_SCHEMA = "meerkat-role-catalog/1";

/** The one file name under the config root. */
export const ROLE_CATALOG_FILENAME = "roles.json";

/** A bounded read: this document is a projection, never a payload store. */
export const ROLE_CATALOG_MAX_BYTES = 64 * 1024;

/** The text fields and their caps. `summary` is prose; the rest are short lines. */
const TEXT_LIMITS = Object.freeze({ agent: 128, nativeAgent: 128, title: 256, summary: 2048 });

/** @param {unknown} value */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value */
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A string list with the loader's cap: enough for a role's declared shape, never
 * an unbounded payload.
 *
 * @param {unknown} value
 * @param {number} cap
 * @param {string} field
 * @param {string[]} errors
 * @returns {string[]|null}
 */
function catalogStringList(value, cap, field, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return null;
  }
  const kept = [];
  for (const entry of value) {
    if (!nonEmptyString(entry)) {
      errors.push(`${field} entries must be non-empty strings`);
      return null;
    }
    kept.push(entry.trim());
  }
  if (kept.length > cap) {
    errors.push(`${field} carries more than ${cap} entries`);
    return null;
  }
  return kept;
}

/** @param {unknown} value @param {string} field @param {string[]} errors */
function catalogText(value, field, errors, { required = false, cap } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return null;
  }
  const text = value.trim();
  if (required && text === "") {
    errors.push(`${field} is required`);
    return null;
  }
  if (cap !== undefined && text.length > cap) {
    errors.push(`${field} is longer than ${cap} characters`);
    return null;
  }
  return text;
}

/**
 * One role, projected and validated. Returns `null` after recording why.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {string[]} errors
 * @returns {object|null}
 */
function normalizeCatalogRole(raw, index, errors) {
  if (!isObject(raw)) {
    errors.push(`roles[${index}] is not an object`);
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ROLE_ID_PATTERN.test(id)) {
    errors.push(`roles[${index}].id ${JSON.stringify(raw.id)} is not a valid role id`);
    return null;
  }
  const before = errors.length;
  const agent = catalogText(raw.agent, `roles[${index}].agent`, errors, {
    required: true,
    cap: TEXT_LIMITS.agent,
  });
  const nativeAgent = raw.native_agent === undefined
    ? null
    : catalogText(raw.native_agent, `roles[${index}].native_agent`, errors, { cap: TEXT_LIMITS.nativeAgent });
  const title = catalogText(raw.title, `roles[${index}].title`, errors, { cap: TEXT_LIMITS.title });
  const summary = catalogText(raw.summary, `roles[${index}].summary`, errors, { cap: TEXT_LIMITS.summary });

  let lanes = [];
  if (raw.lanes !== undefined) {
    if (!Array.isArray(raw.lanes) || raw.lanes.some((lane) => !ROLE_LANES.includes(lane))) {
      errors.push(`roles[${index}].lanes must be a subset of ${ROLE_LANES.join("|")}`);
    } else {
      lanes = [...new Set(raw.lanes)];
    }
  }

  let installedOn = [];
  if (raw.installed_on !== undefined) {
    if (!Array.isArray(raw.installed_on) || raw.installed_on.some((kind) => !ROLE_KINDS.includes(kind))) {
      errors.push(`roles[${index}].installed_on must be a subset of ${ROLE_KINDS.join("|")}`);
    } else {
      installedOn = [...new Set(raw.installed_on)];
    }
  }

  const shapes = catalogStringList(raw.shapes, ROLES_LIMITS.shapes, `roles[${index}].shapes`, errors);

  let defaultReviewer = false;
  if (raw.default_reviewer !== undefined) {
    if (typeof raw.default_reviewer !== "boolean") {
      errors.push(`roles[${index}].default_reviewer must be a boolean`);
    } else {
      defaultReviewer = raw.default_reviewer;
    }
  }

  if (errors.length > before) return null;

  return {
    id,
    agent,
    ...(nativeAgent === null ? {} : { native_agent: nativeAgent }),
    title,
    summary,
    lanes,
    shapes: shapes ?? [],
    installed_on: installedOn,
    default_reviewer: defaultReviewer,
  };
}

/**
 * Validate and normalize a catalog document — the one reader of the shape.
 *
 * Unknown top-level keys are dropped (the projection is the contract); an
 * unknown role field is dropped too, so an older reader accepts a newer writer's
 * additive field. A structural error rejects the whole document.
 *
 * @param {unknown} raw
 * @returns {{ok: true, catalog: object} | {ok: false, message: string, code: string}}
 */
export function normalizeRoleCatalog(raw) {
  if (!isObject(raw)) {
    return { ok: false, code: "schema", message: "the role catalog is not a JSON object" };
  }
  if (raw.schema !== ROLE_CATALOG_SCHEMA) {
    return {
      ok: false,
      code: "schema",
      message: `the role catalog does not carry the "${ROLE_CATALOG_SCHEMA}" marker`,
    };
  }
  const source = raw.source === undefined || raw.source === null
    ? null
    : typeof raw.source === "string"
      ? raw.source.trim()
      : null;
  if (source !== null && source !== "skills" && source !== "explicit") {
    return { ok: false, code: "schema", message: `unknown catalog source ${JSON.stringify(raw.source)}` };
  }
  const primaryKind = ROLE_KINDS.includes(raw.primary_kind) ? raw.primary_kind : null;
  const updatedAt = typeof raw.updated_at === "string" && raw.updated_at.trim() !== ""
    ? raw.updated_at.trim()
    : null;

  if (raw.roles !== undefined && !Array.isArray(raw.roles)) {
    return { ok: false, code: "schema", message: "roles must be an array" };
  }
  const entries = raw.roles ?? [];
  if (entries.length > ROLES_LIMITS.roles) {
    return {
      ok: false,
      code: "too_many",
      message: `the role catalog carries more than ${ROLES_LIMITS.roles} roles`,
    };
  }

  const errors = [];
  const roles = [];
  for (let index = 0; index < entries.length; index += 1) {
    const role = normalizeCatalogRole(entries[index], index, errors);
    if (role !== null) roles.push(role);
  }
  const byId = new Map();
  const byAgent = new Map();
  for (const role of roles) {
    const idKey = role.id.toLowerCase();
    const agentKey = role.agent.toLowerCase();
    if (byId.has(idKey)) {
      errors.push(`duplicate role id ${role.id}`);
      break;
    }
    if (byAgent.has(agentKey)) {
      errors.push(`duplicate role agent ${role.agent}`);
      break;
    }
    byId.set(idKey, role);
    byAgent.set(agentKey, role);
  }
  if (errors.length > 0) {
    return { ok: false, code: "schema", message: errors.join("; ") };
  }

  roles.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    catalog: {
      schema: ROLE_CATALOG_SCHEMA,
      source,
      primary_kind: primaryKind,
      updated_at: updatedAt,
      roles,
    },
  };
}

/**
 * Project one discovered role into the catalog's narrower shape. Host paths and
 * per-kind file variants are deliberately dropped.
 *
 * @param {object} role
 * @returns {object}
 */
export function projectRole(role) {
  return {
    id: role.id,
    agent: role.agent,
    native_agent: role.nativeAgent,
    title: role.title,
    summary: role.summary,
    lanes: [...(role.lanes ?? [])],
    shapes: [...(role.shapes ?? [])],
    installed_on: [...(role.installedOn ?? [])],
    default_reviewer: role.defaultReviewer === true,
  };
}

/**
 * The document the supervisor publishes for one discovery result.
 *
 * @param {{roleSet: object, now?: Date}} input
 * @returns {object}
 */
export function buildRoleCatalog({ roleSet, now = new Date() }) {
  const roles = (Array.isArray(roleSet?.roles) ? roleSet.roles : [])
    .map(projectRole)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: ROLE_CATALOG_SCHEMA,
    source: roleSet?.source ?? null,
    primary_kind: roleSet?.primaryKind ?? null,
    updated_at: now.toISOString(),
    roles,
  };
}

/**
 * Whether two catalogs carry the same content. `updated_at` is metadata, not
 * content: an unchanged sync leaves it alone.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
export function sameCatalog(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.source === b.source &&
    a.primary_kind === b.primary_kind &&
    JSON.stringify(a.roles) === JSON.stringify(b.roles)
  );
}

/**
 * The one assignee-range reader. Membership is by the role's `agent` or `id`,
 * case-insensitively — the same spelling `selectRole` accepts.
 *
 * @param {object|null} catalog
 * @param {unknown} assignee
 * @returns {boolean}
 */
export function catalogHasAssignee(catalog, assignee) {
  if (!nonEmptyString(assignee)) return false;
  const key = assignee.trim().toLowerCase();
  return (catalog?.roles ?? []).some(
    (role) => role.agent.toLowerCase() === key || role.id.toLowerCase() === key,
  );
}

/** The assignee names a caller may use, in catalog order. */
export function catalogAgentNames(catalog) {
  return (catalog?.roles ?? []).map((role) => role.agent);
}
