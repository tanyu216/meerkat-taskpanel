/**
 * The event commands: the direct board stream (`tail`), the local hub (`hub`)
 * and its follower (`follow`).
 *
 * A streaming command's output is **not** the `{ok,data}` envelope: a long-lived
 * stream cannot fit a one-shot document. These commands write newline-delimited
 * JSON instead (one object per line), and the first line is `{"type":"open"}`
 * once the stream (or the hub) has answered. A failure *before* the stream
 * opens (unreachable board, auth refusal, a bad `--after`, a hub that cannot
 * start) is still the normal `{ok:false,error}` envelope with a nonzero exit.
 *
 * The line types are shared with the loop's `streamCli` through
 * `EVENT_STREAM_LINE`, so the producer and the consumer cannot drift.
 *
 * Consumers: the supervisor's event subscriber (`--subscribe`) spawns
 * `events follow`, which consumes the hub's one board connection; `events tail`
 * remains the direct diagnostic stream.
 */

import { fileURLToPath } from "node:url";

import {
  CLI_EXIT,
  EVENT_STREAM_LINE,
  SSE_SHUTDOWN_EVENT,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { createSseParser } from "../../foundation/sse-parse.mjs";
import { errorPayload } from "../../foundation/transport/errors.mjs";
import { hubError, hubRecords } from "../hub/client.mjs";
import { ensureHub, hubPaths, newHubToken } from "../hub/runtime.mjs";
import { createHubServer } from "../hub/server.mjs";

/** The CLI entry a detached hub re-executes. */
const CLI_ENTRY = fileURLToPath(new URL("../index.mjs", import.meta.url));

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

/**
 * Build and start the hub for one resolved board. Exported so a test can drive
 * the same server in-process and stop it deliberately; the command wraps it
 * with signal handlers and waits for idle or shutdown.
 *
 * @param {{client: object, board: {url: string, token: string|null}, env: object}} ctx
 * @param {{log?: (line: string) => void}} [options]
 * @returns {Promise<ReturnType<typeof createHubServer>>}
 */
export async function runHub(ctx, options = {}) {
  const { log = (line) => process.stderr.write(`${line}\n`) } = options;
  if (ctx.board === null || typeof ctx.board?.url !== "string") {
    throw new DomainError("CLI_IO", {
      message: "events hub: the board coordinates are not resolved",
    });
  }
  const paths = hubPaths(ctx.board.url, ctx.board.token, ctx.env);
  const token = newHubToken();
  const server = createHubServer({
    client: ctx.client,
    paths,
    token,
    log: (line) => {
      try {
        log(line);
      } catch {
        /* the parent redirected stderr to a file that may be gone */
      }
    },
  });
  await server.start();
  return server;
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

      const parser = createSseParser();
      try {
        // `requestStream` yields decoded text, so the parser consumes it directly.
        for await (const chunk of stream) {
          for (const frame of parser.push(chunk)) {
            if (frame.event === SSE_SHUTDOWN_EVENT) {
              let data = null;
              try {
                data = JSON.parse(frame.data);
              } catch {
                // A malformed shutdown frame still means the server is leaving.
              }
              ctx.emit(
                data === null
                  ? { type: EVENT_STREAM_LINE.SHUTDOWN }
                  : { type: EVENT_STREAM_LINE.SHUTDOWN, data },
              );
              return { streamed: true, exit: CLI_EXIT.OK };
            }

            let data;
            try {
              data = JSON.parse(frame.data);
            } catch {
              continue; // a frame that is not JSON cannot name a board event
            }
            const parsedId = frame.id === null ? null : Number.parseInt(frame.id, 10);
            ctx.emit({
              type: EVENT_STREAM_LINE.EVENT,
              id: Number.isFinite(parsedId) ? parsedId : null,
              data,
            });
          }
        }
      } catch (err) {
        // Never throw past the first line: the dispatcher's catch would print an
        // envelope into the middle of the NDJSON stream.
        if (err?.details?.reason === "aborted") return { streamed: true, exit: CLI_EXIT.OK };
        if (err?.details?.reason === "idle") {
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
  {
    name: "hub",
    summary: "Run the local event hub: one board connection for every local consumer.",
    usage: "events hub",
    positionals: [],
    flags: [],
    async run(ctx) {
      const server = await runHub(ctx);
      const onSignal = () => {
        void server.stop();
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      try {
        await server.wait();
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      return { streamed: true, exit: CLI_EXIT.OK };
    },
  },
  {
    name: "follow",
    summary: "Follow the local event hub (NDJSON; one board connection per host).",
    usage: "events follow [--after <rev>] [--idle <ms>]",
    positionals: [],
    flags: [
      {
        flag: "after",
        key: "after",
        as: "number",
        value: "<rev>",
        summary: "Replay activities newer than this board revision when the hub still retains them, then stream.",
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
      if (ctx.board === null || typeof ctx.board?.url !== "string") {
        throw new DomainError("CLI_IO", {
          message: "events follow: the board coordinates are not resolved",
        });
      }

      const human = ctx.identity.actor.kind === "human";
      const { pointer } = await ensureHub({
        url: ctx.board.url,
        token: ctx.board.token,
        actorKind: human ? "claude" : ctx.identity.actor.kind,
        asHuman: human,
        agent: ctx.identity.actor.id,
        envFile: typeof ctx.flags.envFile === "string" ? ctx.flags.envFile : null,
        entry: CLI_ENTRY,
        env: ctx.env,
      });

      let opened = false;
      try {
        for await (const record of hubRecords(pointer, {
          op: "follow",
          after,
          idle_ms: idleMs,
        }, { idleMs })) {
          if (record?.type === "heartbeat") continue;
          if (record?.type === EVENT_STREAM_LINE.OPEN) {
            opened = true;
            ctx.emit({ type: EVENT_STREAM_LINE.OPEN });
            continue;
          }
          if (record?.type === EVENT_STREAM_LINE.EVENT) {
            ctx.emit({
              type: EVENT_STREAM_LINE.EVENT,
              id: Number.isInteger(record.id) ? record.id : null,
              data: record.data,
            });
            continue;
          }
          if (record?.type === EVENT_STREAM_LINE.IDLE) {
            ctx.emit({ type: EVENT_STREAM_LINE.IDLE, data: record.data ?? { idle_ms: idleMs } });
            return { streamed: true, exit: CLI_EXIT.OK };
          }
          if (record?.type === EVENT_STREAM_LINE.SHUTDOWN) {
            ctx.emit({
              type: EVENT_STREAM_LINE.SHUTDOWN,
              ...(record.data === undefined ? {} : { data: record.data }),
            });
            return { streamed: true, exit: CLI_EXIT.OK };
          }
          if (record?.type === EVENT_STREAM_LINE.ERROR) {
            if (!opened) throw hubError(record.data);
            ctx.emit({ type: EVENT_STREAM_LINE.ERROR, data: record.data ?? null });
            return { streamed: true, exit: CLI_EXIT.ERROR };
          }
        }
      } catch (err) {
        if (err?.details?.reason === "idle" && opened) {
          ctx.emit({ type: EVENT_STREAM_LINE.IDLE, data: { idle_ms: idleMs } });
          return { streamed: true, exit: CLI_EXIT.OK };
        }
        if (!opened) throw err;
        ctx.emit({ type: EVENT_STREAM_LINE.ERROR, data: errorPayload(err) });
        return { streamed: true, exit: CLI_EXIT.ERROR };
      }

      if (!opened) {
        throw new DomainError("CLI_IO", {
          message: "events follow: the local hub closed before opening the stream",
        });
      }
      ctx.emit({ type: EVENT_STREAM_LINE.EOF });
      return { streamed: true, exit: CLI_EXIT.OK };
    },
  },
];
