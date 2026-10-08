#!/usr/bin/env node
/**
 * `node src/mcp/main.mjs` — the stdio MCP server a host launches.
 *
 * The program is a pump, and one rule governs every line of it: **stdout carries
 * JSON-RPC and nothing else**. A version banner, a "starting…" line or a warning
 * printed to stdout would be read by the client as a malformed message and kill
 * the session, so usage, help and diagnostics all go to stderr. The one piece of
 * luck that makes this cheap is upstream: when `ensureBoard` autostarts `taskd`,
 * `client/autostart.mjs` redirects the daemon's stdout to `<dataDir>/logs/taskd.log`,
 * so a spawned service cannot print into our stream either.
 *
 * Framing is newline-delimited JSON, and both hard cases live in
 * `protocol.mjs#createLineFramer` rather than here: a message split across two
 * reads, and a final message with no trailing newline before EOF. What is left
 * for this file is ordering and teardown:
 *
 *   * lines are handled **one at a time and awaited**, so responses come out in
 *     the order requests came in (a host is entitled to match them by id, but a
 *     stream that reorders is a stream nobody can debug);
 *   * every write is a *whole* line, awaited to drain before the process may
 *     exit, so EOF or a signal can never leave half a response behind;
 *   * stdin EOF exits 0. So do SIGTERM/SIGINT, after the write in flight lands.
 *
 * argv is deliberately two flags wide. `--url` and `--token` mean exactly what
 * they mean to `taskctl`, which is the whole point: an operator who has debugged
 * one surface has debugged both. Anything else is a usage error (exit 2) rather
 * than a silent no-op, because a host config with a typo should fail loudly at
 * launch, not mysteriously at the first tool call.
 */

import { pathToFileURL } from "node:url";

import { CLI_EXIT } from "../shared/constants.mjs";
import { createLineFramer } from "./protocol.mjs";
import { invalidParams } from "./result.mjs";
import { createMcpServer } from "./server.mjs";

/** Printed to **stderr**, never stdout. */
export const USAGE = [
  "task-panel MCP server (stdio)",
  "",
  "usage: node src/mcp/main.mjs [--url <url>] [--token <token>]",
  "",
  "  --url <url>      talk to the board at this address instead of the runtime pointer",
  "  --token <token>  present this token (otherwise $TASKD_TOKEN, then the pointer's token file)",
  "  --help           print this and exit",
  "",
  "Speaks JSON-RPC 2.0, one message per line, on stdin/stdout.",
].join("\n");

/**
 * The two flags, in both spellings.
 *
 * @param {string[]} argv
 * @returns {{url: string|null, token: string|null, help: boolean}}
 * @throws {import('../shared/errors.mjs').DomainError} CLI_USAGE
 */
export function parseArgv(argv) {
  const parsed = { url: null, token: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--url" || arg === "--token") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw invalidParams(`${arg} needs a value`);
      index += 1;
      if (arg === "--url") parsed.url = value;
      else parsed.token = value;
      continue;
    }
    if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length);
      continue;
    }
    if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
      continue;
    }
    throw invalidParams(`unknown argument: ${arg}`, { hint: { fix: "node src/mcp/main.mjs --help" } });
  }

  return parsed;
}

/**
 * Write one whole line, resolved once the stream has accepted it.
 *
 * `Writable.write` returning `false` is not an error — it is the stream saying
 * "I have buffered as much as I will for now". Awaiting `drain` in that case is
 * what keeps a slow reader from making the pump drop or interleave a response;
 * awaiting nothing when it returns `true` is what keeps the fast path fast.
 *
 * Exported so both arms can be unit-tested with a fake stream: real back-pressure
 * needs a pipe buffer to fill, which no hermetic test can arrange reliably.
 *
 * @param {{write: (text: string) => boolean, once: (event: string, fn: () => void) => unknown}} stream
 * @param {string} text
 * @returns {Promise<void>}
 */
export function writeLine(stream, text) {
  return new Promise((resolve) => {
    if (stream.write(text)) resolve();
    else stream.once("drain", resolve);
  });
}

/**
 * Run the pump until stdin ends.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return CLI_EXIT.USAGE;
  }

  if (args.help) {
    process.stderr.write(`${USAGE}\n`);
    return CLI_EXIT.OK;
  }

  const server = createMcpServer({ url: args.url, token: args.token, env: process.env });
  const framer = createLineFramer();

  /** The write currently in flight, so a signal can wait for it instead of truncating it. */
  let inFlight = null;

  /** One whole line out, awaited until the stream accepts it. */
  const write = (text) => writeLine(process.stdout, text);

  const handleLine = async (line) => {
    const answer = await server.handleLine(line);
    if (answer === null) return; // a notification: the correct answer is silence
    inFlight = write(`${answer}\n`);
    await inFlight;
    inFlight = null;
  };

  const shutdown = async () => {
    if (inFlight !== null) await inFlight.catch(() => {});
    process.exit(CLI_EXIT.OK);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  for await (const chunk of process.stdin) {
    for (const line of framer.push(chunk)) await handleLine(line);
  }

  // EOF: the last line of a stream need not end in a newline, and dropping it
  // would make `printf '%s' '{…}' | node main.mjs` silently do nothing.
  const tail = framer.flush();
  if (tail !== null) await handleLine(tail);

  return CLI_EXIT.OK;
}

// Guarded so the module can be imported by tests (which unit-test `parseArgv`)
// without starting a server — the same pattern `src/cli/index.mjs` uses.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main());
}
