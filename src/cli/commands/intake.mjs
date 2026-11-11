/**
 * `intake create|list|get|complete|fail` (0007).
 *
 * A human's free-text work description is submitted here (the web uses the same
 * route); the supervisor reads the pending queue through `list`, and the
 * decision lane answers with `complete` (the cards it filed) or `fail` (why it
 * could not). The CLI is an HTTP client — it never opens SQLite.
 *
 * `complete`/`fail` converge on a request that is already in that terminal
 * state: a retried answer returns the row that landed. A contradiction between
 * the two terminal states is the board's `INVALID_TRANSITION`, not a silent
 * overwrite.
 */

import { table } from "../output/human.mjs";

/** `--created a,b --created c` → `["a","b","c"]`. */
function createdRefs(value) {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** The one-line human read of a request. */
function requestLine(request) {
  const refs = request.created_refs?.length > 0 ? ` → ${request.created_refs.join(", ")}` : "";
  const error = request.last_error ? ` (${request.last_error})` : "";
  return `${request.id}  ${request.status}  ${request.project_id}${refs}${error}`;
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Submit a free-text work description for the decision lane.",
    usage: "intake create --project <id> --text <text> [--idem <key>]",
    positionals: [],
    flags: [
      { flag: "project", key: "project", as: "string", value: "<id>", required: true, summary: "The project the cards will belong to." },
      { flag: "text", key: "text", as: "string", value: "<text>", required: true, summary: "What should be true when the work is done." },
      { flag: "idem", key: "idem", as: "string", value: "<key>", summary: "Client idempotency key; a retried submit returns the first request." },
    ],
    async run(ctx) {
      const { request } = await ctx.client.post("/api/v1/intake", {
        project_id: ctx.flags.project,
        text: ctx.flags.text,
        idem: ctx.flags.idem,
      });
      return { data: { request }, human: `submitted ${requestLine(request)}` };
    },
  },
  {
    name: "list",
    summary: "List intake requests, oldest first.",
    usage: "intake list [--status <status>] [--project <id>] [--limit <n>]",
    positionals: [],
    flags: [
      { flag: "status", key: "status", as: "string", value: "<status>", summary: "pending|consumed|failed." },
      { flag: "project", key: "project", as: "string", value: "<id>" },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      const { requests } = await ctx.client.get("/api/v1/intake", {
        query: {
          status: ctx.flags.status,
          project_id: ctx.flags.project,
          limit: ctx.flags.limit,
        },
      });
      const human =
        requests.length === 0
          ? "no intake requests"
          : table(["id", "status", "project", "created_at"], requests.map((request) => [
              request.id,
              request.status,
              request.project_id,
              request.created_at,
            ]));
      return { data: { requests }, human };
    },
  },
  {
    name: "get",
    summary: "Read one intake request.",
    usage: "intake get <id>",
    positionals: [{ name: "id" }],
    flags: [],
    async run(ctx) {
      const { request } = await ctx.client.get(`/api/v1/intake/${encodeURIComponent(ctx.args.id)}`);
      return { data: { request }, human: requestLine(request) };
    },
  },
  {
    name: "complete",
    summary: "Record the cards a request produced.",
    usage: "intake complete <id> --created <ref> [--created <ref>]…",
    positionals: [{ name: "id" }],
    flags: [
      { flag: "created", key: "created", as: "string", value: "<ref>", repeat: true, required: true, summary: "Created card identifier; repeatable, also accepts a comma-separated list." },
    ],
    async run(ctx) {
      const { request } = await ctx.client.post(
        `/api/v1/intake/${encodeURIComponent(ctx.args.id)}/complete`,
        { created: createdRefs(ctx.flags.created) },
      );
      return { data: { request }, human: `completed ${requestLine(request)}` };
    },
  },
  {
    name: "fail",
    summary: "Record that a request could not become work.",
    usage: "intake fail <id> --reason <text>",
    positionals: [{ name: "id" }],
    flags: [
      { flag: "reason", key: "reason", as: "string", value: "<text>", required: true, summary: "Why the description could not be turned into cards." },
    ],
    async run(ctx) {
      const { request } = await ctx.client.post(
        `/api/v1/intake/${encodeURIComponent(ctx.args.id)}/fail`,
        { reason: ctx.flags.reason },
      );
      return { data: { request }, human: `failed ${requestLine(request)}` };
    },
  },
];
