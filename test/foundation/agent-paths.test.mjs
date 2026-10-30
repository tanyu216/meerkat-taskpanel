/**
 * The agent-install vocabulary: agent directories, the one config root, and the
 * per-kind config file under it. Shared by the orchestrator, the CLI, the
 * transport session and the installer, so a rename cannot leave one of them
 * reading a file nobody writes.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  AGENT_DIRS,
  KIND_CONFIG_DIR_ENV,
  agentPaths,
  loopLogPath,
  resolveConfigDir,
  resolveKindConfigPath,
} from "../../src/foundation/agent-paths.mjs";

describe("agent-paths — the installed agent's directories", () => {
  it("names the three agent directories", () => {
    assert.deepEqual(AGENT_DIRS, {
      claude: ".claude",
      codex: ".codex",
      pi: ".agents",
    });
  });

  it("derives one agent's paths from its home", () => {
    const paths = agentPaths("/home/op", "claude");
    assert.equal(paths.agentDir, ".claude");
    assert.equal(
      paths.state,
      join("/home/op", ".claude", "meerkat-taskpanel", "supervisor.state.json"),
    );
    assert.equal(paths.loopSkill, join("/home/op", ".claude", "skills", "meerkat-loop"));
    assert.equal(paths.boardSkill, join("/home/op", ".claude", "skills", "meerkat"));
    assert.equal(paths.stateDir, join("/home/op", ".claude", "meerkat-taskpanel"));
  });

  it("is not where the loop log lives — the log is one file for every kind", () => {
    const claude = agentPaths("/home/op", "claude");
    const codex = agentPaths("/home/op", "codex");
    assert.equal(Object.hasOwn(claude, "log"), false);
    // The state directory stays per kind: the queue, the locks and the ledgers
    // must not be shared between two pools.
    assert.notEqual(claude.stateDir, codex.stateDir);
  });

  it("does not derive the machine-local project map from the agent home", () => {
    const paths = agentPaths("/home/op", "claude");
    assert.equal(Object.hasOwn(paths, "projectsJson"), false);
  });
});

describe("loopLogPath — one loop log, under the config root", () => {
  it("puts supervisor.log in logs/ at the config root", () => {
    assert.equal(loopLogPath("/opt/tree"), join("/opt/tree", "logs", "supervisor.log"));
  });

  it("takes no actor kind, so every kind writes the same file", () => {
    // The signature is the guarantee: a kind argument would fork the path again.
    assert.equal(loopLogPath.length, 1);
  });
});

describe("resolveConfigDir — one machine-local config directory", () => {
  it("uses the injected program root", () => {
    assert.equal(resolveConfigDir({ root: "/opt/tree", env: {} }), "/opt/tree");
  });

  it("lets MEERKAT_TASKPANEL_CONFIG_DIR replace the program root", () => {
    assert.equal(
      resolveConfigDir({
        root: "/opt/tree",
        env: { [KIND_CONFIG_DIR_ENV]: "/srv/tp-config" },
      }),
      "/srv/tp-config",
    );
  });

  it("resolves a relative override against cwd", () => {
    assert.equal(
      resolveConfigDir({ root: "/opt/tree", env: { [KIND_CONFIG_DIR_ENV]: "config" }, cwd: "/work" }),
      "/work/config",
    );
  });

  it("falls back to the program root for a blank override", () => {
    assert.equal(
      resolveConfigDir({ root: "/opt/tree", env: { [KIND_CONFIG_DIR_ENV]: "   " } }),
      "/opt/tree",
    );
  });
});

describe("resolveKindConfigPath — one config per actor kind at the config root", () => {
  it("names .env.<kind> under an injected program root", () => {
    for (const kind of ["claude", "codex", "pi"]) {
      assert.equal(
        resolveKindConfigPath({ actorKind: kind, root: "/opt/tree", env: {} }),
        join("/opt/tree", `.env.${kind}`),
      );
    }
  });

  it("lets MEERKAT_TASKPANEL_CONFIG_DIR replace the program root", () => {
    assert.equal(
      resolveKindConfigPath({
        actorKind: "codex",
        root: "/opt/tree",
        env: { [KIND_CONFIG_DIR_ENV]: "/srv/tp-config" },
      }),
      join("/srv/tp-config", ".env.codex"),
    );
  });

  it("resolves a relative override against cwd", () => {
    assert.equal(
      resolveKindConfigPath({
        actorKind: "pi",
        root: "/opt/tree",
        env: { [KIND_CONFIG_DIR_ENV]: "config" },
        cwd: "/work",
      }),
      join("/work", "config", ".env.pi"),
    );
  });

  it("accepts any safe kind token, not just the installed three", () => {
    assert.equal(
      resolveKindConfigPath({ actorKind: "system", root: "/opt/tree", env: {} }),
      join("/opt/tree", ".env.system"),
    );
    assert.equal(
      resolveKindConfigPath({ actorKind: "openclaw", root: "/opt/tree", env: {} }),
      join("/opt/tree", ".env.openclaw"),
    );
  });

  it("has no file for the human or an absent kind", () => {
    assert.equal(resolveKindConfigPath({ actorKind: "human", env: {} }), null);
    assert.equal(resolveKindConfigPath({ actorKind: "", env: {} }), null);
    assert.equal(resolveKindConfigPath({ env: {} }), null);
  });

  it("refuses a token that is not a plain file-name segment", () => {
    for (const kind of ["../escape", "a/b", "two words", "."]) {
      assert.throws(
        () => resolveKindConfigPath({ actorKind: kind, root: "/opt/tree", env: {} }),
        /invalid actor kind/,
      );
    }
  });
});
