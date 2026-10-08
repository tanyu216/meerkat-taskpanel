/**
 * `POST /api/v1/token` — rotate the board's access token.
 *
 * Loopback-only, and enforced in `auth.mjs` before the route runs: a remote
 * caller may *use* a token, never mint one. The refusal is a 403 with
 * `details.reason = "loopback_only"` rather than a new error code, because the
 * code table is a shared vocabulary and this is a policy detail (§F-F).
 *
 * The response deliberately does **not** carry the token: it names the file, and
 * a caller that is genuinely local (which is the only kind that can get here)
 * reads it. A secret never crosses the socket.
 */

import { rotateToken } from "../../core/index.mjs";

/** @param {object} router @param {{board: object, token: string|null}} surface */
export function registerTokenRoutes(router, surface) {
  const { board } = surface;

  router.post("/api/v1/token", () => {
    const rotated = rotateToken(board.dataDir);
    // Keep the in-process copy current so this same server accepts the new
    // token immediately (a non-loopback caller holding the old one is locked
    // out the moment it rotates — which is the point of rotating).
    surface.token = rotated.token;
    return { token_file: rotated.file, rotated: true };
  });
}
