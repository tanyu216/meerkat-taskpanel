/**
 * The `src/mcp` layering rules, machine-enforced (R5, plan §5.4).
 *
 * M3 adds one dependency edge that did not exist before — `src/mcp → src/cli` —
 * and the whole justification for it is that MCP reuses the CLI's *transport
 * seam* rather than growing a second copy of the error mapping. That is only
 * true while the edge stays narrow, so the edge is pinned here, against the
 * source text, in four pieces:
 *
 *   1. **Every planned module exists.** A scan over an empty (or half-written)
 *      tree must fail rather than pass vacuously.
 *   2. **No storage, no SQLite.** MCP talks to the board the way the CLI does:
 *      over HTTP. Reaching into `core/storage` would make the daemon optional
 *      and break the single-writer model.
 *   3. **The `src/cli` whitelist.** `client/index.mjs`, `runtime.mjs`,
 *      `token.mjs`, `actor.mjs`, `errors.mjs` — and nothing else. In particular
 *      never `commands/**` (policy must not be re-decided here) and never
 *      `output/**` (MCP has no human renderer).
 *   4. **No new dependencies, no HTTP server, no spawning.** Only `src/shared`
 *      and relative imports; the daemon is spawned by `client/autostart.mjs`,
 *      which is reached through the whitelisted `runtime.mjs`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  importedSpecifiers,
  isNodeBuiltin,
  listModuleFiles,
  readSource,
  stripCommentsAndStrings,
} from "../helpers/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MCP = resolve(ROOT, "src/mcp");
const CLI = resolve(ROOT, "src/cli");
const SERVER = resolve(ROOT, "src/server");

/** Every module M3 promises to ship. A missing one must fail, not scan empty. */
const PLANNED_MCP = [
  "index.mjs",
  "main.mjs",
  "server.mjs",
  "protocol.mjs",
  "registry.mjs",
  "board.mjs",
  "actor.mjs",
  "result.mjs",
  "tools/schema.mjs",
  "tools/tasks.mjs",
  "tools/comments.mjs",
  "tools/relations.mjs",
  "tools/sessions.mjs",
  "tools/dictionary.mjs",
  "tools/projects.mjs",
];

/**
 * The *only* `src/cli` modules `src/mcp` may import (plan §3.5, F-E1).
 *
 * This array is the ruling, not a comment about it: widening it is a deliberate
 * edit that has to survive review, and narrowing the surface is what keeps "MCP
 * is a thin proxy" from decaying into "MCP is a second CLI".
 *
 * `client/http.mjs` is in the list because F-C1 requires it and F-C1 outranks
 * the enumeration in §3.5: the acceptance criterion is that a gate refusal
 * reaches an MCP caller as *the same error object* the CLI sees, and since
 * `src/cli/**` is read-only for this card, the only way to get that object is
 * `domainErrorFromPayload` — which lives in `http.mjs`. `createBoardClient` does
 * not re-export it. Note what this is *not*: `http.mjs` is the transport seam
 * (`requestJson`, `withQuery`, the error rebuild), not policy. No command file,
 * no renderer, nothing that decides anything.
 */
const CLI_WHITELIST = [
  "client/index.mjs",
  "client/http.mjs",
  "runtime.mjs",
  "token.mjs",
  "actor.mjs",
  "errors.mjs",
].map((rel) => resolve(CLI, rel));

/** Node builtins MCP has no business with, however it is written. */
const FORBIDDEN_BUILTINS = [
  "node:sqlite",
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:child_process",
  "node:worker_threads",
];

const mcpFiles = listModuleFiles(MCP);

/** Resolve a relative specifier to an absolute path (no extension lookup). */
function resolveSpecifier(fromFile, specifier) {
  return resolve(dirname(fromFile), specifier);
}

/** Is `target` inside `dir`? */
function within(dir, target) {
  const rel = relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

/** `file → specifier` strings, for every import in the tree. */
function offending(predicate) {
  const out = [];
  for (const file of mcpFiles) {
    for (const specifier of importedSpecifiers(readSource(file))) {
      if (predicate(file, specifier)) out.push(`${relative(ROOT, file)} → ${specifier}`);
    }
  }
  return out;
}

describe("mcp/imports — the layering rules", () => {
  it("ships every planned MCP module (an empty scan must not pass)", () => {
    assert.ok(mcpFiles.length >= PLANNED_MCP.length, `expected ≥ ${PLANNED_MCP.length} MCP modules, found ${mcpFiles.length}`);
    const missing = PLANNED_MCP.filter((rel) => !existsSync(join(MCP, rel)));
    assert.deepEqual(missing, [], `missing MCP modules: ${missing.join(", ")}`);
  });

  it("src/mcp never touches core/storage or node:sqlite", () => {
    const violations = offending(
      (_file, specifier) => specifier === "node:sqlite" || /core\/storage/.test(specifier),
    );
    assert.deepEqual(violations, [], "MCP is an HTTP client of the board, never a second writer");
  });

  it("src/mcp never imports src/cli/commands/** or src/cli/output/**", () => {
    const violations = offending((file, specifier) => {
      if (!specifier.startsWith(".")) return false;
      const target = resolveSpecifier(file, specifier);
      return within(resolve(CLI, "commands"), target) || within(resolve(CLI, "output"), target);
    });
    assert.deepEqual(violations, [], "policy is decided by the service, and MCP renders no human text");
  });

  it("src/mcp imports src/cli only through the whitelist", () => {
    const violations = offending((file, specifier) => {
      if (!specifier.startsWith(".")) return false;
      const target = resolveSpecifier(file, specifier);
      if (!within(CLI, target)) return false;
      return !CLI_WHITELIST.includes(target);
    });
    assert.deepEqual(violations, [], "the transport seam is reusable; the command surface is not");
  });

  it("src/mcp never imports src/server (the daemon is reached over HTTP)", () => {
    const violations = offending((file, specifier) => {
      if (!specifier.startsWith(".")) return false;
      return within(SERVER, resolveSpecifier(file, specifier));
    });
    assert.deepEqual(violations, []);
  });

  it("src/mcp imports no HTTP server, no spawner and no SQLite", () => {
    const violations = offending((_file, specifier) => FORBIDDEN_BUILTINS.includes(specifier));
    assert.deepEqual(violations, [], "stdio is the only transport MCP owns");
  });

  it("src/mcp imports nothing from outside node:/src (zero new dependencies)", () => {
    const violations = offending((_file, specifier) => {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) return false;
      // A bare specifier is a dependency; the project has none and wants none.
      return true;
    });
    assert.deepEqual(violations, [], "the image builds offline — a bare import would end that");
  });

  it("src/mcp reaches src/shared and relative modules only, besides the whitelist", () => {
    const violations = offending((file, specifier) => {
      if (isNodeBuiltin(specifier) || !specifier.startsWith(".")) return false;
      const target = resolveSpecifier(file, specifier);
      // Inside `src/mcp` itself, in `src/shared`, or the whitelisted `src/cli`.
      return !within(MCP, target) && !within(resolve(ROOT, "src/shared"), target) && !within(CLI, target);
    });
    assert.deepEqual(violations, []);
  });

  it("every failure raised in src/mcp is a DomainError (no bare `throw new Error`)", () => {
    const offenders = [];
    for (const file of mcpFiles) {
      const code = stripCommentsAndStrings(readSource(file));
      if (/throw\s+new\s+Error\s*\(/.test(code)) offenders.push(relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], "every MCP failure must carry a code (plan §5.4.7)");
  });
});
