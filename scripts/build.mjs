#!/usr/bin/env node
/**
 * Build the distribution tree under `dist/`.
 *
 * `dist/` is the npm release tree. The hosted board root is `web/dist`, produced by the
 * frontend build — *not* `dist/web`. This only
 *   1. recreates `dist/` from scratch,
 *   2. drops a release-tree placeholder at `dist/web/.gitkeep` (not the board asset dir), and
 *   3. syncs every skill into `dist/plugins/<target>/skills/<skill>/`.
 *
 * The loop payload (`skills/meerkat-loop/body` + `templates/`) is a *generated* artefact
 * that a release ships as-is; the build verifies it is current rather than rewriting the
 * source tree, so a stale payload is a red build instead of a silent divergence.
 *
 * No network access. Node builtins only.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncLoop } from "./sync-loop.mjs";
import { skillTargets, syncSkills } from "./sync-skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

async function main() {
  console.log(`Building into ${dist}`);

  const loop = await syncLoop({ root, check: true });
  if (!loop.ok) {
    console.error(
      `build: FAILED — the loop payload in ${loop.skill} is out of date. ` +
        "Run `node scripts/sync-skills.mjs` and commit the result.",
    );
    return 1;
  }

  await rm(dist, { recursive: true, force: true });

  await mkdir(join(dist, "web"), { recursive: true });
  await writeFile(
    join(dist, "web", ".gitkeep"),
    "",
  );
  console.log("  dist/web/.gitkeep (release-tree placeholder; hosted board root is web/dist)");

  const report = await syncSkills({ root, baseDir: dist });
  for (const r of report.results) {
    console.log(`  dist/plugins/${r.target}/skills/${r.skill}`);
  }

  if (!report.ok) {
    console.error("build: FAILED — skill sync into dist/ was not clean.");
    return 1;
  }

  const targets = skillTargets();
  console.log(`build: OK — ${targets.length} skill copy(ies) written to dist/`);
  return 0;
}

process.exit(await main());
