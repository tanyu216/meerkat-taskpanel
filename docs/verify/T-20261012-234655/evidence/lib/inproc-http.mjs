/**
 * In-process HTTP harness (verification-only, T-20261012-234655).
 *
 * This lane's sandbox denies `bind(2)` for AF_INET *and* AF_UNIX (`listen`
 * raises EPERM for every host/port tried), so a real socket cannot be opened.
 * `createTaskd` therefore cannot get past its `listen` step, and every
 * socket-driving test in the repo fails for a reason that has nothing to do
 * with the diff under review.
 *
 * What is replaced here is *only* the socket layer:
 *
 *   * `net.Server.prototype.listen` is made a no-op that reports "bound" (a
 *     prototype patch, so the real `createServer`/`handle` chain is untouched);
 *   * a request is delivered to the *actual* `'request'` listener that
 *     `createServer(handler)` registered — i.e. straight into the daemon's own
 *     `handle()` — as a readable carrying `method`/`url`/`headers`/`socket`;
 *   * the response is a stand-in with the four members the daemon's own
 *     `sendJson` and `handleAttachmentContent` actually touch
 *     (`writeHead`, `write`, `end`, plus the `headersSent`/`writableEnded`
 *     flags and the `finish` event).
 *
 * `writeHead` + `end` is the entire response contract in this server (there is
 * no streaming/proxy layer), so the status/headers/body recorded here are the
 * ones the daemon computed. What the stand-in cannot prove is TCP framing,
 * keep-alive and backpressure — none of which R1/R2/R3 turn on.
 *
 * Everything above the socket is the production code path: the real router,
 * the real run-through of `errorResponse`/`mapSqliteError`, the real
 * `handleAttachmentContent`. A status/body observed here is the status/body a
 * client would have seen, minus the transport.
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import { Readable } from "node:stream";

let patched = false;

/** Replace the socket layer once per process. Returns an undo function. */
export function patchListen() {
  if (patched) return () => {};
  patched = true;
  const realListen = net.Server.prototype.listen;
  const realClose = net.Server.prototype.close;

  net.Server.prototype.listen = function listen(...args) {
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) process.nextTick(callback);
    // `address()` must answer an object or the daemon reads `undefined.port`.
    this.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 0 });
    return this;
  };
  net.Server.prototype.close = function close(callback) {
    if (typeof callback === "function") process.nextTick(callback);
    return this;
  };

  return () => {
    net.Server.prototype.listen = realListen;
    net.Server.prototype.close = realClose;
    patched = false;
  };
}

/** The response members the daemon's own code touches — no more, no less. */
class StandInResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.finished = false;
    this._headers = {};
    this.chunks = [];
  }

  setHeader(name, value) {
    this._headers[String(name).toLowerCase()] = value;
    return this;
  }

  getHeader(name) {
    return this._headers[String(name).toLowerCase()];
  }

  removeHeader(name) {
    delete this._headers[String(name).toLowerCase()];
  }

  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk, encoding, callback) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    const done = typeof encoding === "function" ? encoding : callback;
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
    }
    if (typeof done === "function") process.nextTick(done);
    return true;
  }

  end(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.writableEnded = true;
    this.finished = true;
    process.nextTick(() => {
      this.emit("finish");
      this.emit("close");
      if (typeof callback === "function") callback();
    });
    return this;
  }
}

/** A request reader carrying the four members `handle()` reads. */
function standInRequest({ method, path, headers, body }) {
  const payload = body === undefined || body === null ? [] : [Buffer.from(body)];
  const req = Readable.from(payload);
  req.method = method;
  req.url = path;
  req.headers = { host: "127.0.0.1", connection: "close", ...(headers ?? {}) };
  // A loopback `remoteAddress` is what makes this an authorized local caller —
  // the same thing a `curl` from this machine would look like.
  req.socket = { remoteAddress: "127.0.0.1", remotePort: 44_444, localPort: 4_444 };
  return req;
}

/**
 * Send one request through a live `taskd` surface, without a socket.
 *
 * @param {{server: import('node:http').Server}} taskd
 * @param {{method: string, path: string, headers?: Record<string,string>, body?: string|Buffer|null}} request
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string, json: any}>}
 */
export async function sendInProcess(taskd, request) {
  const handlers = taskd.server.listeners("request");
  if (handlers.length === 0) throw new Error("the daemon registered no request listener");
  const handler = handlers[0];

  const req = standInRequest(request);
  const res = new StandInResponse();

  // The listener is `(req, res) => { handle(req, res).catch(...) }`: it returns
  // `undefined`, not a promise, so a request is "done" when the response is.
  const finished = new Promise((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
  });
  handler(req, res);
  await finished;

  const body = Buffer.concat(res.chunks).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON — the attachment GET path returns bytes */
  }
  return {
    status: res.statusCode,
    headers: res._headers,
    body,
    json,
  };
}

/** `createTaskd`, but against a patched (non-binding) socket layer. */
export async function createInProcessTaskd(options = {}) {
  patchListen();
  const { createTaskd } = await import(
    `file://${process.cwd()}/src/server/index.mjs`
  );
  return createTaskd(options);
}
