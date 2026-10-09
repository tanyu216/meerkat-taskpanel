/**
 * Identifier helpers: internal UUIDs, deterministic session ids, human-readable
 * task identifiers and content hashes.
 *
 * `node:crypto` lives *here* rather than in `domain/` — the purity test forbids
 * `node:` specifiers in `src/core/domain/**`, and these are the utilities the
 * domain needs but cannot host.
 *
 * No I/O beyond the hash/random primitives.
 */

import { createHash, randomUUID } from "node:crypto";

import { IDENTIFIER_PAD, IDENTIFIER_PATTERN, SESSION_ID_NAMESPACE } from "./constants.mjs";

/** A fresh internal id (never shown to humans; `identifier` is the readable one). */
export function newId() {
  return randomUUID();
}

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
 * Deterministic agent-session id: the natural key is `(task, seg, owner)`, so a
 * resumed session keeps its id without a lookup.
 *
 * @param {string} taskId
 * @param {string} owner
 * @param {string} seg
 */
export function sessionId(taskId, owner, seg) {
  return uuidv5(`${taskId}\u0000${owner}\u0000${seg}`);
}

/**
 * Project id → identifier prefix. `meerkat-taskpanel` → `MEERKAT-TASKPANEL`, `demo_x` → `DEMO-X`.
 * @param {string} projectId
 */
export function identifierPrefix(projectId) {
  return String(projectId)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `PROJ-0007` — the per-project counter is allocated inside the write
 * transaction (`projects.allocateIdentifier`), so ids never repeat.
 *
 * @param {string} projectId
 * @param {number} serial 1-based
 */
export function formatIdentifier(projectId, serial) {
  const n = Number(serial);
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`formatIdentifier: serial must be a positive integer, got ${serial}`);
  }
  return `${identifierPrefix(projectId)}-${String(n).padStart(IDENTIFIER_PAD, "0")}`;
}

/**
 * Deliberately permissive: hand-written legacy cards (`T-20261008-230500-slug`)
 * must import unchanged (F2). It only rejects what could never be an id.
 *
 * @param {unknown} value
 */
export function isValidIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

/** sha256 hex of a string or buffer. */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable content hash of a JSON-ish value: keys are sorted so the hash does not
 * depend on key order (used for md `source_hash` idempotency).
 * @param {unknown} value
 */
export function contentHash(value) {
  return sha256Hex(stableStringify(value));
}

/**
 * JSON.stringify with sorted object keys and a cycle guard.
 * @param {unknown} value
 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) throw new TypeError("stableStringify: circular structure");
    seen.add(node);
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
    seen.delete(node);
    return out;
  };
  return JSON.stringify(walk(value));
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
