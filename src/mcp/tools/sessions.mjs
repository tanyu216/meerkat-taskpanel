/**
 * The three agent-session tools — "which conversation was working on this card".
 *
 * `session_set` mirrors `taskctl session set` down to the deterministic id: the
 * natural key is `(task, owner, seg)`, so when the caller does not supply
 * `session_id` it is derived with `shared/ids.mjs` — the *same* function the CLI
 * uses. A resumed conversation therefore keeps its id whether it came back
 * through a terminal or through a host, which is the whole point of deriving it
 * rather than storing it.
 *
 * The task read only happens when a derivation is actually needed; a caller that
 * brings its own `session_id` costs one HTTP call, not two.
 */

import { sessionId as deriveSessionId } from "../../shared/ids.mjs";
import { input, integer, oneOf, string } from "./schema.mjs";

const ref = (value) => encodeURIComponent(value);

export const SESSION_TOOLS = [
  {
    name: "session_list",
    readOnly: true,
    description: "List the agent sessions registered against a task.",
    inputSchema: input({ ref: string("Task id or identifier (required).") }, ["ref"]),
    async handler(args, ctx) {
      const { sessions } = await ctx.client.get(`/api/v1/tasks/${ref(args.ref)}/sessions`);
      return { payload: { sessions } };
    },
  },

  {
    name: "session_set",
    readOnly: false,
    description:
      "Register or refresh an agent session for a task. session_id is derived from (task, owner, seg) when omitted, so a resumed conversation keeps the same id.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        seg: string("Segment name for this session (required)."),
        backend: string("The agent backend, e.g. claude or codex (required)."),
        owner: string("Who owns the session; defaults to this MCP agent."),
        phase: string("Free-form phase label, e.g. seg1-plan."),
        pid: integer("Process id, when the caller knows it."),
        session_id: string("Explicit session id; derived from (task, owner, seg) when omitted."),
      },
      ["ref", "seg", "backend"],
    ),
    async handler(args, ctx) {
      const owner = args.owner ?? ctx.actor.id;

      let sessionId = args.session_id;
      if (sessionId === undefined) {
        // The deterministic id is built from the *resolved* task id, so
        // `DEMO-0001` and its uuid must produce the same session.
        const { task } = await ctx.client.get(`/api/v1/tasks/${ref(args.ref)}`);
        sessionId = deriveSessionId(task.id, owner, args.seg);
      }

      const { session } = await ctx.client.post(`/api/v1/tasks/${ref(args.ref)}/sessions`, {
        seg: args.seg,
        owner,
        backend: args.backend,
        session_id: sessionId,
        phase: args.phase,
        pid: args.pid,
      });
      return { payload: { session } };
    },
  },

  {
    name: "session_close",
    readOnly: false,
    description: "Close an agent session as closed (the default) or failed.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        session_id: string("The session row id to close (required)."),
        status: oneOf(["closed", "failed"], "How the session ended; defaults to closed."),
      },
      ["ref", "session_id"],
    ),
    async handler(args, ctx) {
      const { session } = await ctx.client.post(
        `/api/v1/tasks/${ref(args.ref)}/sessions/${encodeURIComponent(args.session_id)}/close`,
        { status: args.status ?? "closed" },
      );
      return { payload: { session } };
    },
  },
];
