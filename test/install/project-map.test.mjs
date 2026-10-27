/**
 * The installer's project-map migration helper (unit level).
 *
 * The end-to-end behaviour lives in `kind-bundle.test.mjs`; this file pins the
 * merge rule itself — target wins, source-only entries are added, unknown keys
 * survive, the source is removed only after a successful write, and a file the
 * helper cannot interpret is left exactly where it is.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { PROJECT_MAP_FILENAME, migrateProjectMap } from "../../scripts/install/lib/project-map.mjs";

const dirs = [];
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-install-map-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A config root plus a source file outside it, each with the given document. */
function fixture(sourceDocument, targetDocument = null) {
  const into = makeDir();
  const sourceDir = makeDir();
  const from = join(sourceDir, "projects.json");
  if (sourceDocument !== null) writeFileSync(from, JSON.stringify(sourceDocument));
  const target = join(into, PROJECT_MAP_FILENAME);
  if (targetDocument !== null) writeFileSync(target, JSON.stringify(targetDocument));
  return { into, from, target };
}

describe("install/lib/project-map — migrateProjectMap", () => {
  it("adopts the source when the target is absent, then removes the source", () => {
    const { into, from, target } = fixture({
      note: "root-kept",
      projects: [{ project: "A", local_path: "/a", kind: "ops" }],
    });

    const result = migrateProjectMap({ into, from, label: "claude" });
    assert.equal(result.status, 0, result.message);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
      note: "root-kept",
      projects: [{ project: "A", local_path: "/a", kind: "ops" }],
    });
    assert.equal(existsSync(from), false);
    assert.match(result.message, /1 added, 0 kept, 0 skipped/);
  });

  it("merges into an existing map: the target wins and its top-level keys survive", () => {
    const { into, from, target } = fixture(
      {
        projects: [
          { project: "A", local_path: "/old" },
          { project: "B", run_dir: "/pad" },
        ],
      },
      {
        note: "target-kept",
        projects: [{ project: "A", local_path: "/new", kind: "ops" }],
      },
    );

    const result = migrateProjectMap({ into, from });
    assert.equal(result.status, 0, result.message);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
      note: "target-kept",
      projects: [
        { project: "A", local_path: "/new", kind: "ops" },
        { project: "B", run_dir: "/pad" },
      ],
    });
    assert.equal(existsSync(from), false);
    assert.match(result.message, /1 added, 1 kept, 0 skipped/);
  });

  it("leaves a malformed source in place and never creates a target", () => {
    const into = makeDir();
    const sourceDir = makeDir();
    const from = join(sourceDir, "projects.json");
    writeFileSync(from, '{"demo":{"local_path":"/tmp/demo"}}');

    const result = migrateProjectMap({ into, from });
    assert.equal(result.status, 3);
    assert.match(result.message, /not a project map/);
    assert.equal(existsSync(from), true);
    assert.equal(existsSync(join(into, PROJECT_MAP_FILENAME)), false);
  });

  it("leaves the source in place when the target itself is malformed", () => {
    const into = makeDir();
    const sourceDir = makeDir();
    const from = join(sourceDir, "projects.json");
    writeFileSync(from, JSON.stringify({ projects: [{ project: "A" }] }));
    writeFileSync(join(into, PROJECT_MAP_FILENAME), "{ not json");

    const result = migrateProjectMap({ into, from });
    assert.equal(result.status, 3);
    assert.equal(existsSync(from), true);
  });

  it("changes nothing on a dry run", () => {
    const { into, from, target } = fixture({ projects: [{ project: "A" }] });
    const result = migrateProjectMap({ into, from, dryRun: true });
    assert.equal(result.status, 0);
    assert.match(result.message, /would migrate/);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(from), true);
  });

  it("is a no-op for a missing source, or when source and target are the same file", () => {
    const into = makeDir();
    const missing = migrateProjectMap({ into, from: join(makeDir(), "projects.json") });
    assert.equal(missing.status, 0);
    assert.equal(missing.message, "");

    const target = join(into, PROJECT_MAP_FILENAME);
    writeFileSync(target, JSON.stringify({ projects: [] }));
    const same = migrateProjectMap({ into, from: target });
    assert.equal(same.status, 0);
    assert.equal(existsSync(target), true);
  });
});
