/**
 * Source scanning helpers for the dependency-rules test (`domain/purity`) and
 * for any test that needs the file list of a source tree.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Replace `// line` and block comments with spaces. String literals are left
 * intact — module specifiers live inside them.
 *
 * @param {string} code
 */
export function stripComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === c) break;
        j += 1;
      }
      out += code.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Replace comments *and* string/template bodies with spaces. Use this when the
 * scan is about code text rather than module specifiers (e.g. "no bare
 * `throw new Error`"), so prose in a string never trips it.
 *
 * @param {string} code
 */
export function stripCommentsAndStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === c) break;
        j += 1;
      }
      out += " ";
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Module specifiers from every static `import` / `export … from` / dynamic
 * `import()` in `code`, in source order.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function importedSpecifiers(code) {
  const clean = stripComments(code);
  const specs = [];
  for (const m of clean.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of clean.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

/**
 * Is this specifier a Node built-in (`node:fs`) or a bare builtin (`fs`)?
 * @param {string} specifier
 */
export function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  return [
    "fs",
    "path",
    "os",
    "net",
    "http",
    "https",
    "crypto",
    "child_process",
    "process",
    "url",
    "util",
    "stream",
    "tls",
    "dgram",
    "worker_threads",
    "sqlite",
  ].includes(specifier);
}

/**
 * Every `.mjs` file under `dir`, recursively, sorted (absolute paths).
 *
 * A missing directory yields `[]` rather than throwing, so a scan can be
 * written before the tree it guards exists. Callers that must not silently
 * scan nothing assert on the returned length.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listModuleFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".mjs")) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** @param {string} file */
export function readSource(file) {
  return readFileSync(file, "utf8");
}
