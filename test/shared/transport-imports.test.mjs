/**
 * The shared transport seam, machine-enforced.
 *
 * M3 reached the taskd transport seam (HTTP client, autostart, runtime pointer,
 * token resolution, actor derivation, error mapping) through a **temporary**
 * `src/mcp → src/cli` whitelist edge, pending this extraction. That edge is gone:
 * the seam lives here, in `src/shared/transport/**`, and both `src/cli` and
 * `src/mcp` import it. This file pins it against the source text:
 *
 *   1. **Every planned seam module exists.** An empty (or half-written) scan must
 *      fail rather than pass vacuously.
 *   2. **The seam depends downward only.** `src/shared` sits below the surfaces,
 *      so a seam module may import other `src/shared` modules, Node builtins and
 *      its own relatives — never `src/cli`, `src/mcp` or `src/server`.
 *   3. **Both surfaces reach it.** The "reuse, do not fork" mechanism behind
 *      gate-equivalence is only real if the CLI and MCP actually import the one
 *      seam; a surface that silently grew a second copy would still pass a
 *      "nothing imports sideways" check.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { importedSpecifiers, isNodeBuiltin, listModuleFiles, readSource } from "../helpers/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = resolve(ROOT, "src/shared");
const TRANSPORT = resolve(SHARED, "transport");
const CLI = resolve(ROOT, "src/cli");
const MCP = resolve(ROOT, "src/mcp");
const SERVER = resolve(ROOT, "src/server");

/** Every module the extracted seam promises to ship. */
const PLANNED_TRANSPORT = [
  "client.mjs",
  "http.mjs",
  "autostart.mjs",
  "runtime.mjs",
  "token.mjs",
  "actor.mjs",
  "errors.mjs",
];

/** Is `target` inside `dir`? */
function within(dir, target) {
  const rel = relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

const transportFiles = listModuleFiles(TRANSPORT);

describe("shared/transport — the extracted seam", () => {
  it("ships every planned seam module (an empty scan must not pass)", () => {
    assert.ok(
      transportFiles.length >= PLANNED_TRANSPORT.length,
      `expected ≥ ${PLANNED_TRANSPORT.length} transport modules, found ${transportFiles.length}`,
    );
    const missing = PLANNED_TRANSPORT.filter((rel) => !existsSync(join(TRANSPORT, rel)));
    assert.deepEqual(missing, [], `missing transport modules: ${missing.join(", ")}`);
  });

  it("the seam imports nothing from src/cli, src/mcp or src/server", () => {
    const violations = [];
    for (const file of transportFiles) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (within(CLI, target) || within(MCP, target) || within(SERVER, target)) {
          violations.push(`${relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, [], "the shared seam sits below the surfaces; it must not import one");
  });

  it("src/shared imports nothing from src/cli, src/mcp or src/server (the iron rule)", () => {
    // The charter rule is whole-tree, not just seam-scoped: `src/shared` is the
    // bottom of the dependency graph, so *no* module under it — seam or helper —
    // may reach up into a surface. This is what the `mcp → cli` whitelist edge
    // used to violate; with the seam extracted, the rule holds unqualified.
    const violations = [];
    for (const file of listModuleFiles(SHARED)) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (within(CLI, target) || within(MCP, target) || within(SERVER, target)) {
          violations.push(`${relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, [], "nothing in src/shared may import cli/mcp/server");
  });

  it("the seam imports only node builtins and src/shared relatives", () => {
    const violations = [];
    for (const file of transportFiles) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (isNodeBuiltin(specifier)) continue;
        if (!specifier.startsWith(".")) {
          violations.push(`${relative(ROOT, file)} → ${specifier} (bare specifier)`);
          continue;
        }
        if (!within(SHARED, resolve(dirname(file), specifier))) {
          violations.push(`${relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, [], "the seam may reach other shared modules, nothing above them");
  });

  it("both src/cli and src/mcp import the seam from src/shared", () => {
    const reaches = (dir) => {
      const files = listModuleFiles(dir);
      return files.some((file) =>
        importedSpecifiers(readSource(file)).some(
          (specifier) => specifier.startsWith(".") && within(TRANSPORT, resolve(dirname(file), specifier)),
        ),
      );
    };
    assert.ok(reaches(CLI), "src/cli must reach the shared transport seam");
    assert.ok(reaches(MCP), "src/mcp must reach the shared transport seam");
  });
});
