/**
 * The Cursor plugin's session-start hook.
 *
 * Cursor is not installed here, so the host integration cannot be run. Cursor's
 * hook contract is its own — a lowercase `sessionStart` key and one
 * `additional_context` string, not Claude Code's `hookSpecificOutput` — so these
 * cases pin the shipped shape and run the hook script directly. The real host
 * firing is the half named as unverified in `docs/install.md`.
 *
 * Run with: `node --test`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { CHECK_MARKER } from "../../src/foundation/session-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-cursor-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the hook with a plugin root and parse its stdout as JSON. */
function runHook(pluginRoot) {
  const result = spawnSync("bash", [join(ROOT, "hooks", "session-start.sh")], {
    encoding: "utf8",
    env: { ...process.env, CURSOR_PLUGIN_ROOT: pluginRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  return { result, json: JSON.parse(result.stdout) };
}

describe("cursor plugin — manifest", () => {
  it("declares the hooks file", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".cursor-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.hooks, "./hooks/hooks-cursor.json");
  });

  it("uses Cursor's lowercase sessionStart shape", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks-cursor.json"), "utf8"));
    assert.equal(hooks.version, 1);
    assert.ok(Array.isArray(hooks.hooks.sessionStart), "lowercase sessionStart");
    assert.equal(hooks.hooks.SessionStart, undefined, "not Claude Code's capitalised key");
    assert.equal(typeof hooks.hooks.sessionStart[0].command, "string");
  });

  it("ships the hooks directory in the npm package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(pkg.files.includes("hooks"), "package.json#files must include hooks");
  });
});

describe("cursor plugin — session-start hook", () => {
  it("emits the shared check as additional_context, not hookSpecificOutput", () => {
    const { json } = runHook(ROOT);

    assert.equal(typeof json.additional_context, "string");
    assert.ok(json.additional_context.includes(CHECK_MARKER), json.additional_context);
    assert.equal("hookSpecificOutput" in json, false, "Cursor reads additional_context");
  });

  it("still emits valid JSON and exits 0 when the instruction is absent", () => {
    const { json } = runHook(tempDir());
    assert.deepEqual(json, { additional_context: "" });
  });

  it("stays silent once the repository is configured", () => {
    const repo = tempDir();
    mkdirSync(join(repo, "docs", "agents"), { recursive: true });
    writeFileSync(join(repo, "docs", "agents", "issue-tracker.md"), "# configured\n");

    const result = spawnSync("bash", [join(ROOT, "hooks", "session-start.sh")], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CURSOR_PLUGIN_ROOT: ROOT },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { additional_context: "" });
  });

  it("ships the hook script", () => {
    assert.ok(existsSync(join(ROOT, "hooks", "session-start.sh")));
  });
});
