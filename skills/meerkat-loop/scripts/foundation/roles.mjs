/**
 * The optional team-role layer.
 *
 * A roles root is a directory containing `manifest.json`, the role workflows it
 * names, and an optional `decision-policy.md`. It is authored by
 * `setup-meerkat`; `install.sh` never ships one, so a deployment with no roles
 * root behaves exactly as it did before this module existed.
 *
 * Precedence is **whole-manifest**, not per-role merge:
 *
 *   1. an explicit `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`;
 *   2. `<project>/.meerkat/roles/`;
 *   3. `<agent-dir>/skills/meerkat-loop/roles/`;
 *   4. `<agent-dir>/meerkat-taskpanel/roles/` (the deployed body).
 *
 * Project roles therefore replace the global team as a set. That is easier to
 * reason about than a merge, and it keeps a project from accidentally inheriting
 * half of a workflow.
 *
 * Failure is deliberately soft. A missing manifest means "no role layer"; a
 * malformed manifest is reported and produces no roles, never an exception that
 * could wedge a poll or a wake. A bad workflow path degrades that one role's
 * path to `null` and warns, so the role remains visible for reporting.
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";

/** The only manifest shape this loader understands. */
export const ROLES_MANIFEST_VERSION = 1;

/** Candidate source labels, in precedence order. */
export const ROLES_SOURCES = Object.freeze(["explicit", "project", "loop-skill", "state"]);

export const ROLES_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  workflowBytes: 64 * 1024,
  roles: 32,
  responsibilities: 12,
  boundaries: 12,
});

const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANES = Object.freeze(["worker", "reviewer"]);

/** @param {unknown} value */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value */
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/** Read at most `limit` bytes; returns `{ text, truncated }`. */
function readBounded(path, limit) {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/** A role path is a safe relative markdown path inside its root. */
function safeRelative(rel) {
  if (!nonEmptyString(rel)) return false;
  if (isAbsolute(rel)) return false;
  if (rel.includes("\0") || rel.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  if (rel.startsWith("~")) return false;
  if (extname(rel).toLowerCase() !== ".md") return false;
  const parts = rel.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Resolve a role-relative file, refusing absolute paths, traversal and symlink
 * escapes. Returns the canonical absolute path, or `null`.
 */
export function resolveRoleFile(root, rel) {
  if (!safeRelative(rel)) return null;
  const candidate = join(root, rel);
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    if (!statSync(candidate).isFile()) return null;
    realTarget = realpathSync(candidate);
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
  return realTarget;
}

/** @param {unknown} value @returns {string[]} */
function stringList(value, cap) {
  if (!Array.isArray(value)) return [];
  return value.filter(nonEmptyString).slice(0, cap).map((entry) => entry.trim());
}

/** @param {unknown} value @returns {("worker"|"reviewer")[]} */
function lanesOf(value) {
  const lanes = Array.isArray(value)
    ? value.filter((lane) => LANES.includes(lane))
    : [];
  return lanes.length > 0 ? [...new Set(lanes)] : ["worker"];
}

/** A workflow may be one string, or one path per lane. */
function workflowPaths(value, lanes, root) {
  const result = { worker: null, reviewer: null };
  if (typeof value === "string") {
    const path = resolveRoleFile(root, value);
    for (const lane of lanes) result[lane] = path;
    return result;
  }
  if (isObject(value)) {
    for (const lane of lanes) {
      if (typeof value[lane] === "string") result[lane] = resolveRoleFile(root, value[lane]);
    }
  }
  return result;
}

/** @param {string} label */
function sourceLabel(source) {
  return ROLES_SOURCES.includes(source) ? source : null;
}

/**
 * Find the roles root to load. Returns `{ dir, source }` or `null`.
 *
 * @param {{explicitDir?: string|null, projectDir?: string|null, loopSkillDir?: string|null, stateDir?: string|null}} input
 */
export function resolveRolesRoot(input = {}) {
  const candidates = [
    ["explicit", input.explicitDir],
    ["project", input.projectDir ? join(input.projectDir, ".meerkat", "roles") : null],
    ["loop-skill", input.loopSkillDir ? join(input.loopSkillDir, "roles") : null],
    ["state", input.stateDir ? join(input.stateDir, "roles") : null],
  ];
  for (const [source, dir] of candidates) {
    if (typeof dir !== "string" || dir === "") continue;
    if (existsSync(join(dir, "manifest.json"))) {
      return { dir, source: sourceLabel(source) };
    }
  }
  return null;
}

/** @param {string|null|undefined} loopSkillDir */
function loadDecisionPolicy(rolesRoot, loopSkillDir) {
  const team = rolesRoot ? join(rolesRoot, "decision-policy.md") : null;
  if (team && existsSync(team)) {
    try {
      const { text, truncated } = readBounded(team, ROLES_LIMITS.workflowBytes);
      return { source: "team", path: team, text, isDefault: false, truncated };
    } catch {
      // fall through to the default
    }
  }
  const fallback = loopSkillDir ? join(loopSkillDir, "references", "decision-policy.md") : null;
  if (fallback && existsSync(fallback)) {
    try {
      const { text, truncated } = readBounded(fallback, ROLES_LIMITS.workflowBytes);
      return { source: "default", path: fallback, text, isDefault: true, truncated };
    } catch {
      // fall through to "none"
    }
  }
  return { source: null, path: null, text: null, isDefault: true, truncated: false };
}

/** @param {object} raw @param {string} root @param {string[]} warnings */
function normalizeRole(raw, root, warnings) {
  if (!isObject(raw)) {
    warnings.push("role entry is not an object; skipped");
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ROLE_ID.test(id)) {
    warnings.push(`role id ${JSON.stringify(raw.id)} is not valid; skipped`);
    return null;
  }
  const agent = nonEmptyString(raw.agent) ? raw.agent.trim() : id;
  const nativeAgent = nonEmptyString(raw.native_agent) ? raw.native_agent.trim() : id;
  const lanes = lanesOf(raw.lanes);
  const workflows = workflowPaths(raw.workflow, lanes, root);
  for (const lane of lanes) {
    if (workflows[lane] === null) {
      warnings.push(`role ${id}: workflow for ${lane} is missing or escapes the roles root`);
    }
  }
  const selfCheck = nonEmptyString(raw.self_check) ? resolveRoleFile(root, raw.self_check) : null;
  if (nonEmptyString(raw.self_check) && selfCheck === null) {
    warnings.push(`role ${id}: self_check is missing or escapes the roles root`);
  }
  const reviewerPrompt = nonEmptyString(raw.reviewer_prompt)
    ? resolveRoleFile(root, raw.reviewer_prompt)
    : null;
  if (nonEmptyString(raw.reviewer_prompt) && reviewerPrompt === null) {
    warnings.push(`role ${id}: reviewer_prompt is missing or escapes the roles root`);
  }

  return {
    id,
    agent,
    nativeAgent,
    lanes,
    title: nonEmptyString(raw.title) ? raw.title.trim() : agent,
    summary: nonEmptyString(raw.summary) ? raw.summary.trim() : "",
    responsibilities: stringList(raw.responsibilities, ROLES_LIMITS.responsibilities),
    boundaries: stringList(raw.boundaries, ROLES_LIMITS.boundaries),
    workflows,
    selfCheck,
    reviewerPrompt,
    agentDefinition: isObject(raw.agent_definition) ? { ...raw.agent_definition } : {},
  };
}

/**
 * Load the effective team.
 *
 * @param {{explicitDir?: string|null, projectDir?: string|null, loopSkillDir?: string|null, stateDir?: string|null}} input
 * @returns {{
 *   ok: boolean,
 *   source: string|null,
 *   root: string|null,
 *   team: string|null,
 *   defaultReviewer: object|null,
 *   roles: object[],
 *   byAgent: Map<string, object>,
 *   decisionPolicy: {source: string|null, path: string|null, text: string|null, isDefault: boolean, truncated: boolean},
 *   warnings: string[],
 *   error?: string,
 * }}
 */
export function loadRoles(input = {}) {
  const warnings = [];
  const empty = {
    ok: true,
    source: null,
    root: null,
    team: null,
    defaultReviewer: null,
    roles: [],
    byAgent: new Map(),
    decisionPolicy: loadDecisionPolicy(null, input.loopSkillDir ?? null),
    warnings,
  };

  const resolved = resolveRolesRoot(input);
  if (resolved === null) return empty;

  const manifestPath = join(resolved.dir, "manifest.json");
  let raw;
  try {
    const { text, truncated } = readBounded(manifestPath, ROLES_LIMITS.manifestBytes);
    if (truncated) {
      warnings.push(`manifest is larger than ${ROLES_LIMITS.manifestBytes} bytes; refusing it`);
      return { ...empty, ok: false, source: resolved.source, root: resolved.dir, error: "manifest too large" };
    }
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ...empty,
      ok: false,
      source: resolved.source,
      root: resolved.dir,
      error: err instanceof Error ? err.message : String(err),
      warnings: [...warnings, `cannot read the roles manifest: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!isObject(raw) || raw.version !== ROLES_MANIFEST_VERSION || !Array.isArray(raw.roles)) {
    return {
      ...empty,
      ok: false,
      source: resolved.source,
      root: resolved.dir,
      error: "manifest must be { version: 1, roles: [...] }",
      warnings: [...warnings, "the roles manifest has an unsupported shape or version; no roles loaded"],
    };
  }
  if (raw.roles.length > ROLES_LIMITS.roles) {
    warnings.push(`the manifest names more than ${ROLES_LIMITS.roles} roles; the extras are ignored`);
  }

  const roles = [];
  const byAgent = new Map();
  for (const entry of raw.roles.slice(0, ROLES_LIMITS.roles)) {
    const role = normalizeRole(entry, resolved.dir, warnings);
    if (role === null) continue;
    const key = role.agent.toLowerCase();
    if (byAgent.has(key)) {
      warnings.push(`duplicate agent ${role.agent}; keeping the first role (${byAgent.get(key).id})`);
      continue;
    }
    roles.push(role);
    byAgent.set(key, role);
    byAgent.set(role.id.toLowerCase(), byAgent.get(key));
  }

  const wanted = nonEmptyString(raw.default_reviewer) ? raw.default_reviewer.trim().toLowerCase() : null;
  let defaultReviewer = null;
  if (wanted !== null) {
    const found = roles.find(
      (role) => role.id.toLowerCase() === wanted && role.lanes.includes("reviewer"),
    );
    if (found) defaultReviewer = found;
    else warnings.push(`default_reviewer ${JSON.stringify(raw.default_reviewer)} is not a reviewer role`);
  }
  defaultReviewer ??= roles.find((role) => role.lanes.includes("reviewer")) ?? null;

  return {
    ok: true,
    source: resolved.source,
    root: resolved.dir,
    team: nonEmptyString(raw.team) ? raw.team.trim() : null,
    defaultReviewer,
    roles,
    byAgent,
    decisionPolicy: loadDecisionPolicy(resolved.dir, input.loopSkillDir ?? null),
    warnings,
  };
}

/**
 * Select the role named by a card's assignee, restricted to one lane.
 *
 * @param {object|null} roleSet
 * @param {unknown} agent
 * @param {"worker"|"reviewer"} lane
 * @returns {object|null}
 */
export function selectRole(roleSet, agent, lane = "worker") {
  if (!roleSet || !Array.isArray(roleSet.roles) || !nonEmptyString(agent)) return null;
  const key = String(agent).trim().toLowerCase();
  return (
    roleSet.roles.find(
      (role) =>
        (Array.isArray(role.lanes) ? role.lanes : []).includes(lane) &&
        (role.agent.toLowerCase() === key || role.id.toLowerCase() === key),
    ) ?? null
  );
}

/**
 * Select the reviewer role for an agent. A dedicated reviewer whose own role is
 * worker-only falls back to the manifest's default reviewer, so a worker's
 * boundaries never leak into a review.
 *
 * @param {object|null} roleSet
 * @param {unknown} agent
 * @returns {object|null}
 */
export function selectReviewerRole(roleSet, agent) {
  const direct = selectRole(roleSet, agent, "reviewer");
  if (direct !== null) return direct;
  return roleSet?.defaultReviewer ?? null;
}
