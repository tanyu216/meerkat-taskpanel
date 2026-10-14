/* Minimal `node:http` stand-in for this lane: the macOS sandbox denies every
   `listen()`, so the verifier needs `createServer` to hand back the handler
   without ever binding a socket. The handler is stashed on globalThis so the
   Playwright route carrier can call it directly. Only `createServer` is
   imported by the consumer (`web/scripts/dom-smoke.mjs`). */
import { EventEmitter } from "node:events";

const FAKE_PORT = 41807;

export function createServer(handler) {
  if (typeof handler === "function") globalThis.__capturedServerHandler = handler;
  const server = new EventEmitter();
  server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: FAKE_PORT });
  server.listen = (...args) => {
    const cb = args.find((a) => typeof a === "function");
    if (cb) queueMicrotask(cb);
    return server;
  };
  server.close = (cb) => {
    if (cb) queueMicrotask(cb);
    return server;
  };
  server.on = EventEmitter.prototype.on.bind(server);
  return server;
}
