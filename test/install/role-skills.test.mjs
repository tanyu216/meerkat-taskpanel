/**
 * The installer's role inventory is **data**, read from `role.json` — the same
 * marker the supervisor and the native-agent generator read.
 *
 * The defect this pins: the installer named the five roles inline while the
 * runtime had already moved to discovery, so a shipped sixth role would be
 * packaged and routable but never installed.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { listRoleSkills } from "../../scripts/install/lib/role-skills.mjs";
import { REQUIRED, discoverRoleSkillDirs } from "../../scripts/release/pack-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A minimal skill directory: `role.json` (optional) and `SKILL.md`. */
function skillRepo(roles) {
  const repo = tempDir("tp-role-skills-");
  for (const [name, role] of Object.entries(roles)) {
    const dir = join(repo, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    if (role !== null) writeFileSync(join(dir, "role.json"), JSON.stringify(role), "utf8");
  }
  return repo;
}

const roleJson = (id, agent = id) => ({
  schema: "meerkat-role",
  id,
  agent,
  native_agent: id,
  lanes: ["worker"],
  shapes: ["a shape"],
});

describe("role-skills — the repository's role inventory", () => {
  it("lists exactly the five standard role skills", () => {
    assert.deepEqual(
      listRoleSkills(ROOT).map((role) => role.dir),
      ["jobs", "linus", "reviewer", "turing", "worker"],
    );
  });

  it("finds a new role from role.json and ignores a non-role skill", () => {
    const repo = skillRepo({
      jobs: roleJson("jobs", "Jobs"),
      ops: roleJson("ops", "Ops"),
      notes: null, // a skill without the marker is not a role
      hidden: roleJson("hidden", "Hidden"),
    });
    // A dot-directory is never a role, even with a marker.
    mkdirSync(join(repo, "skills", ".cache"), { recursive: true });
    writeFileSync(join(repo, "skills", ".cache", "role.json"), JSON.stringify(roleJson("cache", "Cache")), "utf8");

    assert.deepEqual(listRoleSkills(repo).map((role) => role.dir), ["hidden", "jobs", "ops"]);
  });

  it("returns no roles for a tree that does not exist", () => {
    assert.deepEqual(listRoleSkills(join(tempDir("tp-role-none-"), "missing")), []);
  });
});

describe("role-skills — the install and package inventories", () => {
  it("the shell installer discovers roles from role.json and hard-codes none", () => {
    const source = readFileSync(join(ROOT, "scripts/install/_common.sh"), "utf8");
    // Shell-only: a node spawn here would be intercepted by the node-check tests'
    // fake `node`, which answers `-v` and nothing else.
    assert.match(source, /for dir in "\$\(repo_root\)"\/skills\/\*\/; do/);
    assert.match(source, /"meerkat-role"/);
    assert.doesNotMatch(
      source,
      /role_skill_names\(\)\s*\{[^}]*\bjobs\b[^}]*\blinus\b/,
      "the role names must not be a second inventory in the shell",
    );
  });

  it("the release manifest requires every discovered role's SKILL.md and role.json", () => {
    const roles = discoverRoleSkillDirs(ROOT);
    assert.deepEqual(roles, ["jobs", "linus", "reviewer", "turing", "worker"]);
    for (const role of roles) {
      assert.ok(REQUIRED.includes(`skills/${role}/SKILL.md`), `${role}: SKILL.md`);
      assert.ok(REQUIRED.includes(`skills/${role}/role.json`), `${role}: role.json (the discovery marker)`);
    }
  });

  it("discovers a role added to a temp tree", () => {
    const repo = skillRepo({ jobs: roleJson("jobs", "Jobs"), ops: roleJson("ops", "Ops") });
    assert.deepEqual(discoverRoleSkillDirs(repo), ["jobs", "ops"]);
  });
});
