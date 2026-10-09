#!/usr/bin/env node
/**
 * Assert that an `npm pack` tarball ships the release and nothing else.
 *
 * `npm pack` obeys the root `package.json` `files` whitelist, but a whitelist is
 * only as good as the run that produced the tarball: a stray `files` edit, a
 * regression in the toolchain, or a generated artefact that slipped into the
 * context all widen the package silently. This script reads the tarball the
 * release step actually produced and checks two things:
 *
 *   * every REQUIRED path is present (the tarball is a complete release), and
 *   * no file escapes the `files` whitelist (the tarball ships nothing extra —
 *     no `web/`, no `test/`, no `dist/`, no `.data/`).
 *
 * The whitelist is read from the tarball's OWN `package/package.json`, so the
 * check cannot drift from the manifest it is verifying.
 *
 *   node scripts/release/pack-manifest.mjs <tarball.tgz>
 *
 * The tarball is parsed with `node:zlib` + a small `ustar` reader — no `tar`
 * binary, no dependencies. Exit 0 when the manifest is clean, 1 when it is not,
 * 2 when the tarball cannot be read at all.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

/** Files a publishable tarball must contain. */
export const REQUIRED = Object.freeze([
  "package.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "install.sh",
  "src/cli/index.mjs",
  "src/mcp/main.mjs",
  "src/server/main.mjs",
  "skills/meerkat-taskpanel/SKILL.md",
  "plugins/claude/.claude-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  "plugins/openclaw/openclaw.plugin.json",
  "plugins/pi/package.json",
]);

/**
 * Files npm includes whether or not `files` names them.
 * @see https://docs.npmjs.com/cli/configuring-npm/package-json#files
 */
export const ALWAYS_INCLUDED = Object.freeze(["package.json", "README.md", "README.zh-CN.md", "LICENSE"]);

const BLOCK = 512;

/** Read a NUL/space-terminated string field out of a tar header. */
function field(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/** Parse a tar size field: octal, or base-256 when the high bit is set. */
function readSize(buffer, offset) {
  if ((buffer[offset] & 0x80) !== 0) {
    // base-256: the low bits of the first byte are the most-significant bits.
    let value = buffer[offset] & 0x7f;
    for (let i = 1; i < 12; i += 1) value = value * 256 + buffer[offset + i];
    return value;
  }
  const text = field(buffer, offset, 12).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** Parse a pax extended header body (`<len> <key>=<value>\n` records) for `path`. */
function readPaxPath(data) {
  let offset = 0;
  let path;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8"); // drop trailing \n
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    offset += length;
  }
  return path;
}

/**
 * Read the regular-file entries out of an *uncompressed* tar buffer.
 *
 * Handles the `ustar` header plus the two extensions node-tar may emit for a
 * long path: a GNU long-name entry (`L`) and a pax extended header (`x`).
 *
 * @param {Buffer} buffer
 * @returns {{path: string, size: number}[]}
 */
export function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let nextName = null; // a name forced by a preceding `L`/`x` entry

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // A zero block marks the end of the archive; two in a row is the norm.
    if (header.every((byte) => byte === 0)) break;

    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const typeflag = String.fromCharCode(header[156]);
    const size = readSize(header, 124);
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const dataStart = offset + BLOCK;

    if (typeflag === "L") {
      nextName = buffer.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0+$/, "");
    } else if (typeflag === "x" || typeflag === "g") {
      nextName = readPaxPath(buffer.subarray(dataStart, dataStart + size)) ?? nextName;
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      entries.push({ path: nextName ?? fullName, size });
      nextName = null;
    } else {
      nextName = null; // directories (5) and links (1/2) are not shipped payload
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

/** `package/`-relative path for a tar entry, or the path unchanged if unrooted. */
function relativePath(path) {
  return path.startsWith("package/") ? path.slice("package/".length) : path;
}

/**
 * The whitelist's top-level names: every `files` entry's first segment, plus the
 * always-included names.
 *
 * @param {{files?: string[]}} pkg
 * @returns {Set<string>}
 */
export function allowedTopLevel(pkg) {
  const allowed = new Set(ALWAYS_INCLUDED);
  for (const entry of pkg.files ?? []) {
    allowed.add(String(entry).split("/")[0]);
  }
  return allowed;
}

/**
 * Check a parsed entry list against a package.json.
 *
 * @param {{path: string, size: number}[]} entries
 * @param {{files?: string[], version?: string}} pkg
 * @returns {{ok: boolean, missing: string[], leaked: string[], count: number}}
 */
export function checkManifest(entries, pkg) {
  const present = new Set(entries.map((entry) => relativePath(entry.path)));
  const missing = REQUIRED.filter((path) => !present.has(path));

  const allowed = allowedTopLevel(pkg);
  const leaked = [...present]
    .filter((path) => path !== "" && !allowed.has(path.split("/")[0]))
    .sort();

  return { ok: missing.length === 0 && leaked.length === 0, missing, leaked, count: present.size };
}

/** Gunzip when the buffer is gzip-framed; pass a plain tar through untouched. */
export function maybeGunzip(buffer) {
  return buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h", default: false } },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write("Usage: node scripts/release/pack-manifest.mjs <tarball.tgz>\n");
    return positionals.length === 0 && !values.help ? 2 : 0;
  }

  const tarball = positionals[0];
  let entries;
  let pkg;
  try {
    const raw = maybeGunzip(await readFile(tarball));
    entries = parseTar(raw);
    // The whitelist comes from the tarball's own manifest, so the check and the
    // manifest it verifies cannot drift apart.
    pkg = JSON.parse(readEntryBody(raw, "package/package.json"));
  } catch (err) {
    process.stderr.write(`pack-manifest: cannot read ${tarball}: ${err.message}\n`);
    return 2;
  }

  const result = checkManifest(entries, pkg);
  const version = typeof pkg.version === "string" ? pkg.version : "(no version)";

  if (!result.ok) {
    process.stderr.write(`pack-manifest: FAILED for ${tarball} (${version}, ${result.count} files)\n`);
    if (result.missing.length > 0) {
      process.stderr.write("  missing required files:\n");
      for (const path of result.missing) process.stderr.write(`    - ${path}\n`);
    }
    if (result.leaked.length > 0) {
      process.stderr.write("  files outside the `files` whitelist:\n");
      for (const path of result.leaked) process.stderr.write(`    - ${path}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `pack-manifest: OK — ${tarball} (${version}, ${result.count} files, ${REQUIRED.length} required present, no leaks)\n`,
  );
  return 0;
}

/** Read one entry's bytes out of an uncompressed tar buffer by exact path. */
function readEntryBody(buffer, wanted) {
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const typeflag = String.fromCharCode(header[156]);
    const size = readSize(header, 124);
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    if (fullName === wanted && (typeflag === "0" || typeflag === "\0")) {
      return buffer.subarray(offset + BLOCK, offset + BLOCK + size).toString("utf8");
    }
    offset = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error(`${wanted} not found in tarball`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
