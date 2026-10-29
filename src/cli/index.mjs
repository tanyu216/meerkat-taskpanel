#!/usr/bin/env node
/**
 * `taskctl` — the entry point (§M2).
 *
 * The whole program is five steps, in this order:
 *
 *   0. **preflight** — refuse a runtime older than Node 22 (see
 *      `foundation/node-version.mjs`), so a too-old Node fails here, loudly, rather
 *      than deep inside a command when `node:sqlite` is finally imported;
 *   1. **parse** — `argv.mjs`, which refuses anything malformed as `CLI_USAGE`;
 *   2. **answer `--help` / `--version`** — before any board is contacted, so
 *      help works on a machine with no board and no data directory;
 *   2b. **answer a local command** (`status`) — it reads the runtime pointer, so
 *      it needs no identity, no token and no board, and must work when the board
 *      is down;
 *   3. **connect** — resolve the token, find or start the board, build a client;
 *   4. **run and render** — the command's result through `output/`, which is the
 *      only place that writes to stdout/stderr.
 *
 * Two rules the whole file exists to keep: the token is resolved once and never
 * printed, and every byte that reaches a terminal goes through `redactText` on
 * the way out.
 */

import { readFileSync } from "node:fs";

import { CLI_EXIT, CONTRACT_SCHEMA_VERSION, LOG_LEVEL_ENV, VERSION } from "../foundation/constants.mjs";
import { loadEnvFile } from "../foundation/env-config.mjs";
import { DomainError } from "../foundation/errors.mjs";
import { resolveKindConfigPath } from "../foundation/agent-paths.mjs";
import { createLogger, parseLogLevel } from "../foundation/log.mjs";
import { repoRoot } from "../foundation/runtime-locator.mjs";
import { isSupportedNode, unsupportedNodeMessage } from "../foundation/node-version.mjs";
import { redactDeep, redactText } from "../foundation/redact.mjs";
import { ACTOR_ENV_KEYS, resolveActor } from "../foundation/transport/actor.mjs";
import { parseArgv } from "./argv.mjs";
import { registry } from "./commands/index.mjs";
import { exitCodeFor } from "../foundation/transport/errors.mjs";
import { renderFailure, renderResult } from "./output/index.mjs";
import { connectBoard, createBoardSession } from "../foundation/transport/session.mjs";
import { commandUsage, groupUsage, topLevelUsage, versionLine } from "./usage.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";

/** `--json`, in either spelling. Read from the raw argv so it survives a parse failure. */
export function wantsJson(argv) {
  return argv.some((token) => token === "--json" || token.startsWith("--json="));
}

/**
 * The `--version --json` payload.
 *
 * One construction, used by the CLI and read by the CLI contract checker: the
 * snapshot freezes the payload's *keys*, so it must come from the code that
 * actually answers the command, never from a second list.
 */
export function versionPayload() {
  return { version: VERSION, schema_version: CONTRACT_SCHEMA_VERSION };
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
    out = () => {},
    board = null,
    // A caller that already resolved the session passes it; a direct test or
    // the local path can omit it and get the same actor rule.
    identity = resolveActor({ flags: parsed.flags, env }),
  } = options;
  return {
    client,
    flags: parsed.flags,
    args: parsed.commandArgs,
    actor: identity.actor,
    /** The resolved board coordinates; the local hub key needs both. Never printed. */
    board,
    session: parsed.flags.sessionId ?? identity.session,
    cwd,
    env,
    readStdin: stdin,
    readFile,
    identity,
    /**
     * One NDJSON record for a streaming command. Redacted on the way out, like
     * every other byte the CLI writes; a streaming command returns
     * `{streamed: true}` so the dispatcher does not add an envelope.
     */
    emit: (record) => out(`${JSON.stringify(redactDeep(record))}\n`),
  };
}

/**
 * The CLI's diagnostic logger.
 *
 * Off unless `TASKD_LOG_LEVEL` names a level, and silent when it names `off`.
 * It writes through the injected stderr sink, so a `--json` document on stdout
 * is never touched and a test can capture the line.
 *
 * @param {(text: string) => void} err
 * @param {Record<string, string|undefined>} env
 */
function cliLogger(err, env) {
  const raw = env?.[LOG_LEVEL_ENV];
  const level = typeof raw === "string" && raw.trim() !== "" ? parseLogLevel(raw) : null;
  if (level === null || level === "off") return () => {};
  return createLogger({
    level,
    sinks: [(line) => err(`${line}\n`)],
    meta: { service: "taskctl" },
  });
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
  // The CLI is quiet unless asked: its stdout is the data plane and its stderr
  // is the product's error surface, so a log line is only wanted when someone
  // is diagnosing. `TASKD_LOG_LEVEL=debug` turns it on; every event below is
  // debug, so `info`/`warn` never add a line either.
  const log = cliLogger(err, env);
  /** @type {string|null} */
  let tokenSource = null;

  let parsed;
  try {
    parsed = parseArgv(argv, registry);
  } catch (failure) {
    log({ event: "cli_failure", command: null, code: failure?.code ?? null });
    renderFailure(failure, { json, out, err });
    return exitCodeFor(failure);
  }
  log({
    event: "cli_command",
    command: parsed.command?.name ?? null,
    group: parsed.group?.name ?? null,
  });

  if (parsed.version === true) {
    // The version leg, in machine form: `--json` publishes the contract schema
    // generation beside the release version, so a client's drift gate can read
    // the number the provider actually speaks instead of hard-coding it. The
    // bare line is unchanged — it is answered before any board, token or data
    // directory, and a consumer that needs only the version must not pay for a
    // board (nor fail when there is none).
    if (json) {
      renderResult({ data: versionPayload(), human: "" }, { json, out, err });
      return CLI_EXIT.OK;
    }
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

  // A **local** command reports something the client itself knows. `status`
  // reads the runtime pointer; `project dir --require-dir` reads the local
  // projects map for a wake and must work with the board down. Both run before
  // the identity check and before any board is contacted: there is no write to
  // attribute and no token to resolve. They get a minimal context —
  // deliberately not `createContext`, which resolves an actor.
  const localCommand =
    parsed.command?.local === true ||
    (typeof parsed.command?.localWhen === "function" && parsed.command.localWhen(parsed) === true);
  if (localCommand) {
    try {
      const cwd = io.cwd ?? process.cwd();
      const root = repoRoot();
      const config = loadEnvFile({
        flag: parsed.flags.envFile ?? null,
        env,
        cwd,
        root,
        kindFile: resolveKindConfigPath({
          actorKind: parsed.flags.actorKind ?? env[ACTOR_ENV_KEYS.kind] ?? null,
          root,
          env,
          cwd,
        }),
      });
      const local = {
        flags: parsed.flags,
        args: parsed.commandArgs,
        // The raw tokens let a compatibility entry (`taskctl loop …`) hand the
        // original flag spellings to the moved loop parser without rebuilding
        // them from bound flags.
        argv: argv.slice(),
        env: config.env,
        cwd: io.cwd ?? process.cwd(),
        readFile: io.readFile ?? ((file) => readFileSync(file, "utf8")),
        out,
        err,
      };
      const result = await parsed.command.run(local);
      // A streaming/compatibility entry owns stdout for its whole lifetime and
      // has already written its terminal output; an envelope here would be a
      // second document.
      if (result?.streamed === true) return result.exit ?? CLI_EXIT.OK;
      renderResult(result, { json, out, err });
      return result.exit ?? CLI_EXIT.OK;
    } catch (failure) {
      log({ event: "cli_failure", command: parsed.command?.name ?? null, code: failure?.code ?? null });
      renderFailure(failure, { json, out, err });
      return exitCodeFor(failure);
    }
  }

  try {
    // Every command except `--help` / `--version` must declare who is writing.
    // A missing kind is a usage error, not a silent `human` write: the board's
    // human/agent distinction is load-bearing. `--as-human` is the explicit
    // human spelling; `--actor-kind human` is still refused by `resolveActor`.
    const declaredKind =
      parsed.flags.actorKind ??
      env[ACTOR_ENV_KEYS.kind] ??
      (parsed.flags.asHuman === true ? "human" : null);
    if (declaredKind === null || String(declaredKind).trim() === "") {
      throw new DomainError("CLI_USAGE", {
        message:
          "--actor-kind is required (claude|codex|openclaw|pi); " +
          "pass it, export TASKCTL_ACTOR_KIND, or use --as-human",
        details: {
          field: "actorKind",
          examples: ["claude", "codex", "openclaw", "pi"],
          alternative: "--as-human",
        },
        hint: {
          fix: "agents pass --actor-kind <platform> (the taskctl shim does this); a human may use --as-human",
        },
      });
    }

    const session = createBoardSession({
      flags: parsed.flags,
      env,
      cwd: io.cwd ?? process.cwd(),
      ...(io.pointerPath === undefined ? {} : { pointerPath: io.pointerPath }),
    });
    tokenSource = session.source;

    const { client, board } = await connectBoard(session, { flags: parsed.flags });

    const ctx = createContext(parsed, {
      client,
      env: session.env,
      cwd: io.cwd ?? process.cwd(),
      out,
      board,
      identity: session.identity,
      ...(io.stdin === undefined ? {} : { stdin: io.stdin }),
      ...(io.readFile === undefined ? {} : { readFile: io.readFile }),
    });

    const result = await parsed.command.run(ctx);
    // A streaming command owns stdout for its whole lifetime and has already
    // written its terminal line; adding an envelope here would corrupt it.
    if (result?.streamed === true) return result.exit ?? CLI_EXIT.OK;
    renderResult(
      { ...result, data: { ...(result.data ?? {}), token_source: session.source } },
      { json, out, err },
    );
    return result.exit ?? CLI_EXIT.OK;
  } catch (failure) {
    // Where the token came from is part of diagnosing a failure, and it is not
    // the token itself — so it rides along on the error.
    if (tokenSource !== null && failure !== null && typeof failure === "object") {
      failure.details = { ...(failure.details ?? {}), token_source: tokenSource };
    }
    log({ event: "cli_failure", command: parsed.command?.name ?? null, code: failure?.code ?? null });
    renderFailure(failure, { json, out, err });
    return exitCodeFor(failure);
  }
}

// Guarded so the module can be imported by tests without running anything.
if (isEntryPoint(import.meta.url)) {
  // Step 0: the runtime floor. Exit 2 (the "cannot run as invoked" code, shared
  // with `install.sh`) and one clear line — never a stack trace from node:sqlite.
  if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(`${unsupportedNodeMessage(process.versions.node, { bin: "taskctl" })}\n`);
    process.exit(CLI_EXIT.USAGE);
  }

  // Letting the writes drain (below) exposes what `process.exit()` used to hide: a
  // reader that stops early — `… | head`, `… | jq -c 'first'` — closes the pipe, and
  // the next chunk surfaces as an unhandled `'error'` event, which would print a
  // stack trace where every other CLI just stops. The reader asked for no more, so
  // there is nothing to report and nothing failed. Any other write error is still a
  // crash, exactly as it was without a listener.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (failure) => {
      if (failure?.code === "EPIPE") process.exit(CLI_EXIT.OK);
      throw failure;
    });
  }

  const code = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  // A pipe holds 64 KiB before it pushes back, so a larger `--json` payload is
  // still queued when `run` returns. `process.exit()` discards that queue: the
  // reader gets a truncated document and exit 0 — which is how the loop's board
  // read failed silently for a day. Report the code and let the loop end once
  // the queued writes have drained.
  process.exitCode = code;
}
