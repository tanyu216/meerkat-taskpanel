/**
 * The loop's card brief watches — register with the local event hub, do not
 * write the files here.
 *
 * The hub owns the one board SSE connection and the refresh loop; a registration
 * names each card's exact file and ends when the card reaches `done` or
 * `canceled` (the loop passes `ttl_ms: 0`). The hub writes the first snapshot
 * before it answers `registered`, so the poll pass can register **before** the
 * claim and keep the old gate ("a claimed card has a brief") while the file
 * stays fresh for as long as the card is live.
 *
 * This module is deliberately the only place the loop builds a board session for
 * a watch: `transport/session` resolves URL/token/identity, `ensureHub` owns the
 * detached process, and `hub-client` speaks the loopback protocol. No board HTTP
 * call happens here.
 *
 * Node builtins only; no board access.
 */

import { join } from "node:path";

import { cardFileRel } from "../foundation/card-brief.mjs";
import { ensureHub, hubCall } from "../foundation/hub-client.mjs";
import { connectBoard, createBoardSession } from "../foundation/transport/session.mjs";

/** The answer to a `watch` request, or the hub's error record. */
const WATCH_MATCH = (record) =>
  record?.type === "registered" || record?.op === "error";

/** The answer to a `watch-stop` request, or the hub's error record. */
const STOP_MATCH = (record) => record?.op === "watch-stop" || record?.op === "error";

/**
 * The cards one dispatch needs a brief for: the card itself, plus its original
 * when it is a review. Both live under the same target directory.
 *
 * @param {string} dir the resolved project directory
 * @param {string} identifier the card's identifier
 * @param {string|null} [reviewOf] the reviewed card's identifier
 * @returns {Array<{ref: string, out: string}>}
 */
export function briefCards(dir, identifier, reviewOf = null) {
  const cards = [{ ref: identifier, out: join(dir, cardFileRel(identifier)) }];
  if (typeof reviewOf === "string" && reviewOf.trim() !== "") {
    const original = reviewOf.trim();
    cards.push({ ref: original, out: join(dir, cardFileRel(original)) });
  }
  return cards;
}

/**
 * Resolve the board and make sure a hub is running for it.
 *
 * `opts` is the loop's parsed options. `deps` is the test seam: every input is
 * injectable so the registration logic is exercised without a socket.
 *
 * @param {object} opts
 * @param {{env?: object, cwd?: string, createSession?: Function, connect?: Function,
 *          ensure?: Function, log?: Function}} [deps]
 * @returns {Promise<{pointer: object, token: string, url: string}>}
 */
export async function openCardWatch(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  const createSession = deps.createSession ?? createBoardSession;
  const connect = deps.connect ?? connectBoard;
  const ensure = deps.ensure ?? ensureHub;

  const session = createSession({
    flags: {
      token: opts.token,
      envFile: opts.envFile,
      actorKind: opts.actorKind,
      agent,
    },
    env,
    cwd,
  });
  const { url } = await connect(session, { flags: { url: opts.url } });
  const { pointer } = await ensure({
    url,
    token: session.token,
    actorKind: opts.actorKind,
    agent,
    envFile: opts.envFile,
    entry: opts.cli,
    env,
    log: deps.log ?? (() => {}),
  });
  return { pointer, token: pointer.token, url };
}

/**
 * Register one or more cards, each with its exact file.
 *
 * @param {object} opts
 * @param {Array<{ref: string, out: string}>} cards
 * @param {{hub?: {pointer: object, token: string}, hubCall?: Function}} [deps]
 * @returns {Promise<{ok: true, running: boolean, reason: string|null,
 *                    registrationId: string|null, cards: object[]}
 *                  | {ok: false, error: string}>}
 */
export async function registerCardWatch(opts, cards, deps = {}) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { ok: false, error: "a watch needs at least one card" };
  }
  try {
    const hub = deps.hub ?? (await openCardWatch(opts, deps));
    const call = deps.hubCall ?? hubCall;
    const answer = await call(
      hub.pointer,
      hub.token,
      {
        op: "watch",
        cards,
        ttl_ms: 0,
        detach: true,
        ...(typeof deps.owner === "string" && deps.owner !== "" ? { owner: deps.owner } : {}),
      },
      { match: WATCH_MATCH },
    );
    if (answer?.op === "error") {
      return { ok: false, error: answer.error?.message ?? "the hub refused the registration" };
    }
    if (answer?.type !== "registered") {
      return { ok: false, error: "the hub did not answer the registration" };
    }
    return {
      ok: true,
      running: answer.running === true,
      reason: answer.reason ?? null,
      registrationId: answer.registration_id ?? null,
      cards: Array.isArray(answer.cards) ? answer.cards : [],
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Undo a registration. Any one of its paths addresses the whole registration.
 *
 * @param {object} opts
 * @param {{ref?: string|null, out?: string|null}} target
 * @param {{hub?: {pointer: object, token: string}, hubCall?: Function}} [deps]
 * @returns {Promise<{ok: true, stopped: boolean} | {ok: false, error: string}>}
 */
export async function stopCardWatch(opts, target, deps = {}) {
  try {
    const hub = deps.hub ?? (await openCardWatch(opts, deps));
    const call = deps.hubCall ?? hubCall;
    const answer = await call(
      hub.pointer,
      hub.token,
      {
        op: "watch-stop",
        ...(typeof target?.ref === "string" && target.ref !== "" ? { ref: target.ref } : {}),
        ...(typeof target?.out === "string" && target.out !== "" ? { out: target.out } : {}),
      },
      { match: STOP_MATCH },
    );
    if (answer?.op === "error") {
      return { ok: false, error: answer.error?.message ?? "the hub refused the stop" };
    }
    return { ok: true, stopped: answer?.stopped === true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
