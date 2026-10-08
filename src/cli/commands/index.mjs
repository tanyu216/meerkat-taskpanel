/**
 * The command registry — the single list of what `taskctl` can do.
 *
 * `argv.mjs` validates against it, `usage.mjs` prints it, and `index.mjs`
 * dispatches through it. Adding a command means adding an entry here and
 * nothing else, which is what keeps `--help` honest.
 *
 * The groups are the card's vocabulary (§A1): `project`, `context`, `issue`,
 * `comment`, `relation`, `session`, `assignees`, `reporters`, `report`,
 * `export`, `token`. Note what is *not* here: `assignees add`, `assignees rm`,
 * `assignees rename`. The dictionary has no management surface by design, so
 * those are not "not implemented" — they are not commands.
 */

import { GLOBAL_FLAGS } from "../argv.mjs";
import { COMMANDS as commentCommands } from "./comment.mjs";
import { COMMANDS as contextCommands } from "./context.mjs";
import { COMMANDS as dictCommands, REPORTER_COMMANDS } from "./dict.mjs";
import { COMMANDS as exportCommands } from "./export.mjs";
import { COMMANDS as issueCommands } from "./issue.mjs";
import { COMMANDS as projectCommands } from "./project.mjs";
import { COMMANDS as relationCommands } from "./relation.mjs";
import { COMMANDS as reportCommands } from "./report.mjs";
import { COMMANDS as sessionCommands } from "./session.mjs";
import { COMMANDS as tokenCommands } from "./token.mjs";

export const groups = Object.freeze([
  { name: "project", summary: "Workspaces and their metadata.", commands: projectCommands },
  { name: "context", summary: "Where am I?", commands: contextCommands },
  { name: "issue", summary: "Tasks: create, move, deliver.", commands: issueCommands },
  { name: "comment", summary: "The append-only discussion trail.", commands: commentCommands },
  { name: "relation", summary: "Parent/child, blocks, related.", commands: relationCommands },
  { name: "session", summary: "Agent sessions per task.", commands: sessionCommands },
  { name: "assignees", summary: "Read-only dictionary of assignees.", commands: dictCommands },
  { name: "reporters", summary: "Read-only dictionary of reporters.", commands: REPORTER_COMMANDS },
  { name: "report", summary: "Write reports; generate templates.", commands: reportCommands },
  {
    name: "export",
    summary: "Cards as markdown.",
    commands: exportCommands,
    // `taskctl export --md --out cards` (the card's spelling) is the same thing
    // as `taskctl export md --out cards`. The default only applies when the
    // caller passed a flag the command owns — bare `taskctl export` still prints
    // help rather than writing files into the current directory.
    defaultCommand: "md",
  },
  { name: "token", summary: "The board's access token.", commands: tokenCommands },
]);

export const registry = Object.freeze({ globals: GLOBAL_FLAGS, groups });

/** Every registered command, flattened — what the registry/help tests walk. */
export function allCommands() {
  return groups.flatMap((group) => group.commands.map((command) => ({ group, command })));
}
