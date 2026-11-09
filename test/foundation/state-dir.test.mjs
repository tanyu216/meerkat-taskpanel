/**
 * The loop's state-directory resolver.
 *
 * The default is `<config root>/loop`; the legacy `<home>/<agent-dir>/
 * meerkat-taskpanel` is read-only compatibility. The resolver is pure path
 * arithmetic plus one injected existence probe, so these cases never touch the
 * filesystem.
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  agentPaths,
  legacyLoopStateDir,
} from "../../src/foundation/agent-paths.mjs";
import { loopStateDir, QUEUE_FILES, STATE_FILES } from "../../src/foundation/loop-state.mjs";
import {
  hasLoopState,
  resolveLoopState,
  STATE_DIR_ENV,
} from "../../src/foundation/state-dir.mjs";

const CONFIG_ROOT = "/srv/board";
const HOME = "/home/op";
const LEGACY = join(HOME, ".claude", "meerkat-taskpanel");
const DEFAULT = join(CONFIG_ROOT, "loop");

/** An existence probe over a fixed set of paths. */
function existsIn(...paths) {
  const set = new Set(paths.map((path) => resolve(path)));
  return (path) => set.has(resolve(path));
}

describe("state-dir — loopStateDir", () => {
  it("is <config root>/loop", () => {
    assert.equal(loopStateDir(CONFIG_ROOT), DEFAULT);
  });
});

describe("state-dir — agent paths", () => {
  it("no longer carries the loop state", () => {
    const paths = agentPaths(HOME, "claude");
    assert.equal("state" in paths, false);
    assert.equal("stateDir" in paths, false);
    assert.equal(paths.agentDir, ".claude");
    assert.equal(paths.boardSkill, join(HOME, ".claude", "skills", "meerkat"));
  });

  it("names the legacy state dir per kind, and null for an unknown kind", () => {
    assert.equal(legacyLoopStateDir(HOME, "claude"), LEGACY);
    assert.equal(legacyLoopStateDir(HOME, "codex"), join(HOME, ".codex", "meerkat-taskpanel"));
    assert.equal(legacyLoopStateDir(HOME, "pi"), join(HOME, ".agents", "meerkat-taskpanel"));
    assert.equal(legacyLoopStateDir(HOME, "nope"), null);
    assert.equal(legacyLoopStateDir(null, "claude"), null);
  });
});

describe("state-dir — hasLoopState", () => {
  it("needs a substantive state file, not just the directory", () => {
    assert.equal(hasLoopState(DEFAULT, { exists: existsIn() }), false);
    assert.equal(
      hasLoopState(DEFAULT, { exists: existsIn(join(DEFAULT, STATE_FILES.supervisor)) }),
      true,
    );
    assert.equal(
      hasLoopState(DEFAULT, { exists: existsIn(join(DEFAULT, QUEUE_FILES.cards)) }),
      true,
    );
  });
});

describe("state-dir — resolveLoopState precedence", () => {
  it("explicit --state wins over everything and never falls back", () => {
    const stateFile = join("/named", "custom.state.json");
    const got = resolveLoopState({
      stateFile,
      home: HOME,
      actorKind: "claude",
      env: { [STATE_DIR_ENV]: "/from/env" },
      config: { [STATE_DIR_ENV]: "/from/config" },
      exists: existsIn(LEGACY),
    });
    assert.deepEqual(got, { dir: "/named", source: "explicit", legacyDir: null });
  });

  it("process env beats the per-kind config", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: { [STATE_DIR_ENV]: "/from/env" },
      config: { [STATE_DIR_ENV]: "/from/config" },
      exists: existsIn(LEGACY),
    });
    assert.deepEqual(got, { dir: "/from/env", source: "env", legacyDir: null });
  });

  it("the per-kind config is used when the env is absent", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: {},
      config: { [STATE_DIR_ENV]: "/from/config" },
      exists: existsIn(LEGACY),
    });
    assert.deepEqual(got, { dir: "/from/config", source: "config", legacyDir: null });
  });

  it("defaults to <config root>/loop when nothing names it", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: { MEERKAT_TASKPANEL_CONFIG_DIR: CONFIG_ROOT },
      config: {},
      exists: existsIn(),
    });
    assert.deepEqual(got, { dir: DEFAULT, source: "default", legacyDir: LEGACY });
  });

  it("reads the legacy dir only when the default has no state", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: { MEERKAT_TASKPANEL_CONFIG_DIR: CONFIG_ROOT },
      config: {},
      exists: existsIn(join(LEGACY, QUEUE_FILES.cards)),
    });
    assert.deepEqual(got, { dir: LEGACY, source: "legacy", legacyDir: LEGACY });
  });

  it("prefers the default as soon as it holds state", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: { MEERKAT_TASKPANEL_CONFIG_DIR: CONFIG_ROOT },
      config: {},
      exists: existsIn(
        join(LEGACY, QUEUE_FILES.cards),
        join(DEFAULT, QUEUE_FILES.sessions),
      ),
    });
    assert.deepEqual(got, { dir: DEFAULT, source: "default", legacyDir: LEGACY });
  });

  it("an empty default directory is not state", () => {
    const got = resolveLoopState({
      home: HOME,
      actorKind: "claude",
      env: { MEERKAT_TASKPANEL_CONFIG_DIR: CONFIG_ROOT },
      config: {},
      exists: existsIn(DEFAULT, join(LEGACY, QUEUE_FILES.cards)),
    });
    // The default directory exists (a fresh install creates it) but has no file.
    assert.equal(got.source, "legacy");
    assert.equal(got.dir, LEGACY);
  });
});
