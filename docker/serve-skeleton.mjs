#!/usr/bin/env node
/**
 * M0 deploy skeleton — NOT a business implementation.
 *
 * This file exists so the container deploy path (compose up → healthcheck → down) can
 * be exercised before there is a server to exercise. It serves exactly one route,
 * `GET /health`, and answers 404 to everything else.
 *
 * It is scheduled to be deleted: M6 replaces it with the real HTTP surface under
 * `src/server/`, at which point docker-compose.yml points `taskd` there instead.
 * Do not add board logic, storage or routes here.
 *
 * Zero dependencies (`node:http` only). Honours TASKD_HOST / TASKD_PORT and shuts down
 * cleanly on SIGTERM/SIGINT so `docker compose down` is immediate.
 */

import { createServer } from "node:http";

import { VERSION } from "../src/shared/constants.mjs";

const HOST = process.env.TASKD_HOST || "0.0.0.0";
const PORT = Number(process.env.TASKD_PORT || 9527);
const STAGE = "scaffold";
const STARTED_AT = Date.now();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

  if (path === "/health") {
    sendJson(res, 200, {
      status: "ok",
      stage: STAGE,
      version: VERSION,
      uptimeMs: Date.now() - STARTED_AT,
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`taskd (${STAGE} skeleton) listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
