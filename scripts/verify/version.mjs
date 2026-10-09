#!/usr/bin/env node
/**
 * The release version is declared in exactly one place — the root
 * `package.json` `version` — and mirrored, unchanged, into every shipped
 * manifest:
 *
 *   1. package.json                                    (the source of truth)
 *   2. plugins/pi/package.json
 *   3. plugins/claude/.claude-plugin/plugin.json
 *   4. plugins/codex/.codex-plugin/plugin.json
 *   5. plugins/openclaw/openclaw.plugin.json
 *   6. .claude-plugin/marketplace.json  → metadata.version
 *
 * Every host reads *its own* manifest to decide what version it installed, so a
 * drift here ships a release that calls itself two different things. This script
 * reads all six, compares them against the root `package.json`, prints any
 * offending file and exits non-zero on drift — wired into CI so the mistake is
 * caught at pull-request time rather than at tag time.
 *
 *   node scripts/verify/version.mjs            # check; exit 0 iff all six agree
 *   node scripts/verify/version.mjs --print    # print the canonical version
 *   node scripts/verify/version.mjs --base <dir>   # check a tree rooted at <dir>
 *
 * Node builtins only; no network, no dependencies.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The six manifests that must agree, in reporting order. The first entry is the
 * canonical one: every other entry must equal it.
 *
 * `field` names the property that carries the version (so the diagnostic for the
 * marketplace, whose version hides under `metadata`, says so).
 *
 * @type {ReadonlyArray<{label: string, path: string, field: string, canonical?: boolean, pick: (doc: object) => unknown}>}
 */
export const VERSION_SOURCES = Object.freeze([
  { label: "package.json", path: "package.json", field: "version", canonical: true, pick: (doc) => doc.version },
  { label: "pi", path: "plugins/pi/package.json", field: "version", pick: (doc) => doc.version },
  { label: "claude", path: "plugins/claude/.claude-plugin/plugin.json", field: "version", pick: (doc) => doc.version },
  { label: "codex", path: "plugins/codex/.codex-plugin/plugin.json", field: "version", pick: (doc) => doc.version },
  { label: "openclaw", path: "plugins/openclaw/openclaw.plugin.json", field: "version", pick: (doc) => doc.version },
  { label: "marketplace", path: ".claude-plugin/marketplace.json", field: "metadata.version", pick: (doc) => doc.metadata?.version },
]);

/**
 * Read one manifest and pull its version out.
 *
 * @param {{path: string, field: string, pick: (doc: object) => unknown}} source
 * @param {string} base repository root
 * @returns {Promise<{ok: true, version: string} | {ok: false, error: string}>}
 */
async function readSource(source, base) {
  const file = join(base, source.path);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const why = err !== null && err.code === "ENOENT" ? "file not found" : err.message;
    return { ok: false, error: `${source.path}: ${why}` };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${source.path}: not valid JSON (${err.message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${source.path}: expected a JSON object` };
  }

  const version = source.pick(doc);
  if (typeof version !== "string" || version.trim() === "") {
    return { ok: false, error: `${source.path}: missing a non-empty string \`${source.field}\`` };
  }
  return { ok: true, version: version.trim() };
}

/**
 * Validate that all six manifests carry the same version as the root
 * `package.json`.
 *
 * Never throws for a bad tree: a missing file, malformed JSON or a missing field
 * all come back as `{ok: false, error}` so the test suite can construct broken
 * trees and assert on them.
 *
 * @param {string} [base] repository root (defaults to this checkout)
 * @returns {Promise<{ok: boolean, kind?: "drift"|"read", version?: string, sources?: {label: string, path: string, version: string}[], error?: string}>}
 */
export async function validateVersions(base = ROOT) {
  /** @type {{label: string, path: string, version: string}[]} */
  const sources = [];
  for (const source of VERSION_SOURCES) {
    const result = await readSource(source, base);
    if (!result.ok) return { ok: false, kind: "read", sources, error: result.error };
    sources.push({ label: source.label, path: source.path, version: result.version });
  }

  const canonical = sources[0].version;
  const drifted = sources.filter((entry) => entry.version !== canonical);
  if (drifted.length > 0) {
    const lines = drifted.map((entry) => `  ${entry.path} (${entry.label}) is ${entry.version}, expected ${canonical}`);
    return {
      ok: false,
      kind: "drift",
      version: canonical,
      sources,
      error: `version drift against ${VERSION_SOURCES[0].path} (${canonical}):\n${lines.join("\n")}`,
    };
  }

  return { ok: true, version: canonical, sources };
}

/**
 * The canonical version, read from the root `package.json` alone.
 *
 * @param {string} [base]
 * @returns {Promise<string|null>} `null` when the root manifest is unreadable
 */
export async function currentVersion(base = ROOT) {
  const result = await readSource(VERSION_SOURCES[0], base);
  return result.ok ? result.version : null;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "boolean", default: false },
      base: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/version.mjs [--print] [--base <dir>]\n\n" +
        "  --print        print the canonical version (root package.json) and exit\n" +
        "  --base <dir>   check a tree rooted at <dir> (default: this checkout)\n",
    );
    return 0;
  }

  const base = values.base === undefined ? ROOT : resolve(values.base);

  if (values.print) {
    const version = await currentVersion(base);
    if (version === null) {
      process.stderr.write(`version: cannot read ${join(base, VERSION_SOURCES[0].path)}\n`);
      return 2;
    }
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const result = await validateVersions(base);
  if (!result.ok) {
    process.stderr.write(`version: FAILED — ${result.error}\n`);
    // A missing/malformed manifest (2) reads differently from drift (1): the
    // first is a broken tree, the second a version that was not kept in sync.
    return result.kind === "read" ? 2 : 1;
  }

  for (const entry of result.sources) {
    process.stdout.write(`  ${entry.version}  ${entry.path}  (${entry.label})\n`);
  }
  process.stdout.write(`version: OK — all ${result.sources.length} manifests agree on ${result.version}\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
