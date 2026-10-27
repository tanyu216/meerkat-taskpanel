/**
 * `taskctl project dir` and `taskctl project map` — the one machine-local
 * project → directory map, and the "ask instead of guessing" rule.
 *
 * The board holds no directory (O3). The answer lives in `<config root>/
 * projects.json`, and the CLI is its only door: a registered project prints its
 * directory, an entry that names none prints `dir: null` (a project may
 * legitimately have no local directory), and a project with **no entry** stops
 * and asks the user (a coded failure with an actionable hint) rather than
 * continuing in some other checkout. The last two must never collapse.
 *
 * `project map` is the writer, and it is local by construction: no identity, no
 * token, no board. `MEERKAT_TASKPANEL_CONFIG_DIR` is what a test (or a
 * container, or a read-only install root) uses to relocate the whole config
 * directory, exactly as it relocates `.env.<kind>`.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  cleanupTempDirs,
  dataOf,
  errorOf,
  makeTempDir,
  runCli,
  withCli,
} from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A config root holding a map, plus the CLI env that points at it. */
function writeMap(entries, configDir = makeTempDir("meerkat-taskpanel-map-")) {
  const file = join(configDir, "projects.json");
  writeFileSync(file, JSON.stringify({ projects: entries }, null, 2));
  return { configDir, file, env: { MEERKAT_TASKPANEL_CONFIG_DIR: configDir } };
}

/** An empty config root (no map yet). */
function emptyConfig() {
  const configDir = makeTempDir("meerkat-taskpanel-map-");
  return { configDir, file: join(configDir, "projects.json"), env: { MEERKAT_TASKPANEL_CONFIG_DIR: configDir } };
}

/** A real directory under a fresh temp dir, usable as a target. */
function makeTarget() {
  const dir = join(makeTempDir("meerkat-taskpanel-target-"), "checkout");
  mkdirSync(dir);
  return dir;
}

/** A closed board URL: the local commands must never need one. */
const DEAD_BOARD = { TASKD_URL: "http://127.0.0.1:1", TASKD_NO_AUTOSTART: "1" };

describe("cli/project dir", () => {
  it("prints the directory a registered project works in", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const target = makeTarget();
      const { env } = writeMap([{ project: "demo", local_path: target }]);

      const result = run(["project", "dir", "demo", "--json"], { env });
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.project, "demo");
      assert.equal(data.dir, target);

      const human = run(["project", "dir", "demo"], { env });
      assert.equal(human.status, 0);
      assert.equal(human.stdout, `${target}\n`, "human output is the directory itself");
    });
  });

  it("refuses the retired --projects-json flag", async () => {
    await withCli(async ({ run }) => {
      const { env, file } = writeMap([{ project: "demo" }]);
      const result = run(["project", "dir", "demo", "--projects-json", file, "--json"], { env });
      assert.equal(result.status, 2, "the map has one location; a per-invocation override is gone");
      assert.equal(errorOf(result).code, "CLI_USAGE");
    });
  });

  it("asks instead of guessing when no directory is registered (unmapped)", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const { env } = writeMap([{ project: "somewhere-else", local_path: makeTarget() }]);

      const result = run(["project", "dir", "demo", "--json"], { env });
      assert.equal(result.status, 1, "an unresolved directory is a failure, never a silent success");
      const error = errorOf(result);
      assert.equal(error.code, "PROJECT_DIR_UNMAPPED");
      assert.match(error.message, /no local directory is registered for project demo/);
      assert.match(error.hint.fix, /taskctl project map set demo/);
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
        const { env } = writeMap([{ project: "demo", local_path }]);
        const result = run(["project", "dir", "demo", "--json"], { env });
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
      const { env } = writeMap([{ project: "demo", meta: { kind: "ops" } }]);

      const result = run(["project", "dir", "demo", "--json"], { env });
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.project, "demo");
      assert.equal(data.dir, null, "no directory is an answer, never a guess");

      // Exit 0 must still say something: silence here is the state the wake
      // glue's guards treat as a failure.
      const human = run(["project", "dir", "demo"], { env });
      assert.equal(human.status, 0);
      assert.notEqual(human.stdout.trim(), "", "a null answer still prints a sentence");
      assert.match(human.stdout, /demo/);
    });
  });

  it("prints `run_dir` when that is the only directory the entry names", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const launch = makeTarget();
      const { env } = writeMap([{ project: "demo", run_dir: launch }]);

      const result = run(["project", "dir", "demo", "--json"], { env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).dir, launch, "the CLI and the wake agree on one directory");

      const human = run(["project", "dir", "demo"], { env });
      assert.equal(human.stdout, `${launch}\n`);
    });
  });

  it("still refuses a key that is given but unusable — a blank local_path never falls back", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const launch = makeTarget();
      const { env } = writeMap([{ project: "demo", local_path: "", run_dir: launch }]);

      const result = run(["project", "dir", "demo", "--json"], { env });
      assert.equal(result.status, 1, "a supplied-but-blank path is a failure");
      const error = errorOf(result);
      assert.equal(error.code, "PROJECT_DIR_REQUIRED");
      assert.match(error.message, /`local_path`/);
    });
  });

  it("reports a missing or malformed map as a coded failure", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);

      const empty = emptyConfig();
      const missing = run(["project", "dir", "demo", "--json"], { env: empty.env });
      assert.equal(missing.status, 1);
      assert.equal(errorOf(missing).code, "PROJECT_MAP_UNREADABLE");
      assert.ok(errorOf(missing).message.includes(empty.file), "the message names the config-root file");

      const bad = emptyConfig();
      writeFileSync(bad.file, "{ not json");
      const malformed = run(["project", "dir", "demo", "--json"], { env: bad.env });
      assert.equal(malformed.status, 1);
      assert.equal(errorOf(malformed).code, "PROJECT_MAP_UNREADABLE");
    });
  });

  it("still says 'no such project' when the board does not know the id", async () => {
    await withCli(async ({ run }) => {
      const { env } = writeMap([{ project: "ghost", local_path: makeTarget() }]);
      const result = run(["project", "dir", "ghost", "--json"], { env });
      assert.equal(result.status, 1, "a directory is not an excuse to invent a project");
      assert.equal(errorOf(result).code, "NOT_FOUND");
    });
  });

  it("--require-dir is map-only and exits 3 when it cannot name a directory", async () => {
    await withCli(async ({ run }) => {
      // No board project is created: `--require-dir` must not ask the board.
      const target = makeTarget();
      const mapped = writeMap([{ project: "ghost", local_path: target }]);
      const ok = run(["project", "dir", "ghost", "--require-dir", "--json"], { env: mapped.env });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(dataOf(ok).dir, target);

      // The local path must not contact a board: a dead URL and no autostart
      // still resolve the map. This is the wake's "the board is down" case.
      const offline = run(["project", "dir", "ghost", "--require-dir", "--json"], {
        env: { ...mapped.env, ...DEAD_BOARD },
      });
      assert.equal(offline.status, 0, offline.stderr);
      assert.equal(dataOf(offline).dir, target);

      const unmapped = writeMap([{ project: "other", local_path: target }]);
      const missing = run(["project", "dir", "ghost", "--require-dir", "--json"], { env: unmapped.env });
      assert.equal(missing.status, 3, "no verdict is exit 3, never a success");
      assert.equal(dataOf(missing).code, "PROJECT_DIR_UNMAPPED");

      const none = writeMap([{ project: "ghost", meta: { kind: "ops" } }]);
      const noDir = run(["project", "dir", "ghost", "--require-dir"], { env: none.env });
      assert.equal(noDir.status, 3, "a wake needs a directory, even when the entry is complete");
      assert.equal(noDir.stdout, "", "no directory on stdout means no verdict");
      assert.match(noDir.stderr, /PROJECT_DIR_REQUIRED/);
    });
  });
});

describe("cli/project map — the local writer", () => {
  it("lists a missing map as empty, exit 0", () => {
    const { env, file } = emptyConfig();
    const result = runCli(["project", "map", "list", "--json"], { env, ...DEAD_BOARD });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(dataOf(result), { file, present: false, projects: [] });
  });

  it("sets a directory, creates the file, and updates in place keeping unknown keys", () => {
    const { env, file } = emptyConfig();
    const target = makeTarget();

    const created = runCli(["project", "map", "set", "demo", "--local-path", target, "--json"], { env });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(dataOf(created).dir, target);
    assert.equal(dataOf(created).created, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      projects: [{ project: "demo", local_path: target }],
    });

    // An unknown per-entry key is the operator's, and a second set must keep it.
    writeFileSync(file, JSON.stringify({ note: "root-kept", projects: [
      { project: "demo", local_path: target, kind: "ops" },
    ] }));
    const updated = runCli(["project", "map", "set", "demo", "--local-path", makeTarget(), "--json"], { env });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(dataOf(updated).created, false);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.note, "root-kept", "an unknown top-level key survives a write");
    assert.equal(saved.projects[0].kind, "ops", "an unknown per-entry key survives a write");
  });

  it("keeps one directory per entry: --run-dir clears local_path, --no-dir clears both", () => {
    const { env, file } = writeMap([{ project: "demo", local_path: makeTarget(), run_dir: makeTarget() }]);

    const launch = makeTarget();
    const runDir = runCli(["project", "map", "set", "demo", "--run-dir", launch, "--json"], { env });
    assert.equal(runDir.status, 0, runDir.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      projects: [{ project: "demo", run_dir: launch }],
    });

    const noDir = runCli(["project", "map", "set", "demo", "--no-dir", "--json"], { env });
    assert.equal(noDir.status, 0, noDir.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { projects: [{ project: "demo" }] });

    const shown = runCli(["project", "map", "show", "demo", "--json"], { env });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(dataOf(shown).dir, null, "no directory is a complete answer");
  });

  it("shows a registered project, including its validated dir", () => {
    const target = makeTarget();
    const { env } = writeMap([{ project: "demo", local_path: target }]);
    const result = runCli(["project", "map", "show", "demo", "--json"], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).dir, target);
  });

  it("refuses an absent entry for show and remove", () => {
    const { env } = writeMap([{ project: "demo" }]);
    for (const action of ["show", "remove"]) {
      const result = runCli(["project", "map", action, "ghost", "--json"], { env });
      assert.equal(result.status, 1, `${action} must fail`);
      assert.equal(errorOf(result).code, "PROJECT_DIR_UNMAPPED");
    }
  });

  it("removes an entry, then reports the second remove as unmapped", () => {
    const { env, file } = writeMap([{ project: "demo", local_path: makeTarget() }, { project: "other" }]);
    const first = runCli(["project", "map", "remove", "demo", "--json"], { env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(dataOf(first).removed, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { projects: [{ project: "other" }] });

    const second = runCli(["project", "map", "remove", "demo", "--json"], { env });
    assert.equal(second.status, 1);
    assert.equal(errorOf(second).code, "PROJECT_DIR_UNMAPPED");
  });

  it("validates the directory it is asked to register", () => {
    const { env } = emptyConfig();
    const file = join(makeTarget(), "a-file");
    writeFileSync(file, "not a directory\n");
    const cases = [
      ["relative/demo", "--local-path", "PROJECT_DIR_NOT_ABSOLUTE"],
      ["/definitely/not/here", "--local-path", "PROJECT_DIR_MISSING"],
      [file, "--run-dir", "PROJECT_DIR_NOT_A_DIRECTORY"],
    ];
    for (const [path, flag, code] of cases) {
      const result = runCli(["project", "map", "set", "demo", flag, path, "--json"], { env });
      assert.equal(result.status, 1, `${path} must fail`);
      assert.equal(errorOf(result).code, code);
    }
  });

  it("is a usage error to name the wrong action, id or mode", () => {
    const { env } = emptyConfig();
    const target = makeTarget();
    const cases = [
      ["project", "map", "bogus", "--json"],
      ["project", "map", "show", "--json"],
      ["project", "map", "set", "demo", "--json"],
      ["project", "map", "set", "demo", "--local-path", target, "--run-dir", target, "--json"],
      ["project", "map", "set", "demo", "--local-path", target, "--no-dir", "--json"],
      ["project", "map", "list", "demo", "--json"],
      ["project", "map", "list", "--no-dir", "--json"],
      ["project", "map", "remove", "demo", "--local-path", target, "--json"],
    ];
    for (const args of cases) {
      const result = runCli(args, { env });
      assert.equal(result.status, 2, `${args.join(" ")} must be CLI_USAGE`);
      assert.equal(errorOf(result).code, "CLI_USAGE");
    }
  });

  it("never overwrites a map it could not parse", () => {
    const { env, file } = emptyConfig();
    const before = "{ this is not json\n";
    writeFileSync(file, before);
    const result = runCli(["project", "map", "set", "demo", "--local-path", makeTarget(), "--json"], { env });
    assert.equal(result.status, 1);
    assert.equal(errorOf(result).code, "PROJECT_MAP_UNREADABLE");
    assert.equal(readFileSync(file, "utf8"), before, "the file is untouched");
  });

  it("reports a read-only config root as PROJECT_MAP_UNWRITABLE", (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores mode bits");
    const { configDir, env } = emptyConfig();
    chmodSync(configDir, 0o500);
    try {
      const result = runCli(["project", "map", "set", "demo", "--local-path", makeTarget(), "--json"], { env });
      assert.equal(result.status, 1, result.stdout);
      assert.equal(errorOf(result).code, "PROJECT_MAP_UNWRITABLE");
      assert.equal(existsSync(join(configDir, "projects.json")), false);
    } finally {
      chmodSync(configDir, 0o700);
    }
  });

  it("needs no identity and no board", () => {
    const { env } = writeMap([{ project: "demo" }]);
    const result = runCli(["project", "map", "list", "--json"], {
      env: { ...env, ...DEAD_BOARD },
      noIdentity: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).projects.length, 1);
  });

  it("resolves a relative MEERKAT_TASKPANEL_CONFIG_DIR against cwd", () => {
    const cwd = makeTempDir("meerkat-taskpanel-cwd-");
    const target = makeTarget();
    const result = runCli(["project", "map", "set", "demo", "--local-path", target, "--json"], {
      env: { MEERKAT_TASKPANEL_CONFIG_DIR: "cfg" },
      cwd,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "cfg", "projects.json"), "utf8")), {
      projects: [{ project: "demo", local_path: target }],
    });
  });

  it("ignores a stale per-kind projects-map key", () => {
    const { env, configDir } = writeMap([{ project: "demo", local_path: makeTarget() }]);
    writeFileSync(join(configDir, ".env.claude"), "MEERKAT_TASKPANEL_PROJECTS_JSON=/tmp/elsewhere.json\n");
    const result = runCli(["project", "map", "list", "--json"], {
      env: { ...env, MEERKAT_TASKPANEL_PROJECTS_JSON: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).projects.length, 1, "the config-root map answers, not the retired key");
  });
});
