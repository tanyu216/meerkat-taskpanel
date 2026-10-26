/**
 * `taskctl project dir` — resolving a project to its local directory, and
 * asking instead of guessing when there is none.
 *
 * The board holds no directory (O3). The answer lives in the agent-local
 * `projects.json` beside the skill, and the command is the CLI's door to it:
 * a registered project prints its directory, an entry that names none prints
 * `dir: null` (a project may legitimately have no local directory), and a
 * project with **no entry** stops and asks the user (a coded failure with an
 * actionable hint) rather than continuing in some other checkout. The last two
 * must never collapse into each other.
 *
 * Real CLI, real board, a temp map — the directory is passed in through
 * `MEERKAT_TASKPANEL_PROJECTS_JSON`, exactly as an installed shim does.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { dataOf, errorOf, makeTempDir, withCli, cleanupTempDirs } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** Write a map file into a fresh temp dir and return {map, dir}. */
function writeMap(entries) {
  const dir = makeTempDir("meerkat-taskpanel-map-");
  const map = join(dir, "projects.json");
  writeFileSync(map, JSON.stringify({ projects: entries }, null, 2));
  return { map, dir };
}

/** A real directory under a fresh temp dir, usable as a target. */
function makeTarget() {
  const dir = join(makeTempDir("meerkat-taskpanel-target-"), "checkout");
  mkdirSync(dir);
  return dir;
}

describe("cli/project dir", () => {
  it("prints the directory a registered project works in", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const target = makeTarget();
      const { map } = writeMap([{ project: "demo", local_path: target }]);

      const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.project, "demo");
      assert.equal(data.dir, target);

      const human = run(["project", "dir", "demo"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(human.status, 0);
      assert.equal(human.stdout, `${target}\n`, "human output is the directory itself");

      // The flag is the explicit form, and it wins over the environment.
      const flagged = run(["project", "dir", "demo", "--projects-json", map, "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: join(makeTempDir(), "absent.json") },
      });
      assert.equal(flagged.status, 0, flagged.stderr);
      assert.equal(dataOf(flagged).dir, target);
    });
  });

  it("asks instead of guessing when no directory is registered (unmapped)", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const { map } = writeMap([{ project: "somewhere-else", local_path: makeTarget() }]);

      const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 1, "an unresolved directory is a failure, never a silent success");
      const error = errorOf(result);
      assert.equal(error.code, "PROJECT_DIR_UNMAPPED");
      assert.match(error.message, /no local directory is registered for project demo/);
      assert.match(error.hint.fix, /ask which local directory project demo works in/);
    });
  });

  it("refuses a relative, a missing and a non-directory target", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const file = join(makeTarget(), "a-file");
      writeFileSync(file, "not a directory\n");

      const cases = [
        ["relative/demo", "PROJECT_DIR_NOT_ABSOLUTE"],
        ["/definitely/not/here", "PROJECT_DIR_MISSING"],
        [file, "PROJECT_DIR_NOT_A_DIRECTORY"],
      ];
      for (const [local_path, code] of cases) {
        const { map } = writeMap([{ project: "demo", local_path }]);
        const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
        assert.equal(result.status, 1, `${local_path} must fail`);
        assert.equal(errorOf(result).code, code, `${local_path} must be ${code}`);
      }
    });
  });

  it("answers `dir: null` — a complete answer, not a failure — for an entry that names no directory", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      // A project that keeps nothing on disk (operations work) is a first-class
      // project, not a registration that is missing something.
      const { map } = writeMap([{ project: "demo", meta: { kind: "ops" } }]);

      const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.project, "demo");
      assert.equal(data.dir, null, "no directory is an answer, never a guess");

      // Exit 0 must still say something: silence here is the state the wake
      // glue's guards treat as a failure.
      const human = run(["project", "dir", "demo"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(human.status, 0);
      assert.notEqual(human.stdout.trim(), "", "a null answer still prints a sentence");
      assert.match(human.stdout, /demo/);
    });
  });

  it("prints `run_dir` when that is the only directory the entry names", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const launch = makeTarget();
      const { map } = writeMap([{ project: "demo", run_dir: launch }]);

      const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).dir, launch, "the CLI and the wake agree on one directory");

      const human = run(["project", "dir", "demo"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(human.stdout, `${launch}\n`);
    });
  });

  it("still refuses a key that is given but unusable — a blank local_path never falls back", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const launch = makeTarget();
      const { map } = writeMap([{ project: "demo", local_path: "", run_dir: launch }]);

      const result = run(["project", "dir", "demo", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 1, "a supplied-but-blank path is a failure");
      const error = errorOf(result);
      assert.equal(error.code, "PROJECT_DIR_REQUIRED");
      assert.match(error.message, /`local_path`/);
    });
  });

  it("reports a missing or malformed map as a coded failure", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);

      const missing = run(["project", "dir", "demo", "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: join(makeTempDir(), "projects.json") },
      });
      assert.equal(missing.status, 1);
      assert.equal(errorOf(missing).code, "PROJECT_MAP_UNREADABLE");

      const bad = makeTempDir();
      writeFileSync(join(bad, "projects.json"), "{ not json");
      const malformed = run(["project", "dir", "demo", "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: join(bad, "projects.json") },
      });
      assert.equal(malformed.status, 1);
      assert.equal(errorOf(malformed).code, "PROJECT_MAP_UNREADABLE");
    });
  });

  it("defaults to the map beside this checkout's skill when the environment is silent", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      // Empty is "unset": the command falls back to the skill's own copy. The repo
      // deliberately ships no projects.json, so this is the documented miss.
      const result = run(["project", "dir", "demo", "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: "" },
      });
      assert.equal(result.status, 1);
      const error = errorOf(result);
      assert.equal(error.code, "PROJECT_MAP_UNREADABLE");
      assert.match(error.message, /skills[/\\]meerkat-taskpanel[/\\]projects\.json/);
    });
  });

  it("still says 'no such project' when the board does not know the id", async () => {
    await withCli(async ({ run }) => {
      const { map } = writeMap([{ project: "ghost", local_path: makeTarget() }]);
      const result = run(["project", "dir", "ghost", "--json"], { env: { MEERKAT_TASKPANEL_PROJECTS_JSON: map } });
      assert.equal(result.status, 1, "a directory is not an excuse to invent a project");
      assert.equal(errorOf(result).code, "NOT_FOUND");
    });
  });

  it("--require-dir is map-only and exits 3 when it cannot name a directory", async () => {
    await withCli(async ({ run }) => {
      // No board project is created: `--require-dir` must not ask the board.
      const target = makeTarget();
      const mapped = writeMap([{ project: "ghost", local_path: target }]);
      const ok = run(["project", "dir", "ghost", "--require-dir", "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: mapped.map },
      });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(dataOf(ok).dir, target);

      // The local path must not contact a board: a dead URL and no autostart
      // still resolve the map. This is the wake's "the board is down" case.
      const offline = run(["project", "dir", "ghost", "--require-dir", "--json"], {
        env: {
          MEERKAT_TASKPANEL_PROJECTS_JSON: mapped.map,
          TASKD_URL: "http://127.0.0.1:1",
          TASKD_NO_AUTOSTART: "1",
        },
      });
      assert.equal(offline.status, 0, offline.stderr);
      assert.equal(dataOf(offline).dir, target);

      const unmapped = writeMap([{ project: "other", local_path: target }]);
      const missing = run(["project", "dir", "ghost", "--require-dir", "--json"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: unmapped.map },
      });
      assert.equal(missing.status, 3, "no verdict is exit 3, never a success");
      assert.equal(dataOf(missing).code, "PROJECT_DIR_UNMAPPED");

      const none = writeMap([{ project: "ghost", meta: { kind: "ops" } }]);
      const noDir = run(["project", "dir", "ghost", "--require-dir"], {
        env: { MEERKAT_TASKPANEL_PROJECTS_JSON: none.map },
      });
      assert.equal(noDir.status, 3, "a wake needs a directory, even when the entry is complete");
      assert.equal(noDir.stdout, "", "no directory on stdout means no verdict");
      assert.match(noDir.stderr, /PROJECT_DIR_REQUIRED/);
    });
  });
});
