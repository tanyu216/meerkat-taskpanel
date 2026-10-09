#!/usr/bin/env node
/**
 * Build the distribution tree under `dist/`.
 *
 * `dist/` is the npm release tree. The hosted board root is `web/dist`, produced by the
 * frontend build — *not* `dist/web`. This only
 *   1. recreates `dist/` from scratch,
 *   2. drops a release-tree placeholder at `dist/web/.gitkeep` (not the board asset dir), and
 *   3. syncs the skill into `dist/plugins/<host>/`.
 *
 * No network access. Node builtins only.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOSTS, syncSkills } from "./sync-skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

async function main() {
  console.log(`Building into ${dist}`);

  await rm(dist, { recursive: true, force: true });

  await mkdir(join(dist, "web"), { recursive: true });
  await writeFile(
    join(dist, "web", ".gitkeep"),
    "",
  );
  console.log("  dist/web/.gitkeep (release-tree placeholder; hosted board root is web/dist)");

  const report = await syncSkills({ root, baseDir: dist });
  for (const r of report.hosts) {
    console.log(`  dist/plugins/${r.host}/skills/${r.source.split("/").pop()}`);
  }

  if (!report.ok) {
    console.error("build: FAILED — skill sync into dist/ was not clean.");
    return 1;
  }

  console.log(`build: OK — ${DEFAULT_HOSTS.length} host plugin(s) written to dist/`);
  return 0;
}

process.exit(await main());
