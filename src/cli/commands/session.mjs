/**
 * `session set|close|list` (A1) — the "which conversation was working on this
 * card" trail, and the resume key (§4.1).
 *
 * The session id is deterministic from `(task, owner, seg)`, so when
 * `--session-id` is omitted the CLI derives it: a resumed conversation keeps
 * its id without anybody having to remember it.
 */

import { sessionId as deriveSessionId } from "../../foundation/ids.mjs";
import { usageError } from "../../foundation/transport/errors.mjs";
import { table } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "set",
    summary: "Register (or refresh) an agent session for a task.",
    usage: "session set <id|identifier> --seg <seg> --owner-kind <name> [--owner <name>] [--phase <phase>] [--goal <text>] [--meta k=v]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "seg", key: "seg", as: "string", value: "<seg>", required: true },
      { flag: "owner-kind", key: "ownerKind", as: "string", value: "<name>", required: true, summary: "The owner's platform kind, e.g. claude, codex." },
      { flag: "owner", key: "owner", as: "string", value: "<name>" },
      { flag: "phase", key: "phase", as: "string", value: "<phase>" },
      { flag: "pid", key: "pid", as: "number", value: "<pid>" },
      { flag: "goal", key: "goal", as: "string", value: "<text>", summary: "One sentence: what this session is for." },
      {
        flag: "meta",
        key: "meta",
        as: "kv",
        summary: "Repeatable opaque metadata (harness, thread_id, log, …); a re-registration merges.",
      },
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
        owner_kind: ctx.flags.ownerKind,
        session_id: sessionId,
        phase: ctx.flags.phase,
        pid: ctx.flags.pid,
        goal: ctx.flags.goal,
        meta: ctx.flags.meta,
      });
      return { data: { session }, human: `session ${session.id} ${session.status} (seg ${session.seg}, owner ${session.owner})` };
    },
  },

  {
    name: "id",
    summary: "Derive the deterministic session id without registering a session.",
    usage: "session id <id|identifier> --seg <seg> [--owner <name>] [--session <task-id>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "seg", key: "seg", as: "string", value: "<seg>", required: true },
      { flag: "owner", key: "owner", as: "string", value: "<name>" },
      { flag: "session", key: "sessionRef", as: "string", value: "<task-id>", summary: "Task id used to derive the session id (defaults to the resolved one)." },
    ],
    async run(ctx) {
      // Read-only: the task is resolved, the id is derived, and nothing is
      // registered. The derivation itself is `session set`'s, so a caller can
      // pass this value to an agent and still land on the same row.
      if (typeof ctx.flags.seg !== "string" || ctx.flags.seg.trim() === "") {
        throw usageError("session id: --seg is required and must not be empty", {
          fix: "pass the segment name, e.g. --seg s1",
        });
      }
      const owner = ctx.flags.owner ?? ctx.actor.id;
      if (typeof owner !== "string" || owner.trim() === "") {
        throw usageError("session id: --owner must not be empty", { fix: "pass --owner <name>" });
      }
      const task = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`)).task;
      // `--session` replaces the task fed to the derivation, exactly as it does
      // for `session set`; `--session-id` is deliberately ignored — this command
      // answers "what does the board derive", not "what did you configure".
      const derivedFrom = ctx.flags.sessionRef ?? task.id;
      const sessionId = deriveSessionId(derivedFrom, owner, ctx.flags.seg);
      return {
        data: {
          session_id: sessionId,
          task_id: task.id,
          task_identifier: task.identifier,
          derived_from: derivedFrom,
          owner,
          seg: ctx.flags.seg,
        },
        // Bare on stdout so `SID=$(taskctl session id …)` works without jq.
        human: sessionId,
      };
    },
  },

  {
    name: "close",
    summary: "Close an agent session, by row id or by its (task, seg, owner) key.",
    usage: "session close <id|identifier> [<session-id>] [--seg <seg>] [--owner <name>] [--failed]",
    positionals: [
      { name: "ref", summary: "Task id or identifier." },
      { name: "sessionId", summary: "Session row id; omit when using --seg.", required: false },
    ],
    flags: [
      { flag: "seg", key: "seg", as: "string", value: "<seg>", summary: "Close the session named by this segment instead of a row id." },
      { flag: "owner", key: "owner", as: "string", value: "<name>", summary: "Owner for --seg (default: the acting actor)." },
      { flag: "failed", key: "failed", as: "boolean", summary: "Close as failed rather than closed." },
    ],
    async run(ctx) {
      const hasId = ctx.args.sessionId !== undefined;
      const hasSeg = ctx.flags.seg !== undefined;
      if (hasId === hasSeg) {
        throw usageError("session close: pass exactly one of <session-id> or --seg", {
          fix: "use `session close <ref> <session-id>` or `session close <ref> --seg <seg>`",
        });
      }
      if (ctx.flags.owner !== undefined && !hasSeg) {
        throw usageError("session close: --owner is only meaningful with --seg", {
          fix: "the row id already names one session",
        });
      }
      const status = ctx.flags.failed === true ? "failed" : "closed";
      const base = `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/sessions`;
      const { session } = hasId
        ? await ctx.client.post(`${base}/${encodeURIComponent(ctx.args.sessionId)}/close`, { status })
        : await ctx.client.post(`${base}/close`, { seg: ctx.flags.seg, owner: ctx.flags.owner, status });
      return { data: { session }, human: `session ${session.id} → ${session.status}` };
    },
  },

  {
    name: "list",
    summary: "List a task's agent sessions, or the board's sessions by owner/kind/status.",
    usage:
      "session list [<id|identifier>] [--owner <name>] [--owner-kind <kind>] " +
      "[--status running|closed|failed] [--limit <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier; omit for the board-wide read.", required: false }],
    flags: [
      { flag: "owner", key: "owner", as: "string", value: "<name>", summary: "Board-wide: exact owner." },
      { flag: "owner-kind", key: "ownerKind", as: "string", value: "<kind>", summary: "Board-wide: exact owner kind." },
      { flag: "status", key: "status", as: "string", value: "<status>", summary: "Board-wide: running|closed|failed." },
      { flag: "limit", key: "limit", as: "number", value: "<n>", summary: "Board-wide: newest first (default 200)." },
    ],
    async run(ctx) {
      const ref = ctx.args.ref;
      if (ref !== undefined) {
        const { sessions } = await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ref)}/sessions`);
        const human = sessions.length === 0
          ? "no sessions"
          : table(["id", "seg", "owner", "owner_kind", "status", "phase", "goal"], sessions.map((s) => [
              s.id,
              s.seg,
              s.owner,
              s.owner_kind,
              s.status,
              s.phase ?? "-",
              s.goal || "-",
            ]));
        return { data: { sessions }, human };
      }

      const filtered = ctx.flags.owner !== undefined
        || ctx.flags.ownerKind !== undefined
        || ctx.flags.status !== undefined;
      if (!filtered) {
        throw usageError("session list: pass a card ref, or --owner/--owner-kind/--status", {
          fix: "a board-wide read needs one filter; the per-card read is `session list <ref>`",
        });
      }
      const { sessions } = await ctx.client.get("/api/v1/sessions", {
        query: {
          owner: ctx.flags.owner,
          owner_kind: ctx.flags.ownerKind,
          status: ctx.flags.status,
          limit: ctx.flags.limit,
        },
      });
      const human = sessions.length === 0
        ? "no sessions"
        : table(["task", "id", "seg", "owner", "owner_kind", "status", "phase", "goal"], sessions.map((s) => [
            s.task_id,
            s.id,
            s.seg,
            s.owner,
            s.owner_kind,
            s.status,
            s.phase ?? "-",
            s.goal || "-",
          ]));
      return { data: { sessions }, human };
    },
  },
];
