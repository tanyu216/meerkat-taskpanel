#!/usr/bin/env node
/**
 * Contract check for the skill definition.
 *
 * `skills/task-dashboard/SKILL.md` must start with YAML frontmatter carrying
 *   name: task-dashboard
 * and a non-empty `description` of at least 20 characters (per the Agent Skills spec,
 * the description is what the host uses to decide when to load the skill).
 *
 * Node builtins only.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_PATH = "skills/task-dashboard/SKILL.md";
const EXPECTED_NAME = "task-dashboard";
const MIN_DESCRIPTION = 20;

/**
 * Best-effort scalar read from the frontmatter block (handles `key: value` on one line).
 * @param {string} frontmatter
 * @param {string} key
 * @returns {string|undefined}
 */
export function readFrontmatterValue(frontmatter, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const match = frontmatter.match(re);
  if (!match) return undefined;
  return match[1].trim().replace(/^["'](.*)["']$/, "$1").trim();
}

/**
 * Validate the skill file.
 * @param {string} [base] repository root
 * @returns {Promise<{ok: boolean, name?: string, description?: string, error?: string}>}
 */
export async function validateSkill(base = root) {
  let raw;
  try {
    raw = await readFile(join(base, SKILL_PATH), "utf8");
  } catch (err) {
    return {
      ok: false,
      error:
        err.code === "ENOENT"
          ? `file not found: ${SKILL_PATH}`
          : `${SKILL_PATH}: ${err.message}`,
    };
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { ok: false, error: "missing YAML frontmatter (file must start with ---)" };
  }

  const frontmatter = match[1];
  const name = readFrontmatterValue(frontmatter, "name");
  const description = readFrontmatterValue(frontmatter, "description");

  if (name !== EXPECTED_NAME) {
    return {
      ok: false,
      name,
      error: `frontmatter name must be "${EXPECTED_NAME}", got ${JSON.stringify(name)}`,
    };
  }

  if (!description || description.length < MIN_DESCRIPTION) {
    return {
      ok: false,
      name,
      description,
      error: `frontmatter description must be at least ${MIN_DESCRIPTION} characters`,
    };
  }

  return { ok: true, name, description };
}

async function main() {
  const result = await validateSkill();

  if (!result.ok) {
    console.error(`FAIL  ${SKILL_PATH}: ${result.error}`);
    console.error("\nskill: FAILED");
    return 1;
  }

  console.log(`OK    ${SKILL_PATH} (name=${result.name})`);
  console.log("\nskill: OK");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
