/**
 * `taskctl loop <verb>` — route one verb to the moved loop entries.
 *
 * The entries still speak the loop's original argv/`opts` shape, so the raw
 * command line is handed through (minus `loop <verb>`) instead of rebuilding it
 * from bound flags. The only translations are the new spellings:
 *
 *   * `--state-dir <dir>` -> `--state <dir>/supervisor.state.json`
 *   * `loop tick --passes a,b` -> three `passes.main` calls
 *   * `loop run --ping-once|--continue-once` -> `--ping-only|--continue-only --once`
 *
 * This is the 2A bridge: the board adapter still spawns `taskctl`. 2B replaces
 * it with the in-process operations layer.
 */

import { join } from "node:path";

import * as consoleEntry from "./console.mjs";
import * as doctorEntry from "./doctor.mjs";
import * as passesEntry from "./passes.mjs";
import * as statusEntry from "./status.mjs";
import * as subscribeEntry from "./subscribe.mjs";
import * as supervisorEntry from "./supervisor.mjs";

const VERBS = new Set([
  "patrol",
  "workflow",
  "poll",
  "tick",
  "console",
  "doctor",
  "status",
  "run",
  "subscribe",
  "session",
]);

/** The raw tokens after removing the `loop <verb>` pair. */
function rawRest(ctx) {
  const raw = Array.isArray(ctx.argv) ? ctx.argv.slice() : [];
  const at = raw.findIndex((token, index) => token === "loop" && VERBS.has(raw[index + 1]));
  if (at < 0) return raw;
  const rest = raw.slice();
  rest.splice(at, 2);
  return rest;
}

/** Remove `--name value` or `--name=value`, returning the value. */
function takeValue(args, name) {
  const rest = [];
  let value;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === `--${name}`) {
      value = args[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith(`--${name}=`)) {
      value = token.slice(name.length + 3);
      continue;
    }
    rest.push(token);
  }
  return { rest, value };
}

/** Remove a bare switch, returning whether it was present. */
function takeSwitch(args, name) {
  return {
    rest: args.filter((token) => token !== `--${name}`),
    value: args.includes(`--${name}`),
  };
}

/**
 * @param {object} ctx the local CLI context (`argv`, `env`, `flags`, `out`, `err`)
 * @param {string} verb one of `VERBS`
 * @returns {Promise<{streamed: true, exit: number}>}
 */
export async function runLoopVerb(ctx, verb) {
  const io = { out: ctx.out, err: ctx.err };
  const env = ctx.env ?? process.env;
  let rest = rawRest(ctx);

  // The documented spelling is `--state-dir`; the moved parser still expects
  // `--state <registry-file>`. Drop a trailing user-supplied `--state` only when
  // `--state-dir` is present, so `--state-dir` wins.
  const stateDir = takeValue(rest, "state-dir");
  rest = stateDir.rest;
  if (stateDir.value !== undefined && stateDir.value !== "") {
    rest = takeValue(rest, "state").rest;
    rest.push("--state", join(stateDir.value, "supervisor.state.json"));
  }

  // The loop never writes as a human, never inherits a caller session and never
  // uses the CLI's optimistic concurrency. The globals are bound everywhere;
  // the loop's own parser does not know them, so refuse them here.
  for (const forbidden of ["--as-human", "--session-id", "--if-version"]) {
    if (rest.some((token) => token === forbidden || token.startsWith(`${forbidden}=`))) {
      io.err(`loop: ${forbidden} is not valid for the loop\n`);
      return { streamed: true, exit: 2 };
    }
  }

  // Reads (`console`, `doctor`, `status`) work with no actor; every mutating
  // verb must say who is acting, like every board command.
  const MUTATING = new Set(["patrol", "workflow", "poll", "tick", "run", "subscribe", "session"]);
  if (MUTATING.has(verb) && !(ctx.flags?.actorKind ?? ctx.env?.TASKCTL_ACTOR_KIND)) {
    io.err("loop: --actor-kind is required for this verb\n");
    return { streamed: true, exit: 2 };
  }

  switch (verb) {
    case "patrol":
    case "workflow":
    case "poll":
      return { streamed: true, exit: await passesEntry.main([verb, ...rest], env, io) };

    case "tick": {
      const passes = takeValue(rest, "passes");
      rest = passes.rest;
      const listed = String(passes.value ?? "patrol,workflow,poll")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      let exit = 0;
      for (const pass of listed) {
        exit = await passesEntry.main([pass, ...rest], env, io);
        if (exit !== 0) break;
      }
      return { streamed: true, exit };
    }

    case "console":
      return { streamed: true, exit: await consoleEntry.main(["--once", ...rest], env, {}, io) };

    case "doctor":
      return { streamed: true, exit: await doctorEntry.main(rest, env, {}, io) };

    case "status":
      return { streamed: true, exit: await statusEntry.main(rest, env, {}, io) };

    case "run": {
      const ping = takeSwitch(rest, "ping-once");
      const cont = takeSwitch(ping.rest, "continue-once");
      rest = cont.rest;
      if (ping.value && cont.value) {
        io.err("loop run: choose --ping-once or --continue-once\n");
        return { streamed: true, exit: 2 };
      }
      if (ping.value) rest.push("--ping-only", "--once");
      if (cont.value) rest.push("--continue-only", "--once");
      return { streamed: true, exit: await supervisorEntry.main(rest, env, io) };
    }

    case "subscribe":
      return { streamed: true, exit: await subscribeEntry.main(["--subscribe", ...rest], env, io) };

    case "session":
      return { streamed: true, exit: await supervisorEntry.main(["--session", ...rest], env, io) };

    default:
      io.err(`loop: unknown verb ${verb}\n`);
      return { streamed: true, exit: 2 };
  }
}
