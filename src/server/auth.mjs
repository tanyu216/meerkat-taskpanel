/**
 * Who may talk to this board (§7 / §7.1).
 *
 * The rule is short, and the loopback exemption is the whole point of a
 * local-first board:
 *
 *   * a request from this machine is trusted — no token, no CIDR list, no ceremony;
 *   * a request from anywhere else must be inside the **CIDR allow-list** (when
 *     one is configured) and must present the access token, as
 *     `Authorization: Bearer <token>` or `?token=<token>` (the second form
 *     exists for `EventSource`, which cannot set headers — M6 uses it);
 *   * `token rotate` is loopback-only: a remote caller may *use* a token, never
 *     mint one.
 *
 * The checks are deliberately ordered *cheapest-and-broadest first*: the CIDR
 * list is a network-level filter and answers `403 ip_not_allowed` before the
 * token is even looked at, so an address outside the list cannot probe for a
 * token's validity.
 *
 * `test/server/auth.test.mjs` drives the loopback half over real HTTP and the
 * rest with synthetic requests, because a test process cannot genuinely arrive
 * from a non-loopback address.
 */

import { timingSafeEqual } from "node:crypto";

import { isAddressAllowed } from "./cidr.mjs";

/** The three spellings a loopback connection can have. `::ffff:127.0.0.1` is IPv4-mapped. */
export const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** @param {unknown} address */
export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  if (LOOPBACK_ADDRESSES.includes(address)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just .0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || /^::ffff:127\./.test(address);
}

/** @param {{socket?: {remoteAddress?: string}}} req */
export function remoteAddressOf(req) {
  return req?.socket?.remoteAddress ?? null;
}

/** @param {{socket?: {remoteAddress?: string}}} req */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(remoteAddressOf(req));
}

/** Constant-time compare that tolerates a length mismatch without throwing. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The token a request presented, if any.
 * @param {{headers?: Record<string, unknown>}} req
 * @param {URL} url
 */
export function presentedToken(req, url) {
  const header = req?.headers?.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }
  const fromQuery = url?.searchParams?.get("token");
  return typeof fromQuery === "string" && fromQuery !== "" ? fromQuery : null;
}

/**
 * @param {{req: object, url: URL, token: string|null, rotate?: boolean, allowList?: object}} input
 *   `allowList` is the parsed `TASKD_ALLOW_CIDRS` policy (`cidr.mjs`). Absent or
 *   `configured: false` means "no list was set" ⇒ every address is allowed.
 * @returns {{ok: true, loopback: boolean}|{ok: false, status: number, payload: object}}
 */
export function authorize(input) {
  const { req, url, token, rotate = false, allowList } = input;
  const loopback = isLoopbackRequest(req);

  if (loopback) return { ok: true, loopback: true };

  // The list gates *remote* callers only. Loopback is the owner's console: an
  // over-tight list must never lock them out of their own board.
  if (isAddressAllowed(remoteAddressOf(req), allowList) === false) {
    return forbid(
      403,
      "this address is not in the board's allow-list",
      "ip_not_allowed",
      { fix: `add your address to ${"TASKD_ALLOW_CIDRS"} on the machine hosting the board` },
    );
  }

  if (rotate) {
    // Not a missing credential — a forbidden action. Say which, so a caller can
    // tell "rotate this locally" from "your token is wrong".
    return forbid(403, "rotating the board token is a loopback-only action", "loopback_only", {
      fix: "run `taskctl token rotate` on the machine hosting the board",
    });
  }

  const presented = presentedToken(req, url);
  if (presented === null) {
    return forbid(401, "this board requires an access token for non-local requests", "missing_token", {
      fix: "pass --token <token>, or export TASKD_TOKEN from the board's data directory",
    });
  }
  if (!sameSecret(presented, token ?? "")) {
    return forbid(401, "the access token is not valid for this board", "bad_token", {
      fix: "pass --token <token>, or export TASKD_TOKEN from the board's data directory",
    });
  }
  return { ok: true, loopback: false };
}

function forbid(status, message, reason, hint = null) {
  return {
    ok: false,
    status,
    payload: {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message,
        http: status,
        details: { reason },
        hint,
      },
    },
  };
}
