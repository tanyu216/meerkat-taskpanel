#!/usr/bin/env node
/**
 * Contract check for the plugin manifests.
 *
 * Each agent kind has its own conventional manifest location and its own required keys:
 *   .claude-plugin/plugin.json                    (the board plugin; root = repo root)
 *   package.json                                  (the `pi` field — Pi has no manifest of
 *                                                  its own, it reads the root package)
 * plus the repository-root Claude marketplace: .claude-plugin/marketplace.json
 *
 * Codex has no manifest of its own: `codex plugin marketplace add` reads the same
 * repository-root marketplace and installs the same `./` bundle as Claude Code, so its
 * expected manifest is the board plugin's (see KIND_BUNDLES.codex). OpenClaw has none
 * either — it reads that same `./` bundle, which is why no native OpenClaw manifest
 * ships (see KIND_BUNDLES.openclaw and docs/install.md).
 *
 * Exits non-zero with a readable message on the first failure. Node builtins only.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {Array<{label: string, path: string, required: string[]}>} */
export const MANIFESTS = [
  {
    label: "claude",
    path: ".claude-plugin/plugin.json",
    required: [
      "name",
      "version",
      "description",
      "author",
      "license",
      "homepage",
      "repository",
      "keywords",
      "skills",
    ],
  },
  {
    label: "pi",
    path: "package.json",
    required: [
      "name",
      "version",
      "type",
      "pi",
    ],
  },
  {
    label: "marketplace",
    path: ".claude-plugin/marketplace.json",
    required: ["name", "owner", "metadata", "plugins"],
  },
];

/**
 * Read and validate every manifest.
 * @param {string} [base] repository root
 * @returns {Promise<{ok: boolean, results: Array<{label: string, path: string, ok: boolean, error?: string}>}>}
 */
export async function validateManifests(base = root) {
  const results = [];

  for (const entry of MANIFESTS) {
    const abs = join(base, entry.path);
    try {
      const raw = await readFile(abs, "utf8");
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        results.push({
          label: entry.label,
          path: entry.path,
          ok: false,
          error: `invalid JSON: ${err.message}`,
        });
        continue;
      }

      const missing = entry.required.filter(
        (key) => data[key] === undefined || data[key] === null,
      );
      if (missing.length > 0) {
        results.push({
          label: entry.label,
          path: entry.path,
          ok: false,
          error: `missing required key(s): ${missing.join(", ")}`,
        });
        continue;
      }

      results.push({ label: entry.label, path: entry.path, ok: true });
    } catch (err) {
      results.push({
        label: entry.label,
        path: entry.path,
        ok: false,
        error: err.code === "ENOENT" ? "file not found" : err.message,
      });
    }
  }

  return { ok: results.every((r) => r.ok), results };
}

async function main() {
  const report = await validateManifests();

  for (const r of report.results) {
    if (r.ok) console.log(`OK    ${r.label.padEnd(12)} ${r.path}`);
    else console.error(`FAIL  ${r.label.padEnd(12)} ${r.path}: ${r.error}`);
  }

  if (!report.ok) {
    console.error("\nmanifests: FAILED");
    return 1;
  }

  console.log(`\nmanifests: OK (${report.results.length} manifests)`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}
