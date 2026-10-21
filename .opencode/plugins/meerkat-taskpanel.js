/**
 * Meerkat TaskPanel plugin for OpenCode.
 *
 * OpenCode is a *directory-granular* host: it is handed a skills directory, not a list of
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
 * Registration plus one session-start injection: the per-repo issue-tracker check.
 * The instruction is authored once, in the board skill, and injected into the
 * first user message of a session (V1 `experimental.chat.messages.transform`,
 * V2 `ctx.session.hook('context', ...)`). It is deduped by its own marker, so a
 * compacted or resumed session never receives two copies.
 *
 * No dependencies — Node builtins only, plain JavaScript, so it loads on both generations
 * without any install step of its own.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasCheck, readIssueTrackerCheck } from "../../src/foundation/session-check.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillsDir = path.resolve(packageRoot, "skills");
const CHECK_TEXT = readIssueTrackerCheck(packageRoot);

/** The text parts of one message, in either host's shape. */
function partTexts(parts) {
  return Array.isArray(parts) ? parts.map((part) => part?.text) : [];
}

/**
 * V1 `experimental.chat.messages.transform` — messages carry `{ info, parts }`.
 * A throw escaping this hook would disable the plugin, so it is contained.
 */
async function injectIntoTransformedMessages(_input, output) {
  try {
    if (!CHECK_TEXT) return;
    const messages = Array.isArray(output?.messages) ? output.messages : [];
    const firstUser = messages.find((message) => message?.info?.role === "user");
    if (!firstUser) return;

    const parts = Array.isArray(firstUser.parts) ? firstUser.parts : (firstUser.parts = []);
    if (hasCheck(partTexts(parts))) return;
    parts.unshift({ type: "text", text: CHECK_TEXT });
  } catch (err) {
    console.error("[meerkat-taskpanel] issue-tracker check (V1) skipped:", err);
  }
}

/**
 * V2 `ctx.session.hook('context', ...)` — messages carry `{ role, content }`.
 * Same containment rule; same marker dedupe.
 */
async function injectIntoContext(event) {
  try {
    if (!CHECK_TEXT) return;
    const messages = Array.isArray(event?.messages) ? event.messages : null;
    if (!messages) return;

    const firstUser = messages.find((message) => message?.role === "user");
    if (firstUser) {
      const content = Array.isArray(firstUser.content) ? firstUser.content : (firstUser.content = []);
      if (hasCheck(partTexts(content))) return;
      content.unshift({ type: "text", text: CHECK_TEXT });
      return;
    }
    messages.push({ role: "user", content: [{ type: "text", text: CHECK_TEXT }] });
  } catch (err) {
    console.error("[meerkat-taskpanel] issue-tracker check (V2) skipped:", err);
  }
}

/**
 * The `name` and `description` of one `SKILL.md`.
 *
 * Deliberately a small reader rather than a YAML parser: it handles the two fields this
 * plugin hands to the host, including a quoted value and the block-scalar form
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

  // The per-repo issue-tracker check, injected once into the session's first user
  // message. Deduped by the instruction's own marker.
  "experimental.chat.messages.transform": injectIntoTransformedMessages,
});

/** V2 setup — called by the V2 PluginSupervisor. */
async function setup(ctx) {
  const hasSkills = Boolean(ctx?.skill && typeof ctx.skill.transform === "function");
  const hasSessions = Boolean(ctx?.session && typeof ctx.session.hook === "function");

  // V1 also calls `default.setup`, with a context that has neither domain. Stand down.
  if (!hasSkills && !hasSessions) return;

  // The session-start check does not depend on skill registration, so a host
  // whose skills are all rejected still gets it.
  if (hasSessions) {
    try {
      await ctx.session.hook("context", injectIntoContext);
    } catch (err) {
      console.error("[meerkat-taskpanel] could not register the issue-tracker check:", err);
    }
  }

  if (!hasSkills) return;

  const skills = readSkills();
  if (skills.length === 0) return;

  await ctx.skill.transform((draft) => {
    // `draft.add()` decodes against the host's Skill.Info schema and throws synchronously
    // on a mismatch — and a throw escaping this callback hard-disables the whole plugin.
    // Contain a rejected payload to its own skill.
    for (const skill of skills) {
      try {
        draft.add(skill);
      } catch (err) {
        console.error(`[meerkat-taskpanel] skill "${skill.id}" rejected by host, skipping:`, err);
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
