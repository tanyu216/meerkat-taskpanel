#!/usr/bin/env node
/**
 * Thin wrapper that runs the Task Panel CLI from the skill.
 *
 * Resolves the repository root relative to this file (skills/task-panel/scripts/ →
 * up three levels), spawns the real CLI entry point with the caller's arguments, pipes
 * stdio through, and propagates the exit code. No business logic lives here.
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const cli = join(root, "src", "cli", "index.mjs");

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  process.stderr.write(`failed to run ${cli}: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
