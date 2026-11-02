#!/usr/bin/env node
/**
 * List the role skills this repository ships — the installer's one role inventory.
 *
 * A role is a skill directory carrying `role.json` with the `meerkat-role` marker.
 * The installer used to name the five standard roles inline; that list drifted
 * from what the runtime actually discovers the moment a role was added. This
 * lister reads the same marker `native-agents.mjs` and the supervisor read, so a
 * new role is installed, packaged and validated with no installer edit.
 *
 * Usage:
 *   node scripts/install/lib/role-skills.mjs --list   # directory names, one per line
 *   node scripts/install/lib/role-skills.mjs --json   # [{dir, id, agent, lanes, ...}]
 *
 * Node builtins only.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../../../src/foundation/entry-guard.mjs";
import { readRoleSkill } from "./native-agents.mjs";

const USAGE = `Usage: node scripts/install/lib/role-skills.mjs --list | --json

  --list  Role skill directory names, one per line.
  --json  The same set with the identity fields the installers read.`;

/** The repository root, derived from this file's location. */
export function repoRoot(here = import.meta.url) {
  return resolve(dirname(fileURLToPath(here)), "../../..");
}

/**
 * Every role skill in `<repo>/skills`, sorted by directory name.
 *
 * @param {string} repo repository root
 * @returns {{dir: string, id: string, agent: string, nativeAgent: string, lanes: string[]}[]}
 */
export function listRoleSkills(repo = repoRoot()) {
  const skillsDir = join(repo, "skills");
  if (!existsSync(skillsDir)) return [];
  const roles = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const role = readRoleSkill(join(skillsDir, entry.name));
    if (role === null || role.id === "") continue;
    roles.push({
      dir: entry.name,
      id: role.id,
      agent: role.agent,
      nativeAgent: role.native_agent,
      lanes: role.lanes,
    });
  }
  return roles.sort((a, b) => a.dir.localeCompare(b.dir));
}

function main(argv) {
  const mode = argv[0];
  if (mode === "-h" || mode === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (mode !== "--list" && mode !== "--json") {
    process.stderr.write(`role-skills: expected --list or --json\n${USAGE}\n`);
    return 2;
  }
  const roles = listRoleSkills();
  if (mode === "--json") {
    process.stdout.write(`${JSON.stringify(roles, null, 2)}\n`);
  } else {
    for (const role of roles) process.stdout.write(`${role.dir}\n`);
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
