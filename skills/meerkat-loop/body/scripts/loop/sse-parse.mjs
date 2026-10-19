/**
 * The Server-Sent Events frame parser (the `text/event-stream` grammar).
 *
 * This is deliberately transport-free: `sse-client.mjs` feeds it decoded text
 * chunks and receives whole frames. Keeping it pure is what makes the awkward
 * cases — a CRLF split across two socket reads, a multi-line `data:` value, the
 * initial `retry:` line — testable without a server.
 *
 * Grammar notes that matter here:
 *   * a comment (`: …`) carries no data and never dispatches;
 *   * `data:` lines accumulate and join with `\n`;
 *   * a blank line dispatches the accumulated frame;
 *   * `event:` names the frame; unnamed frames are `message`;
 *   * `retry:` is a hint (the client owns its own ladder, but it is exposed);
 *   * `id:` is the resume cursor.
 *
 * Node builtins only; no network, no dependencies.
 */

/** A frame larger than this is a protocol error, not something to buffer. */
export const SSE_MAX_BUFFER = 1024 * 1024;

/**
 * @param {{maxBuffer?: number}} [options]
 * @returns {{push: (chunk: string) => object[], end: () => void, buffered: () => number, retry: () => number|null}}
 */
export function createSseParser(options = {}) {
  const maxBuffer = options.maxBuffer ?? SSE_MAX_BUFFER;
  let buffer = "";
  let data = [];
  let event = "";
  let id = null;
  let retry = null;

  const dispatch = (frames) => {
    if (data.length === 0 && event === "") return;
    frames.push({ id, event: event === "" ? "message" : event, data: data.join("\n") });
    data = [];
    event = "";
    // The SSE spec keeps `id` as the last event id; a reconnecting client uses
    // it as its cursor. Each frame carries it, so reset it after dispatch to
    // keep a later id-less frame from inheriting an older id.
    id = null;
  };

  return {
    /**
     * Feed one decoded chunk; return the frames it completed.
     *
     * @param {string} chunk
     * @returns {{id: string|null, event: string, data: string}[]}
     */
    push(chunk) {
      buffer += chunk;
      if (buffer.length > maxBuffer) {
        throw new Error(`SSE frame exceeded ${maxBuffer} bytes`);
      }
      const frames = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          dispatch(frames);
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id") id = value;
        else if (field === "retry") {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
        }
        // Unknown fields are ignored, as the spec requires.
      }
      return frames;
    },
    /** Drop an incomplete trailing frame; a stream that ended mid-frame has no frame. */
    end() {
      buffer = "";
      data = [];
      event = "";
      id = null;
    },
    buffered() {
      return buffer.length;
    },
    retry() {
      return retry;
    },
  };
}
