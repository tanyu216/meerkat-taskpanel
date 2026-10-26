/**
 * One adapter over the live activity stream for the CLI's two consumers.
 *
 * `events tail` and `export watch` read the same SSE frames; only their output
 * vocabulary differs. Keeping the frame rules here means the unnamed-frame
 * rule, the `id:` → `data.revision` cursor fallback, the named `shutdown`
 * frame, and the malformed-payload rule cannot drift between them.
 *
 * The generator yields ordinary values instead of calling a callback so a
 * caller can use `for await` and `break` without a teardown protocol:
 *
 *   {type: "frame", id, revision, data}   one activity
 *   {type: "shutdown", data}              the server is ending the stream
 *   {type: "eof"}                         the transport ended on its own
 */

import { SSE_SHUTDOWN_EVENT } from "../foundation/constants.mjs";
import { createSseParser } from "../foundation/sse-parse.mjs";

/**
 * @param {AsyncIterable<string>} stream decoded chunks from `client.stream`
 * @returns {AsyncGenerator<
 *   | {type: "frame", id: number|null, revision: number|null, data: object}
 *   | {type: "shutdown", data: object|null}
 *   | {type: "eof"}
 * >}
 */
export async function* activityFrames(stream) {
  const parser = createSseParser();
  for await (const chunk of stream) {
    for (const frame of parser.push(chunk)) {
      if (frame.event === SSE_SHUTDOWN_EVENT) {
        // A malformed payload still means the server is leaving.
        yield { type: "shutdown", data: parseJson(frame.data) };
        return;
      }

      const data = parseJson(frame.data);
      if (data === null) continue; // a frame that is not JSON cannot name a board event

      const rawId = frame.id === null ? null : Number.parseInt(frame.id, 10);
      const id = Number.isFinite(rawId) ? rawId : null;
      // The frame id is the board revision. A hand-written frame may carry it
      // only in the payload; `events tail` still reports `id: null`.
      const revision = id ?? (Number.isInteger(data.revision) ? data.revision : null);
      yield { type: "frame", id, revision, data };
    }
  }
  yield { type: "eof" };
}

/**
 * The stream failure in the transport's own vocabulary.
 *
 * @param {unknown} err
 * @returns {"aborted"|"idle"|"error"}
 */
export function streamFailure(err) {
  const reason = err?.details?.reason;
  if (reason === "aborted" || reason === "idle") return reason;
  return "error";
}

/** @param {string} text @returns {object|null} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
