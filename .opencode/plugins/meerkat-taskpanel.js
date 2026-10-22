/**
 * Meerkat TaskPanel plugin for OpenCode.
 *
 * OpenCode is a *directory-granular* agent kind: it is handed a skills directory, not a list of
 * skill names, so pointing it at the repository's own `skills/` gives it both the board
 * skill and the loop skill. Nothing is copied — the directory is resolved from this file's
 * own location, so it follows the package wherever OpenCode fetched it.
 *
 * Dual-compatible with OpenCode V1 and V2, in the shape `obra/superpowers` ships
 * (`.opencode/plugins/superpowers.js` @ v7.0.0):
 *
 *   V1 — the named export, also exposed as `default.server`: a `config` hook pushes the
 *        directory into `config.skills.paths`.
 *   V2 — `default.setup(ctx)`: registers one Skill.Info per `skills/<name>/SKILL.md`
 *        through `ctx.skill.transform(draft => draft.add(...))`. V2 dropped the directory
 *        form, and its `config.skills` is a flat array, which is how the V1 hook tells the
 *        two generations apart and stands down.
 *
 * Registration only. This plugin injects no bootstrap message: the board's session-start
 * briefing belongs to the install side (`install.sh` writes it for claude / codex / pi) and
 * is not wired for OpenCode yet.
 *
 * No dependencies — Node builtins only, plain JavaScript, so it loads on both generations
 * without any install step of its own.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

/**
 * The `name` and `description` of one `SKILL.md`.
 *
 * Deliberately a small reader rather than a YAML parser: it handles the two fields this
 * plugin hands to the agent, including a quoted value and the block-scalar form
 * (`description: >` followed by indented lines) the skills actually use.
 *
 * @param {string} file absolute path to a SKILL.md
 * @returns {{name: string|null, description: string|null}}
 */
function readSkillFields(file) {
  const match = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { name: null, description: null };

  const fields = { name: null, description: null };
  let key = null;
  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/\r$/, "");
    const colon = line.indexOf(":");
    if (colon > 0 && !/^\s/.test(line)) {
      key = line.slice(0, colon).trim();
      // A block-scalar marker carries no value itself; the indented lines that follow do.
      fields[key] = /^[>|][+-]?$/.test(line.slice(colon + 1).trim()) ? "" : line.slice(colon + 1).trim();
    } else if (key !== null && line.trim() !== "" && fields[key] !== null) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }

  for (const field of ["name", "description"]) {
    if (typeof fields[field] !== "string" || fields[field] === "") fields[field] = null;
  }
  return { name: fields.name, description: fields.description };
}

/** Every `skills/<name>/SKILL.md` under {@link skillsDir}, as V2 Skill.Info payloads. */
function readSkills() {
  const skills = [];
  if (!fs.existsSync(skillsDir)) return skills;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;

    const { name, description } = readSkillFields(file);
    skills.push({
      id: entry.name,
      name: name ?? entry.name,
      ...(description === null ? {} : { description }),
      path: file,
      content: fs.readFileSync(file, "utf8"),
    });
  }
  return skills;
}

/**
 * V1 plugin function — discovered by named-export scanning, and also reachable as
 * `default.server` because V1 reads that one too.
 */
export const MeerkatTaskpanelPlugin = async () => ({
  // Hand OpenCode the directory in place, so it discovers the skills without a symlink
  // or a hand-edited `opencode.json`.
  config: async (config) => {
    // V2's `skills` is a flat array and `setup()` registers; only V1 takes paths.
    if (Array.isArray(config.skills)) return;

    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
  },
});

/** V2 setup — called by the V2 PluginSupervisor. */
async function setup(ctx) {
  // V1 also calls `default.setup`, with a context that has no skill domain. Stand down.
  if (!ctx?.skill || typeof ctx.skill.transform !== "function") return;

  const skills = readSkills();
  if (skills.length === 0) return;

  await ctx.skill.transform((draft) => {
    // `draft.add()` decodes against the agent's Skill.Info schema and throws synchronously
    // on a mismatch — and a throw escaping this callback hard-disables the whole plugin.
    // Contain a rejected payload to its own skill.
    for (const skill of skills) {
      try {
        draft.add(skill);
      } catch (err) {
        console.error(`[meerkat-taskpanel] skill "${skill.id}" rejected by the agent, skipping:`, err);
      }
    }
  });
}

/** V2 reads `{ id, setup }`; V1 reads the named export, and `server` for the same reason. */
export default {
  id: "meerkat-taskpanel",
  server: MeerkatTaskpanelPlugin,
  setup,
};
