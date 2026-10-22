/**
 * Help text, generated from the command registry.
 *
 * Generated rather than hand-written so help can never drift from what the
 * parser actually accepts: the same `flags` list that `argv.mjs` validates
 * against is the one printed here. `taskctl --help` must name every group
 * (card A1), and `taskctl <group> --help` must name every command in it.
 *
 * The global flags come from `argv.mjs#GLOBAL_FLAGS` — the very array
 * `bindFlags` validates against and `registry.globals` hands to
 * `topLevelUsage`. They were once re-declared here "to avoid a cycle"; there is
 * none (neither module imports the other), and the two copies had already
 * drifted: `if-version` was `number` there and `string` here, and `json` and
 * `help` carried different summaries — so `taskctl --help` and
 * `taskctl <cmd> --help` disagreed about the same four flags.
 * `test/cli/dispatch.test.mjs` now pins the two surfaces together.
 */

import { GLOBAL_FLAGS } from "./argv.mjs";
import { CLI_NAME, VERSION } from "../foundation/constants.mjs";

/** `--flag <value>` / `-h, --help` — how a flag reads in a usage line. */
export function flagSynopsis(spec) {
  const short = spec.short === undefined ? "" : `${spec.short}, `;
  if ((spec.as ?? "string") === "boolean") return `${short}--${spec.flag}`;
  return `${short}--${spec.flag} ${spec.value ?? "<value>"}`;
}

/**
 * `taskctl issue deliver <id> [options]`, or `taskctl status [options]` for a
 * top-level command (`group === null`).
 */
export function commandSynopsis(group, command) {
  const slots = (command.positionals ?? []).map((slot) =>
    slot.required === false ? `[<${slot.name}>]` : `<${slot.name}>`,
  );
  return [CLI_NAME, ...(group === null ? [] : [group.name]), command.name, ...slots, "[options]"].join(" ");
}

/** The top-level help: bare commands, every group, and the global flags. */
export function topLevelUsage(registry) {
  const lines = [
    `Usage: ${CLI_NAME} <command> [options] | ${CLI_NAME} <group> <command> [options]`,
    "",
    "Task management board for AI Agent teams.",
  ];
  const bare = registry.topLevel ?? [];
  if (bare.length > 0) {
    lines.push("", "Commands:");
    for (const command of bare) {
      lines.push(`  ${command.name.padEnd(12)} ${command.summary}`);
    }
  }
  lines.push("", "Groups:");
  for (const group of registry.groups) {
    const names = group.commands.map((command) => command.name).join(", ");
    lines.push(`  ${group.name.padEnd(12)} ${group.summary}`);
    lines.push(`  ${"".padEnd(12)} ${names}`);
  }
  lines.push("", "Global options:", flagTable(registry.globals));
  lines.push("", `Run \`${CLI_NAME} <group> --help\` for a group, or \`${CLI_NAME} <group> <command> --help\` for one command.`);
  return `${lines.join("\n")}\n`;
}

/** Help for one group: its commands and their summaries. */
export function groupUsage(group) {
  const lines = [`Usage: ${CLI_NAME} ${group.name} <command> [options]`, "", group.summary, "", "Commands:"];
  for (const command of group.commands) {
    lines.push(`  ${command.name.padEnd(10)} ${command.summary}`);
    lines.push(`  ${"".padEnd(10)} ${commandSynopsis(group, command)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Help for one command: its usage line, flags and positionals. */
export function commandUsage(group, command) {
  const lines = [
    `Usage: ${commandSynopsis(group, command)}`,
    "",
    command.summary,
  ];
  if ((command.positionals ?? []).length > 0) {
    lines.push("", "Arguments:");
    for (const slot of command.positionals) {
      lines.push(`  ${`<${slot.name}>`.padEnd(14)} ${slot.summary ?? ""}`.trimEnd());
    }
  }
  const own = command.flags ?? [];
  if (own.length > 0) {
    lines.push("", "Options:", flagTable(own));
  }
  lines.push("", "Global options:", flagTable(GLOBAL_FLAGS));
  return `${lines.join("\n")}\n`;
}

/** The version line `--version` prints. */
export function versionLine() {
  return `${VERSION}\n`;
}

function flagTable(specs) {
  const width = Math.max(...specs.map((spec) => flagSynopsis(spec).length), 4);
  return specs.map((spec) => `  ${flagSynopsis(spec).padEnd(width)}  ${spec.summary ?? ""}`.trimEnd()).join("\n");
}
