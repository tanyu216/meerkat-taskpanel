/**
 * The CLI side of the local hub protocol.
 *
 * A command opens one authenticated connection, sends a single request, and
 * consumes the records the hub writes back. `hubRecords` is an async generator
 * so a caller can `for await` over a long-lived stream and let a `break` close
 * the socket — no callback state machine, no unhandled rejection when the user
 * aborts.
 *
 * Node builtins only.
 */

import { connect } from "node:net";

import { DomainError } from "../../foundation/errors.mjs";
import { HUB_PROTOCOL } from "./runtime.mjs";

const HELLO_TIMEOUT_MS = 2_000;

/** The hello line, written before anything else. */
function helloLine(token) {
  return `${JSON.stringify({ op: "hello", protocol: HUB_PROTOCOL, token })}\n`;
}

/**
 * Turn a hub `error` record into the domain error the CLI renders.
 *
 * @param {unknown} data
 * @returns {DomainError}
 */
export function hubError(data) {
  const payload = data !== null && typeof data === "object" ? data : {};
  return new DomainError(
    typeof payload.code === "string" && payload.code !== "" ? payload.code : "CLI_IO",
    {
      message: typeof payload.message === "string" && payload.message !== ""
        ? payload.message
        : "events hub reported an error",
      ...(payload.details === undefined ? {} : { details: payload.details }),
      ...(payload.hint === undefined ? {} : { hint: payload.hint }),
    },
  );
}

/**
 * Open one hub session and yield every record after the authenticated hello.
 *
 * The caller writes the actual request by passing it here; it is sent as soon
 * as hello is accepted. The socket closes when the generator is closed, when the
 * hub closes it, or on any transport failure (which throws).
 *
 * @param {{port: number, token: string}} pointer
 * @param {object} request
 * @param {{idleMs?: number}} [options] end the local stream after this long with
 *   no records; heartbeats count, exactly like the direct SSE stream
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* hubRecords(pointer, request, options = {}) {
  const { idleMs = 0 } = options;
  if (typeof pointer?.port !== "number" || typeof pointer?.token !== "string") {
    throw new DomainError("CLI_IO", {
      message: "events hub: the hub pointer is not usable",
      details: { pointer: pointer ?? null },
    });
  }

  const socket = connect(Number(pointer.port), "127.0.0.1");
  socket.setEncoding("utf8");
  let authed = false;
  let buffer = "";
  let idleTimer = null;

  const armIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!Number.isInteger(idleMs) || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      socket.destroy(new DomainError("CLI_IO", {
        message: `the local hub was silent for ${idleMs}ms`,
        details: { reason: "idle", idle_ms: idleMs },
      }));
    }, idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  // A hub that never answers hello is not a hub worth waiting for. Once the
  // session is authenticated the socket is a stream bounded only by the
  // caller's idle option.
  const helloTimeout = setTimeout(() => {
    socket.destroy(new Error("the local hub did not answer the hello"));
  }, HELLO_TIMEOUT_MS);
  if (typeof helloTimeout.unref === "function") helloTimeout.unref();

  try {
    socket.write(helloLine(pointer.token));
    for await (const chunk of socket) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          throw new DomainError("CLI_IO", {
            message: "events hub: the local hub wrote a malformed line",
          });
        }
        if (!authed) {
          if (record?.op !== "hello" || record.ok !== true) {
            throw new DomainError("CLI_IO", {
              message: "events hub: the local hub refused this client",
              details: { reason: record?.error ?? null },
            });
          }
          authed = true;
          clearTimeout(helloTimeout);
          armIdle();
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        armIdle();
        yield record;
      }
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("CLI_IO", {
      message: `events hub: lost the local hub connection: ${err?.message ?? err}`,
      details: { port: pointer.port },
    });
  } finally {
    clearTimeout(helloTimeout);
    if (idleTimer !== null) clearTimeout(idleTimer);
    socket.destroy();
  }
}

/**
 * A one-answer request (`watch-status`, `watch-stop`). The hub replies with a
 * record carrying `op`; anything else before it is an error or a heartbeat.
 *
 * @param {{port: number, token: string}} pointer
 * @param {object} request
 * @param {(record: object) => boolean} isAnswer
 * @returns {Promise<object>}
 */
export async function hubAnswer(pointer, request, isAnswer) {
  for await (const record of hubRecords(pointer, request)) {
    if (record?.type === "heartbeat") continue;
    if (record?.type === "error") throw hubError(record.data);
    if (record?.op === "error" && record.ok === false) throw hubError(record.error);
    if (isAnswer(record)) return record;
  }
  throw new DomainError("CLI_IO", {
    message: "events hub: the local hub closed before answering",
    details: { port: pointer.port },
  });
}
