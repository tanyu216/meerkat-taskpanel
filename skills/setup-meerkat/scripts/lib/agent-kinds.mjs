/**
 * The actor-kind directory map, mirrored from `src/foundation/loop-paths.mjs`.
 *
 * The setup skill runs from the installed skill directory, where the toolkit's `src/`
 * tree is not a sibling, so it cannot import the shared table. The map is therefore
 * duplicated here; `test/skill/setup-meerkat.test.mjs` asserts the loop subset matches
 * the toolkit's own table.
 */

import { join } from "node:path";

export const AGENT_KINDS = Object.freeze({
  claude: { dir: ".claude", loop: true, native: "markdown" },
  openclaw: { dir: ".openclaw", loop: false, native: null },
  codex: { dir: ".codex", loop: true, native: "toml" },
  // Pi gets subagents from the `pi-subagents` extension: global definitions live in
  // `~/.pi/agent/agents/` and project definitions in `.pi/agents/`. The skills and
  // config still use the `.agents` base.
  pi: {
    dir: ".agents",
    loop: true,
    native: "markdown",
    nativeDir: ".pi/agent/agents",
    nativeProjectDir: ".pi/agents",
  },
});

/** The actor kinds that run the external loop (OpenClaw does not). */
export const LOOP_KINDS = Object.freeze(
  Object.entries(AGENT_KINDS)
    .filter(([, info]) => info.loop)
    .map(([kind]) => kind),
);

/** The actor kinds with a native agent-definition format. */
export const NATIVE_KINDS = Object.freeze(
  Object.entries(AGENT_KINDS)
    .filter(([, info]) => info.native !== null)
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

/** The loop's per-agent state directory (queue, ledger, locks, status files). */
export function loopStateDir(home, kind) {
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
  const info = AGENT_KINDS[input.kind];
  const format = nativeAgentFormat(input.kind);
  if (format === null) return null;
  const ext = format === "markdown" ? "md" : "toml";
  const base = input.projectDir
    ? join(input.projectDir, info.nativeProjectDir ?? join(info.dir, "agents"))
    : join(input.home, info.nativeDir ?? join(info.dir, "agents"));
  return join(base, `${input.name}.${ext}`);
}

/** The `tools` allowlist the `pi-subagents` extension expects. */
export function piToolsForLanes(lanes) {
  return lanes.includes("worker")
    ? "read, grep, find, ls, bash, edit, write"
    : "read, grep, find, ls, bash";
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
