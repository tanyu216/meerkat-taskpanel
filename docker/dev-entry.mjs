#!/usr/bin/env node
/**
 * Dev / manual-preview entry — taskd plus Vite's dev server in one container.
 *
 * The shipping image is the `runtime` stage and has no devDependencies; this
 * entry is only used by the `dev` stage (`docker/docker-compose.dev.yml`),
 * where `webbuild` has already installed the frontend's pinned dependencies
 * offline. The browser talks to Vite only: `/api` and `/health` are proxied to
 * the loopback taskd by `web/vite.config.js`, so the app sees the same relative
 * URLs it sees in production.
 *
 * Two processes, one lifecycle: either exiting stops the other, and SIGTERM /
 * SIGINT are forwarded so `docker compose down` shuts taskd down gracefully
 * (the writer lock and the runtime pointer are removed on the way out).
 *
 * taskd runs under Node's `--watch`, so a change to any imported backend module
 * (`src/server`, `src/core`, `src/shared`) restarts it in place; Vite's HMR
 * covers `web/src`. Together they make the container live for both halves.
 *
 * Environment:
 *   TASKD_HOST       taskd bind host (default 127.0.0.1)
 *   TASKD_PORT       taskd port (default 9527)
 *   TASKD_DATA_DIR   board data directory (the container's /app/.data)
 *   VITE_PORT        Vite port (default 5173; published as 19527 by compose)
 */
import { spawn } from "node:child_process";

const HOST = process.env.TASKD_HOST ?? "127.0.0.1";
const PORT = process.env.TASKD_PORT ?? "9527";
const VITE_PORT = process.env.VITE_PORT ?? "5173";
const PROBE_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
const HEALTH = `http://${PROBE_HOST}:${PORT}/health`;

const children = new Set();

function start(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stop(signal) {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const taskd = start(process.execPath, ["--watch", "--watch-preserve-output", "src/server/main.mjs"]);

/** Wait for the loopback board; a failed taskd must not leave Vite pointing at nothing. */
async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (taskd.exitCode !== null) return false;
    try {
      const response = await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const healthy = await waitForHealth();
if (!healthy) {
  console.error(`dev: taskd did not answer ${HEALTH}; stopping`);
  stop("SIGTERM");
  process.exitCode = 1;
  process.exit(1);
}

console.log(`dev: taskd ${HEALTH} · Vite on 0.0.0.0:${VITE_PORT} (host 19527)`);
const vite = start("npm", ["--prefix", "web", "run", "dev", "--", "--host", "0.0.0.0", "--port", VITE_PORT]);

const code = await new Promise((resolve) => {
  taskd.on("exit", (exitCode) => {
    stop("SIGTERM");
    resolve(exitCode ?? 0);
  });
  vite.on("exit", (exitCode) => {
    stop("SIGTERM");
    resolve(exitCode ?? 0);
  });
});

process.exit(code);
