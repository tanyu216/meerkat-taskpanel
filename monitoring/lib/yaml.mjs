/**
 * A small YAML reader for the declarative artefacts under `monitoring/` and the compose
 * overlay.
 *
 * Why this exists: the project has a hard no-dependency / no-network rule, so `js-yaml`
 * is not available, and the rules file must be *structurally* checked — an alert whose
 * threshold silently rotted to `0.01` is exactly the failure this repo cares about.
 * (`scripts/verify/lib/mini-yaml.mjs` is the other, deliberately flat reader used for
 * the container profiles; it cannot express nesting, which rules and compose need.)
 *
 * The subset implemented — and nothing more:
 *
 *   - block mappings and block sequences, nested by indentation (spaces only)
 *   - `key: value` with a plain, single-quoted or double-quoted scalar value
 *   - flow sequences `[a, b]` and flow mappings `{k: v}` (nesting included)
 *   - block scalars `|`, `|-`, `|+` (literal), including blank lines inside
 *   - `#` comments: whole-line, and trailing when preceded by whitespace
 *   - scalars: `null` / `~`, `true` / `false`, integers and decimals
 *
 * Deliberately **refused**, with the offending line number, rather than guessed at:
 * anchors and aliases (`&`, `*`), tags (`!`), reserved indicators (`%`, `@`, `` ` ``),
 * folded scalars (`>`), document markers (`---`, `...`) and tab indentation. A parser
 * that guesses is worse than one that stops — the callers below assert every refusal.
 *
 * Duplicate keys follow the flat reader's precedent: the last one wins.
 */

import { MonitoringError } from "./errors.mjs";

const NUMBER_PATTERN = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/u;
const RESERVED_INDICATORS = ["&", "*", "!", "%", "@", "`"];
const BLOCK_INDICATORS = Object.freeze({ "|": "clip", "|-": "strip", "|+": "keep" });
const ESCAPES = Object.freeze({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f" });

/** A YAML failure: a `MonitoringError` carrying the 1-based line number. */
export class YamlError extends MonitoringError {
  /**
   * @param {"YAML_PARSE_ERROR"|"UNSUPPORTED_YAML"} code
   * @param {string} message
   * @param {number} line
   */
  constructor(code, message, line) {
    super(code, { message: `${message} (line ${line})`, line, details: { line } });
    this.name = "YamlError";
  }
}

const fail = (code, message, line) => new YamlError(code, message, line);

/**
 * Parse a single-document YAML subset.
 * @param {string} text
 * @returns {unknown} `null` for an empty document
 * @throws {YamlError}
 */
export function parseYaml(text) {
  const lines = splitLines(text);
  const state = { lines, index: 0 };

  skipTrivia(state);
  if (state.index >= lines.length) return null;

  const first = lines[state.index];
  if (first.indent !== 0) throw fail("YAML_PARSE_ERROR", "the document must start at column 1", first.lineNo);

  const { value } = parseBlock(state, 0);
  skipTrivia(state);
  if (state.index < lines.length) {
    throw fail("YAML_PARSE_ERROR", "unexpected trailing content", lines[state.index].lineNo);
  }
  return value;
}

/** Split into `{raw, indent, lineNo}` entries, rejecting tab indentation. */
function splitLines(text) {
  const entries = [];
  const raw = String(text ?? "").replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    const indent = /^ */u.exec(line)[0].length;
    if (line[indent] === "\t" || /^ *\t/u.test(line)) {
      throw fail("YAML_PARSE_ERROR", "tab indentation is not allowed", index + 1);
    }
    entries.push({ raw: line, indent, lineNo: index + 1 });
  }
  return entries;
}

/** A line's content: indentation and comments removed. "" means blank or comment-only. */
function contentOf(entry) {
  return stripComment(entry.raw.slice(entry.indent)).trimEnd();
}

/** Drop a trailing comment, honouring quotes (`#` inside quotes, or mid-word, stays). */
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/u.test(text[index - 1]))) return text.slice(0, index);
  }
  return text;
}

/** Advance past blank and comment-only lines, leaving the index on the next real line. */
function skipTrivia(state) {
  while (state.index < state.lines.length) {
    const entry = state.lines[state.index];
    if (entry.raw.trim() === "" || contentOf(entry) === "") {
      state.index += 1;
      continue;
    }
    return;
  }
}

/** Reject the constructs this reader does not implement. */
function guard(content, lineNo) {
  if (content.startsWith("---") || content.startsWith("...")) {
    throw fail("UNSUPPORTED_YAML", "document markers are not implemented", lineNo);
  }
}

/** Parse the block (mapping or sequence) that starts at `state.index`, at `indent`. */
function parseBlock(state, indent) {
  const content = contentOf(state.lines[state.index]);
  return isSequenceItem(content) ? parseSequence(state, indent) : parseMap(state, indent);
}

/** Parse a block mapping at exactly `indent`. */
function parseMap(state, indent) {
  const map = {};
  for (;;) {
    skipTrivia(state);
    if (state.index >= state.lines.length) break;

    const entry = state.lines[state.index];
    const content = contentOf(entry);
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      throw fail("YAML_PARSE_ERROR", `unexpected indentation (column ${entry.indent + 1})`, entry.lineNo);
    }
    guard(content, entry.lineNo);
    if (isSequenceItem(content)) {
      throw fail("YAML_PARSE_ERROR", "found a sequence item where a mapping was expected", entry.lineNo);
    }

    const pair = splitKey(content, entry.lineNo);
    state.index += 1;

    if (pair.rest === "") {
      const nested = peekNestedIndent(state, indent);
      map[pair.key] = nested === null ? null : parseBlock(state, nested).value;
    } else if (Object.hasOwn(BLOCK_INDICATORS, pair.rest)) {
      map[pair.key] = readBlockScalar(state, BLOCK_INDICATORS[pair.rest], indent);
    } else if (pair.rest.startsWith(">")) {
      throw fail("UNSUPPORTED_YAML", "folded block scalars (`>`) are not implemented", entry.lineNo);
    } else {
      map[pair.key] = parseScalarOrFlow(pair.rest, entry.lineNo);
    }
  }
  return { value: map };
}

/** Parse a block sequence at exactly `indent`. */
function parseSequence(state, indent) {
  const items = [];
  for (;;) {
    skipTrivia(state);
    if (state.index >= state.lines.length) break;

    const entry = state.lines[state.index];
    const content = contentOf(entry);
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      throw fail("YAML_PARSE_ERROR", `unexpected indentation (column ${entry.indent + 1})`, entry.lineNo);
    }
    guard(content, entry.lineNo);
    if (!isSequenceItem(content)) break;

    const rest = content === "-" ? "" : content.slice(2).trim();
    state.index += 1;

    if (rest === "") {
      const nested = peekNestedIndent(state, indent);
      items.push(nested === null ? null : parseBlock(state, nested).value);
      continue;
    }
    if (Object.hasOwn(BLOCK_INDICATORS, rest)) {
      items.push(readBlockScalar(state, BLOCK_INDICATORS[rest], indent));
      continue;
    }
    if (rest.startsWith(">")) {
      throw fail("UNSUPPORTED_YAML", "folded block scalars (`>`) are not implemented", entry.lineNo);
    }

    // `- a: 1` is a mapping whose first key starts at the item's content column; re-align
    // it and parse it as such, so the item's following keys line up naturally.
    if (inlineMapExists(rest, entry.lineNo)) {
      state.lines.splice(state.index, 0, {
        raw: `${" ".repeat(indent + 2)}${rest}`,
        indent: indent + 2,
        lineNo: entry.lineNo,
      });
      items.push(parseMap(state, indent + 2).value);
      continue;
    }

    items.push(parseScalarOrFlow(rest, entry.lineNo));
  }
  return { value: items };
}

/** Does `text` start with a `key:` pair (used to detect a sequence item's inline map)? */
function inlineMapExists(text, lineNo) {
  const pair = trySplitKey(text, lineNo);
  return pair !== null && pair.key !== "";
}

const isSequenceItem = (content) => content === "-" || content.startsWith("- ");

/** The indent of the block nested under the current key, or `null` when there is none. */
function peekNestedIndent(state, indent) {
  const saved = state.index;
  skipTrivia(state);
  if (state.index >= state.lines.length) return null;
  const next = state.lines[state.index];
  if (next.indent > indent) return next.indent;
  state.index = saved;
  return null;
}

/** Read a literal block scalar (`|`, `|-`, `|+`) following the current key. */
function readBlockScalar(state, chomp, indent) {
  const collected = [];
  let contentIndent = null;
  for (let index = state.index; index < state.lines.length; index += 1) {
    const entry = state.lines[index];
    if (entry.raw.trim() === "") continue;
    if (entry.indent > indent) contentIndent = entry.indent;
    break;
  }
  if (contentIndent === null) return "";

  while (state.index < state.lines.length) {
    const entry = state.lines[state.index];
    if (entry.raw.trim() === "") {
      collected.push("");
      state.index += 1;
      continue;
    }
    if (entry.indent < contentIndent) break;
    collected.push(entry.raw.slice(contentIndent));
    state.index += 1;
  }

  const trimmed = [...collected];
  while (trimmed.length > 0 && trimmed.at(-1) === "") trimmed.pop();
  if (trimmed.length === 0) return "";

  const body = chomp === "keep" ? collected : trimmed;
  return chomp === "strip" ? body.join("\n") : `${body.join("\n")}\n`;
}

/** Split `key: rest`; throws when `text` is not a mapping entry. */
function splitKey(text, lineNo) {
  const pair = trySplitKey(text, lineNo);
  if (pair === null) throw fail("YAML_PARSE_ERROR", 'expected "key: value"', lineNo);
  if (pair.key === "") throw fail("YAML_PARSE_ERROR", "empty key", lineNo);
  return pair;
}

/** Split `key: rest`, or `null` when `text` is not one. */
function trySplitKey(text, lineNo) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    const end = findClosingQuote(text, quote);
    if (end === -1) throw fail("YAML_PARSE_ERROR", "unterminated quoted key", lineNo);
    const after = text.slice(end + 1).trimStart();
    if (!after.startsWith(":")) return null;
    return { key: unquote(text.slice(0, end + 1), lineNo), rest: after.slice(1).trim() };
  }
  const colon = indexOfKeyColon(text);
  if (colon === -1) return null;
  return { key: text.slice(0, colon).trim(), rest: text.slice(colon + 1).trim() };
}

/** The first `:` that ends a key — at depth 0, outside quotes, followed by space or EOL. */
function indexOfKeyColon(text) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0 && (index === text.length - 1 || text[index + 1] === " ")) return index;
  }
  return -1;
}

/** Parse a scalar or a flow collection. */
function parseScalarOrFlow(text, lineNo) {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const first = trimmed[0];
  if (RESERVED_INDICATORS.includes(first)) {
    throw fail("UNSUPPORTED_YAML", `the indicator "${first}" is not implemented`, lineNo);
  }
  if (first === "[" || first === "{") {
    const { value, index } = parseFlow(trimmed, 0, lineNo);
    assertFullyConsumed(trimmed, index, lineNo);
    return value;
  }
  if (first === '"' || first === "'") {
    const end = findClosingQuote(trimmed, first);
    if (end === -1) throw fail("YAML_PARSE_ERROR", "unterminated quoted scalar", lineNo);
    const value = unquote(trimmed.slice(0, end + 1), lineNo);
    assertFullyConsumed(trimmed, end + 1, lineNo);
    return value;
  }
  return parsePlainScalar(trimmed);
}

function assertFullyConsumed(text, index, lineNo) {
  if (text.slice(index).trim() !== "") {
    throw fail("YAML_PARSE_ERROR", `unexpected trailing content ${JSON.stringify(text.slice(index).trim())}`, lineNo);
  }
}

/** `null`/`~`, booleans, numbers, or the string itself. */
function parsePlainScalar(text) {
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (NUMBER_PATTERN.test(text)) return Number(text);
  return text;
}

/** The index of the quote that closes the one at `text[start]`, or -1. */
function findClosingQuote(text, quote, start = 0) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") index += 1;
    else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") index += 1;
      else return index;
    }
  }
  return -1;
}

/** Strip and unescape a quoted scalar (single quotes: `''` means one quote). */
function unquote(text, lineNo = 1) {
  const quote = text[0];
  const body = text.slice(1, -1);
  if (quote === "'") return body.replace(/''/gu, "'");
  return body.replace(/\\(.)/gu, (match, escaped) => {
    if (!Object.hasOwn(ESCAPES, escaped)) {
      throw fail("YAML_PARSE_ERROR", `unknown escape \\${escaped} in a double-quoted scalar`, lineNo);
    }
    return ESCAPES[escaped];
  });
}

/** Parse a flow collection starting at `text[index]`, returning it and the next index. */
function parseFlow(text, index, lineNo) {
  const opener = text[index];
  const closer = opener === "[" ? "]" : "}";
  const isMapping = opener === "{";
  const value = isMapping ? {} : [];
  let cursor = index + 1;

  for (;;) {
    cursor = skipSpaces(text, cursor);
    if (text[cursor] === closer) return { value, index: cursor + 1 };
    if (cursor >= text.length) throw fail("YAML_PARSE_ERROR", `unterminated flow ${isMapping ? "mapping" : "sequence"}`, lineNo);

    if (isMapping) {
      const key = parseFlowValue(text, cursor, lineNo, ":,}");
      cursor = skipSpaces(text, key.index);
      if (text[cursor] !== ":") throw fail("YAML_PARSE_ERROR", "expected `:` in a flow mapping", lineNo);
      const entry = parseFlowValue(text, skipSpaces(text, cursor + 1), lineNo, ",}");
      value[String(key.value)] = entry.value;
      cursor = entry.index;
    } else {
      const entry = parseFlowValue(text, cursor, lineNo, ",]");
      value.push(entry.value);
      cursor = entry.index;
    }

    cursor = skipSpaces(text, cursor);
    if (text[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === closer) return { value, index: cursor + 1 };
    throw fail("YAML_PARSE_ERROR", `expected \`,\` or \`${closer}\` in a flow collection`, lineNo);
  }
}

/** One flow entry: a nested collection, a quoted scalar or a bare one. */
function parseFlowValue(text, index, lineNo, stops) {
  const char = text[index];
  if (char === "[" || char === "{") return parseFlow(text, index, lineNo);
  if (char === '"' || char === "'") {
    const end = findClosingQuote(text, char, index);
    if (end === -1) throw fail("YAML_PARSE_ERROR", "unterminated quoted scalar", lineNo);
    return { value: unquote(text.slice(index, end + 1), lineNo), index: end + 1 };
  }
  let cursor = index;
  while (cursor < text.length && !stops.includes(text[cursor])) cursor += 1;
  const raw = text.slice(index, cursor).trim();
  if (raw === "") throw fail("YAML_PARSE_ERROR", "empty flow entry", lineNo);
  return { value: parsePlainScalar(raw), index: cursor };
}

function skipSpaces(text, index) {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
  return cursor;
}
