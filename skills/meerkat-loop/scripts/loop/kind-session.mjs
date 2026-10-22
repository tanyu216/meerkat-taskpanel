/**
 * The resident kind-session seam.
 *
 * A kind pool owns one or more long-lived agent conversations. Each conversation
 * is a `SessionHandle`: it accepts a prompt, streams events, reports when the
 * turn is complete, and can be interrupted or closed without exiting the
 * supervisor.
 *
 * The pool is deliberately kind-agnostic. `scripts/loop/session.mjs` (the pool
 * manager) knows about projects, queues and subagents; it does not know which
 * CLI is underneath. An actor-kind adapter only has to implement this interface.
 *
 * Node builtins only; no network, no dependencies.
 */

import { createClaudePool } from "./actor-kinds/claude.mjs";
import { createCodexPool } from "./actor-kinds/codex.mjs";
import { createCursorPool } from "./actor-kinds/cursor.mjs";
import { createOpenCodePool } from "./actor-kinds/opencode.mjs";
import { createPiPool } from "./actor-kinds/pi.mjs";

/** Split a stream into LF-delimited lines, preserving no partial line. */
export function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line !== "") onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/** Write one JSONL record. */
export function writeJsonLine(stream, value) {
  return stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * The actor kinds with a resident adapter. A kind that is not here keeps the one-shot
 * path: patrol + workflow run, dispatch is paused ("no resident pool").
 */
export const RESIDENT_KINDS = Object.freeze({
  claude: createClaudePool,
  codex: createCodexPool,
  pi: createPiPool,
  opencode: createOpenCodePool,
  cursor: createCursorPool,
});

/**
 * Create the resident pool for one actor kind.
 *
 * `bin` is an escape hatch for tests and for an operator whose CLI is not named
 * like the default. The production supervisor passes no `bin`.
 *
 * @param {{actorKind: string, opts: object, log: (line: string) => void, bin?: string, onEvent?: (event: object) => void}} input
 */
export function createKindPool(input = {}) {
  const factory = RESIDENT_KINDS[String(input.actorKind ?? "")];
  if (factory === undefined) {
    throw new Error(`no resident-session adapter for actor kind '${input.actorKind}'`);
  }
  return factory(input);
}
