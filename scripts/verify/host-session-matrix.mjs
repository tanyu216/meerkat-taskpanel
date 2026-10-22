#!/usr/bin/env node
/**
 * The host-only probe for the resident session adapters.
 *
 * The container has none of the host CLIs, so the adapters' *protocol* claims
 * can only be checked on a machine that has them. This script starts each
 * available CLI on its native protocol and performs the handshake the adapter
 * performs — no model turn, no card, no board:
 *
 *   claude   `claude --help` must name stream-json input/output
 *   codex    `app-server generate-json-schema` must publish thread/turn methods,
 *            and a live app-server must answer `initialize`
 *   pi       `pi --mode rpc` must answer `get_state`
 *   opencode `serve` must answer `GET /session` (per-directory server design)
 *   cursor   `cursor-agent acp` must answer `initialize`
 *
 * A host whose CLI is missing is SKIPped. Exit 0 when every available host
 * answered, 1 when one did not, 3 when nothing could be probed at all.
 *
 * Usage:
 *   node scripts/verify/host-session-matrix.mjs [--host claude,codex,pi,opencode,cursor]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { freePort } from "../loop/hosts/opencode.mjs";

export const HOSTS = Object.freeze(["claude", "codex", "pi", "opencode", "cursor"]);

const TIMEOUT_MS = 20_000;

/** Is the binary on PATH? */
export function installed(bin) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return !probe.error;
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

async function probeOpenCode() {
  if (!installed("opencode")) return { ok: false, skipped: true, error: "not installed" };
  const dir = mkdtempSync(join(tmpdir(), "tp-opencode-probe-"));
  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    let last = "no answer";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/session`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return { ok: true, detail: `serve answered GET /session on ${port}` };
        last = `GET /session → ${response.status}`;
      } catch (err) {
        last = err.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, error: last };
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function probeCursor() {
  if (!installed("cursor-agent")) return { ok: false, skipped: true, error: "not installed" };
  return handshake({
    bin: "cursor-agent",
    args: ["acp"],
    start: (send) =>
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } },
      }),
    steps: (message, send, done) => {
      if (message.id === 1 && message.result !== undefined) {
        done({ ok: true, detail: "initialize answered" });
      } else if (message.id === 1) {
        done({ ok: false, error: "initialize returned an error" });
      }
    },
  }).then((result) => result, (err) => ({ ok: false, error: err.message }));
}

const PROBES = Object.freeze({
  claude: probeClaude,
  codex: probeCodex,
  pi: probePi,
  opencode: probeOpenCode,
  cursor: probeCursor,
});

/**
 * @param {{hosts?: string[], log?: (line: string) => void}} [input]
 * @returns {Promise<{exitCode: number, results: Record<string, object>}>}
 */
export async function runMatrix(input = {}) {
  const log = input.log ?? ((line) => process.stdout.write(`${line}\n`));
  const hosts = input.hosts ?? [...HOSTS];
  const results = {};
  let failures = 0;
  let passes = 0;
  let skips = 0;
  for (const host of hosts) {
    const probe = PROBES[host];
    if (probe === undefined) {
      log(`${host}: FAIL (unknown host)`);
      failures += 1;
      results[host] = { ok: false, error: "unknown host" };
      continue;
    }
    const result = await probe();
    results[host] = result;
    if (result.ok) {
      passes += 1;
      log(`${host}: OK (${result.detail ?? "handshake answered"})`);
    } else if (result.skipped) {
      skips += 1;
      log(`${host}: SKIP (${result.error})`);
    } else {
      failures += 1;
      log(`${host}: FAIL (${result.error})`);
    }
  }
  const exitCode = failures > 0 ? 1 : passes === 0 ? 3 : 0;
  return { exitCode, results };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  let hosts = [...HOSTS];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host" || arg === "--hosts") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      hosts = value.split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg.startsWith("--host=") || arg.startsWith("--hosts=")) {
      hosts = arg.slice(arg.indexOf("=") + 1).split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, hosts };
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { help: false, hosts };
}

const USAGE = `Usage: node scripts/verify/host-session-matrix.mjs [--host claude,codex,pi,opencode,cursor]

Probes each installed host CLI on the resident session protocol the loop uses.
No model turn is made. Exit 0 = every available host answered, 1 = a failure,
3 = nothing could be probed (no CLI installed).
`;

if (isEntryPoint(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`host-session-matrix: ${err.message}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  runMatrix({ hosts: options.hosts }).then(({ exitCode }) => process.exit(exitCode));
}
