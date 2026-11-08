/**
 * Argument parsing — one pure function, so the whole matrix is unit-testable.
 *
 * Two passes, deliberately:
 *
 *   1. `tokenize` is *syntax only*. It knows which flag names take a value (a
 *      fixed, global set) so `--no-report in_review` parses the way a human
 *      means it, and it knows that `--` ends the flags and `-` is a value (the
 *      stdin marker for `--report-file -`).
 *   2. `parseArgv` is *semantics*: it finds the command in the registry and
 *      rejects anything that command does not accept.
 *
 * Everything it refuses is `CLI_USAGE` — exit 2 — never a runtime error: "you
 * typed it wrong" and "the board said no" must be distinguishable by exit code
 * alone (§F-C2).
 */

import { DomainError } from "../foundation/errors.mjs";

/**
 * Flag names that never take a value. Everything else consumes the next token.
 *
 * This must stay a superset of every `as: "boolean"` flag the command table
 * declares; `test/cli/units.test.mjs` derives that set and fails on a gap. The
 * one deliberate exception is `workflow`: a switch on `issue reconcile`, a value
 * on every `loop` verb (`--workflow yes`). One global tokenizer cannot be both,
 * so it stays out and the loop keeps its value form.
 */
export const BOOLEAN_FLAGS = Object.freeze(
  new Set([
    "json",
    "help",
    "version",
    "as-human",
    "no-report",
    "force-create",
    "force",
    "show",
    "check",
    "include-archived",
    "include-unassigned",
    "order-debug",
    "stale",
    "failed",
    "check-blockers",
    "once",
    "detach",
    "watch-status",
    "stop",
    "standalone",
    "require-dir",
    "no-dir",
    "no-base-ref",
    "no-merge-ref",
    "keep",
    "remove",
    "watch",
    "md",
    "dry-run",
    "take-over",
    "allow-dup",
    "allow-steal",
    "assignee-only",
    "patrol-llm",
    "ping-once",
    "continue-once",
  ]),
);

/** Flags every command accepts, wherever they appear on the line. */
export const GLOBAL_FLAGS = Object.freeze([
  { flag: "json", key: "json", as: "boolean", summary: "Machine-readable JSON on stdout ({ok:true,data})." },
  { flag: "url", key: "url", as: "string", value: "<url>", summary: "Board to talk to (default: the local taskd)." },
  { flag: "token", key: "token", as: "string", value: "<token>", summary: "Access token (never echoed)." },
  { flag: "env-file", key: "envFile", as: "string", value: "<path>", summary: "Config file (default: <install root>/.env; env: MEERKAT_TASKPANEL_ENV_FILE)." },
  { flag: "if-version", key: "ifVersion", as: "number", value: "<n>", summary: "Optimistic-concurrency guard." },
  { flag: "actor-kind", key: "actorKind", as: "string", value: "<name>", summary: "The platform writing (claude|codex|…); required on every command that talks to the board — local reads (`board`) and --help/--version need none. `human` is reserved; use --as-human." },
  { flag: "as-human", key: "asHuman", as: "boolean", summary: "Write as the configured human, not as yourself." },
  { flag: "session-id", key: "sessionId", as: "string", value: "<id>", summary: "Agent session identifier." },
  { flag: "agent", key: "agent", as: "string", value: "<name>", summary: "Actor id recorded on writes — a role or person (jobs, linus, turing, …)." },
  { flag: "help", key: "help", as: "boolean", short: "-h", summary: "Show help for the command and exit." },
  { flag: "version", key: "version", as: "boolean", summary: "Print the version and exit (with --json: the version and the contract schema_version)." },
]);

/** The short forms the tokenizer recognises. */
const SHORT_FLAGS = Object.freeze({ "-h": "help" });

/**
 * `@param {string[]} argv`
 * @returns {{positionals: string[], flags: Map<string, (string|boolean)[]>}}
 */
export function tokenize(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** Raw argv index beside each positional — the command token's boundary. @type {number[]} */
  const indices = [];
  /** @type {Map<string, (string|boolean)[]>} */
  const flags = new Map();
  const add = (name, value) => {
    const list = flags.get(name);
    if (list === undefined) flags.set(name, [value]);
    else list.push(value);
  };

  let onlyPositional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!onlyPositional && token === "--") {
      onlyPositional = true;
      continue;
    }

    if (!onlyPositional && Object.hasOwn(SHORT_FLAGS, token)) {
      add(SHORT_FLAGS[token], true);
      continue;
    }

    if (!onlyPositional && token.startsWith("--") && token.length > 2) {
      const equals = token.indexOf("=");
      if (equals !== -1) {
        add(token.slice(2, equals), token.slice(equals + 1));
        continue;
      }
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        add(name, true);
        continue;
      }
      const next = argv[i + 1];
      // `-` is a legitimate value (stdin); another `--flag` is not.
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        add(name, true);
        continue;
      }
      add(name, next);
      i += 1;
      continue;
    }

    positionals.push(token);
    indices.push(i);
  }

  return { positionals, indices, flags };
}

/**
 * A usage failure — always `CLI_USAGE`, so the process exits 2 (§F-C2).
 * @param {string} message
 * @param {object} [hint]
 */
function usageError(message, hint) {
  return new DomainError("CLI_USAGE", hint === undefined ? { message } : { message, hint });
}

/**
 * The retired `loop <verb>` spellings and the command each became.
 *
 * Private on purpose: this map is a migration aid, not a registry. It never
 * appears in `--help` and never enters `test/fixtures/contract/cli.snapshot.json`.
 * `loop` and `pool` are the two names that changed; the other eight kept their
 * verb word and merely lost the `loop` prefix.
 */
const RETIRED_LOOP_VERBS = Object.freeze({
  status: "loop",
  session: "pool",
  patrol: "patrol",
  workflow: "workflow",
  poll: "poll",
  tick: "tick",
  console: "console",
  doctor: "doctor",
  run: "run",
  subscribe: "subscribe",
});

/** The one hint every retired-spelling error carries. */
const MIGRATION_FIX = "re-run install.sh to refresh the scheduling units" +
  " (the runtime commands are top-level now)";

/**
 * Coerce and validate the flags a command actually accepts.
 *
 * @param {Map<string, (string|boolean)[]>} tokenized
 * @param {object[]} specs
 * @param {string} where human-readable command name, for error messages
 * @param {string} helpTarget what `taskctl <x> --help` would name
 * @param {{lenient?: boolean}} [options] `lenient` skips flags this spec does not
 *   know — used for the globals-only first pass, before the command is known
 */
export function bindFlags(tokenized, specs, where, helpTarget, options = {}) {
  /** @type {Record<string, unknown>} */
  const bound = {};
  const known = new Map(specs.map((spec) => [spec.flag, spec]));
  const helpCommand = helpTarget === "" ? "taskctl" : `taskctl ${helpTarget}`;

  for (const [name, values] of tokenized) {
    const spec = known.get(name);
    if (spec === undefined) {
      if (options.lenient === true) continue;
      throw usageError(`${where}: unknown option --${name}`, {
        fix: `run \`${helpCommand} --help\` to see the options it accepts`,
      });
    }
    const as = spec.as ?? "string";
    if (as === "boolean") {
      bound[spec.key] = values.some((value) => value !== false) && values.at(-1) !== "false";
      continue;
    }
    for (const value of values) {
      if (value === true) {
        throw usageError(`${where}: --${name} needs a value`, { fix: `pass --${name} <value>` });
      }
      if (as === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          throw usageError(`${where}: --${name} expects a number (got ${JSON.stringify(value)})`);
        }
        bound[spec.key] = number;
        continue;
      }
      if (as === "kv") {
        const equals = value.indexOf("=");
        if (equals <= 0) {
          throw usageError(`${where}: --${name} expects key=value (got ${JSON.stringify(value)})`, {
            fix: 'e.g. --meta key=value',
          });
        }
        const map = /** @type {Record<string,string>} */ (bound[spec.key] ?? {});
        map[value.slice(0, equals)] = value.slice(equals + 1);
        bound[spec.key] = map;
        continue;
      }
      if (spec.repeat === true) {
        const list = /** @type {string[]} */ (bound[spec.key] ?? []);
        list.push(value);
        bound[spec.key] = list;
        continue;
      }
      bound[spec.key] = value;
    }
  }

  for (const spec of specs) {
    if (spec.required === true && bound[spec.key] === undefined) {
      throw usageError(`${where}: --${spec.flag} is required`);
    }
  }
  return bound;
}

/**
 * Full parse: registry lookup, globals, command flags, positionals.
 *
 * @param {string[]} argv
 * @param {{groups: object[], topLevel?: object[]}} registry
 * @returns {{flags: object, group: object|null, command: object|null, commandArgs: object, positionals: string[], commandIndex: number|null, wantedHelp: boolean, version: boolean}}
 */
export function parseArgv(argv, registry) {
  const { positionals, indices, flags } = tokenize(argv);
  // First pass: the globals only, and *leniently* — a command flag is not an
  // error until we know which command it belongs to.
  const globals = bindFlags(flags, GLOBAL_FLAGS, "taskctl", "", { lenient: true });
  const wantsVersion = globals.version === true;
  const [groupName, commandName, ...rest] = positionals;

  if (groupName === undefined) {
    return helpResult(globals, null, null, [], wantsVersion);
  }

  // A **top-level command** is one word, not a group and a verb (`taskctl
  // board`). It is matched before the group lookup because it is not a group:
  // there is no namespace to put it inside. The registry test pins that the two
  // namespaces never collide, so the order is a formality — but it is also what
  // makes `taskctl board --help` a command page and not "unknown group".
  const topLevel = (registry.topLevel ?? []).find((entry) => entry.name === groupName);
  if (topLevel !== undefined) {
    // `loop` was a group until the flattening; its ten verbs are top-level
    // commands now, so a retired verb after `loop` arrives as a positional.
    // Name the new spelling — and do it before `bindFlags`, so a retired flag
    // cannot hide the migration message behind "unknown option".
    if (topLevel.name === "loop" && commandName !== undefined) {
      const moved = RETIRED_LOOP_VERBS[commandName];
      if (moved !== undefined) {
        throw usageError(`loop ${commandName} has moved: use \`taskctl ${moved}\``, {
          fix: MIGRATION_FIX,
        });
      }
    }
    if (globals.help === true) {
      return helpResult(globals, null, topLevel, rest, wantsVersion);
    }
    const bound = bindFlags(flags, [...GLOBAL_FLAGS, ...(topLevel.flags ?? [])], topLevel.name, topLevel.name);
    // The destructuring above always captures the second positional as
    // `commandName`; for a bare command that *is* its first argument.
    const args = commandName === undefined ? [] : [commandName, ...rest];
    const slots = topLevel.positionals ?? [];
    const required = slots.filter((slot) => slot.required !== false).length;
    if (args.length < required) {
      throw usageError(`${topLevel.name}: missing argument <${slots[args.length]?.name ?? "…"}>`, {
        fix: `usage: taskctl ${topLevel.usage ?? topLevel.name}`,
      });
    }
    if (args.length > slots.length) {
      throw usageError(`${topLevel.name}: unexpected argument ${JSON.stringify(args[slots.length])}`, {
        fix: `usage: taskctl ${topLevel.usage ?? topLevel.name}`,
      });
    }
    const commandArgs = {};
    slots.forEach((slot, index) => {
      if (args[index] !== undefined) commandArgs[slot.name] = args[index];
    });
    return {
      flags: bound,
      group: null,
      command: topLevel,
      commandArgs,
      positionals: args,
      commandIndex: indices[0] ?? null,
      wantedHelp: false,
      version: wantsVersion,
    };
  }

  const group = registry.groups.find((entry) => entry.name === groupName);
  if (group === undefined) {
    // The board-status read kept the word, changed the subject: `status` used to
    // mean the board client; it is `board` now, and `loop` is the loop's own read.
    if (groupName === "status") {
      throw usageError("status has moved: use `taskctl board`", {
        fix: "`taskctl board` reports the board; `taskctl loop` reports the loop",
      });
    }
    throw usageError(`unknown command ${JSON.stringify(groupName)}`, {
      fix: "run `taskctl --help` for the list of commands",
    });
  }
  if (commandName === undefined) {
    // A group may name a default command, but only a caller who passed one of
    // *its* flags gets it: bare `taskctl export` prints help rather than writing
    // files into the working directory.
    const implicit =
      group.defaultCommand !== undefined && globals.help !== true && hasNonGlobalFlag(flags)
        ? group.commands.find((entry) => entry.name === group.defaultCommand)
        : undefined;
    if (implicit === undefined) return helpResult(globals, group, null, [], wantsVersion);
    const bound = bindFlags(flags, [...GLOBAL_FLAGS, ...(implicit.flags ?? [])], `${group.name} ${implicit.name}`, `${group.name} ${implicit.name}`);
    return {
      flags: bound,
      group,
      command: implicit,
      commandArgs: {},
      positionals: [],
      commandIndex: null,
      wantedHelp: false,
      version: wantsVersion,
    };
  }

  const command = group.commands.find((entry) => entry.name === commandName);
  if (command === undefined) {
    throw usageError(`unknown command ${JSON.stringify(`${groupName} ${commandName}`)}`, {
      fix: `run \`taskctl ${groupName} --help\` for the commands it has`,
    });
  }

  const where = `${groupName} ${commandName}`;
  if (globals.help === true) {
    return helpResult(globals, group, command, rest, wantsVersion);
  }

  // Globals and command flags share one namespace; a command may not redeclare a
  // global (the registry test pins that).
  const bound = bindFlags(flags, [...GLOBAL_FLAGS, ...(command.flags ?? [])], where, where);

  const slots = command.positionals ?? [];
  const required = slots.filter((slot) => slot.required !== false).length;
  if (rest.length < required) {
    throw usageError(`${where}: missing argument <${slots[rest.length]?.name ?? "…"}>`, {
      fix: `usage: taskctl ${command.usage ?? where}`,
    });
  }
  if (rest.length > slots.length) {
    throw usageError(`${where}: unexpected argument ${JSON.stringify(rest[slots.length])}`, {
      fix: `usage: taskctl ${command.usage ?? where}`,
    });
  }

  const commandArgs = {};
  slots.forEach((slot, index) => {
    if (rest[index] !== undefined) commandArgs[slot.name] = rest[index];
  });

  return {
    flags: bound,
    group,
    command,
    commandArgs,
    positionals: rest,
    commandIndex: indices[1] ?? null,
    wantedHelp: false,
    version: wantsVersion,
  };
}

function helpResult(flags, group, command, positionals, version) {
  return { flags, group, command, commandArgs: {}, positionals, commandIndex: null, wantedHelp: true, version };
}

/** Did the caller pass anything the *globals* do not own? */
function hasNonGlobalFlag(tokenized) {
  const globalNames = new Set(GLOBAL_FLAGS.map((spec) => spec.flag));
  for (const name of tokenized.keys()) {
    if (!globalNames.has(name)) return true;
  }
  return false;
}
