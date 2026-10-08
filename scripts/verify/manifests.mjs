#!/usr/bin/env node
/**
 * Contract check for the plugin manifests.
 *
 * Each host has its own conventional manifest location and its own required keys:
 *   plugins/claude/.claude-plugin/plugin.json
 *   plugins/codex/.codex-plugin/plugin.json
 *   plugins/openclaw/openclaw.plugin.json      (root-level, no dot-directory)
 *   plugins/pi/package.json
 * plus the repository-root Claude marketplace: .claude-plugin/marketplace.json
 *
 * Exits non-zero with a readable message on the first failure. Node builtins only.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {Array<{label: string, path: string, required: string[]}>} */
export const MANIFESTS = [
  {
    label: "claude",
    path: "plugins/claude/.claude-plugin/plugin.json",
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
    label: "codex",
    path: "plugins/codex/.codex-plugin/plugin.json",
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
    label: "openclaw",
    path: "plugins/openclaw/openclaw.plugin.json",
    required: [
      "id",
      "name",
      "version",
      "description",
      "categories",
      "skills",
      "activation",
      "configSchema",
    ],
  },
  {
    label: "pi",
    path: "plugins/pi/package.json",
    required: [
      "name",
      "version",
      "private",
      "description",
      "license",
      "type",
      "files",
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
