/**
 * The supervised tool policy across the three adapters, and the absence of the
 * retired full-access switch.
 *
 * ADR 0020 / 0021: the worker lane runs with every tool; the director and
 * reviewer lanes keep everything except the file-edit tools. Codex has no
 * per-role tool surface, so a read-only lane's boundary is the prompt there.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { sessionArgs as claudeArgs } from "../../src/orchestrator/actor-kinds/claude.mjs";
import { sessionArgs as piArgs } from "../../src/orchestrator/actor-kinds/pi.mjs";
import { threadPolicy } from "../../src/orchestrator/actor-kinds/codex.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every text file under `dir`, recursively. */
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe("supervised tool access (ADR 0020 / 0021)", () => {
  it("gives the worker lane every tool on every adapter", () => {
    for (const role of ["worker", "unknown"]) {
      const claude = claudeArgs({ opts: {}, role });
      assert.equal(claude[claude.indexOf("--permission-mode") + 1], "bypassPermissions");
      assert.equal(claude.includes("--allowedTools"), false);
      assert.equal(claude.includes("--disallowedTools"), false);

      const pi = piArgs({ opts: {}, role });
      assert.ok(pi.includes("--approve"));
      assert.equal(pi.includes("--tools"), false);
      assert.equal(pi.includes("--exclude-tools"), false);
    }
    assert.deepEqual(threadPolicy(), {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("keeps the director and reviewer write-less on Claude and Pi", () => {
    for (const role of ["director", "reviewer"]) {
      const claude = claudeArgs({ opts: {}, role });
      assert.equal(claude[claude.indexOf("--permission-mode") + 1], "bypassPermissions");
      assert.equal(claude[claude.indexOf("--disallowedTools") + 1], "Edit,Write,NotebookEdit");
      assert.doesNotMatch(claude[claude.indexOf("--disallowedTools") + 1], /\bAgent\b/);

      const pi = piArgs({ opts: {}, role });
      assert.ok(pi.includes("--approve"));
      assert.equal(pi[pi.indexOf("--exclude-tools") + 1], "edit,write");
      assert.equal(pi.includes("--tools"), false);
    }
  });

  it("carries no per-role surface on Codex", () => {
    // Codex cannot enforce a read-only lane at the adapter; the role prompt is
    // the boundary. Every lane gets the same full-access posture.
    assert.deepEqual(threadPolicy(), threadPolicy({ opts: { role: "reviewer" } }));
    assert.deepEqual(threadPolicy(), threadPolicy({ opts: { role: "director" } }));
  });

  it("leaves no full-access switch in the source", () => {
    const retired = /allowAllTools|ALLOW_ALL_TOOLS|allow-all-tools/;
    const files = [
      ...filesUnder(join(ROOT, "src")),
      ...filesUnder(join(ROOT, "scripts", "install")),
    ];
    const hits = files.filter((path) => retired.test(readFileSync(path, "utf8")));
    assert.deepEqual(hits, [], "the opt-in is retired, not hidden in a template");
  });
});
