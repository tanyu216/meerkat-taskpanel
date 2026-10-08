/**
 * `token rotate` (§7.1, §F-F1).
 *
 * The service refuses this from anywhere but loopback (403, `loopback_only`), so
 * by the time a rotation succeeds the caller is on the machine that owns the
 * file — which is why the CLI can read the new token from disk rather than have
 * the service send it. A secret never crosses the socket.
 *
 * Output is redacted by default: `td_****`, plus where the token lives.
 * `--show` prints the value, and says so, because the one thing worse than not
 * showing it is showing it by accident.
 */

import { readFileSync } from "node:fs";

import { REDACTED_TOKEN } from "../../shared/redact.mjs";
import { fields } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "rotate",
    summary: "Rotate the board's access token (loopback only).",
    usage: "token rotate [--show]",
    positionals: [],
    flags: [{ flag: "show", key: "show", as: "boolean", summary: "Print the new token in clear text." }],
    async run(ctx) {
      const result = await ctx.client.post("/api/v1/token", {});
      const tokenFile = result.token_file;
      const token = typeof tokenFile === "string" ? readFileSync(tokenFile, "utf8").trim() : null;
      const human = fields([
        ["rotated", tokenFile],
        ["token", ctx.flags.show === true ? token : REDACTED_TOKEN],
        ...(ctx.flags.show === true ? [["warning", "the line above is a secret — do not paste it anywhere"]] : []),
      ]);
      return {
        data: { token_file: tokenFile, rotated: true, token: ctx.flags.show === true ? token : null },
        human,
        // The one command that may print a secret, and only when asked.
        allowSecrets: ctx.flags.show === true,
      };
    },
  },
];
