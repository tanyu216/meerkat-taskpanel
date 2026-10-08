/**
 * `comment list|add` (A1).
 *
 * Comments are append-only at the database level, so there is no edit and no
 * delete here — and `kind` matters: `decision`, `confirm` and `change` are what
 * a human uses to put something on the record, and a reviewer reads them.
 */

import { table } from "../output/human.mjs";

const KINDS = ["discuss", "decision", "confirm", "change", "note", "defect"];

export const COMMANDS = [
  {
    name: "list",
    summary: "List a task's comments, oldest first.",
    usage: "comment list <id|identifier> [--kind <kind>] [--limit <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "kind", key: "kind", as: "string", value: "<kind>", summary: KINDS.join("|") },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      const { comments } = await ctx.client.get(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/comments`,
        { query: { kind: ctx.flags.kind, limit: ctx.flags.limit } },
      );
      const human = comments.length === 0
        ? "no comments"
        : table(["created_at", "kind", "author", "body"], comments.map((c) => [
            c.created_at,
            c.kind,
            `${c.author_id} (${c.author_kind})`,
            c.body.length > 60 ? `${c.body.slice(0, 57)}...` : c.body,
          ]));
      return { data: { comments }, human };
    },
  },

  {
    name: "add",
    summary: "Append a comment.",
    usage: "comment add <id|identifier> --body <text> [--kind <kind>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "body", key: "body", as: "string", value: "<text>", required: true },
      { flag: "kind", key: "kind", as: "string", value: "<kind>", summary: `${KINDS.join("|")} (default: discuss)` },
      { flag: "file", key: "file", as: "string", value: "<path|->", summary: "Read the body from a file or stdin." },
    ],
    async run(ctx) {
      const body = ctx.flags.file === undefined
        ? ctx.flags.body
        : ctx.flags.file === "-"
          ? await ctx.readStdin()
          : await ctx.readFile(ctx.flags.file);
      const { comment } = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/comments`,
        { body, kind: ctx.flags.kind },
      );
      return { data: { comment }, human: `commented on ${ctx.args.ref} (${comment.kind})` };
    },
  },
];
