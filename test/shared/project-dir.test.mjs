/**
 * The host-local project → directory rule (`src/shared/project-dir.mjs`).
 *
 * The board holds no directory (O3), so "which directory does this project work
 * in?" is answered by `projects.json` — and the answer must be *validated*, not
 * trusted: a target directory that is absent, relative, or not a directory must
 * stop the caller instead of starting a worker somewhere unintended.
 *
 * The filesystem is injected, so every branch here runs without a disk.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROJECT_DIR_CODES,
  checkTargetDirectory,
  parseProjectMap,
  resolveProjectDir,
} from "../../src/shared/project-dir.mjs";

/** An `inspect` that answers from a fixed table. */
const kinds = (table) => (path) => table[path] ?? "missing";

const FILE = "/etc/projects.json";

describe("checkTargetDirectory (required + absolute + exists + directory)", () => {
  it("refuses a missing directory (nothing registered at all)", () => {
    for (const value of [undefined, null, "", "   ", 42, { path: "/tmp" }]) {
      const result = checkTargetDirectory(value, { project: "demo", file: FILE });
      assert.equal(result.ok, false);
      assert.equal(result.code, PROJECT_DIR_CODES.REQUIRED, `${JSON.stringify(value)} must be REQUIRED`);
      assert.match(result.message, /no target directory is registered for project demo/);
    }
  });

  it("refuses a relative path (a directory the board would have to interpret)", () => {
    const result = checkTargetDirectory("code/demo", { project: "demo", inspect: kinds({}), file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.NOT_ABSOLUTE);
    assert.match(result.message, /is not an absolute path/);
  });

  it("refuses an absolute path that is not there (a moved checkout)", () => {
    const result = checkTargetDirectory("/gone/demo", { project: "demo", inspect: kinds({}), file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.MISSING);
    assert.match(result.message, /does not exist/);
  });

  it("refuses a path that exists but is not a directory", () => {
    const inspect = kinds({ "/tmp/demo": "file" });
    const result = checkTargetDirectory("/tmp/demo", { project: "demo", inspect, file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.NOT_A_DIRECTORY);
    assert.match(result.message, /is not a directory/);
  });

  it("accepts an absolute path that is a directory", () => {
    const inspect = kinds({ "/tmp/demo": "directory" });
    const result = checkTargetDirectory("/tmp/demo", { project: "demo", inspect, file: FILE });
    assert.deepEqual(result, { ok: true, dir: "/tmp/demo" });
  });
});

describe("parseProjectMap", () => {
  it("reads the documented shape and ignores non-object entries", () => {
    const parsed = parseProjectMap(
      JSON.stringify({ projects: [{ project: "demo", local_path: "/tmp/demo" }, "junk", null, 7] }),
      { file: FILE },
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.entries, [{ project: "demo", local_path: "/tmp/demo" }]);
  });

  it("refuses text that is not JSON rather than reading it as an empty map", () => {
    const parsed = parseProjectMap("{ projects: nope", { file: FILE });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, PROJECT_DIR_CODES.MAP_UNREADABLE);
    assert.match(parsed.message, /not valid JSON/);
  });

  it("refuses a JSON document with no `projects` array", () => {
    for (const text of ["{}", "[]", '{"projects": {}}', "null"]) {
      const parsed = parseProjectMap(text, { file: FILE });
      assert.equal(parsed.ok, false, `${text} must be unreadable`);
      assert.equal(parsed.code, PROJECT_DIR_CODES.MAP_UNREADABLE);
    }
  });
});

describe("resolveProjectDir (project identity → local directory)", () => {
  const entries = [
    { project: "demo", local_path: "/code/demo" },
    { project: "other", local_path: "/code/other" },
  ];
  const inspect = kinds({ "/code/demo": "directory", "/code/other": "directory" });

  it("resolves a registered project to its directory", () => {
    const result = resolveProjectDir({ entries, project: "demo", inspect, file: FILE });
    assert.equal(result.ok, true);
    assert.equal(result.dir, "/code/demo");
    assert.equal(result.project, "demo");
  });

  it("is unmapped — not a guess — when the project has no entry", () => {
    const result = resolveProjectDir({ entries, project: "nope", inspect, file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.UNMAPPED);
    assert.match(result.message, /no local directory is registered for project nope/);
  });

  it("is unmapped when no identity was given at all", () => {
    for (const project of ["", "  ", null, undefined, 7]) {
      const result = resolveProjectDir({ entries, project, inspect, file: FILE });
      assert.equal(result.ok, false);
      assert.equal(result.code, PROJECT_DIR_CODES.UNMAPPED);
    }
  });

  it("validates the entry's directory — a registered but unusable path fails", () => {
    const broken = [{ project: "demo", local_path: "relative/demo" }];
    const result = resolveProjectDir({ entries: broken, project: "demo", inspect, file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.NOT_ABSOLUTE);
    assert.equal(result.project, "demo");
  });

  it("carries no entry with it when it fails", () => {
    const result = resolveProjectDir({ entries, project: "nope", inspect, file: FILE });
    assert.equal(Object.hasOwn(result, "entry"), false);
  });
});
