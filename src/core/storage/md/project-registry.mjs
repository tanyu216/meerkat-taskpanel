/**
 * The team's project registry (`~/.openclaw/team/projects.json`) — the bridge
 * between a card's human-readable `project` name and the TaskPanel project id.
 *
 * ARCHITECTURE §4.8 ④: a card's `project:` is a **registered name** (a key in
 * the registry), not an id. Before M5 the migrator treated it as an id and
 * silently created a project for every unknown name; this module is the one
 * place that resolves name → id, and the caller decides what a miss means
 * (warn and skip, or create only when `--create-project` was given).
 *
 * Candidate shapes are accepted so the file can evolve without a migrator
 * change:
 *
 *   { "projects": { "<key>": { ... } } }   // the team file today
 *   { "<key>": { ... } }                    // a bare map
 *
 * An entry's id defaults to its key and its name to its id, so the common
 * `{ "TaskPanel": { root, kind, ... } }` resolves `TaskPanel` → `TaskPanel`. An
 * explicit `id`/`name` overrides either. Everything else (kind, repos, guides,
 * default_git_rules, root_git, notes, registered_at, …) is carried verbatim into
 * `projects.meta_json` — the registry is the source, the board is the authority.
 *
 * Pure except for `loadProjectRegistry` (one read).
 */

import { readFileSync } from "node:fs";

import { DomainError } from "../../../shared/errors.mjs";
import { norm } from "../../../shared/norm.mjs";

/** Keys a registry entry may carry, plus anything else, mapped into `meta`. */
const WORKSPACE_KEYS = Object.freeze(["root", "workspace_path", "workspacePath"]);

/**
 * The normalisation used for a project name — the same rule as labels,
 * assignees and reporters (§4.4): NFKC → drop whitespace → case-fold. Reusing
 * `norm` keeps one definition of "same name" across the board.
 *
 * @param {unknown} value
 * @returns {string} `""` when the value carries no usable name
 */
export function normalizeProjectKey(value) {
  if (typeof value !== "string") return "";
  try {
    return norm(value);
  } catch {
    return "";
  }
}

/** @param {unknown} value */
function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The **buildin** projects: reserved names the board owns itself, so a card may
 * name one without it appearing in the team's `projects.json`.
 *
 * `__team__` is the reserved team-internal project (PROTOCOL §②: a team chore
 * is not a repository). It has no filesystem repo, so its `workspace_path` is a
 * **synthetic absolute anchor** — it satisfies the `projects.workspace_path`
 * CHECK (`LIKE '/%'`) and its UNIQUE constraint, and it is deliberately not a
 * real home path (this repository is public). Do not hardcode a `/Users/…`
 * path here.
 *
 * A file entry for the same key always wins: `parseProjectRegistry` only fills
 * a buildin slot the file left empty.
 */
export const BUILDIN_PROJECTS = Object.freeze([
  Object.freeze({
    key: "__team__",
    id: "__team__",
    name: "__team__",
    workspacePath: "/__team__",
    meta: Object.freeze({
      buildin: true,
      kind: "team",
      notes: "reserved team-internal project; no filesystem repo — the workspace path is a synthetic anchor",
    }),
    raw: Object.freeze({}),
  }),
]);

/**
 * Resolve a card's `project` against the buildin entries only.
 *
 * Used when there is no registry file at all, so buildin resolution works even
 * without `--projects` (a `__team__` card must never be skipped as
 * "unregistered" just because the team file is absent).
 *
 * @param {unknown} value a registered name or an id
 * @returns {object|null}
 */
export function resolveBuildinProject(value) {
  const key = normalizeProjectKey(value);
  if (key !== "") {
    for (const entry of BUILDIN_PROJECTS) {
      if (normalizeProjectKey(entry.key) === key || normalizeProjectKey(entry.name) === key) return entry;
    }
  }
  if (typeof value === "string") {
    for (const entry of BUILDIN_PROJECTS) if (entry.id === value) return entry;
  }
  return null;
}

/**
 * Parse a registry file's text.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {{file: string, entries: object[], duplicates: string[], resolve: (name: unknown) => object|null, resolveById: (id: unknown) => object|null, size: number}}
 * @throws {DomainError} VALIDATION_FAILED when the text is not a JSON object map
 */
export function parseProjectRegistry(text, options = {}) {
  const file = options.file ?? "<registry>";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${file}: not valid JSON (${err.message})`,
      details: { file, field: "projects" },
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${file}: a project registry must be a JSON object of project entries`,
      details: { file, field: "projects" },
    });
  }

  const map = parsed.projects !== undefined ? parsed.projects : parsed;
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${file}: 'projects' must be an object keyed by project name`,
      details: { file, field: "projects" },
    });
  }

  const entries = [];
  /** @type {Map<string, object>} */
  const byKey = new Map();
  /** @type {Map<string, object>} */
  const byId = new Map();
  const duplicates = [];

  for (const [key, raw] of Object.entries(map)) {
    if (key.startsWith("$")) continue; // `$schema_note` and friends — documentation, not a project
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id = stringOrNull(record.id) ?? key;
    const name = stringOrNull(record.name) ?? id;
    const workspacePath = WORKSPACE_KEYS.map((field) => stringOrNull(record[field])).find(
      (value) => value !== null,
    ) ?? null;

    const meta = {};
    for (const [metaKey, metaValue] of Object.entries(record)) {
      if (metaKey === "id" || metaKey === "name" || WORKSPACE_KEYS.includes(metaKey)) continue;
      meta[metaKey] = metaValue;
    }
    meta.registered_key = key;

    const entry = { key, id, name, workspacePath, meta, raw: record };

    for (const candidate of new Set([normalizeProjectKey(key), normalizeProjectKey(name)])) {
      if (candidate === "") continue;
      if (byKey.has(candidate)) {
        if (!duplicates.includes(candidate)) duplicates.push(candidate);
        continue;
      }
      byKey.set(candidate, entry);
    }
    if (!byId.has(id)) byId.set(id, entry);
    entries.push(entry);
  }

  // Buildin projects fill only the slots the file left empty, so a real entry
  // named `__team__` (unlikely, but the file is the authority) overrides it.
  for (const entry of BUILDIN_PROJECTS) {
    for (const candidate of new Set([normalizeProjectKey(entry.key), normalizeProjectKey(entry.name)])) {
      if (candidate === "") continue;
      if (!byKey.has(candidate)) byKey.set(candidate, entry);
    }
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
    if (!entries.includes(entry)) entries.push(entry);
  }

  return {
    file,
    entries,
    duplicates,
    size: entries.length,
    /** Resolve by registered name (normalised) or by id. @param {unknown} value */
    resolve(value) {
      const key = normalizeProjectKey(value);
      if (key !== "" && byKey.has(key)) return byKey.get(key);
      return typeof value === "string" && byId.has(value) ? byId.get(value) : null;
    },
    /** @param {unknown} value */
    resolveById(value) {
      return typeof value === "string" && byId.has(value) ? byId.get(value) : null;
    },
  };
}

/**
 * Read and parse a registry file.
 * @param {string} path
 * @returns {ReturnType<typeof parseProjectRegistry>}
 */
export function loadProjectRegistry(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `could not read the project registry ${path}: ${err.message}`,
      details: { file: path, field: "projects" },
    });
  }
  return parseProjectRegistry(text, { file: path });
}
