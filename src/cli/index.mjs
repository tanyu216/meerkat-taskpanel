#!/usr/bin/env node
/**
 * taskctl — Task Dashboard CLI entry point.
 *
 * M0 scaffold: this is intentionally a stub. It only knows how to identify itself.
 * Real commands (claim, heartbeat, status, progress, comment, report, session-*,
 * spawn, depend, children, deps, rollup, query, read) land in M2 — see
 * skills/task-dashboard/references/cli.md.
 */

import { CLI_NAME, VERSION } from "../shared/constants.mjs";

const USAGE = `Usage: ${CLI_NAME} <command> [options]

Task management board for AI Agent teams.

Options:
  --version    Print version and exit
  -h, --help   Print this help and exit

Commands:
  (none implemented yet — M0 scaffold)`;

function main(argv) {
  if (argv.includes("--version")) {
    console.log(VERSION);
    return 0;
  }

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  process.stderr.write(
    `${CLI_NAME}: not implemented yet (M0 scaffold)\n` +
      `Requested: ${argv.join(" ")}\n`,
  );
  return 2;
}

process.exit(main(process.argv.slice(2)));
