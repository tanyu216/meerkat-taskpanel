/**
 * Who may talk to this board (§7.1).
 *
 * The rule is short and the loopback exemption is the whole point of a
 * local-first board:
 *
 *   * a request from this machine is trusted — no token, no ceremony;
 *   * a request from anywhere else must present the access token, as
 *     `Authorization: Bearer <token>` or `?token=<token>` (the second form
 *     exists for `EventSource`, which cannot set headers — M6 uses it);
 *   * `token rotate` is loopback-only: a remote caller may *use* a token, never
 *     mint one.
 *
 * `test/server/auth.test.mjs` drives this over real HTTP for the loopback half
 * and with synthetic requests for the rest, because a test process cannot
 * genuinely arrive from a non-loopback address.
 */

import { timingSafeEqual } from "node:crypto";

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
 * @param {{req: object, url: URL, token: string|null, rotate?: boolean}} input
 * @returns {{ok: true, loopback: boolean}|{ok: false, status: number, payload: object}}
 */
export function authorize(input) {
  const { req, url, token, rotate = false } = input;
  const loopback = isLoopbackRequest(req);

  if (rotate && !loopback) {
    // Not a missing credential — a forbidden action. Say which, so a caller can
    // tell "rotate this locally" from "your token is wrong".
    return forbid(403, "rotating the board token is a loopback-only action", "loopback_only");
  }

  if (loopback) return { ok: true, loopback: true };

  const presented = presentedToken(req, url);
  if (presented === null) {
    return forbid(401, "this board requires an access token for non-local requests", "missing_token");
  }
  if (!sameSecret(presented, token ?? "")) {
    return forbid(401, "the access token is not valid for this board", "bad_token");
  }
  return { ok: true, loopback: false };
}

function forbid(status, message, reason) {
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
        hint:
          reason === "loopback_only"
            ? { fix: "run `taskctl token rotate` on the machine hosting the board" }
            : { fix: "pass --token <token>, or export TASKD_TOKEN from the board's data directory" },
      },
    },
  };
}
