/**
 * `events tail` — the board's live activity stream over the CLI.
 *
 * This is the one command whose output is **not** the `{ok,data}` envelope: a
 * long-lived stream cannot fit a one-shot document. It writes newline-delimited
 * JSON records instead (one object per line), and the first line is always
 * `{"type":"open"}` once the board has answered. A failure that happens *before*
 * the stream opens (unreachable board, auth refusal, a bad `--after`) is still
 * the normal `{ok:false,error}` envelope with a nonzero exit — the dispatcher
 * renders it because no line has been written yet.
 *
 * The line types are shared with the loop's `streamCli` through
 * `EVENT_STREAM_LINE`, so the producer and the consumer cannot drift.
 *
 * Consumers: the supervisor's event subscriber (`--subscribe`), which spawns
 * this command and reconnects when it writes `idle`, `shutdown` or `eof`.
 */

import { CLI_EXIT, EVENT_STREAM_LINE, SSE_SUBSCRIBE_IDLE_MS } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { errorPayload } from "../../foundation/transport/errors.mjs";
import { activityFrames, streamFailure } from "../activity-stream.mjs";

/** @param {string} message */
function usageError(message) {
  return new DomainError("CLI_USAGE", { message });
}

/** `--after` and `--idle` are counts; a float or a negative is a usage mistake. */
function nonNegativeInteger(flags, key, flag) {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(`--${flag} expects a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

export const COMMANDS = [
  {
    name: "tail",
    summary: "Stream board activities as newline-delimited JSON until the stream ends.",
    usage: "events tail [--after <rev>] [--idle <ms>]",
    positionals: [],
    flags: [
      {
        flag: "after",
        key: "after",
        as: "number",
        value: "<rev>",
        summary: "Replay activities newer than this board revision, then stream.",
      },
      {
        flag: "idle",
        key: "idle",
        as: "number",
        value: "<ms>",
        summary: `End the stream after this long with no bytes (0 disables; default ${SSE_SUBSCRIBE_IDLE_MS}).`,
      },
    ],
    async run(ctx) {
      const after = nonNegativeInteger(ctx.flags, "after", "after");
      const idleMs = nonNegativeInteger(ctx.flags, "idle", "idle") ?? SSE_SUBSCRIBE_IDLE_MS;

      // A first-request failure throws here, before any line is written, so the
      // dispatcher still renders the normal error envelope.
      const stream = await ctx.client.stream("/api/v1/events", {
        query: { after },
        idleMs,
      });

      ctx.emit({ type: EVENT_STREAM_LINE.OPEN });

      try {
        // `requestStream` yields decoded text, so the shared adapter consumes it
        // directly; the line vocabulary above is this command's own.
        for await (const frame of activityFrames(stream)) {
          if (frame.type === "shutdown") {
            ctx.emit(
              frame.data === null
                ? { type: EVENT_STREAM_LINE.SHUTDOWN }
                : { type: EVENT_STREAM_LINE.SHUTDOWN, data: frame.data },
            );
            return { streamed: true, exit: CLI_EXIT.OK };
          }
          if (frame.type === "eof") break;
          ctx.emit({ type: EVENT_STREAM_LINE.EVENT, id: frame.id, data: frame.data });
        }
      } catch (err) {
        // Never throw past the first line: the dispatcher's catch would print an
        // envelope into the middle of the NDJSON stream.
        const reason = streamFailure(err);
        if (reason === "aborted") return { streamed: true, exit: CLI_EXIT.OK };
        if (reason === "idle") {
          ctx.emit({ type: EVENT_STREAM_LINE.IDLE, data: { idle_ms: idleMs } });
          return { streamed: true, exit: CLI_EXIT.OK };
        }
        ctx.emit({ type: EVENT_STREAM_LINE.ERROR, data: errorPayload(err) });
        return { streamed: true, exit: CLI_EXIT.ERROR };
      }

      ctx.emit({ type: EVENT_STREAM_LINE.EOF });
      return { streamed: true, exit: CLI_EXIT.OK };
    },
  },
];
