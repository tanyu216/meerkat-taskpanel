#!/usr/bin/env node
/**
 * Build the distribution tree under `dist/`.
 *
 * `dist/` is the npm release tree. The hosted board root is `web/dist`, produced by the
 * frontend build — *not* `dist/web`. This only
 *   1. recreates `dist/` from scratch, and
 *   2. drops a release-tree placeholder at `dist/web/.gitkeep` (not the board asset dir).
 *
 * Nothing is copied into `dist/plugins/`: no skill is distributed as a committed copy, and
 * every harness reads the repository's own `skills/` tree through a manifest at the root.
 * The loop is part of the toolkit (`src/orchestrator/`), so the release carries no loop
 * payload: the three skills are `SKILL.md` + `references/`, copied by `install.sh`.
 *
 * No network access. Node builtins only.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  console.log("build: OK — dist/ recreated (no skill copies: every harness reads skills/ in place)");
  return 0;
}

process.exit(await main());
