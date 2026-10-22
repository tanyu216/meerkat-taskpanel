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

import { CLI_EXIT, CONTRACT_SCHEMA_VERSION, VERSION } from "../foundation/constants.mjs";
import { loadEnvFile } from "../foundation/env-config.mjs";
import { DomainError } from "../foundation/errors.mjs";
import { isSupportedNode, unsupportedNodeMessage } from "../foundation/node-version.mjs";
import { redactDeep, redactText } from "../foundation/redact.mjs";
import { repoRoot } from "../foundation/runtime-locator.mjs";
import { ACTOR_ENV_KEYS, resolveActor } from "../foundation/transport/actor.mjs";
import { parseArgv } from "./argv.mjs";
import { createBoardClient } from "../foundation/transport/client.mjs";
import { registry } from "./commands/index.mjs";
import { exitCodeFor } from "../foundation/transport/errors.mjs";
import { renderFailure, renderResult } from "./output/index.mjs";
import { ensureBoard, readPointer } from "../foundation/transport/runtime.mjs";
import { resolveToken } from "../foundation/transport/token.mjs";
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
    /**
     * One NDJSON record for a streaming command. Redacted on the way out, like
     * every other byte the CLI writes; a streaming command returns
     * `{streamed: true}` so the dispatcher does not add an envelope.
     */
    emit: (record) => out(`${JSON.stringify(redactDeep(record))}\n`),
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

  // A **local** command (`status`) reports the client's own view of the board.
  // It runs before the identity check and before any board is contacted: there
  // is no write to attribute and no token to resolve, and a command whose whole
  // job is "is the board up?" must be able to answer when it is not. It gets a
  // minimal context — deliberately not `createContext`, which resolves an actor
  // and would make `status` require `--actor-kind`.
  if (parsed.command?.local === true) {
    try {
      const config = loadEnvFile({
        flag: parsed.flags.envFile ?? null,
        env,
        cwd: io.cwd ?? process.cwd(),
        root: repoRoot(),
      });
      const local = {
        flags: parsed.flags,
        env: config.env,
        cwd: io.cwd ?? process.cwd(),
        readFile: io.readFile ?? ((file) => readFileSync(file, "utf8")),
        out,
      };
      const result = await parsed.command.run(local);
      renderResult(result, { json, out, err });
      return result.exit ?? CLI_EXIT.OK;
    } catch (failure) {
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
          "--actor-kind is required (claude|codex|openclaw|pi|opencode|cursor); " +
          "pass it, export TASKCTL_ACTOR_KIND, or use --as-human",
        details: {
          field: "actorKind",
          examples: ["claude", "codex", "openclaw", "pi", "opencode", "cursor"],
          alternative: "--as-human",
        },
        hint: {
          fix: "agents pass --actor-kind <platform> (the taskctl shim does this); a human may use --as-human",
        },
      });
    }

    const config = loadEnvFile({
      flag: parsed.flags.envFile ?? null,
      env,
      cwd: io.cwd ?? process.cwd(),
      root: repoRoot(),
    });
    const effectiveEnv = config.env;

    // Resolve the actor before touching a board: a reserved `human` kind or a
    // session with no platform is a usage mistake, and it should not depend on
    // whether a board happens to be running.
    const identity = resolveActor({ flags: parsed.flags, env: effectiveEnv });

    const pointerOptions = {
      env: effectiveEnv,
      ...(io.pointerPath === undefined ? {} : { pointerPath: io.pointerPath }),
    };

    // The token is resolved *first*, from the pointer as it stands. That order
    // matters for one reason: when finding the board fails, the failure should
    // still say which of the four sources was in play. It costs nothing —
    // `--url`/`$TASKD_TOKEN`/the token file do not depend on the board being up,
    // and a board this process started itself is on loopback, which needs no
    // token at all. The pointer is read exactly the way `ensureBoard` reads it
    // (data-directory fallback included, R1), so the token belongs to whichever
    // board answers.
    const { token, source } = resolveToken({
      flag: parsed.flags.token,
      env: effectiveEnv,
      tokenFile: config.tokenFile,
      pointer: readPointer(io.pointerPath === undefined ? { env: effectiveEnv } : { env: effectiveEnv, path: io.pointerPath }),
    });
    tokenSource = source;

    const { url } = await ensureBoard({ url: parsed.flags.url ?? null, ...pointerOptions });
    const client = createBoardClient({
      url,
      token,
      actor: identity.actor,
      session: parsed.flags.sessionId ?? null,
    });

    const ctx = createContext(parsed, {
      client,
      env: effectiveEnv,
      cwd: io.cwd ?? process.cwd(),
      out,
      ...(io.stdin === undefined ? {} : { stdin: io.stdin }),
      ...(io.readFile === undefined ? {} : { readFile: io.readFile }),
    });

    const result = await parsed.command.run(ctx);
    // A streaming command owns stdout for its whole lifetime and has already
    // written its terminal line; adding an envelope here would corrupt it.
    if (result?.streamed === true) return result.exit ?? CLI_EXIT.OK;
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
if (isEntryPoint(import.meta.url)) {
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
