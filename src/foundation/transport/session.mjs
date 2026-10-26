/**
 * One board session, in the one order every caller must use.
 *
 * `.env` → actor → token → (connect) → client. The CLI and the loop
 * orchestrator both go through here, so a write attributed one way by hand is
 * attributed the same way by the loop. `createBoardSession` stops before any
 * board contact — the token and identity are local facts — and `connectBoard` is
 * the only step that may start or reach a daemon.
 *
 * The token never leaves this module's return object except into the board
 * client and the `board` coordinates the local hub keys on; commands receive
 * the client, never the token.
 *
 * Node builtins only; transport is foundation.
 */

import { loadEnvFile } from "../env-config.mjs";
import { repoRoot } from "../runtime-locator.mjs";
import { resolveActor } from "./actor.mjs";
import { createBoardClient } from "./client.mjs";
import { ensureBoard, readPointer } from "./runtime.mjs";
import { resolveToken } from "./token.mjs";

/**
 * Resolve the config, identity and token, without contacting a board.
 *
 * @param {{
 *   flags?: object,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   root?: string,
 *   pointerPath?: string,
 * }} [input]
 * @returns {{
 *   config: object,
 *   env: NodeJS.ProcessEnv,
 *   identity: {actor: {kind: string, id: string}, session?: string|null},
 *   token: string|null,
 *   source: string,
 *   pointerOptions: {env: NodeJS.ProcessEnv, pointerPath?: string},
 * }}
 */
export function createBoardSession({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  root = repoRoot(),
  pointerPath,
} = {}) {
  const config = loadEnvFile({
    flag: flags.envFile ?? null,
    env,
    cwd,
    root,
  });
  const effectiveEnv = config.env;

  // Resolve the actor before touching a board: a reserved `human` kind or a
  // session with no platform is a usage mistake, and it should not depend on
  // whether a board happens to be running.
  const identity = resolveActor({ flags, env: effectiveEnv });

  const pointerOptions = {
    env: effectiveEnv,
    ...(pointerPath === undefined ? {} : { pointerPath }),
  };

  // The token is resolved before the board is found: when finding the board
  // fails, the failure still says which source was in play. The pointer is read
  // exactly the way `ensureBoard` reads it (data-directory fallback included).
  const { token, source } = resolveToken({
    flag: flags.token,
    env: effectiveEnv,
    tokenFile: config.tokenFile,
    pointer: readPointer(
      pointerPath === undefined ? { env: effectiveEnv } : { env: effectiveEnv, path: pointerPath },
    ),
  });

  return { config, env: effectiveEnv, identity, token, source, pointerOptions };
}

/**
 * Find or start the board and build its client.
 *
 * @param {{pointerOptions: object, token: string|null, identity: {actor: object}}} session
 * @param {{flags?: object}} [input]
 * @returns {Promise<{url: string, client: object, board: {url: string, token: string|null}}>}
 */
export async function connectBoard(session, { flags = {} } = {}) {
  const { url } = await ensureBoard({ url: flags.url ?? null, ...session.pointerOptions });
  const client = createBoardClient({
    url,
    token: session.token,
    actor: session.identity.actor,
    session: flags.sessionId ?? null,
  });
  return { url, client, board: { url, token: session.token } };
}
