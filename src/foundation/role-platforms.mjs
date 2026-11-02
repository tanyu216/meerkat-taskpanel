/**
 * Which actor kind carries a role, and where dispatch goes when it cannot.
 *
 * Installation location is the routing: a role discovered on claude, codex or pi
 * runs there. This module is the pure half of that rule — it takes a role record
 * (`installedOn`) and an availability predicate and answers two questions:
 *
 *   - `effective`: the kind a session for this role should run on;
 *   - `fallback`: set when the preferred kind is unavailable and another kind
 *     that *also carries the role* takes over.
 *
 * It is deliberately free of I/O: probing whether a CLI can start belongs to the
 * caller (the supervisor's adapter probe), so tests can state availability
 * directly instead of depending on the host.
 *
 * A role that no installed kind can carry resolves to `effective: null`. The
 * caller must then **not claim** its cards and report once — dispatching to a kind
 * that does not carry the skill would point the handoff at a file that is not
 * there.
 *
 * Node builtins only; no I/O.
 */

import { ROLE_KINDS, effectiveKindOrder } from "./roles.mjs";

/**
 * The kinds carrying a role, preferred first: the supervisor's primary kind when
 * it carries the role, then the configured kind order (default claude → codex →
 * pi). A kind the configured order omits is appended by `effectiveKindOrder`, so
 * it remains a carrier rather than disappearing.
 *
 * @param {{installedOn?: string[], platform?: string}|null|undefined} role
 * @param {string|null|undefined} primaryKind
 * @param {string|string[]|null|undefined} [kindOrder]
 * @returns {string[]}
 */
export function platformChain(role, primaryKind, kindOrder) {
  const installed = Array.isArray(role?.installedOn) && role.installedOn.length > 0
    ? role.installedOn.filter((kind) => ROLE_KINDS.includes(kind))
    : role?.platform && ROLE_KINDS.includes(role.platform)
      ? [role.platform]
      : [];
  const unique = [...new Set(installed)];
  if (unique.length === 0) return [];
  return effectiveKindOrder(primaryKind, kindOrder).filter((kind) => unique.includes(kind));
}

/** @param {unknown} available */
function availability(available) {
  if (typeof available === "function") return available;
  if (available instanceof Set) return (kind) => available.has(kind);
  return () => true;
}

/**
 * Resolve the effective kind for one role.
 *
 * @param {{installedOn?: string[], platform?: string}|null|undefined} role
 * @param {{primaryKind?: string|null, order?: string|string[]|null, available?: ((kind: string) => boolean)|Set<string>|null}} [input]
 * @returns {{preferred: string|null, effective: string|null, fallback: string|null, chain: string[]}}
 */
export function resolveRolePlatform(role, input = {}) {
  const chain = platformChain(role, input.primaryKind ?? null, input.order);
  const preferred = chain[0] ?? null;
  const isAvailable = availability(input.available);
  const effective = chain.find((kind) => isAvailable(kind)) ?? null;
  return {
    preferred,
    effective,
    fallback: effective !== null && effective !== preferred ? effective : null,
    chain,
  };
}

/**
 * The same resolution for a whole role set.
 *
 * @param {object[]} roles
 * @param {{primaryKind?: string|null, order?: string|string[]|null, available?: ((kind: string) => boolean)|Set<string>|null}} [input]
 * @returns {Map<string, {preferred: string|null, effective: string|null, fallback: string|null, chain: string[]}>}
 */
export function resolveRolePlatforms(roles, input = {}) {
  const map = new Map();
  if (!Array.isArray(roles)) return map;
  for (const role of roles) {
    if (typeof role?.id !== "string") continue;
    map.set(role.id, resolveRolePlatform(role, input));
  }
  return map;
}

/**
 * The one-line report `loop status` / `loop doctor` show: every role with where it
 * is installed, where it will run, and any fallback or unavailability.
 *
 * @param {object[]} roles
 * @param {{primaryKind?: string|null, order?: string|string[]|null, available?: ((kind: string) => boolean)|Set<string>|null}} [input]
 * @returns {string[]}
 */
export function describeRolePlatforms(roles, input = {}) {
  if (!Array.isArray(roles) || roles.length === 0) return [];
  const map = resolveRolePlatforms(roles, input);
  const lines = [];
  for (const role of roles) {
    const resolved = map.get(role.id);
    if (resolved === undefined) continue;
    const installed = Array.isArray(role.installedOn) && role.installedOn.length > 0
      ? role.installedOn.join(",")
      : "none";
    let tail;
    if (resolved.effective === null) tail = "unavailable — its cards are not claimed";
    else if (resolved.fallback !== null) tail = `fallback ${resolved.fallback} (${resolved.preferred} unavailable)`;
    else tail = resolved.effective;
    lines.push(`role ${role.agent}: installed on ${installed}; dispatch ${tail}`);
  }
  return lines;
}
