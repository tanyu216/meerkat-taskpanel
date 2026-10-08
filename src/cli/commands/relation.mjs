/**
 * `relation add|remove|list` (A1).
 *
 * Relations are add/remove only — history stays readable (§4.1). For `parent`
 * the *source* is the parent and the target is the child, which is why the
 * command reads `relation add <parent-epic> --target <child>`.
 */

import { table } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "add",
    summary: "Add a relation: source is the task you name, target is --target.",
    usage: "relation add <id|identifier> --type <parent|blocks|related> --target <id|identifier>",
    positionals: [{ name: "ref", summary: "Source task (the parent, for `parent`)." }],
    flags: [
      { flag: "type", key: "type", as: "string", value: "<parent|blocks|related>", required: true },
      { flag: "target", key: "target", as: "string", value: "<id|identifier>", required: true },
      { flag: "force", key: "force", as: "boolean", summary: "Skip the app-layer parent checks (the database still guards)." },
    ],
    async run(ctx) {
      const { relation } = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/relations`,
        { type: ctx.flags.type, target: ctx.flags.target, force: ctx.flags.force === true },
      );
      return { data: { relation }, human: `related ${relation.source} --${relation.type}--> ${relation.target} (#${relation.id})` };
    },
  },

  {
    name: "remove",
    summary: "Remove a relation by its id.",
    usage: "relation remove <id|identifier> <relation-id>",
    positionals: [{ name: "ref", summary: "Either endpoint's task." }, { name: "relationId", summary: "The relation id." }],
    flags: [],
    async run(ctx) {
      const removed = await ctx.client.delete(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/relations/${ctx.args.relationId}`,
      );
      return { data: removed, human: `removed relation #${ctx.args.relationId}` };
    },
  },

  {
    name: "list",
    summary: "Show everything around a task: edges, children, ancestors, blockers.",
    usage: "relation list <id|identifier>",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [],
    async run(ctx) {
      const listing = await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/relations`);
      const rows = [
        ...listing.children.map((r) => ["child", r.target, `#${r.id}`]),
        ...listing.ancestors.map((r) => ["ancestor", r.source, `#${r.id}`]),
        ...listing.blocked_by.map((r) => ["blocked_by", r.source, `#${r.id}`]),
        ...listing.blocks.map((r) => ["blocks", r.target, `#${r.id}`]),
      ];
      return {
        data: listing,
        human: rows.length === 0 ? "no relations" : table(["role", "task", "relation"], rows),
      };
    },
  },
];
