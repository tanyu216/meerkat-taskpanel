/**
 * M5: project name → id resolution (ARCHITECTURE §4.8 ④).
 *
 * A card's `project:` is a registered name, not an id. These are the pure rules
 * the importer leans on; `import-hardening.test.mjs` proves the importer uses
 * them. Fixtures are synthetic (F9).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  loadProjectRegistry,
  normalizeProjectKey,
  parseProjectRegistry,
  resolveBuildinProject,
} from "../../src/core/storage/md/project-registry.mjs";

const REGISTRY = join(import.meta.dirname, "fixtures/registry/projects.json");

describe("md/project-registry — parsing", () => {
  it("reads the team's { projects: { key: {...} } } shape", () => {
    const registry = parseProjectRegistry(readFileSync(REGISTRY, "utf8"), { file: "projects.json" });
    assert.equal(registry.size, 3, "two file entries + the buildin __team__");
    const demo = registry.resolve("demo");
    assert.equal(demo.id, "demo");
    assert.equal(demo.name, "demo");
    assert.equal(demo.meta.kind, "code");
    assert.equal(demo.meta.default_git_rules, "explicit paths only");
    assert.deepEqual(demo.meta.guides, ["/tmp/meerkat-taskpanel-migrate-fixture/README.md"]);
    assert.equal(demo.meta.registered_key, "demo");
    // A registry `root` is ordinary metadata now (O3): carried verbatim into
    // `meta`, never interpreted as a project directory.
    assert.equal(demo.meta.root, "/tmp/meerkat-taskpanel-migrate-fixture");
    assert.equal("workspacePath" in demo, false, "the registry resolves no workspace path");
  });

  it("skips $-prefixed documentation keys", () => {
    const registry = parseProjectRegistry('{ "$schema_note": "x", "projects": { "a": {} } }');
    assert.equal(registry.size, 2, "the one file entry + the buildin __team__");
    assert.equal(registry.resolve("$schema_note"), null);
  });

  it("resolves the buildin __team__ project with no file entry", () => {
    const registry = parseProjectRegistry('{ "projects": { "A": {} } }');
    const team = registry.resolve("__team__");
    assert.equal(team.id, "__team__");
    assert.equal(team.name, "__team__");
    assert.equal(team.meta.buildin, true);
    assert.equal(team.meta.kind, "team");
    assert.equal("workspacePath" in team, false, "a buildin project carries no synthetic workspace anchor (O3)");
    assert.equal(registry.resolveById("__team__").id, "__team__", "resolvable by id too");
    assert.ok(registry.entries.some((entry) => entry.id === "__team__"), "listed in entries");
  });

  it("lets a file entry named __team__ override the buildin", () => {
    const registry = parseProjectRegistry('{ "projects": { "__team__": { "root": "/tmp/team-real" } } }');
    const team = registry.resolve("__team__");
    assert.equal(team.meta.root, "/tmp/team-real", "the file is the authority; its root is carried verbatim");
    assert.notEqual(team.meta.buildin, true);
  });

  it("exposes resolveBuildinProject for the no-registry-file path", () => {
    assert.equal(resolveBuildinProject("__team__").id, "__team__");
    assert.equal(resolveBuildinProject("__TEAM__").id, "__team__", "normalised");
    assert.equal(resolveBuildinProject("nope"), null);
    assert.equal(resolveBuildinProject(null), null);
  });

  it("accepts a bare name map, and carries workspace_path / workspacePath spellings into meta", () => {
    const registry = parseProjectRegistry(
      '{ "A": { "workspace_path": "/tmp/a" }, "B": { "workspacePath": "/tmp/b" } }',
    );
    assert.equal(registry.resolve("A").meta.workspace_path, "/tmp/a");
    assert.equal(registry.resolve("B").meta.workspacePath, "/tmp/b");
  });

  it("lets an explicit id/name override the key, and resolves both ways", () => {
    const registry = parseProjectRegistry('{ "project:a": { "id": "p-a", "name": "Alpha", "root": "/tmp/a" } }');
    assert.equal(registry.resolve("Alpha").id, "p-a", "by name");
    assert.equal(registry.resolve("project:a").id, "p-a", "by key");
    assert.equal(registry.resolve("p-a").id, "p-a", "by id (so an exported card re-imports)");
  });

  it("matches names ignoring case and whitespace (§4.4 normalisation)", () => {
    const registry = parseProjectRegistry('{ "projects": { "Meerkat TaskPanel": { "root": "/tmp/tp" } } }');
    for (const spelling of ["Meerkat TaskPanel", "meerkattaskpanel", "MEERKAT  TASKPANEL", "  meerkat taskpanel  "]) {
      assert.equal(registry.resolve(spelling)?.meta.root, "/tmp/tp", spelling);
    }
    assert.equal(normalizeProjectKey("Meerkat TaskPanel"), "meerkattaskpanel");
  });

  it("reports duplicate normalised names and keeps the first", () => {
    const registry = parseProjectRegistry('{ "projects": { "A": { "root": "/tmp/1" }, "a": { "root": "/tmp/2" } } }');
    assert.deepEqual(registry.duplicates, ["a"]);
    assert.equal(registry.resolve("A").meta.root, "/tmp/1");
  });

  it("returns null on a miss instead of inventing an entry", () => {
    const registry = parseProjectRegistry('{ "projects": { "A": {} } }');
    assert.equal(registry.resolve("nope"), null);
    assert.equal(registry.resolve(""), null);
    assert.equal(registry.resolve(null), null);
  });

  it("refuses text that is not a JSON object of projects", () => {
    for (const text of ["not json", "[]", '"a string"', '{"projects": []}']) {
      assert.throws(() => parseProjectRegistry(text, { file: "r.json" }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        return true;
      }, text);
    }
  });
});

describe("md/project-registry — loading", () => {
  it("loads the fixture file", () => {
    const registry = loadProjectRegistry(REGISTRY);
    assert.equal(registry.file, REGISTRY);
    assert.equal(registry.resolve("Widgets").meta.root, "/tmp/widgets-fixture");
  });

  it("turns an unreadable file into a DomainError, not an ENOENT stack", () => {
    assert.throws(() => loadProjectRegistry("/tmp/definitely-not-a-registry.json"), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.match(err.message, /could not read the project registry/);
      return true;
    });
  });
});
