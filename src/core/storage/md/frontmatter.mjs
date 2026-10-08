/**
 * Card frontmatter — a deliberately small YAML subset.
 *
 *   key: plain scalar            (everything is a string; no type guessing)
 *   key: [a, b]                  (inline array)
 *   key: "quoted"                (JSON.parse)
 *   key: |                       (literal block — newlines kept)
 *   key: >                       (folded block — newlines become spaces)
 *
 * Anything else — an indented mapping, a `key:` with no value and no block
 * marker, a tab-indented block, an unparsable quoted value — is a **hard
 * error with a line number**. Guessing is what turns a migrator into a data
 * corruption engine; refusing is what makes it trustworthy.
 *
 * `parse → serialize → parse` is idempotent by construction: serialisation only
 * emits syntax this parser accepts, and multi-line strings are written as block
 * scalars so a rewrite cannot grow the file without bound (the card-rewriting
 * bug the plan calls out is a growth loop, and this is where it is prevented).
 */

import { DomainError } from "../../../shared/errors.mjs";

/** The `---` fence. */
export const FENCE = "---";

/**
 * Characters that force a value to be quoted on the way out. Deliberately
 * conservative: anything structural, plus anything a reader might mistake for
 * syntax. Everything else — including non-ASCII text, which is normal in these
 * cards — is written plain and read back verbatim.
 */


/** Values that must be quoted even if they look plain. */
const NUMERIC_LIKE = /^-?\d+(\.\d+)?$/;

/**
 * Characters that force quoting. Structural characters only — a colon or a `#`
 * is literal in this subset (the parser splits on the *first* colon), so
 * timestamps and prose stay readable, and `key: value` always re-reads as the
 * same string.
 */
const NEEDS_QUOTING = /[\[\]{}"'|>&*!%@`]/;

/**
 * @param {string} text a whole card file
 * @param {{file?: string}} [options]
 * @returns {{data: Record<string, unknown>, order: string[], body: string, lineCount: number}}
 */
export function parseFrontmatter(text, options = {}) {
  const file = options.file ?? "<memory>";
  const lines = String(text).split("\n");
  if (lines[0]?.trim() !== FENCE) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `${file}:1 expected the card to start with '---'`,
      details: { file, line: 1, found: lines[0] ?? "" },
    });
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `${file}: unterminated frontmatter (no closing '---')`,
      details: { file, line: lines.length },
    });
  }

  /** @type {Record<string, unknown>} */
  const data = {};
  const order = [];
  const fail = (line, message, extra = {}) => {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `${file}:${line + 1} ${message}`,
      details: { file, line: line + 1, ...extra },
    });
  };

  for (let i = 1; i < end; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (/^\s/.test(raw)) {
      fail(i, "unexpected indentation — nested structures are not supported", { found: raw });
    }
    const match = /^([A-Za-z0-9_.\-]+):(.*)$/.exec(raw);
    if (match === null) {
      fail(i, "expected 'key: value'", { found: raw });
    }
    const key = match[1];
    const rest = match[2];

    if (rest.trim() === "") {
      // A block scalar, or nothing at all.
      const peek = lines[i + 1];
      if (peek !== undefined && /^\s+\S/.test(peek)) {
        fail(i, "a value on the next line needs an explicit '|' or '>' block marker", {
          key,
          hint: `write '${key}: |' for a literal block`,
        });
      }
      data[key] = "";
      if (!order.includes(key)) order.push(key);
      continue;
    }

    const marker = rest.trim();
    if (marker === "|" || marker === ">") {
      const { value, next } = readBlock(lines, i + 1, end, marker, fail, i);
      data[key] = value;
      if (!order.includes(key)) order.push(key);
      i = next - 1;
      continue;
    }

    data[key] = parseScalar(rest.trim(), (message, extra) => fail(i, message, { key, ...extra }));
    if (!order.includes(key)) order.push(key);
  }

  return {
    data,
    order,
    body: lines.slice(end + 1).join("\n"),
    lineCount: end + 1,
  };
}

/**
 * Read an indented block scalar starting at `start`.
 * @returns {{value: string, next: number}}
 */
function readBlock(lines, start, end, marker, fail, keyLine) {
  const collected = [];
  let i = start;
  let indent = null;
  for (; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      collected.push("");
      continue;
    }
    const match = /^(\s+)/.exec(line);
    if (match === null) break; // dedented back to a key
    if (line.includes("\t")) fail(i, "tab indentation is not supported", { found: line });
    if (indent === null) indent = match[1].length;
    if (match[1].length < indent) break;
    collected.push(line.slice(indent));
  }

  // Trailing blank lines belong to the block only in the literal form.
  while (collected.length > 0 && collected.at(-1) === "") collected.pop();
  if (collected.length === 0) {
    fail(keyLine, "empty block scalar", { marker });
  }

  const value = marker === "|" ? `${collected.join("\n")}\n` : `${collected.join(" ")}\n`;
  return { value, next: i };
}

/**
 * Parse an inline value.
 * @param {string} raw
 * @param {(message: string, extra?: object) => never} fail
 */
export function parseScalar(raw, fail) {
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) fail("inline arrays must be closed on the same line", { found: raw });
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitList(inner).map((item) => {
      const text = item.trim();
      if (text.startsWith('"')) return parseJson(text, fail);
      if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
      if (text.startsWith("[")) fail("nested arrays are not supported", { found: raw });
      return text;
    });
  }
  if (raw.startsWith('"')) return parseJson(raw, fail);
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) fail("unterminated single-quoted value", { found: raw });
    return raw.slice(1, -1);
  }
  if (raw.startsWith("{") || raw.startsWith("&") || raw.startsWith("*")) {
    fail("that value syntax is not supported — use a quoted JSON string", { found: raw });
  }
  return raw;
}

/** Split on commas that are not inside quotes or brackets. */
function splitList(inner) {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (const char of inner) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** A double-quoted value is JSON — which is exactly how escapes round-trip. */
function parseJson(text, fail) {
  try {
    return JSON.parse(text);
  } catch {
    fail("the quoted value is not valid JSON", { found: text });
  }
}

/**
 * Render a value.
 * @param {unknown} value
 */
export function renderScalar(value) {
  if (value === null || value === undefined) return '""';
  if (Array.isArray(value)) return `[${value.map((item) => renderListItem(item)).join(", ")}]`;
  const text = String(value);
  if (text === "") return '""';
  if (text.includes("\n")) return "|"; // handled by the caller
  if (needsQuoting(text)) return JSON.stringify(text);
  return text;
}

function renderListItem(item) {
  const text = String(item);
  if (text === "" || needsQuoting(text) || text.includes(",")) return JSON.stringify(text);
  return text;
}

function needsQuoting(text) {
  if (text === "") return true;
  // A colon followed by a space is a mapping in every other YAML reader — a
  // card has to stay safe to open in one.
  if (/: /.test(text)) return true;
  if (text !== text.trim()) return true;
  if (NUMERIC_LIKE.test(text)) return true;
  if (NEEDS_QUOTING.test(text)) return true;
  if (/[\x00-\x1f]/.test(text)) return true;
  return false;
}

/**
 * Serialise a frontmatter block.
 *
 * @param {Record<string, unknown>} data
 * @param {{order?: string[], indent?: string}} [options] `order` is the
 *   canonical key order; keys it does not mention follow, in their own order.
 * @returns {string} the block, fences included, ending with a newline
 */
export function serializeFrontmatter(data, options = {}) {
  const { order = [], indent = "  " } = options;
  const keys = [
    ...order.filter((key) => Object.hasOwn(data, key)),
    ...Object.keys(data).filter((key) => !order.includes(key)),
  ];
  const out = [`${FENCE}`];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.includes("\n")) {
      out.push(`${key}: |`);
      const body = value.endsWith("\n") ? value.slice(0, -1) : value;
      for (const line of body.split("\n")) out.push(line === "" ? "" : `${indent}${line}`);
      continue;
    }
    out.push(`${key}: ${renderScalar(value)}`);
  }
  out.push(FENCE);
  return `${out.join("\n")}\n`;
}
