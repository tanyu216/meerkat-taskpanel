/**
 * `session set|close|list` (A1) — the "which conversation was working on this
 * card" trail, and the resume key (§4.1).
 *
 * The session id is deterministic from `(task, owner, seg)`, so when
 * `--session-id` is omitted the CLI derives it: a resumed conversation keeps
 * its id without anybody having to remember it.
 */

import { sessionId as deriveSessionId } from "../../shared/ids.mjs";
import { table } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "set",
    summary: "Register (or refresh) an agent session for a task.",
    usage: "session set <id|identifier> --seg <seg> --backend <name> [--owner <name>] [--phase <phase>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "seg", key: "seg", as: "string", value: "<seg>", required: true },
      { flag: "backend", key: "backend", as: "string", value: "<name>", required: true, summary: "e.g. claude, codex." },
      { flag: "owner", key: "owner", as: "string", value: "<name>" },
      { flag: "phase", key: "phase", as: "string", value: "<phase>" },
      { flag: "pid", key: "pid", as: "number", value: "<pid>" },
      { flag: "session", key: "sessionRef", as: "string", value: "<task-id>", summary: "Task id used to derive the session id (defaults to the resolved one)." },
    ],
    async run(ctx) {
      // The deterministic id needs the *resolved* task id, so the task is read
      // first — `PROJ-0001` and its uuid must produce the same session.
      const task = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`)).task;
      const owner = ctx.flags.owner ?? ctx.actor.id;
      const sessionId = ctx.flags.sessionId ?? deriveSessionId(ctx.flags.sessionRef ?? task.id, owner, ctx.flags.seg);
      const { session } = await ctx.client.post(`/api/v1/tasks/${task.identifier}/sessions`, {
        seg: ctx.flags.seg,
        owner,
        backend: ctx.flags.backend,
        session_id: sessionId,
        phase: ctx.flags.phase,
        pid: ctx.flags.pid,
      });
      return { data: { session }, human: `session ${session.id} ${session.status} (seg ${session.seg}, owner ${session.owner})` };
    },
  },

  {
    name: "close",
    summary: "Close an agent session.",
    usage: "session close <id|identifier> <session-id> [--failed]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }, { name: "sessionId", summary: "Session row id." }],
    flags: [{ flag: "failed", key: "failed", as: "boolean", summary: "Close as failed rather than closed." }],
    async run(ctx) {
      const { session } = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/sessions/${encodeURIComponent(ctx.args.sessionId)}/close`,
        { status: ctx.flags.failed === true ? "failed" : "closed" },
      );
      return { data: { session }, human: `session ${session.id} → ${session.status}` };
    },
  },

  {
    name: "list",
    summary: "List a task's agent sessions.",
    usage: "session list <id|identifier>",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [],
    async run(ctx) {
      const { sessions } = await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/sessions`);
      const human = sessions.length === 0
        ? "no sessions"
        : table(["id", "seg", "owner", "backend", "status", "phase"], sessions.map((s) => [
            s.id,
            s.seg,
            s.owner,
            s.backend,
            s.status,
            s.phase ?? "-",
          ]));
      return { data: { sessions }, human };
    },
  },
];
