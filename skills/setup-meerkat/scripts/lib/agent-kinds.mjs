/**
 * The actor-kind directory map, mirrored from `src/foundation/agent-paths.mjs`.
 *
 * The setup skill runs from the installed skill directory, where the toolkit's `src/`
 * tree is not a sibling, so it cannot import the shared table. The map is therefore
 * duplicated here; `test/skill/setup-meerkat.test.mjs` asserts the loop subset matches
 * the toolkit's own table.
 */

import { join } from "node:path";

export const AGENT_KINDS = Object.freeze({
  claude: { dir: ".claude", loop: true },
  openclaw: { dir: ".openclaw", loop: false },
  codex: { dir: ".codex", loop: true },
  // Pi keeps its skills and config under the `.agents` base.
  pi: { dir: ".agents", loop: true },
});

/** The actor kinds that run the external loop (OpenClaw does not). */
export const LOOP_KINDS = Object.freeze(
  Object.entries(AGENT_KINDS)
    .filter(([, info]) => info.loop)
    .map(([kind]) => kind),
);

/**
 * A full preference permutation from a configured order. Mirrors
 * `src/foundation/roles.mjs#normalizeKindOrder`; the setup skill runs from its
 * installed skill directory and cannot import the toolkit's `src/`.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function normalizeKindOrder(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  const listed = [];
  for (const entry of raw) {
    const kind = String(entry ?? "").trim().toLowerCase();
    if (LOOP_KINDS.includes(kind) && !listed.includes(kind)) listed.push(kind);
  }
  return [...listed, ...LOOP_KINDS.filter((kind) => !listed.includes(kind))];
}

/**
 * The order the supervisor actually scans: its own primary kind first, then the
 * configured order for the rest.
 *
 * @param {string|null|undefined} primaryKind
 * @param {string|string[]|null|undefined} kindOrder
 * @returns {string[]}
 */
export function effectiveKindOrder(primaryKind, kindOrder) {
  const primary = LOOP_KINDS.includes(primaryKind) ? primaryKind : LOOP_KINDS[0];
  return [primary, ...normalizeKindOrder(kindOrder).filter((kind) => kind !== primary)];
}

export const PLATFORM_CAPABILITIES = Object.freeze({
  claude: Object.freeze(["design", "architecture", "implementation", "tests", "review"]),
  codex: Object.freeze(["implementation", "tests", "review"]),
  pi: Object.freeze(["implementation", "tests"]),
});

/** The capability tags a standard role needs; an unknown role falls back to its lane. */
export const ROLE_CAPABILITY_TAGS = Object.freeze({
  jobs: Object.freeze(["design"]),
  linus: Object.freeze(["architecture", "implementation"]),
  turing: Object.freeze(["tests"]),
  reviewer: Object.freeze(["review"]),
});

/** @param {string} kind */
export function isAgentKind(kind) {
  return Object.hasOwn(AGENT_KINDS, kind);
}

/** @param {string} kind */
export function agentDir(kind) {
  return AGENT_KINDS[kind]?.dir ?? null;
}

/** @param {string} home @param {string} kind */
export function agentBase(home, kind) {
  return join(home, AGENT_KINDS[kind].dir);
}

/** @param {string} home @param {string} kind @param {string} skill */
export function skillDir(home, kind, skill) {
  return join(agentBase(home, kind), "skills", skill);
}

/** The loop's state directory at the config root (queue, ledger, locks, status files). */
export function loopStateDir(programRoot) {
  return join(programRoot, "loop");
}

/** The pre-migration per-kind state directory, reported as legacy and never written. */
export function legacyLoopStateDir(home, kind) {
  return join(agentBase(home, kind), "meerkat-taskpanel");
}

/** The per-kind config at the program root, one file per actor kind. */
export function kindConfigFile(programRoot, kind) {
  return join(programRoot, `.env.${kind}`);
}

/** @param {string} home @param {string} kind */
export function shimFile(home, kind) {
  return join(agentBase(home, kind), "bin", "taskctl");
}

/** @param {string} home */
export function serverRoot(home) {
  return join(home, ".meerkat-taskpanel");
}
