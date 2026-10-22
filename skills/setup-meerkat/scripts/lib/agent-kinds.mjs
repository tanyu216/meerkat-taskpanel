/**
 * The actor-kind directory map, mirrored from the loop's `AGENT_DIRS`.
 *
 * The setup skill runs from the installed skill directory and from the repo, so it
 * cannot import `scripts/loop/options.mjs` (the installed copy has no checkout). The
 * map is therefore duplicated here; `test/skill/setup-meerkat.test.mjs` asserts the
 * loop subset matches the loop's own table.
 */

import { join } from "node:path";

export const AGENT_KINDS = Object.freeze({
  claude: { dir: ".claude", loop: true, native: "markdown" },
  openclaw: { dir: ".openclaw", loop: false, native: null },
  codex: { dir: ".codex", loop: true, native: "toml" },
  pi: { dir: ".agents", loop: true, native: null },
  opencode: { dir: ".config/opencode", loop: true, native: null },
  cursor: { dir: ".cursor", loop: true, native: null },
});

/** The actor kinds that run the external loop (OpenClaw does not). */
export const LOOP_KINDS = Object.freeze(
  Object.entries(AGENT_KINDS)
    .filter(([, info]) => info.loop)
    .map(([kind]) => kind),
);

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

/** @param {string} home @param {string} kind */
export function loopSkillDir(home, kind) {
  return skillDir(home, kind, "meerkat-loop");
}

/** @param {string} home @param {string} kind */
export function loopBodyDir(home, kind) {
  return join(agentBase(home, kind), "meerkat-taskpanel");
}

/** @param {string} home @param {string} kind */
export function configFile(home, kind) {
  return join(agentBase(home, kind), "meerkat-taskpanel.env");
}

/** @param {string} home @param {string} kind */
export function shimFile(home, kind) {
  return join(agentBase(home, kind), "bin", "taskctl");
}

/** @param {string} home */
export function serverRoot(home) {
  return join(home, ".meerkat-taskpanel");
}

/** @param {string} kind */
export function nativeAgentFormat(kind) {
  return AGENT_KINDS[kind]?.native ?? null;
}

/**
 * Where a native agent definition belongs.
 *
 * @param {{home: string, kind: string, name: string, projectDir?: string|null}} input
 * @returns {string|null}
 */
export function nativeAgentFile(input) {
  const format = nativeAgentFormat(input.kind);
  if (format === null) return null;
  const ext = format === "markdown" ? "md" : "toml";
  const base = input.projectDir
    ? join(input.projectDir, AGENT_KINDS[input.kind].dir, "agents")
    : join(input.home, AGENT_KINDS[input.kind].dir, "agents");
  return join(base, `${input.name}.${ext}`);
}

/**
 * The tool allowlist for a role's native definition. A reviewer lane is read-only;
 * a worker lane may edit and run commands.
 *
 * @param {string[]} lanes
 */
export function toolsForLanes(lanes) {
  return lanes.includes("worker")
    ? "Read, Edit, Write, Grep, Glob, Bash"
    : "Read, Grep, Glob, Bash";
}
