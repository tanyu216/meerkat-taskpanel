/**
 * Team-template validation for `install-roles.mjs`.
 *
 * This is a standalone mirror of the loop's `src/foundation/roles.mjs` rules: the
 * skill cannot import the checkout (it is also installed as a standalone copy), so
 * the shape and the path-safety checks are duplicated. Keep the two in step when the
 * manifest schema changes.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

export const TEAM_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  workflowBytes: 64 * 1024,
  roles: 32,
});

const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANES = Object.freeze(["worker", "reviewer"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** @param {string} rel */
export function safeRelative(rel) {
  if (!nonEmpty(rel)) return false;
  if (isAbsolute(rel)) return false;
  if (rel.includes("\0") || rel.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  if (rel.startsWith("~")) return false;
  if (extname(rel).toLowerCase() !== ".md") return false;
  return rel
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** @param {string} root @param {string} rel @returns {string|null} */
export function resolveRoleFile(root, rel) {
  if (!safeRelative(rel)) return null;
  const candidate = join(root, rel);
  try {
    const realRoot = realpathSync(root);
    if (!statSync(candidate).isFile()) return null;
    const realTarget = realpathSync(candidate);
    return realTarget === realRoot || realTarget.startsWith(realRoot + sep) ? realTarget : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function stringList(value) {
  return Array.isArray(value)
    ? value.filter(nonEmpty).slice(0, 12).map((entry) => entry.trim())
    : [];
}

/** @param {unknown} value */
function lanesOf(value) {
  const lanes = Array.isArray(value) ? value.filter((lane) => LANES.includes(lane)) : [];
  return lanes.length > 0 ? [...new Set(lanes)] : ["worker"];
}

/** @param {unknown} workflow @param {string[]} lanes @param {string} root */
function workflowsOf(workflow, lanes, root) {
  const result = { worker: null, reviewer: null };
  if (typeof workflow === "string") {
    const path = resolveRoleFile(root, workflow);
    for (const lane of lanes) result[lane] = path;
  } else if (isObject(workflow)) {
    for (const lane of lanes) {
      if (typeof workflow[lane] === "string") result[lane] = resolveRoleFile(root, workflow[lane]);
    }
  }
  return result;
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
  const lanes = lanesOf(raw.lanes);
  const workflows = workflowsOf(raw.workflow, lanes, root);
  for (const lane of lanes) {
    if (workflows[lane] === null) {
      warnings.push(`role ${id}: workflow for ${lane} is missing or escapes the team root`);
    }
  }
  const selfCheck = nonEmpty(raw.self_check) ? resolveRoleFile(root, raw.self_check) : null;
  const reviewerPrompt = nonEmpty(raw.reviewer_prompt)
    ? resolveRoleFile(root, raw.reviewer_prompt)
    : null;
  return {
    id,
    agent: nonEmpty(raw.agent) ? raw.agent.trim() : id,
    nativeAgent: nonEmpty(raw.native_agent) ? raw.native_agent.trim() : id,
    lanes,
    title: nonEmpty(raw.title) ? raw.title.trim() : id,
    summary: nonEmpty(raw.summary) ? raw.summary.trim() : "",
    responsibilities: stringList(raw.responsibilities),
    boundaries: stringList(raw.boundaries),
    workflows,
    selfCheck,
    reviewerPrompt,
    agentDefinition: isObject(raw.agent_definition) ? { ...raw.agent_definition } : {},
  };
}

/**
 * Read and validate a team template or an installed roles root.
 *
 * @param {string} root
 * @returns {{
 *   ok: boolean,
 *   root: string,
 *   manifest: object|null,
 *   team: string|null,
 *   roles: object[],
 *   defaultReviewer: object|null,
 *   decisionPolicy: string|null,
 *   warnings: string[],
 *   errors: string[],
 *   files: string[],
 * }}
 */
export function readTeam(root) {
  const warnings = [];
  const errors = [];
  const empty = {
    ok: false,
    root,
    manifest: null,
    team: null,
    roles: [],
    defaultReviewer: null,
    decisionPolicy: null,
    warnings,
    errors,
    files: [],
  };

  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    empty.errors.push(`missing manifest.json in ${root}`);
    return empty;
  }
  let raw;
  try {
    const text = readFileSync(manifestPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > TEAM_LIMITS.manifestBytes) {
      empty.errors.push(`manifest.json is larger than ${TEAM_LIMITS.manifestBytes} bytes`);
      return empty;
    }
    raw = JSON.parse(text);
  } catch (err) {
    empty.errors.push(`cannot read manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }

  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.roles)) {
    empty.errors.push("manifest.json must be { version: 1, roles: [...] }");
    return empty;
  }
  if (raw.roles.length > TEAM_LIMITS.roles) {
    warnings.push(`more than ${TEAM_LIMITS.roles} roles; the extras are ignored`);
  }

  const roles = [];
  const seen = new Set();
  for (const entry of raw.roles.slice(0, TEAM_LIMITS.roles)) {
    const role = normalizeRole(entry, root, warnings);
    if (role === null) continue;
    const key = role.agent.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`duplicate agent ${role.agent}; keeping the first role`);
      continue;
    }
    seen.add(key);
    roles.push(role);
  }

  const wanted = nonEmpty(raw.default_reviewer) ? raw.default_reviewer.trim().toLowerCase() : null;
  let defaultReviewer = null;
  if (wanted !== null) {
    defaultReviewer = roles.find(
      (role) => role.id.toLowerCase() === wanted && role.lanes.includes("reviewer"),
    ) ?? null;
    if (defaultReviewer === null) warnings.push(`default_reviewer ${JSON.stringify(raw.default_reviewer)} is not a reviewer role`);
  }
  defaultReviewer ??= roles.find((role) => role.lanes.includes("reviewer")) ?? null;

  const decisionPolicy = existsSync(join(root, "decision-policy.md"))
    ? join(root, "decision-policy.md")
    : null;

  return {
    ok: errors.length === 0,
    root,
    manifest: raw,
    team: nonEmpty(raw.team) ? raw.team.trim() : null,
    roles,
    defaultReviewer,
    decisionPolicy,
    warnings,
    errors,
    files: teamFiles(root),
  };
}

/**
 * The team files to install, relative to the root. `agents/` holds native agent
 * templates, not role files; it is handled separately.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function teamFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (rel === "agents" || rel.startsWith("agents/")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * Verify that a roles root can be consumed by the loop: every manifest path is
 * inside the root and exists. Used by `install-roles.mjs --validate`.
 *
 * @param {string} root
 */
export function validateRolesRoot(root) {
  const team = readTeam(root);
  return {
    ok: team.ok,
    root: team.root,
    team: team.team,
    roles: team.roles.map((role) => ({
      id: role.id,
      agent: role.agent,
      lanes: role.lanes,
      workflows: role.workflows,
      selfCheck: role.selfCheck,
      reviewerPrompt: role.reviewerPrompt,
    })),
    defaultReviewer: team.defaultReviewer?.id ?? null,
    decisionPolicy: team.decisionPolicy,
    warnings: team.warnings,
    errors: team.errors,
  };
}

/** A root-relative path for a resolved file, or null when it is outside. */
export function relativeTo(root, path) {
  if (typeof path !== "string") return null;
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") ? null : rel.split(sep).join("/");
}
