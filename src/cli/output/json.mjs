/**
 * The `--json` envelope (§F-C2).
 *
 *   success  {"ok": true,  "data": …}
 *   failure  {"ok": false, "error": {code, message, http, details, hint}}
 *
 * The error half is `DomainError.toJSON()` verbatim, so an agent can bind to
 * `error.code` and `error.hint.command` and never parse prose. Both halves go to
 * **stdout** — a program piping `taskctl … --json` must not have to merge two
 * streams — while human output for a *human* reader goes to stderr.
 *
 * Everything written here passes through `redactDeep` unless the command says
 * otherwise (`token rotate --show` is the one command that means to print a
 * secret).
 */

import { errorPayload } from "../errors.mjs";
import { redactDeep } from "../../shared/redact.mjs";

/** @param {unknown} data */
export function successEnvelope(data) {
  return { ok: true, data: data === undefined ? null : data };
}

/** @param {unknown} err */
export function errorEnvelope(err) {
  return { ok: false, error: errorPayload(err) };
}

/**
 * @param {object} envelope
 * @param {{redact?: boolean}} [options]
 * @returns {string}
 */
export function serialize(envelope, options = {}) {
  const { redact = true } = options;
  const value = redact ? redactDeep(envelope) : envelope;
  return `${JSON.stringify(value, null, 2)}\n`;
}
