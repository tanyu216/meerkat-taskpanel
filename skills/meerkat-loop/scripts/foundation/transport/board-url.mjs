/**
 * Board URL helpers — pure, shared by the CLI and the loop subscriber.
 *
 * The server's own `isLoopbackRequest` cannot be reused: `src/server` sits
 * *above* this module in the dependency graph, and `src/cli` may not import it.
 * These functions are the client-side equivalent, and they decide one thing that
 * matters for `TASKD_URL`: whether a dead address is a **local** one that may
 * still fall through to a running board or a lazy start, or a **remote** one that
 * must fail loudly instead of silently starting a second board.
 *
 * `normalizeBoardUrl` is deliberately narrow: an origin only (scheme, host,
 * port). A path, query, credentials or fragment in a board address is a
 * configuration mistake, not something to silently drop.
 */

import { DomainError } from "../errors.mjs";

/** @param {unknown} value */
function invalid(message, details = {}) {
  return new DomainError("CONFIG_FILE_INVALID", {
    message,
    details,
    hint: { fix: "use http://host:port (no path, query, credentials, or port 0)" },
  });
}

/**
 * Is `host` a loopback name/address?
 *
 * `localhost` is treated as loopback even though a hostile `/etc/hosts` could
 * point it elsewhere: it is the spelling a local-first board uses, and the
 * alternative would make the default `http://localhost:9527` a remote address.
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
    return value.split(".").slice(1).every((octet) => Number(octet) <= 255);
  }
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
    return value.split(".").slice(1).every((octet) => Number(octet) <= 255);
  }
  return false;
}

/**
 * Normalize a board address to its origin, or refuse it.
 *
 * @param {unknown} value
 * @returns {string} e.g. `http://localhost:9527`
 * @throws {DomainError} CONFIG_FILE_INVALID
 */
export function normalizeBoardUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("TASKD_URL is empty");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalid("TASKD_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("TASKD_URL must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalid("TASKD_URL must not carry credentials");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw invalid("TASKD_URL must not carry a path");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw invalid("TASKD_URL must not carry a query or fragment");
  }
  if (parsed.port === "0") {
    throw invalid("TASKD_URL must not use port 0");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "0.0.0.0" || host === "[::]" || host === "::") {
    throw invalid("TASKD_URL must name an address a client can connect to");
  }
  return parsed.origin;
}

/**
 * Is this URL's host loopback?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  try {
    return isLoopbackHost(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

/**
 * The literal IPv4/IPv6 forms to probe when a `localhost` URL does not answer.
 *
 * A board bound to `0.0.0.0` is reachable at `127.0.0.1`; a dual-stack resolver
 * may send `localhost` to `::1` first, where nothing is listening. Trying both
 * literals before declaring the configured address dead avoids a spurious
 * autostart. Other hosts have no fallback.
 *
 * @param {string} value a normalized URL
 * @returns {string[]}
 */
export function loopbackFallbackUrls(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "localhost") return [];
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return [`http://127.0.0.1${port}`, `http://[::1]${port}`];
}
