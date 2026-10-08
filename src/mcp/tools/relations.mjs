/**
 * The three relation tools.
 *
 * `task_relation_add` takes the target as a **ref** (`DEMO-0003` or a uuid), not
 * as an internal id, because that is what a caller actually has. The service
 * resolves the same way the CLI does, so nothing is lost by not exposing ids.
 *
 * `force` is the escape hatch for a relation the dictionary-ish guards would
 * otherwise refuse; it is passed through untouched and never second-guessed
 * here — the rules (`SELF_REFERENCE`, `CROSS_PROJECT_RELATION`,
 * `RELATION_CYCLE`, `RELATION_DUPLICATE`) are the service's, and the parity test
 * between the trigger and the domain check is what keeps them honest.
 */

import { boolean, input, integer, oneOf, string } from "./schema.mjs";

/** `related` is stored with source < target; `parent`/`blocks` are directional. */
const RELATION_TYPES = ["parent", "blocks", "related"];

const ref = (value) => encodeURIComponent(value);

export const RELATION_TOOLS = [
  {
    name: "task_relation_list",
    readOnly: true,
    description:
      "List a task's relations, split by direction: its children, its ancestors, what blocks it and what it blocks.",
    inputSchema: input({ ref: string("Task id or identifier (required).") }, ["ref"]),
    async handler(args, ctx) {
      return { payload: await ctx.client.get(`/api/v1/tasks/${ref(args.ref)}/relations`) };
    },
  },

  {
    name: "task_relation_add",
    readOnly: false,
    description:
      "Relate two tasks, reading source to target: parent makes target a child of ref (and ref must be an epic), blocks says ref blocks target, related is symmetric.",
    inputSchema: input(
      {
        ref: string("The source task id or identifier (required)."),
        type: oneOf(RELATION_TYPES, "parent, blocks or related (required)."),
        target: string("The target task's id or identifier (required)."),
        force: boolean("Override the guards that would refuse this relation."),
      },
      ["ref", "type", "target"],
    ),
    async handler(args, ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${ref(args.ref)}/relations`, {
        type: args.type,
        target: args.target,
        force: args.force === true,
      });
      return { payload };
    },
  },

  {
    name: "task_relation_remove",
    readOnly: false,
    description:
      "Remove one relation by its relation id (as returned by task_relation_list). Relations are immutable, so changing one means remove and re-add.",
    inputSchema: input(
      {
        ref: string("Task id or identifier the relation belongs to (required)."),
        relation_id: integer("The relation row id (required)."),
      },
      ["ref", "relation_id"],
    ),
    async handler(args, ctx) {
      const payload = await ctx.client.delete(
        `/api/v1/tasks/${ref(args.ref)}/relations/${encodeURIComponent(String(args.relation_id))}`,
      );
      return { payload };
    },
  },
];
