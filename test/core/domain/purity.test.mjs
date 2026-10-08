/**
 * Step 3: the dependency iron rules, machine-checked (plan §3.1, ARCHITECTURE §3).
 *
 *   domain    → only `domain/*` + `src/shared/*`, and no Node builtins at all
 *   storage   → domain + shared, never an HTTP/network module
 *   commands  → domain + storage + shared
 *   shared    → never imports `src/core`
 *
 * Static text reading only — this one is explicitly allowed on the host
 * (ARCHITECTURE §9.1 exception 4), and it is what keeps "domain is pure" from
 * decaying into a comment.
 */

import assert from "node:assert/strict";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  importedSpecifiers,
  isNodeBuiltin,
  listModuleFiles,
  readSource,
  stripCommentsAndStrings,
} from "../../helpers/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CORE = resolve(ROOT, "src/core");
const SHARED = resolve(ROOT, "src/shared");

/** Files that exist right now; the test grows with the tree automatically. */
const domainFiles = listModuleFiles(resolve(CORE, "domain"));
const storageFiles = listModuleFiles(resolve(CORE, "storage"));
const commandFiles = listModuleFiles(resolve(CORE, "commands"));
const sharedFiles = listModuleFiles(SHARED);

/** Resolve a relative specifier to an absolute path (no extension lookup). */
function resolveSpecifier(fromFile, specifier) {
  return resolve(dirname(fromFile), specifier);
}

/** Is `target` inside `dir`? */
function within(dir, target) {
  const rel = relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

describe("domain purity", () => {
  it("actually found the trees (guards against a silent no-op scan)", () => {
    // The full module inventory is asserted in `test/core/index.test.mjs`; here
    // it is enough that the scan is not reading an empty directory.
    assert.ok(domainFiles.length >= 3, `expected domain modules, found ${domainFiles.length}`);
    assert.ok(sharedFiles.length >= 4, `expected shared modules, found ${sharedFiles.length}`);
  });

  it("src/core/domain/** imports no Node builtin", () => {
    const offenders = [];
    for (const file of domainFiles) {
      for (const spec of importedSpecifiers(readSource(file))) {
        if (isNodeBuiltin(spec)) offenders.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], "domain must stay I/O free");
  });

  it("src/core/domain/** imports nothing outside domain/ and shared/", () => {
    const offenders = [];
    for (const file of domainFiles) {
      for (const spec of importedSpecifiers(readSource(file))) {
        if (!spec.startsWith(".")) {
          offenders.push(`${relative(ROOT, file)} → ${spec} (bare specifier)`);
          continue;
        }
        const target = resolveSpecifier(file, spec);
        if (!within(CORE, target) && !within(SHARED, target)) {
          offenders.push(`${relative(ROOT, file)} → ${spec} (outside domain/shared)`);
          continue;
        }
        // Anything under core/ must be domain itself — not storage or commands.
        if (within(CORE, target) && !within(resolve(CORE, "domain"), target)) {
          offenders.push(`${relative(ROOT, file)} → ${spec} (domain may not reach storage/commands)`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("src/core/storage/** never imports an HTTP/network module", () => {
    const forbidden = ["node:http", "node:https", "node:net", "node:tls", "node:dgram"];
    const offenders = [];
    for (const file of storageFiles.length > 0 ? storageFiles : []) {
      for (const spec of importedSpecifiers(readSource(file))) {
        if (forbidden.includes(spec)) offenders.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], "storage must not speak HTTP");
  });

  it("src/shared/** never imports src/core", () => {
    const offenders = [];
    for (const file of sharedFiles) {
      for (const spec of importedSpecifiers(readSource(file))) {
        if (!spec.startsWith(".")) continue;
        if (within(CORE, resolveSpecifier(file, spec))) {
          offenders.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "dependency direction is core → shared, never the reverse");
  });

  it("no core module reaches for CommonJS `require`", () => {
    const offenders = [];
    for (const file of [...domainFiles, ...storageFiles, ...commandFiles]) {
      if (/\brequire\s*\(/.test(stripCommentsAndStrings(readSource(file)))) {
        offenders.push(relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("core raises DomainError, never a bare Error", () => {
    const offenders = [];
    for (const file of [...domainFiles, ...storageFiles, ...commandFiles]) {
      const code = stripCommentsAndStrings(readSource(file));
      if (/throw\s+new\s+Error\s*\(/.test(code)) offenders.push(relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], "every core failure must carry a code (plan §3.2)");
  });
});
