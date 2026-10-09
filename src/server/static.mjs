/**
 * Static hosting for the built board (ARCHITECTURE §8).
 *
 * `web/dist` is produced by the frontend build (M6b) and may simply not be
 * there — a backend checkout, a fresh clone, the container image before the web
 * build runs. Absence must therefore be a *normal* state: `createStaticHost`
 * reports `available: false` and the server 404s exactly as it did before there
 * was a frontend. Nothing here creates or invents a build.
 *
 * The two rules that matter are both about paths. A request is resolved against
 * the root and then **re-checked to still be inside it**: `..` is rejected
 * outright and the resolved path must share the root's prefix, which together
 * close the directory-traversal hole a naive `join(root, url)` leaves open. And
 * an unknown path with no file extension falls back to `index.html`, because
 * that is what a client-side router (vue-router) needs to serve `/board/PROJ-1`
 * from a static directory.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { STATIC_INDEX } from "../shared/constants.mjs";

/** The handful of types a board bundle actually ships. */
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
});

/**
 * Resolve `pathname` under `root`, refusing anything that escapes.
 *
 * @param {string} root absolute directory
 * @param {string} pathname URL path (already decoded)
 * @returns {string|null} an absolute path inside `root`, or null
 */
export function safeResolve(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // a malformed %-escape is not a path
  }
  if (decoded.includes("\0")) return null;
  // Refuse `..` as a *segment*, before `normalize` can quietly collapse it:
  // `..%2f..%2fetc/passwd` decodes to `/../../etc/passwd`, which normalization
  // would silently turn into a legal path. For a security control, explicit
  // beats clever.
  if (decoded.split(/[/\\]+/).includes("..")) return null;

  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  if (relative === "" || relative === ".") return join(root, STATIC_INDEX);
  const candidate = resolve(root, relative);
  const base = resolve(root);
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}

/** @param {string} path @returns {string} */
export function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * @param {{root: string}} options
 * @returns {{available: boolean, root: string, serve: Function}}
 */
export function createStaticHost(options) {
  const root = resolve(options.root);
  // Resolved lazily on the first request rather than at construction: the
  // server may start before the web build lands, and must not need a restart.
  const state = { checked: false, available: false };
  const host = {
    root,
    get available() {
      return state.available;
    },
    async probe() {
      if (state.checked) return state.available;
      state.checked = true;
      try {
        state.available = (await stat(join(root, STATIC_INDEX))).isFile();
      } catch {
        state.available = false;
      }
      return state.available;
    },
    /**
     * Try to serve `pathname`.
     *
     * @param {import('node:http').ServerResponse} res
     * @param {string} pathname
     * @param {string} method
     * @returns {Promise<boolean>} true when the response was written
     */
    async serve(res, pathname, method) {
      if (!(await host.probe())) return false;

      const file = safeResolve(root, pathname);
      if (file === null) return false;

      const found = await fileOrIndex(root, file);
      if (found === null) return false;

      const info = await stat(found).catch(() => null);
      if (info === null || !info.isFile()) return false;

      res.writeHead(200, {
        "content-type": contentTypeFor(found),
        "content-length": info.size,
        // Hashed bundle assets are immutable; the shell must never be cached or
        // a deploy would keep serving yesterday's API contract.
        "cache-control": found.endsWith(STATIC_INDEX) ? "no-cache" : "public, max-age=3600",
      });
      if (method === "HEAD") {
        res.end();
        return true;
      }
      await pipe(createReadStream(found), res);
      return true;
    },
  };
  return host;
}

/**
 * The file to serve, applying the SPA fallback.
 *
 * A path that resolves to a real file wins. Otherwise a path that looks like a
 * *route* (no file extension) is answered with the shell — `index.html`, which
 * lives at the root; an asset that is genuinely missing is a real 404 rather
 * than an HTML page.
 */
async function fileOrIndex(root, file) {
  if ((await stat(file).catch(() => null))?.isFile() === true) return file;
  if (extname(file) !== "") return null; // a missing asset is a real 404
  const index = join(resolve(root), STATIC_INDEX);
  if ((await stat(index).catch(() => null))?.isFile() !== true) return null;
  return index;
}

/** Stream a file into the response, resolving when the bytes are done. */
function pipe(stream, res) {
  return new Promise((resolvePromise, reject) => {
    stream.on("error", reject);
    res.on("finish", resolvePromise);
    res.on("error", reject);
    stream.pipe(res);
  });
}
