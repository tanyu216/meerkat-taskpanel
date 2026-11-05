/**
 * Which failed turns are transient.
 *
 * A timeout — or the clean exit an interrupted turn leaves behind — is not a
 * card failure: the same card can be retried without spending its delivery
 * budget. Everything else (`spawn error`, a non-zero exit, `boom`) stays a real
 * failure, and the attempt bound keeps its existing meaning.
 *
 * The classifier is deliberately one predicate in one file: the queue, the hold
 * path and the session pool must agree on what "timed out" means, and the
 * adapters' error strings are the only input they share.
 *
 * Node builtins only; no I/O.
 */

/** The adapter's timeout text, which may be wrapped by a lane prefix. */
const TURN_TIMEOUT = /turn timed out after \d+ms/;

/**
 * A turn whose child exited cleanly (code 0, no signal) after an interrupt.
 * The adapter names the kind in the phrase; the surrounding text is free.
 */
const CLEAN_EXIT = /(?:^|\s)(?:claude|codex(?: app-server)?|pi) exited \(code=0, signal=null\)(?:$|\s)/;

/**
 * @param {unknown} error the error text or Error a failed turn produced
 * @returns {boolean} true when the failure can be retried without the attempt bound
 */
export function isTurnTimeoutError(error) {
  if (error === null || error === undefined) return false;
  const text = String(error).trim();
  if (text === "") return false;
  return TURN_TIMEOUT.test(text) || CLEAN_EXIT.test(text);
}
