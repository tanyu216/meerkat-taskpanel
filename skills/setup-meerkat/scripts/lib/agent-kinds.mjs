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
  // Pi gets subagents from the `pi-subagents` extension; the skills and config
  // still use the `.agents` base.
  pi: { dir: ".agents", loop: true },
});

/** The actor kinds that run the external loop (OpenClaw does not). */
export const LOOP_KINDS = Object.freeze(
  Object.entries(AGENT_KINDS)
    .filter(([, info]) => info.loop)
    .map(([kind]) => kind),
);

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

/** Where each role is offered first when more than one platform can do the work. */
export const ROLE_PLATFORM_PREFERENCE = Object.freeze({
  jobs: Object.freeze(["claude", "codex", "pi"]),
  linus: Object.freeze(["claude", "codex", "pi"]),
  turing: Object.freeze(["codex", "claude", "pi"]),
  reviewer: Object.freeze(["claude", "codex", "pi"]),
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

/** The loop's per-agent state directory (queue, ledger, locks, status files). */
export function loopStateDir(home, kind) {
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
