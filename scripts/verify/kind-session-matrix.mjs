#!/usr/bin/env node
/**
 * The agent-kind probe for the resident session adapters.
 *
 * The container has none of the agent CLIs, so the adapters' *protocol* claims
 * can only be checked on a machine that has them. This script starts each
 * available CLI on its native protocol and performs the handshake the adapter
 * performs — no model turn, no card, no board:
 *
 *   claude   `claude --help` must name stream-json input/output
 *   codex    `app-server generate-json-schema` must publish thread/turn methods,
 *            and a live app-server must answer `initialize`
 *   pi       `pi --mode rpc` must answer `get_state`
 *
 * An agent kind whose CLI is missing is SKIPped. Exit 0 when every available agent kind
 * answered, 1 when one did not, 3 when nothing could be probed at all.
 *
 * Usage:
 *   node scripts/verify/kind-session-matrix.mjs [--actor-kind claude,codex,pi]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

export const KINDS = Object.freeze(["claude", "codex", "pi"]);

const TIMEOUT_MS = 20_000;

/** Is the binary on PATH? */
export function installed(bin) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return !probe.error;
}

/** A free loopback port for one probe server. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => (port === null ? reject(new Error("could not allocate a port")) : resolve(port)));
    });
  });
}

/** Run one JSONL handshake against a spawned CLI. */
function handshake({ bin, args, cwd, steps, start, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.on("error", (err) => done({ ok: false, error: `spawn error: ${err.message}` }));
    child.on("spawn", () => start?.(send));
    child.on("exit", (code) => done({ ok: false, error: `exited (code=${code ?? "null"})` }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const verdict = steps(message, send, done);
        if (verdict !== undefined) return;
      }
    });
  });
}

/** @returns {Promise<{ok: boolean, detail?: string, error?: string, skipped?: boolean}>} */
async function probeClaude() {
  if (!installed("claude")) return { ok: false, skipped: true, error: "not installed" };
  const help = spawnSync("claude", ["--help"], { encoding: "utf8", timeout: 10_000 });
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  for (const needle of ["--input-format", "--output-format", "stream-json"]) {
    if (!text.includes(needle)) return { ok: false, error: `claude --help does not name ${needle}` };
  }
  return { ok: true, detail: "stream-json input/output advertised" };
}

async function probeCodex() {
  if (!installed("codex")) return { ok: false, skipped: true, error: "not installed" };
  const dir = mkdtempSync(join(tmpdir(), "tp-codex-schema-"));
  try {
    const generated = spawnSync("codex", ["app-server", "generate-json-schema", "--out", dir], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (generated.status !== 0) {
      return { ok: false, error: `generate-json-schema exited ${generated.status}` };
    }
    const requests = readFileSync(join(dir, "ClientRequest.json"), "utf8");
    for (const method of ["thread/start", "turn/start"]) {
      if (!requests.includes(method)) return { ok: false, error: `schema has no ${method}` };
    }
    const live = await handshake({
      bin: "codex",
      args: ["app-server", "--listen", "stdio://"],
      start: (send) =>
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "meerkat-matrix", version: "1.0.0" } },
        }),
      steps: (message, send, done) => {
        if (message.id === 1 && message.result !== undefined) {
          done({ ok: true, detail: "initialize answered; thread and turn methods published" });
        } else if (message.id === 1) done({ ok: false, error: "initialize returned an error" });
      },
    });
    return live.ok ? live : { ok: false, error: `${live.error} (live handshake)` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function probePi() {
  if (!installed("pi")) return { ok: false, skipped: true, error: "not installed" };
  return handshake({
    bin: "pi",
    args: ["--mode", "rpc", "--no-session"],
    start: (send) => send({ id: "1", type: "get_state" }),
    steps: (message, send, done) => {
      if (message.type === "response" && message.id === "1") {
        const id = message.data?.sessionId ?? message.data?.session_id ?? null;
        done(
          message.success === false
            ? { ok: false, error: "get_state failed" }
            : { ok: true, detail: `get_state answered (session ${id ?? "unreported"})` },
        );
      }
    },
  });
}

const PROBES = Object.freeze({
  claude: probeClaude,
  codex: probeCodex,
  pi: probePi,
});

/**
 * @param {{kinds?: string[], log?: (line: string) => void}} [input]
 * @returns {Promise<{exitCode: number, results: Record<string, object>}>}
 */
export async function runMatrix(input = {}) {
  const log = input.log ?? ((line) => process.stdout.write(`${line}\n`));
  const kinds = input.kinds ?? [...KINDS];
  const results = {};
  let failures = 0;
  let passes = 0;
  let skips = 0;
  for (const kind of kinds) {
    const probe = PROBES[kind];
    if (probe === undefined) {
      log(`${kind}: FAIL (unknown actor kind)`);
      failures += 1;
      results[kind] = { ok: false, error: "unknown actor kind" };
      continue;
    }
    const result = await probe();
    results[kind] = result;
    if (result.ok) {
      passes += 1;
      log(`${kind}: OK (${result.detail ?? "handshake answered"})`);
    } else if (result.skipped) {
      skips += 1;
      log(`${kind}: SKIP (${result.error})`);
    } else {
      failures += 1;
      log(`${kind}: FAIL (${result.error})`);
    }
  }
  const exitCode = failures > 0 ? 1 : passes === 0 ? 3 : 0;
  return { exitCode, results };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  let kinds = [...KINDS];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--actor-kind" || arg === "--actor-kinds") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      kinds = value.split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg.startsWith("--actor-kind=") || arg.startsWith("--actor-kinds=")) {
      kinds = arg.slice(arg.indexOf("=") + 1).split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, kinds };
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { help: false, kinds };
}

const USAGE = `Usage: node scripts/verify/kind-session-matrix.mjs [--actor-kind claude,codex,pi]

Probes each installed agent CLI on the resident session protocol the loop uses.
No model turn is made. Exit 0 = every available agent kind answered, 1 = a failure,
3 = nothing could be probed (no CLI installed).
`;

if (isEntryPoint(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`kind-session-matrix: ${err.message}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  runMatrix({ kinds: options.kinds }).then(({ exitCode }) => process.exit(exitCode));
}
