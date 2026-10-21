#!/usr/bin/env node
/**
 * Derive the deterministic agent-session id **without contacting the board**.
 *
 * The board's `session set` derives the same value from `(task, owner, seg)`:
 * an RFC 4122 v5 UUID over the NUL-joined inputs under
 * `SESSION_ID_NAMESPACE`. That is how a resumed conversation keeps its id.
 * A caller that must know the id *before* it starts a host — to pass it as the
 * host's `--session-id` — needs the derivation without the round trip, so this
 * script carries it.
 *
 * This file ships on its own (the installed skill has no `src/` tree), so the
 * four functions below are deliberately a private copy of
 * `src/foundation/ids.mjs`. `test/skill/session-id.test.mjs` re-derives a vector
 * matrix against the foundation and pins the namespace and the RFC 4122 test
 * vector; any drift between the copies reds that test.
 *
 * **The task id is the resolved row UUID, not the board identifier.** Call
 * `taskctl issue get <ref> --json` and take `data.task.id`. Passing `PROJ-0001`
 * here hashes a different string and produces an id `session set` will not.
 *
 * Node builtins only; no network, no board, no side effects.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The board's UUIDv5 namespace for agent-session ids (`src/foundation/constants.mjs`). */
export const SESSION_ID_NAMESPACE = "4f3d9c2a-1b77-5e0c-9a4d-8f6e2b1c0d5a";

/**
 * RFC 4122 v5 (SHA-1, name-based) UUID.
 *
 * @param {string} name
 * @param {string} [namespace] uuid string
 * @returns {string}
 */
export function uuidv5(name, namespace = SESSION_ID_NAMESPACE) {
  const nsBytes = uuidToBytes(namespace);
  const digest = createHash("sha1").update(nsBytes).update(String(name), "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/**
 * The deterministic session id for `(task, owner, seg)`.
 *
 * `seg` is required: it is part of the natural key, and a silent default would
 * let two segments collide on one row.
 *
 * @param {string} taskId the resolved task UUID
 * @param {string} owner
 * @param {string} seg
 * @returns {string}
 */
export function sessionId(taskId, owner, seg) {
  return uuidv5(`${taskId}\u0000${owner}\u0000${seg}`);
}

const USAGE = `Usage: session-id.mjs --task-id <uuid> --owner <name> --seg <seg>

Print the deterministic session id for (task, owner, seg) without contacting taskd.

  --task-id  the resolved task UUID (taskctl issue get <ref> --json -> data.task.id),
             not the board identifier
  --owner    the session owner name
  --seg      the segment name

Exit codes: 0 printed; 2 bad usage.
`;

/**
 * @param {string[]} [argv]
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} [io]
 * @returns {number} process exit code
 */
export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "task-id": { type: "string" },
        owner: { type: "string" },
        seg: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr.write(`session-id: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.values.help === true) {
    io.stdout.write(USAGE);
    return 0;
  }

  const values = {
    "--task-id": parsed.values["task-id"],
    "--owner": parsed.values.owner,
    "--seg": parsed.values.seg,
  };
  for (const [flag, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.trim() === "") {
      io.stderr.write(`session-id: ${flag} is required and must not be empty\n\n${USAGE}`);
      return 2;
    }
  }

  io.stdout.write(`${sessionId(values["--task-id"], values["--owner"], values["--seg"])}\n`);
  return 0;
}

/** @param {string} uuid */
function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError(`uuidv5: ${JSON.stringify(uuid)} is not a UUID`);
  }
  return Buffer.from(hex, "hex");
}

/** @param {Uint8Array} bytes 16 bytes */
function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// Node resolves `import.meta.url` through `realpath` but leaves `process.argv[1]`
// as spelled, so both sides must be canonicalised — otherwise the guard is
// silently false when the installed path carries a symlink. The board skill's
// `report.mjs` carries the same private copy for the same reason (it ships
// without `src/`).
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (
  process.argv[1] !== undefined &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))
) {
  process.exitCode = main();
}
