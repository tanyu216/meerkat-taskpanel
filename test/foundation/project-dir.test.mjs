/**
 * The host-local project → directory rule (`src/foundation/project-dir.mjs`).
 *
 * The board holds no directory (O3), so "which directory does this project work
 * in?" is answered by `projects.json` — and the answer must be *validated*, not
 * trusted: a directory that is relative, missing or not a directory must stop
 * the caller instead of starting a worker somewhere unintended.
 *
 * Three answers, and they must stay distinguishable:
 *
 *   * an **entry** naming a usable directory → that directory;
 *   * an **entry** naming none (`local_path`/`run_dir` both unset) → `dir: null`:
 *     a complete answer for a project that has no local directory at all;
 *   * **no entry** at all → `PROJECT_DIR_UNMAPPED`, the "ask the user" case.
 *
 * The filesystem is injected, so every branch here runs without a disk.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  PROJECT_DIR_CODES,
  checkTargetDirectory,
  defaultProjectsJson,
  mergeProjectEntries,
  parseProjectMap,
  parseProjectMapDocument,
  readProjectMapForEdit,
  removeProjectEntry,
  resolveProjectDir,
  resolveWakeDir,
  upsertProjectEntry,
  writeProjectMap,
} from "../../src/foundation/project-dir.mjs";

/** An `inspect` that answers from a fixed table. */
const kinds = (table) => (path) => table[path] ?? "missing";

const FILE = "/etc/projects.json";

describe("checkTargetDirectory (usable + absolute + exists + directory)", () => {
  it("refuses a value that is not a usable path, naming the key that carried it", () => {
    for (const value of [undefined, null, "", "   ", 42, { path: "/tmp" }]) {
      const result = checkTargetDirectory(value, { project: "demo", file: FILE });
      assert.equal(result.ok, false);
      assert.equal(result.code, PROJECT_DIR_CODES.REQUIRED, `${JSON.stringify(value)} must be REQUIRED`);
      assert.match(result.message, /no usable directory for project demo/);
      assert.match(result.message, /`local_path`/, "the default key is named");
    }
  });

  it("names the key it was handed — a broken `run_dir` is not reported as `local_path`", () => {
    const result = checkTargetDirectory("  ", { key: "run_dir", project: "demo", file: FILE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.REQUIRED);
    assert.match(result.message, /`run_dir`/);
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

  it("takes `run_dir` as the directory when the entry names no local_path", () => {
    const result = resolveProjectDir({
      entries: [{ project: "ops", run_dir: "/launch/ops" }],
      project: "ops",
      inspect: kinds({ "/launch/ops": "directory" }),
      file: FILE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.dir, "/launch/ops");
    assert.equal(result.entry.run_dir, "/launch/ops");
  });

  it("skips non-object entries instead of crashing on a hand-written stray", () => {
    const result = resolveProjectDir({
      entries: [null, "stray", { project: "demo", local_path: "/demo" }],
      project: "demo",
      inspect: kinds({ "/demo": "directory" }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dir, "/demo");
  });

  it("answers `dir: null` — a complete answer, not a failure — when the entry names no directory at all", () => {
    const result = resolveProjectDir({
      entries: [{ project: "ops", kind: "ops", notes: "keeps nothing on disk" }],
      project: "ops",
      inspect,
      file: FILE,
    });
    assert.equal(result.ok, true, "a project with no local directory is not an error");
    assert.equal(result.dir, null);
    assert.equal(result.project, "ops");
    assert.equal(result.entry.notes, "keeps nothing on disk", "the entry comes back whole, metadata included");
  });

  it("prefers `local_path` when the entry carries both keys", () => {
    const result = resolveProjectDir({
      entries: [{ project: "demo", local_path: "/code/demo", run_dir: "/launch/demo" }],
      project: "demo",
      inspect: kinds({ "/code/demo": "directory", "/launch/demo": "directory" }),
      file: FILE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.dir, "/code/demo");
  });

  it("falls through a null local_path to run_dir, but a blank one never falls back", () => {
    const inspect = kinds({ "/launch/demo": "directory" });
    const explicitNull = resolveProjectDir({
      entries: [{ project: "demo", local_path: null, run_dir: "/launch/demo" }],
      project: "demo",
      inspect,
      file: FILE,
    });
    assert.equal(explicitNull.ok, true);
    assert.equal(explicitNull.dir, "/launch/demo", "null is 'not given'");

    const blank = resolveProjectDir({
      entries: [{ project: "demo", local_path: "", run_dir: "/launch/demo" }],
      project: "demo",
      inspect,
      file: FILE,
    });
    assert.equal(blank.ok, false, "a supplied-but-blank path is a failure, never a silent fallback");
    assert.equal(blank.code, PROJECT_DIR_CODES.REQUIRED);
    assert.match(blank.message, /`local_path`/);
  });

  it("validates run_dir exactly like a local_path, and names it in the failure", () => {
    const cases = [
      ["relative/ops", PROJECT_DIR_CODES.NOT_ABSOLUTE],
      ["/gone/ops", PROJECT_DIR_CODES.MISSING],
      ["/file/ops", PROJECT_DIR_CODES.NOT_A_DIRECTORY],
    ];
    for (const [run_dir, code] of cases) {
      const result = resolveProjectDir({
        entries: [{ project: "ops", run_dir }],
        project: "ops",
        inspect: kinds({ "/file/ops": "file" }),
        file: FILE,
      });
      assert.equal(result.ok, false, `${run_dir} must fail`);
      assert.equal(result.code, code, `${run_dir} must be ${code}`);
      assert.match(result.message, /`run_dir`/, "the failure names run_dir, not local_path");
    }
  });
});

describe("resolveWakeDir (the worker's cwd, or a coded refusal)", () => {
  const mapText = JSON.stringify({ projects: [{ project: "demo", local_path: "/code/demo" }] });
  const readMap = (text) => () => text;
  const inspect = kinds({ "/code/demo": "directory" });

  it("resolves a registered project without asking a board", () => {
    const result = resolveWakeDir({
      project: "demo",
      projectsJson: FILE,
      read: readMap(mapText),
      inspect,
    });
    assert.deepEqual(result, { ok: true, dir: "/code/demo" });
  });

  it("refuses an unmapped project", () => {
    const result = resolveWakeDir({
      project: "nope",
      projectsJson: FILE,
      read: readMap(mapText),
      inspect,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.UNMAPPED);
  });

  it("refuses an entry that names no directory — a wake needs one", () => {
    const result = resolveWakeDir({
      project: "ops",
      projectsJson: FILE,
      read: readMap(JSON.stringify({ projects: [{ project: "ops" }] })),
      inspect,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.REQUIRED);
  });

  it("reports an unreadable map instead of resolving nothing", () => {
    const result = resolveWakeDir({
      project: "demo",
      projectsJson: FILE,
      read: () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
      inspect,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.MAP_UNREADABLE);
  });
});

describe("defaultProjectsJson (one machine-local map at the config root)", () => {
  it("names projects.json under an injected program root", () => {
    assert.equal(
      defaultProjectsJson({}, { root: "/opt/tree" }),
      join("/opt/tree", "projects.json"),
    );
  });

  it("follows MEERKAT_TASKPANEL_CONFIG_DIR, resolving a relative value against cwd", () => {
    assert.equal(
      defaultProjectsJson({ MEERKAT_TASKPANEL_CONFIG_DIR: "/srv/cfg" }, { root: "/opt/tree" }),
      join("/srv/cfg", "projects.json"),
    );
    assert.equal(
      defaultProjectsJson({ MEERKAT_TASKPANEL_CONFIG_DIR: "cfg" }, { root: "/opt/tree", cwd: "/work" }),
      join("/work/cfg", "projects.json"),
    );
  });

  it("ignores the retired MEERKAT_TASKPANEL_PROJECTS_JSON key", () => {
    assert.equal(
      defaultProjectsJson(
        { MEERKAT_TASKPANEL_PROJECTS_JSON: "/tmp/map.json" },
        { root: "/opt/tree" },
      ),
      join("/opt/tree", "projects.json"),
    );
  });
});

describe("parseProjectMapDocument (raw, so a write can preserve unknown keys)", () => {
  it("returns the raw root object and the raw projects array", () => {
    const text = JSON.stringify({
      schema: "keep-me",
      projects: [{ project: "A", local_path: "/a" }, "stray", null],
    });
    const document = parseProjectMapDocument(text, { file: FILE });
    assert.equal(document.ok, true);
    assert.equal(document.root.schema, "keep-me");
    assert.deepEqual(document.projects, [{ project: "A", local_path: "/a" }, "stray", null]);
  });

  it("refuses malformed JSON and a missing projects array", () => {
    for (const text of ["{ not json", "{}", '{"projects":{}}', "null"]) {
      assert.equal(
        parseProjectMapDocument(text, { file: FILE }).code,
        PROJECT_DIR_CODES.MAP_UNREADABLE,
      );
    }
  });
});

describe("readProjectMapForEdit", () => {
  it("treats a missing file as an empty map", () => {
    const result = readProjectMapForEdit(FILE, {
      read: () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });
    assert.deepEqual(result, {
      ok: true,
      present: false,
      root: {},
      projects: [],
      file: FILE,
    });
  });

  it("returns the raw document when the file exists", () => {
    const result = readProjectMapForEdit(FILE, {
      read: () => '{"note":"x","projects":[{"project":"A"}]}',
    });
    assert.equal(result.ok, true);
    assert.equal(result.present, true);
    assert.equal(result.root.note, "x");
    assert.deepEqual(result.projects, [{ project: "A" }]);
  });

  it("refuses a malformed file rather than starting from an empty map", () => {
    const result = readProjectMapForEdit(FILE, { read: () => "{ nope" });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.MAP_UNREADABLE);
  });
});

describe("upsertProjectEntry (the pure write rule)", () => {
  it("appends a new entry and reports that it created one", () => {
    const result = upsertProjectEntry([], { project: "A", localPath: "/a" });
    assert.deepEqual(result.entries, [{ project: "A", local_path: "/a" }]);
    assert.equal(result.created, true);
    assert.deepEqual(result.entry, { project: "A", local_path: "/a" });
  });

  it("updates the first match in place and keeps the entry's unknown keys", () => {
    const result = upsertProjectEntry(
      [{ project: "A", local_path: "/old", kind: "ops" }, { project: "B" }],
      { project: "A", runDir: "/launch" },
    );
    assert.deepEqual(result.entries, [
      { project: "A", run_dir: "/launch", kind: "ops" },
      { project: "B" },
    ]);
    assert.equal(result.created, false);
  });

  it("keeps one directory per entry: local-path, run-dir and no-dir each clear the other key", () => {
    const start = [{ project: "A", local_path: "/old", run_dir: "/pad" }];
    assert.deepEqual(
      upsertProjectEntry(start, { project: "A", localPath: "/new" }).entries,
      [{ project: "A", local_path: "/new" }],
    );
    assert.deepEqual(
      upsertProjectEntry(start, { project: "A", runDir: "/newpad" }).entries,
      [{ project: "A", run_dir: "/newpad" }],
    );
    assert.deepEqual(
      upsertProjectEntry(start, { project: "A", noDir: true }).entries,
      [{ project: "A" }],
    );
  });

  it("leaves non-object entries where they are", () => {
    const result = upsertProjectEntry(["stray", null, { project: "A" }], {
      project: "B",
      localPath: "/b",
    });
    assert.deepEqual(result.entries, ["stray", null, { project: "A" }, { project: "B", local_path: "/b" }]);
  });
});

describe("removeProjectEntry", () => {
  it("removes every match and reports how many went", () => {
    const result = removeProjectEntry(
      [{ project: "A" }, { project: "B" }, { project: "A", extra: 1 }],
      "A",
    );
    assert.deepEqual(result.entries, [{ project: "B" }]);
    assert.equal(result.removed, 2);
  });

  it("reports a miss without changing the array", () => {
    const start = [{ project: "A" }];
    const result = removeProjectEntry(start, "Ghost");
    assert.deepEqual(result.entries, start);
    assert.equal(result.removed, 0);
  });
});

describe("mergeProjectEntries (installer migration: target wins)", () => {
  it("appends source-only entries and keeps the target's copy on a clash", () => {
    const result = mergeProjectEntries(
      [{ project: "A", local_path: "/new" }, "stray"],
      [{ project: "A", local_path: "/old" }, { project: "B", note: "keep" }],
    );
    assert.deepEqual(result.entries, [
      { project: "A", local_path: "/new" },
      "stray",
      { project: "B", note: "keep" },
    ]);
    assert.equal(result.added, 1);
    assert.equal(result.kept, 1);
  });

  it("skips malformed and duplicate source entries", () => {
    const result = mergeProjectEntries(
      [],
      [null, "stray", { project: "" }, { project: "A" }, { project: "A", local_path: "/later" }],
    );
    assert.deepEqual(result.entries, [{ project: "A" }]);
    assert.equal(result.added, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.skipped, 3);
  });
});

describe("writeProjectMap (atomic, preserving what it did not interpret)", () => {
  const dirs = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-project-map-"));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("writes pretty JSON with a trailing newline, creating the directory", () => {
    const file = join(makeDir(), "nested", "projects.json");
    const result = writeProjectMap(file, [{ project: "A", local_path: "/a" }]);
    assert.equal(result.ok, true);
    assert.equal(
      readFileSync(file, "utf8"),
      '{\n  "projects": [\n    {\n      "project": "A",\n      "local_path": "/a"\n    }\n  ]\n}\n',
    );
  });

  it("keeps the root object's unknown keys", () => {
    const file = join(makeDir(), "projects.json");
    writeProjectMap(file, [{ project: "A" }], { root: { note: "keep" } });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      note: "keep",
      projects: [{ project: "A" }],
    });
  });

  it("writes a temp file and renames it over the target", () => {
    const file = join(makeDir(), "projects.json");
    const calls = [];
    const deps = {
      mkdirSync: (path, options) => calls.push(["mkdir", path, options]),
      writeFileSync: (path, text, options) => calls.push(["write", path, text, options]),
      renameSync: (from, to) => calls.push(["rename", from, to]),
      unlinkSync: (path) => calls.push(["unlink", path]),
      statSync: (path) => {
        calls.push(["stat", path]);
        return { mode: 0o600 };
      },
    };
    const result = writeProjectMap(file, [], { deps });
    assert.equal(result.ok, true);
    const write = calls.find(([kind]) => kind === "write");
    const rename = calls.find(([kind]) => kind === "rename");
    assert.ok(write[1].startsWith(`${file}.tmp-`), "the temp file sits beside the target");
    assert.deepEqual(rename.slice(1), [write[1], file]);
    assert.equal(write[3].mode, 0o600, "an existing file's mode is preserved");
  });

  it("reports PROJECT_MAP_UNWRITABLE and cleans the temp file when the write fails", () => {
    const file = join(makeDir(), "projects.json");
    const unlinked = [];
    const result = writeProjectMap(file, [], {
      deps: {
        mkdirSync: () => {},
        writeFileSync: () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
        renameSync: () => {},
        unlinkSync: (path) => unlinked.push(path),
        statSync: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROJECT_DIR_CODES.MAP_UNWRITABLE);
    assert.equal(unlinked.length, 1);
    assert.ok(unlinked[0].startsWith(`${file}.tmp-`));
  });

  it("never leaves a temp file behind on success", () => {
    const dir = makeDir();
    writeProjectMap(join(dir, "projects.json"), []);
    assert.deepEqual(readdirSync(dir), ["projects.json"]);
  });
});
