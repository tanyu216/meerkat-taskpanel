/**
 * `route-role.mjs` — moving a role skill between agent platforms.
 *
 * Installation location is the routing, so a move is a copy plus, only on an
 * explicit confirmation, a deletion of the source. These tests pin the safety
 * rules: never delete without `--confirm-remove`, never touch a role that was
 * not named, report a re-run unchanged, and never overwrite a differing target
 * without `--force`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  carryingKinds,
  roleAt,
  routeRole,
} from "../../skills/setup-meerkat/scripts/route-role.mjs";

const dirs = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tp-route-role-"));
  dirs.push(home);
  writeRole(home, ".claude", "turing");
  writeRole(home, ".claude", "jobs");
  return { home };
}

function writeRole(home, dir, id, extra = "") {
  const skill = join(home, dir, "skills", id);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "role.json"), JSON.stringify({ schema: "meerkat-role", id, agent: id, lanes: ["worker"] }));
  writeFileSync(join(skill, "SKILL.md"), `# ${id}\n${extra}`);
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("route-role", () => {
  it("copies the named role to the target kind and keeps the source by default", () => {
    const f = fixture();
    const report = routeRole({ home: f.home, role: "turing", to: "codex" });
    assert.equal(report.ok, true);
    assert.deepEqual(carryingKinds(f.home, "turing"), ["claude", "codex"]);
    assert.equal(existsSync(join(f.home, ".codex", "skills", "turing", "SKILL.md")), true);
    assert.equal(existsSync(join(f.home, ".claude", "skills", "turing", "SKILL.md")), true, "the source is kept");
    assert.equal(report.kept, true);
  });

  it("removes the source only when --confirm-remove says so", () => {
    const f = fixture();
    routeRole({ home: f.home, role: "turing", to: "codex", confirmRemove: true });
    assert.equal(roleAt(f.home, ".claude", "turing"), null);
    assert.notEqual(roleAt(f.home, ".codex", "turing"), null);
    assert.notEqual(roleAt(f.home, ".claude", "jobs"), null, "an unnamed role is untouched");
  });

  it("a dry run never copies or removes", () => {
    const f = fixture();
    const report = routeRole({ home: f.home, role: "turing", to: "codex", dryRun: true, confirmRemove: true });
    assert.equal(report.removed, null);
    assert.equal(existsSync(join(f.home, ".codex", "skills", "turing")), false);
    assert.notEqual(roleAt(f.home, ".claude", "turing"), null);
  });

  it("reports a second identical move as unchanged", () => {
    const f = fixture();
    routeRole({ home: f.home, role: "turing", to: "codex" });
    const report = routeRole({ home: f.home, role: "turing", to: "codex" });
    assert.equal(report.ok, true);
    assert.equal(report.changed.length, 0);
    assert.equal(report.unchanged.length, 1);
  });

  it("refuses to overwrite a differing target without --force", () => {
    const f = fixture();
    writeRole(f.home, ".codex", "turing", "different\n");
    const report = routeRole({ home: f.home, role: "turing", to: "codex" });
    assert.equal(report.ok, false);
    assert.match(report.error, /target differs/);
    assert.match(readFileSync(join(f.home, ".codex", "skills", "turing", "SKILL.md"), "utf8"), /different/);
  });

  it("reports an unknown role and an unknown kind instead of throwing", () => {
    const f = fixture();
    assert.match(routeRole({ home: f.home, role: "ghost", to: "codex" }).error, /no kind carries/);
    assert.match(routeRole({ home: f.home, role: "turing", to: "openclaw" }).error, /unknown target kind/);
  });
});
