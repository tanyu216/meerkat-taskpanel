/**
 * The OpenCode plugin, driven directly.
 *
 * OpenCode is not installed here, and the container ships no host CLIs at all, so the
 * *host integration* cannot be run from this repository. The plugin's own logic, however,
 * is plain JavaScript with no host dependency — so this drives it against a fake plugin
 * context and pins what it hands over: the V1 config hook's path list, and the V2 draft
 * payloads. That is the half that can be proved here; the half that cannot is named in
 * `docs/install.md`.
 *
 * Run with: `node --test`
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import plugin, { MeerkatTaskpanelPlugin } from "../../.opencode/plugins/meerkat-taskpanel.js";
import { LOOP_SKILL_NAME } from "../../scripts/sync-loop.mjs";
import { SKILL_NAME } from "../../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS_DIR = join(ROOT, "skills");

/** Run the V1 `config` hook against a config object and return it. */
async function runConfigHook(config) {
  const hooks = await MeerkatTaskpanelPlugin({ client: {}, directory: ROOT });
  await hooks.config(config);
  return config;
}

/** Collect the payloads the V2 `setup` hands the host's skill draft. */
async function collectRegisteredSkills() {
  const added = [];
  const ctx = {
    skill: {
      transform: async (fn) => fn({ add: (skill) => added.push(skill) }),
    },
  };
  await plugin.setup(ctx);
  return added;
}

describe("opencode plugin — exports", () => {
  it("carries the V2 id/setup and re-exposes the V1 function as `server`", () => {
    assert.equal(plugin.id, SKILL_NAME);
    assert.equal(typeof plugin.setup, "function");
    assert.equal(plugin.server, MeerkatTaskpanelPlugin);
  });
});

describe("opencode plugin — V1 config hook", () => {
  it("hands OpenCode the repository's own skills directory, in place", async () => {
    const config = await runConfigHook({});

    assert.deepEqual(config.skills.paths, [SKILLS_DIR]);
    // The whole point: this is the checkout's `skills/`, not a copy made for OpenCode.
    assert.equal(config.skills.paths[0], join(ROOT, "skills"));
  });

  it("keeps an existing paths list and does not add itself twice", async () => {
    const config = await runConfigHook({ skills: { paths: ["/somewhere/else"] } });
    assert.deepEqual(config.skills.paths, ["/somewhere/else", SKILLS_DIR]);

    await (await MeerkatTaskpanelPlugin({ client: {}, directory: ROOT })).config(config);
    assert.deepEqual(config.skills.paths, ["/somewhere/else", SKILLS_DIR]);
  });

  it("stands down on a V2-shaped config, where skills is a flat array", async () => {
    const config = await runConfigHook({ skills: [] });
    assert.deepEqual(config.skills, [], "V2 registration belongs to setup(), not the hook");
  });
});

describe("opencode plugin — V2 setup", () => {
  it("registers both skills, with the frontmatter the host reads", async () => {
    const skills = await collectRegisteredSkills();

    assert.deepEqual(
      skills.map((skill) => skill.id).sort(),
      [LOOP_SKILL_NAME, SKILL_NAME].sort(),
    );

    for (const skill of skills) {
      assert.equal(skill.name, skill.id, `${skill.id}: name comes from the frontmatter`);
      assert.equal(typeof skill.description, "string");
      assert.ok(skill.description.length >= 20, `${skill.id}: description must be substantial`);
      assert.ok(skill.path.endsWith(join(skill.id, "SKILL.md")), `${skill.id}: path`);
      assert.ok(skill.content.length > 0, `${skill.id}: content is carried inline`);
      // Registered from the shared tree, never from a copy.
      assert.ok(skill.path.startsWith(SKILLS_DIR), `${skill.id}: read from the one skills/ tree`);
    }
  });

  it("runs a block-scalar description through the reader, not just a plain one", async () => {
    // `meerkat-loop`'s description is written as `description: >` with indented lines;
    // a reader that only handled `key: value` would hand the host a bare ">".
    const skills = await collectRegisteredSkills();
    const loop = skills.find((skill) => skill.id === LOOP_SKILL_NAME);
    assert.notEqual(loop.description, ">");
    assert.ok(loop.description.length > 40, `expected a folded description, got ${JSON.stringify(loop.description)}`);
  });

  it("returns quietly on a V1-shaped context, which has no skill domain", async () => {
    await plugin.setup({});
    await plugin.setup(undefined);
    await plugin.setup({ skill: {} });
    assert.ok(true, "none of these may throw");
  });

  it("a skill the host rejects does not take the others down with it", async () => {
    const added = [];
    const ctx = {
      skill: {
        transform: async (fn) =>
          fn({
            add: (skill) => {
              if (skill.id === SKILL_NAME) throw new Error("rejected by the host");
              added.push(skill.id);
            },
          }),
      },
    };

    await plugin.setup(ctx);
    assert.deepEqual(added, [LOOP_SKILL_NAME], "the surviving skill is still registered");
  });
});
