/**
 * The optional team-role layer — discovered from installed role skills.
 *
 * A role is a standalone skill: `skills/<role>/` carries `SKILL.md` (the workflow
 * entry), `role.json` (its machine-readable identity) and `references/` (branch
 * workflows, self-check, reviewer prompt). The supervisor does not read a team
 * manifest and does not own a roles root. It scans every installed agent kind's
 * skills tree:
 *
 *   1. an explicit `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR` (a directory of
 *      role directories) replaces the scanned set;
 *   2. otherwise `<home>/<agent-dir>/skills/* /role.json` for claude, codex and pi.
 *
 * **Installation location is the routing.** Each hit records the kind that
 * carries the skill, so a role installed only on codex runs on codex. When a role
 * is installed on several kinds the supervisor's primary kind wins, then the
 * fixed order claude → codex → pi. The record keeps `installedOn` so a later
 * dispatch can fall back to another kind that carries the same role.
 *
 * Decision authority is **not** part of the role layer. The
 * `meerkat-director` skill's `references/decision-policy.md` is the single source;
 * a role skill or an explicit roles directory can never override it.
 *
 * Failure is deliberately soft. A missing role.json means "not a role"; a
 * malformed file is reported and skipped, never an exception that could wedge a
 * poll or a wake. A bad path degrades that role's path to `null` and warns, so the
 * role remains visible for reporting.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";

import { AGENT_DIRS } from "./agent-paths.mjs";

/** The marker every role skill carries; anything else is not a role. */
const ROLE_SCHEMA = "meerkat-role";

/** The kinds the supervisor scans and may dispatch on, in fixed preference order. */
export const ROLE_KINDS = Object.freeze(["claude", "codex", "pi"]);

/**
 * The kinds whose host is verified to expand a `/<skill>` opener as a user
 * message. Resident lanes on every other kind keep the full handoff with the
 * skill path, so an unexpanded command cannot run as a stray instruction.
 */
export const SKILL_OPENER_KINDS = Object.freeze(["claude"]);

/**
 * The kinds whose adapter loads the role skill into the session when it opens
 * (Codex `developerInstructions`, Pi `--append-system-prompt`), so no message
 * command is sent.
 */
export const INLINE_SKILL_KINDS = Object.freeze(["codex", "pi"]);

/** @param {unknown} kind */
export function supportsSkillOpener(kind) {
  return SKILL_OPENER_KINDS.includes(String(kind ?? ""));
}

/** @param {unknown} kind */
export function supportsInlineSkill(kind) {
  return INLINE_SKILL_KINDS.includes(String(kind ?? ""));
}

/**
 * How a resident lane loads its role skill: a `/<skill>` message (`opener`), at
 * session open inside the adapter (`inline`), or not at all (`none`).
 *
 * @param {unknown} kind
 * @returns {"opener"|"inline"|"none"}
 */
export function skillLoadMode(kind) {
  const value = String(kind ?? "");
  if (SKILL_OPENER_KINDS.includes(value)) return "opener";
  if (INLINE_SKILL_KINDS.includes(value)) return "inline";
  return "none";
}

const ROLES_LIMITS = Object.freeze({
  roleJsonBytes: 32 * 1024,
  workflowBytes: 64 * 1024,
  policyBytes: 64 * 1024,
  roles: 32,
  responsibilities: 16,
  boundaries: 16,
  shapes: 16,
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

/** A role path is a safe relative path with one of the allowed extensions. */
function safeRelative(rel, extensions = [".md"]) {
  if (!nonEmptyString(rel)) return false;
  if (isAbsolute(rel)) return false;
  if (rel.includes("\0") || rel.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  if (rel.startsWith("~")) return false;
  if (!extensions.includes(extname(rel).toLowerCase())) return false;
  const parts = rel.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Resolve a file inside `root`, refusing absolute paths, traversal and symlink
 * escapes. Returns the canonical absolute path, or `null`.
 */
function resolveInside(root, rel, extensions) {
  if (!safeRelative(rel, extensions)) return null;
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

/**
 * Resolve a role-relative markdown file (workflow, self-check, reviewer prompt).
 * Returns the canonical absolute path, or `null`.
 */
function resolveRoleFile(root, rel) {
  return resolveInside(root, rel, [".md"]);
}

/** The files one installed copy contributes. */
function variantOf(role) {
  return {
    skillDir: role.skillDir ?? null,
    workflow: role.workflow ?? null,
    selfCheck: role.selfCheck ?? null,
    reviewerPrompt: role.reviewerPrompt ?? null,
  };
}

/**
 * The files for one axis of dispatch: the selected kind's copy when it was
 * discovered, else the role's own (useful for hand-built test fixtures and for
 * an explicit roles directory, which is primary-kind by definition).
 *
 * @param {object} role
 * @param {string|null|undefined} kind
 * @returns {{skillDir: string|null, workflow: string|null, selfCheck: string|null, reviewerPrompt: string|null}}
 */
export function roleVariant(role, kind) {
  const variant = typeof kind === "string" ? role?.variants?.[kind] : null;
  return variant ?? variantOf(role ?? {});
}

/** @param {unknown} value @param {number} cap @returns {string[]} */
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

/**
 * The agent kinds to scan, primary first then the fixed order.
 *
 * @param {string|null|undefined} primaryKind
 * @returns {string[]}
 */
function kindsToScan(primaryKind) {
  const primary = ROLE_KINDS.includes(primaryKind) ? primaryKind : "claude";
  return [primary, ...ROLE_KINDS.filter((kind) => kind !== primary)];
}

/**
 * A skill directory carrying a role.json.
 *
 * @param {string} skillDir
 * @param {string} kind
 * @param {string[]} warnings
 * @returns {object|null}
 */
function readRoleSkill(skillDir, kind, warnings) {
  const roleJson = resolveInside(skillDir, "role.json", [".json"]);
  if (roleJson === null) return null;
  let raw;
  try {
    const { text, truncated } = readBounded(roleJson, ROLES_LIMITS.roleJsonBytes);
    if (truncated) {
      warnings.push(`${skillDir}: role.json is too large; skipped`);
      return null;
    }
    raw = JSON.parse(text);
  } catch (err) {
    warnings.push(`${skillDir}: cannot read role.json (${err instanceof Error ? err.message : String(err)}); skipped`);
    return null;
  }
  return normalizeRole(raw, skillDir, kind, warnings);
}

/** @param {object} raw @param {string} skillDir @param {string} kind @param {string[]} warnings */
function normalizeRole(raw, skillDir, kind, warnings) {
  if (!isObject(raw)) {
    warnings.push(`${skillDir}: role.json is not an object; skipped`);
    return null;
  }
  if (raw.schema !== ROLE_SCHEMA) {
    warnings.push(`${skillDir}: role.json lacks the "${ROLE_SCHEMA}" marker; skipped`);
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ROLE_ID.test(id)) {
    warnings.push(`${skillDir}: role id ${JSON.stringify(raw.id)} is not valid; skipped`);
    return null;
  }
  const agent = nonEmptyString(raw.agent) ? raw.agent.trim() : id;
  const nativeAgent = nonEmptyString(raw.native_agent) ? raw.native_agent.trim() : id;
  const lanes = lanesOf(raw.lanes);
  const workflow = resolveRoleFile(skillDir, "SKILL.md");
  if (workflow === null) warnings.push(`role ${id}: SKILL.md is missing or escapes the skill directory`);
  const selfCheck = nonEmptyString(raw.self_check) ? resolveRoleFile(skillDir, raw.self_check) : null;
  if (nonEmptyString(raw.self_check) && selfCheck === null) {
    warnings.push(`role ${id}: self_check is missing or escapes the skill directory`);
  }
  const reviewerPrompt = nonEmptyString(raw.reviewer_prompt)
    ? resolveRoleFile(skillDir, raw.reviewer_prompt)
    : null;
  if (nonEmptyString(raw.reviewer_prompt) && reviewerPrompt === null) {
    warnings.push(`role ${id}: reviewer_prompt is missing or escapes the skill directory`);
  }

  return {
    id,
    agent,
    nativeAgent,
    lanes,
    // The per-kind files, so a dispatch on a fallback kind points at that
    // kind's copy of the skill instead of the primary kind's.
    variants: { [kind]: variantOf({ skillDir, workflow, selfCheck, reviewerPrompt }) },
    title: nonEmptyString(raw.title) ? raw.title.trim() : agent,
    summary: nonEmptyString(raw.summary) ? raw.summary.trim() : "",
    responsibilities: stringList(raw.responsibilities, ROLES_LIMITS.responsibilities),
    boundaries: stringList(raw.boundaries, ROLES_LIMITS.boundaries),
    shapes: stringList(raw.shapes, ROLES_LIMITS.shapes),
    skillDir,
    platform: kind,
    installedOn: [kind],
    workflow,
    selfCheck,
    reviewerPrompt,
    defaultReviewer: raw.default_reviewer === true,
  };
}

/**
 * Scan one directory of role directories (the explicit `--roles-dir` form).
 *
 * @param {string} dir
 * @param {string} kind
 * @param {string[]} warnings
 * @returns {object[]}
 */
function scanRoleDirectory(dir, kind, warnings) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`roles: cannot read ${dir} (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
  const roles = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const role = readRoleSkill(join(dir, entry.name), kind, warnings);
    if (role !== null) roles.push(role);
  }
  return roles;
}

/**
 * Load the effective role set.
 *
 * @param {{
 *   home?: string|null,
 *   primaryKind?: string|null,
 *   explicitDir?: string|null,
 *   kinds?: string[]|null,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   source: string|null,
 *   root: string|null,
 *   primaryKind: string,
 *   roles: object[],
 *   byAgent: Map<string, object>,
 *   defaultReviewer: object|null,
 *   routing: {source: string|null, text: string|null},
 *   decisionPolicy: {source: string|null, path: string|null, text: string|null, skillDir: string|null, isDefault: boolean, truncated: boolean},
 *   warnings: string[],
 *   error?: string,
 * }}
 */
export function loadRoles(input = {}) {
  const warnings = [];
  const primaryKind = ROLE_KINDS.includes(input.primaryKind) ? input.primaryKind : "claude";
  const kinds = Array.isArray(input.kinds) && input.kinds.length > 0
    ? input.kinds.filter((kind) => ROLE_KINDS.includes(kind))
    : kindsToScan(primaryKind);

  const collected = [];
  let source = null;
  let root = null;

  if (nonEmptyString(input.explicitDir)) {
    const dir = input.explicitDir.trim();
    if (existsSync(dir)) {
      source = "explicit";
      root = dir;
      collected.push(...scanRoleDirectory(dir, primaryKind, warnings));
    } else {
      warnings.push(`roles: ${dir} does not exist; no roles loaded`);
    }
  } else if (nonEmptyString(input.home)) {
    const home = input.home.trim();
    source = "skills";
    root = join(home, AGENT_DIRS[primaryKind] ?? ".claude", "skills");
    for (const kind of kinds) {
      const skillsDir = join(home, AGENT_DIRS[kind] ?? `.${kind}`, "skills");
      if (!existsSync(skillsDir)) continue;
      let entries;
      try {
        entries = readdirSync(skillsDir, { withFileTypes: true });
      } catch (err) {
        warnings.push(`roles: cannot read ${skillsDir} (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const role = readRoleSkill(join(skillsDir, entry.name), kind, warnings);
        if (role !== null) collected.push(role);
      }
    }
  }

  // Merge by id, preferring the first hit (the scan is primary-first). Every
  // later hit only adds its kind to installedOn.
  const roles = [];
  const byId = new Map();
  const byAgent = new Map();
  for (const role of collected) {
    const seen = byId.get(role.id);
    if (seen) {
      if (!seen.installedOn.includes(role.platform)) seen.installedOn.push(role.platform);
      seen.variants[role.platform] = variantOf(role);
      if (seen.agent.toLowerCase() !== role.agent.toLowerCase()) {
        warnings.push(
          `role ${role.id}: agent name differs on ${role.platform} (${role.agent} vs ${seen.agent}); keeping ${seen.platform}`,
        );
      }
      continue;
    }
    if (roles.length >= ROLES_LIMITS.roles) {
      warnings.push(`more than ${ROLES_LIMITS.roles} roles; the extras are ignored`);
      break;
    }
    const agentKey = role.agent.toLowerCase();
    const idKey = role.id.toLowerCase();
    if (byAgent.has(agentKey) || byAgent.has(idKey)) {
      const first = byAgent.get(agentKey) ?? byAgent.get(idKey);
      warnings.push(`duplicate agent ${role.agent}; keeping the first role (${first.id})`);
      continue;
    }
    roles.push(role);
    byId.set(role.id, role);
    byAgent.set(agentKey, role);
    byAgent.set(idKey, role);
  }

  const defaultReviewer =
    roles.find((role) => role.defaultReviewer && role.lanes.includes("reviewer")) ??
    roles.find((role) => role.lanes.includes("reviewer")) ??
    null;
  if (roles.some((role) => role.defaultReviewer) && defaultReviewer?.defaultReviewer !== true) {
    warnings.push("no role marked default_reviewer has the reviewer lane; using the first reviewer role");
  }

  return {
    ok: true,
    source,
    root,
    primaryKind,
    roles,
    byAgent,
    defaultReviewer,
    routing: {
      source: roles.length > 0 ? source : null,
      text: roles.length > 0 ? renderRoutingTable(roles) : null,
    },
    decisionPolicy: loadDecisionPolicy(input.home ?? null, primaryKind),
    warnings,
  };
}

/**
 * The work→role routing table, generated from each role's `shapes`.
 *
 * @param {object[]} roles
 * @returns {string}
 */
export function renderRoutingTable(roles) {
  const lines = [
    "| Work shape | Accountable role | Skill |",
    "|---|---|---|",
  ];
  for (const role of roles) {
    // A reviewer-lane role never takes ordinary work: a review card is created
    // and assigned by the supervisor, not routed by the director.
    const workerCapable = Array.isArray(role.lanes) ? role.lanes.includes("worker") : true;
    if (!workerCapable) continue;
    for (const shape of role.shapes) {
      lines.push(`| ${shape} | ${role.agent} | ${role.workflow ?? `${role.skillDir}/SKILL.md`} |`);
    }
  }
  lines.push(
    "",
    "One accountable role per work shape. A shape the table does not describe goes to the Worker role.",
    "Reviewer roles are never routed; review cards are created and assigned by the supervisor.",
    "The card's assignee still selects the executing role; this table routes, it never decides.",
  );
  return lines.join("\n");
}

/**
 * The director skill's decision policy. A role/team layer can never override it.
 *
 * @param {string|null} home
 * @param {string} primaryKind
 * @returns {{source: string|null, path: string|null, text: string|null, skillDir: string|null, isDefault: boolean, truncated: boolean}}
 */
function loadDecisionPolicy(home, primaryKind) {
  if (!nonEmptyString(home)) {
    return { source: null, path: null, text: null, skillDir: null, isDefault: true, truncated: false };
  }
  const skillDir = join(home, AGENT_DIRS[primaryKind] ?? `.${primaryKind}`, "skills", "meerkat-director");
  const path = join(skillDir, "references", "decision-policy.md");
  if (!existsSync(path)) {
    return { source: null, path: null, text: null, skillDir, isDefault: true, truncated: false };
  }
  try {
    const { text, truncated } = readBounded(path, ROLES_LIMITS.policyBytes);
    return { source: "director", path, text, skillDir, isDefault: true, truncated };
  } catch {
    return { source: null, path: null, text: null, skillDir, isDefault: true, truncated: false };
  }
}

/**
 * A stable fingerprint of one installed skill: every regular file under it, by
 * relative path and content. The pool uses it to decide whether a resident
 * session still holds the skill it was opened with; a change reopens the session
 * and re-sends the opener.
 *
 * @param {string|null} skillDir
 * @returns {string|null}
 */
export function skillFingerprint(skillDir) {
  if (!nonEmptyString(skillDir) || !existsSync(skillDir)) return null;
  let root;
  try {
    root = statSync(skillDir);
  } catch {
    return null;
  }
  if (!root.isDirectory()) return null;
  const files = [];
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
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (entry.isFile()) files.push({ rel, full });
    }
  };
  walk(skillDir, "");
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(file.full));
    } catch {
      return null;
    }
    hash.update("\0");
  }
  return hash.digest("hex");
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
 * The fallback role when a card names no role: the Worker skill.
 *
 * @param {object|null} roleSet
 * @returns {object|null}
 */
export function selectWorkerRole(roleSet) {
  if (!roleSet || !Array.isArray(roleSet.roles)) return null;
  return (
    roleSet.roles.find((role) => role.id === "worker" && role.lanes.includes("worker")) ??
    roleSet.roles.find((role) => role.agent.toLowerCase() === "worker" && role.lanes.includes("worker")) ??
    null
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
