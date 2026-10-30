/**
 * The command registry — the single list of what `taskctl` can do.
 *
 * `argv.mjs` validates against it, `usage.mjs` prints it, and `index.mjs`
 * dispatches through it. Adding a command means adding an entry here and
 * nothing else, which is what keeps `--help` honest.
 *
 * The groups are the card's vocabulary (§A1): `project`, `issue`, `comment`,
 * `relation`, `attachment`, `session`, `actors`, `labels`, `report`,
 * `export`, `token`, plus `sla` — the board's computed SLA read, which is also
 * the loop patrol's transport. `attachment` is T-20261014-212017-4's: the drawer's file
 * surface needed a writer, and the CLI is the board's second front door.
 * Note what is *not* here: `actors add`, `actors rm`, `actors rename`.
 * The dictionary has no management surface by design, so those are not "not
 * implemented" — they are not commands.
 */

import { GLOBAL_FLAGS } from "../argv.mjs";
import { COMMANDS as attachmentCommands } from "./attachment.mjs";
import { COMMANDS as commentCommands } from "./comment.mjs";
import { COMMANDS as actorCommands } from "./dict.mjs";
import { COMMANDS as eventCommands } from "./events.mjs";
import { COMMANDS as exportCommands } from "./export.mjs";
import { COMMANDS as issueCommands } from "./issue.mjs";
import { COMMANDS as labelCommands } from "./labels.mjs";
import { COMMANDS as loopCommands } from "./loop.mjs";
import { COMMANDS as projectCommands } from "./project.mjs";
import { COMMANDS as relationCommands } from "./relation.mjs";
import { COMMANDS as reportCommands } from "./report.mjs";
import { COMMANDS as sessionCommands } from "./session.mjs";
import { COMMANDS as slaCommands } from "./sla.mjs";
import { COMMANDS as statusCommands } from "./status.mjs";
import { COMMANDS as tokenCommands } from "./token.mjs";

export const groups = Object.freeze([
  { name: "project", summary: "Projects and their metadata.", commands: projectCommands },
  { name: "issue", summary: "Tasks: create, move, deliver.", commands: issueCommands },
  { name: "comment", summary: "The append-only discussion trail.", commands: commentCommands },
  { name: "relation", summary: "Parent/child, blocks, related.", commands: relationCommands },
  { name: "attachment", summary: "A card's files: add, list, download, remove.", commands: attachmentCommands },
  { name: "session", summary: "Agent sessions per task.", commands: sessionCommands },
  { name: "actors", summary: "Read-only dictionary of actors (assignees and reporters).", commands: actorCommands },
  { name: "labels", summary: "Read-only registry of labels.", commands: labelCommands },
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
  { name: "sla", summary: "The board's computed SLA rows (read-only).", commands: slaCommands },
  {
    name: "events",
    summary: "The board's live activity stream (read-only, NDJSON).",
    commands: eventCommands,
  },
  {
    name: "loop",
    summary: "The external loop: passes, daemons and status.",
    commands: loopCommands,
  },
]);

/**
 * Commands that are one word, not `group command`.
 *
 * `status` belongs here because it reads the *client's* view of the board (the
 * runtime pointer) without talking to it — there is no group it would honestly
 * sit inside, and inventing one (`taskd`) would name the server process for a
 * read the server never sees. The parser matches this list before `groups`, so a
 * name may not appear in both; the registry test pins that.
 */
export const topLevel = Object.freeze([...statusCommands]);

export const registry = Object.freeze({ globals: GLOBAL_FLAGS, groups, topLevel });

/**
 * Every registered command, flattened — what the registry/help tests walk.
 *
 * A top-level command carries `group: null`. `commandPath` is how help and flag
 * checks spell either shape as one string.
 */
export function allCommands() {
  return [
    ...topLevel.map((command) => ({ group: null, command })),
    ...groups.flatMap((group) => group.commands.map((command) => ({ group, command }))),
  ];
}

/** `taskctl status` / `taskctl issue get` — the spelling shared by both shapes. */
export function commandPath(group, command) {
  return group === null ? command.name : `${group.name} ${command.name}`;
}
