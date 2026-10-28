/**
 * `comment list|add` (A1).
 *
 * Comments are append-only at the database level, so there is no edit and no
 * delete here — and `kind` matters: `decision`, `confirm` and `change` are what
 * a human uses to put something on the record, and a reviewer reads them.
 */

import { usageError } from "../../foundation/transport/errors.mjs";
import { table } from "../output/human.mjs";

const KINDS = ["discuss", "decision", "confirm", "confirm_request", "change", "note", "defect", "question"];

export const COMMANDS = [
  {
    name: "list",
    summary: "List a task's comments, newest first.",
    usage: "comment list <id|identifier> [--kind <kind>] [--limit <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "kind", key: "kind", as: "string", value: "<kind>", summary: KINDS.join("|") },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      // `order=desc` makes `--limit` mean "the newest N" and gives the table
      // and `--json` the same newest-first order the drawer shows.
      const { comments } = await ctx.client.get(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/comments`,
        { query: { kind: ctx.flags.kind, limit: ctx.flags.limit, order: "desc" } },
      );
      const human = comments.length === 0
        ? "no comments"
        : table(["created_at", "kind", "author", "body"], comments.map((c) => [
            c.created_at,
            c.kind,
            // The author column names the author, not the id: `author_id` is an
            // actor id since 0020, and the wire's `author` ref carries the
            // readable `display_name` beside it (the id stands in only when the
            // ref is absent — a board-less projection).
            `${c.author?.display_name ?? c.author_id} (${c.author?.kind ?? c.author_kind})`,
            c.body.length > 60 ? `${c.body.slice(0, 57)}...` : c.body,
          ]));
      return { data: { comments }, human };
    },
  },

  {
    name: "add",
    summary: "Append a comment.",
    usage:
      "comment add <id|identifier> (--body <text> | --file <path|->) [--kind <kind>] [--ref <kind:id>]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "body", key: "body", as: "string", value: "<text>", summary: "The comment text; or use --file." },
      { flag: "kind", key: "kind", as: "string", value: "<kind>", summary: `${KINDS.join("|")} (default: note)` },
      { flag: "file", key: "file", as: "string", value: "<path|->", summary: "Read the body from a file or stdin." },
      {
        flag: "ref",
        key: "refs",
        as: "string",
        value: "<kind:id>",
        repeat: true,
        summary: "Attach a reference (repeatable); the wire stores it as a plain string.",
      },
    ],
    async run(ctx) {
      // Two ways to name one value. `--file` wins when both are given (the
      // long-standing precedence); neither is the one refusal worth making
      // explicit, because the request would otherwise carry an empty body.
      if (ctx.flags.body === undefined && ctx.flags.file === undefined) {
        throw usageError("comment add needs --body or --file", {
          hint: { fix: "pass --body <text>, or --file <path|-> to read it" },
        });
      }
      const body = ctx.flags.file === undefined
        ? ctx.flags.body
        : ctx.flags.file === "-"
          ? await ctx.readStdin()
          : await ctx.readFile(ctx.flags.file);
      const { comment } = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/comments`,
        { body, kind: ctx.flags.kind, refs: ctx.flags.refs },
      );
      return { data: { comment }, human: `commented on ${ctx.args.ref} (${comment.kind})` };
    },
  },
];
