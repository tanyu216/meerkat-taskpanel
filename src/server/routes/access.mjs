/**
 * `GET|PUT /api/v1/access` — the board's access policy and token.
 *
 * Both verbs are **loopback-only** (enforced in `auth.mjs` before the handler
 * runs): the read answers with the bearer token, so it is the same trust domain
 * as the token file, and a remote caller that merely holds a valid token must
 * not be able to widen the allow-list or rotate the credential.
 *
 * The policy is server configuration, not board data: `PUT` writes
 * `<dataDir>/taskd.env` (see `access-config.mjs`) and swaps the in-memory policy
 * the next request is judged against. `rotate_token: true` rotates the token in
 * the same save, so the panel has one Save for every pending edit — including a
 * Reset the reader has not confirmed yet.
 *
 * The token is returned in clear on the read **on purpose**: the Access panel
 * shows the persisted credential, and a refresh must show the same one. It never
 * crosses a socket off this machine.
 */

import { rotateToken } from "../../core/index.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { validateCidrs, writeAccessConfig } from "../access-config.mjs";
import { arr, bool, shape, str } from "../requests.mjs";

/** `PUT /api/v1/access`. */
const SAVE_BODY = shape(
  {
    allow_list: shape({ enabled: bool(), cidrs: arr(str()) }, ["enabled", "cidrs"]),
    /** Rotate the token as part of the same save (the panel's pending Reset). */
    rotate_token: bool(),
  },
  ["allow_list"],
);

/** @param {object} surface */
function snapshot(surface) {
  const config = surface.access.get();
  return {
    token: surface.token,
    token_file: surface.board.token?.file ?? null,
    // `null` when the process environment owns the policy — there is no file
    // this panel could have written.
    config_file: config.file ?? null,
    allow_list: { enabled: config.enabled, cidrs: [...config.cidrs] },
    // `env` means the process environment owns the policy and the panel must not
    // pretend a save would stick; `file` is this panel's last save; `default`
    // means nothing has been saved yet.
    source: config.source,
  };
}

/** @param {object} router @param {{board: object, token: string|null, access: object}} surface */
export function registerAccessRoutes(router, surface) {
  router.get("/api/v1/access", () => snapshot(surface));

  router.put(
    "/api/v1/access",
    ({ body }) => {
      const current = surface.access.get();
      if (current.source === "env") {
        throw new DomainError("VALIDATION_FAILED", {
          message: "the allow-list is managed by the process environment; change the service configuration instead",
          details: { reason: "env_managed" },
        });
      }

      const input = body.allow_list;
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "allow_list must be an object",
          details: { field: "allow_list" },
        });
      }
      if (typeof input.enabled !== "boolean") {
        throw new DomainError("VALIDATION_FAILED", {
          message: "allow_list.enabled must be a boolean",
          details: { field: "allow_list.enabled" },
        });
      }
      const cidrs = validateCidrs(input.cidrs);

      const saved = writeAccessConfig({
        dataDir: surface.board.dataDir,
        enabled: input.enabled,
        cidrs,
      });
      surface.access.set(saved);

      let rotated = false;
      if (body.rotate_token === true) {
        const next = rotateToken(surface.board.dataDir);
        // Keep this process accepting the new token immediately.
        surface.token = next.token;
        rotated = true;
      }

      return { ...snapshot(surface), rotated };
    },
    { body: SAVE_BODY },
  );
}
