#!/usr/bin/env node
/**
 * `taskctl` — the entry point (§M2).
 *
 * The whole program is five steps, in this order:
 *
 *   0. **preflight** — refuse a runtime older than Node 22 (see
 *      `shared/node-version.mjs`), so a too-old Node fails here, loudly, rather
 *      than deep inside a command when `node:sqlite` is finally imported;
 *   1. **parse** — `argv.mjs`, which refuses anything malformed as `CLI_USAGE`;
 *   2. **answer `--help` / `--version`** — before any board is contacted, so
 *      help works on a machine with no board and no data directory;
 *   3. **connect** — resolve the token, find or start the board, build a client;
 *   4. **run and render** — the command's result through `output/`, which is the
 *      only place that writes to stdout/stderr.
 *
 * Two rules the whole file exists to keep: the token is resolved once and never
 * printed, and every byte that reaches a terminal goes through `redactText` on
 * the way out.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { CLI_EXIT } from "../shared/constants.mjs";
import { isSupportedNode, unsupportedNodeMessage } from "../shared/node-version.mjs";
import { redactText } from "../shared/redact.mjs";
import { resolveActor } from "../shared/transport/actor.mjs";
import { parseArgv } from "./argv.mjs";
import { createBoardClient } from "../shared/transport/client.mjs";
import { registry } from "./commands/index.mjs";
import { exitCodeFor } from "../shared/transport/errors.mjs";
import { renderFailure, renderResult } from "./output/index.mjs";
import { ensureBoard, readPointer } from "../shared/transport/runtime.mjs";
import { resolveToken } from "../shared/transport/token.mjs";
import { commandUsage, groupUsage, topLevelUsage, versionLine } from "./usage.mjs";

/** `--json`, in either spelling. Read from the raw argv so it survives a parse failure. */
export function wantsJson(argv) {
  return argv.some((token) => token === "--json" || token.startsWith("--json="));
}

/** Read all of stdin. Used by `--report-file -` and the `--file -` flags. */
export function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += chunk;
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

/**
 * Everything a command's `run(ctx)` is given.
 *
 * Note what is *not* here: the token. Commands talk to the board through the
 * client, which holds it; a command cannot accidentally print it because it
 * never has it.
 */
export function createContext(parsed, options) {
  const {
    client,
    env = process.env,
    cwd = process.cwd(),
    stdin = () => readStdin(),
    readFile = (file) => readFileSync(file, "utf8"),
  } = options;
  const identity = resolveActor({ flags: parsed.flags, env });
  return {
    client,
    flags: parsed.flags,
    args: parsed.commandArgs,
    actor: identity.actor,
    session: parsed.flags.sessionId ?? identity.session,
    cwd,
    env,
    readStdin: stdin,
    readFile,
    identity,
  };
}

/**
 * Run one command line.
 *
 * @param {string[]} argv
 * @param {{stdout: Function, stderr: Function, env?: object, cwd?: string, stdin?: Function, readFile?: Function, pointerPath?: string}} io
 * @returns {Promise<number>} the process exit code
 */
export async function run(argv, io) {
  const out = io.stdout;
  const err = io.stderr;
  const env = io.env ?? process.env;
  const json = wantsJson(argv);
  /** @type {string|null} */
  let tokenSource = null;

  let parsed;
  try {
    parsed = parseArgv(argv, registry);
  } catch (failure) {
    renderFailure(failure, { json, out, err });
    return exitCodeFor(failure);
  }

  if (parsed.version === true) {
    out(versionLine());
    return CLI_EXIT.OK;
  }

  // Help never needs a board, a token or a data directory.
  if (parsed.wantedHelp) {
    if (parsed.command !== null) out(commandUsage(parsed.group, parsed.command));
    else if (parsed.group !== null) out(groupUsage(parsed.group));
    else out(topLevelUsage(registry));
    return CLI_EXIT.OK;
  }

  try {
    const pointerOptions = {
      env,
      ...(io.pointerPath === undefined ? {} : { pointerPath: io.pointerPath }),
    };

    // The token is resolved *first*, from the pointer as it stands. That order
    // matters for one reason: when finding the board fails, the failure should
    // still say which of the four sources was in play. It costs nothing —
    // `--url`/`$TASKD_TOKEN`/the token file do not depend on the board being up,
    // and a board this process started itself is on loopback, which needs no
    // token at all.
    const { token, source } = resolveToken({
      flag: parsed.flags.token,
      env,
      pointer: readPointer(io.pointerPath === undefined ? { env } : { env, path: io.pointerPath }),
    });
    tokenSource = source;

    const { url } = await ensureBoard({ url: parsed.flags.url ?? null, ...pointerOptions });
    const identity = resolveActor({ flags: parsed.flags, env });
    const client = createBoardClient({
      url,
      token,
      actor: identity.actor,
      session: parsed.flags.sessionId ?? null,
    });

    const ctx = createContext(parsed, {
      client,
      env,
      cwd: io.cwd ?? process.cwd(),
      ...(io.stdin === undefined ? {} : { stdin: io.stdin }),
      ...(io.readFile === undefined ? {} : { readFile: io.readFile }),
    });

    const result = await parsed.command.run(ctx);
    renderResult(
      { ...result, data: { ...(result.data ?? {}), token_source: source } },
      { json, out, err },
    );
    return result.exit ?? CLI_EXIT.OK;
  } catch (failure) {
    // Where the token came from is part of diagnosing a failure, and it is not
    // the token itself — so it rides along on the error.
    if (tokenSource !== null && failure !== null && typeof failure === "object") {
      failure.details = { ...(failure.details ?? {}), token_source: tokenSource };
    }
    renderFailure(failure, { json, out, err });
    return exitCodeFor(failure);
  }
}

// Guarded so the module can be imported by tests without running anything.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Step 0: the runtime floor. Exit 2 (the "cannot run as invoked" code, shared
  // with `install.sh`) and one clear line — never a stack trace from node:sqlite.
  if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(`${unsupportedNodeMessage(process.versions.node, { bin: "taskctl" })}\n`);
    process.exit(CLI_EXIT.USAGE);
  }

  const code = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exit(code);
}
