#!/usr/bin/env node
/**
 * Boot an already-installed published package and check it answers.
 *
 * The release workflow runs this inside a throwaway container, after
 * `npm install meerkat-taskpanel@<version>` from the registry: the repository is
 * not on disk and its `node_modules` cannot satisfy the import, so this is the
 * first proof that the *published* bytes run, not the packed ones.
 *
 *   node scripts/verify/published-smoke.mjs --package-root <dir> --expected-version <x.y.z>
 *
 * The script deliberately imports nothing from `src/`: the workflow checks out
 * only `scripts/verify`, so anything outside this directory would not exist.
 *
 * Exit: 0 ok · 1 a check failed · 2 usage.
 *
 * Node builtins only.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { smokeInstalledBoard } from "./lib/installed-board.mjs";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "package-root": { type: "string" },
    "expected-version": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help || values["package-root"] === undefined) {
  process.stderr.write(
    "Usage: node scripts/verify/published-smoke.mjs --package-root <dir> [--expected-version <x.y.z>]\n",
  );
  process.exit(values.help ? 0 : 2);
}

try {
  const result = await smokeInstalledBoard({
    packageRoot: resolve(values["package-root"]),
    expectedVersion: values["expected-version"],
    log: (line) => process.stdout.write(`  ${line}\n`),
  });
  process.stdout.write(`published-smoke: OK — ${result.version} at ${result.url}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`published-smoke: FAIL — ${error.message}\n`);
  process.exit(1);
}
