/**
 * The two comment tools: append, and read.
 *
 * There is no update and no delete, and that is not an omission — `comments`
 * refuses UPDATE and DELETE at the database level (I4), so a tool that offered
 * either could only ever produce a 500. The tool surface stops exactly where the
 * service's does.
 */

import { input, integer, oneOf, string, stringArray } from "./schema.mjs";

/** The comment kinds `src/core/domain/enums.mjs` stores. */
const COMMENT_KINDS = ["discuss", "decision", "confirm", "change", "note", "defect"];

const ref = (value) => encodeURIComponent(value);

export const COMMENT_TOOLS = [
  {
    name: "task_comment_list",
    readOnly: true,
    description:
      "List a task's comments, oldest first. Filter by kind, cap the number returned, or ask only for those created after a timestamp.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        kind: oneOf(COMMENT_KINDS, "Only comments of this kind."),
        limit: integer("Maximum number of comments to return."),
        after: string("Only comments created after this ISO-8601 timestamp."),
      },
      ["ref"],
    ),
    async handler(args, ctx) {
      const { comments } = await ctx.client.get(`/api/v1/tasks/${ref(args.ref)}/comments`, {
        query: { kind: args.kind, limit: args.limit, after: args.after },
      });
      return { payload: { comments } };
    },
  },

  {
    name: "task_comment_add",
    readOnly: false,
    description:
      "Append a comment to a task. Comments are append-only: to correct one, post another. refs links the comment to other tasks or commits by id.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        body: string("The comment text (required)."),
        kind: oneOf(COMMENT_KINDS, "discuss, decision, confirm, change, note or defect."),
        refs: stringArray("References this comment points at (task ids, commit shas)."),
      },
      ["ref", "body"],
    ),
    async handler(args, ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${ref(args.ref)}/comments`, {
        body: args.body,
        kind: args.kind,
        refs: args.refs,
      });
      return { payload };
    },
  },
];
