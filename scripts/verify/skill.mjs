#!/usr/bin/env node
/**
 * Contract check for the skill definitions.
 *
 * Every skill in {@link SKILLS} must start with YAML frontmatter carrying
 *   name: <directory name>
 * and a non-empty `description` of at least 20 characters (per the Agent Skills spec,
 * the description is what the host uses to decide when to load the skill).
 *
 * The board and loop skills go to the agent kinds that fit them; `setup-meerkat` is the
 * Claude-only install/repair command. All three live in the one `skills/` tree.
 *
 * Node builtins only.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The skills shipped from `skills/`, in the order this checker reports them. */
export const SKILLS = Object.freeze(["meerkat-taskpanel", "meerkat-loop", "setup-meerkat"]);

const MIN_DESCRIPTION = 20;

/**
 * Repository-relative path to one skill's definition.
 * @param {string} skill skill directory name
 * @returns {string}
 */
export function skillPath(skill) {
  return `skills/${skill}/SKILL.md`;
}

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
 * Validate one skill file.
 * @param {string} [base] repository root
 * @param {string} [skill] skill directory name (the expected frontmatter name)
 * @returns {Promise<{ok: boolean, skill: string, name?: string, description?: string, error?: string}>}
 */
export async function validateSkill(base = root, skill = SKILLS[0]) {
  const rel = skillPath(skill);
  let raw;
  try {
    raw = await readFile(join(base, rel), "utf8");
  } catch (err) {
    return {
      ok: false,
      skill,
      error:
        err.code === "ENOENT"
          ? `file not found: ${rel}`
          : `${rel}: ${err.message}`,
    };
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { ok: false, skill, error: "missing YAML frontmatter (file must start with ---)" };
  }

  const frontmatter = match[1];
  const name = readFrontmatterValue(frontmatter, "name");
  const description = readFrontmatterValue(frontmatter, "description");

  if (name !== skill) {
    return {
      ok: false,
      skill,
      name,
      error: `frontmatter name must be "${skill}", got ${JSON.stringify(name)}`,
    };
  }

  if (!description || description.length < MIN_DESCRIPTION) {
    return {
      ok: false,
      skill,
      name,
      description,
      error: `frontmatter description must be at least ${MIN_DESCRIPTION} characters`,
    };
  }

  return { ok: true, skill, name, description };
}

/**
 * Validate every shipped skill.
 * @param {string} [base] repository root
 * @param {string[]} [skills] skill names to check
 * @returns {Promise<{ok: boolean, results: Array<Awaited<ReturnType<typeof validateSkill>>>}>}
 */
export async function validateSkills(base = root, skills = SKILLS) {
  const results = [];
  for (const skill of skills) results.push(await validateSkill(base, skill));
  return { ok: results.every((result) => result.ok), results };
}

async function main() {
  const { ok, results } = await validateSkills();

  for (const result of results) {
    const rel = skillPath(result.skill);
    if (result.ok) {
      console.log(`OK    ${rel} (name=${result.name})`);
    } else {
      console.error(`FAIL  ${rel}: ${result.error}`);
    }
  }

  console.log(ok ? "\nskill: OK" : "\nskill: FAILED");
  return ok ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}
