/**
 * `issue create|list|get|update|move|assign|archive|deliver` (A1–A5).
 *
 * This module owns the two commands the milestone is really about:
 *
 *   `issue deliver <id> --report-file -`  write the report and enter review, atomically
 *   `issue move <id> in_review`           the gate, and the command that fixes it
 *
 * `deliver` is the *short* path on purpose. The report JSON is the only thing
 * the caller has to produce, and `report template` produces a working one — the
 * goal of the milestone is that the compliant route is also the easiest one.
 *
 * Everything here is a thin client of the HTTP surface: no policy is re-decided
 * in the CLI, so the refusal a user sees is the one the service raised.
 */

import { usageError } from "../../shared/transport/errors.mjs";
import { fields, table, taskLine } from "../output/human.mjs";
import { parseReport } from "./report.mjs";

/** `--meta k=v` repeated → object. */
const metaOf = (flags) => flags.meta;

/** The task payload the service returns is `{task, report_waivers}`. */
function taskHuman(task, extra) {
  return fields([
    ["identifier", task.identifier],
    ["status", task.status],
    ["priority", task.priority],
    ["kind", task.kind],
    ["assignee", task.assignee === null ? "-" : `${task.assignee.display_name}#${task.assignee.id}`],
    ["reporter", task.reporter === null ? "-" : `${task.reporter.display_name}#${task.reporter.id}`],
    ["delivery_round", task.delivery_round],
    ["version", task.version],
    ...extra,
  ]);
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a task.",
    usage: "issue create --project <id> --title <text> [--assignee <name>]",
    positionals: [],
    flags: [
      { flag: "project", key: "project", as: "string", value: "<id>", required: true },
      { flag: "title", key: "title", as: "string", value: "<text>", required: true },
      { flag: "description", key: "description", as: "string", value: "<text>" },
      { flag: "status", key: "status", as: "string", value: "<status>" },
      { flag: "priority", key: "priority", as: "string", value: "<low|medium|high|urgent>" },
      { flag: "kind", key: "kind", as: "string", value: "<task|epic>" },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "meta", key: "meta", as: "kv" },
      { flag: "acceptance", key: "acceptance", as: "string", value: "<text>", repeat: true, summary: "Acceptance criterion; repeatable." },
      { flag: "assignee", key: "assignee", as: "string", value: "<text>", summary: "Free text; resolved against the dictionary." },
      { flag: "assignee-kind", key: "assigneeKind", as: "string", value: "<agent|human>" },
      { flag: "assignee-id", key: "assigneeId", as: "string", value: "<id>" },
      { flag: "reporter", key: "reporter", as: "string", value: "<text>" },
      { flag: "reporter-kind", key: "reporterKind", as: "string", value: "<agent|human>" },
      { flag: "reporter-id", key: "reporterId", as: "string", value: "<id>" },
      { flag: "force-create", key: "forceCreate", as: "boolean", summary: "Skip dictionary fuzzy matching." },
      { flag: "idem", key: "idem", as: "string", value: "<key>", summary: "Explicit idempotency key; a match re-uses the existing task." },
      { flag: "allow-dup", key: "allowDup", as: "boolean", summary: "Bypass the idempotency guard and create a duplicate anyway." },
      { flag: "target", key: "target", as: "string", value: "<t>", summary: "Idempotency key's target slot." },
      { flag: "review-of", key: "reviewOf", as: "string", value: "<id>", summary: "Idempotency key's source slot (a card under review)." },
      { flag: "parent", key: "parent", as: "string", value: "<id>", summary: "Idempotency key's source slot (a parent card)." },
    ],
    async run(ctx) {
      const flags = ctx.flags;
      const meta = { ...(metaOf(flags) ?? {}) };
      if (flags.acceptance !== undefined) meta.acceptance = flags.acceptance;
      const payload = await ctx.client.post("/api/v1/tasks", {
        project_id: flags.project,
        title: flags.title,
        description: flags.description,
        status: flags.status,
        priority: flags.priority,
        kind: flags.kind,
        labels: flags.labels,
        meta: Object.keys(meta).length === 0 ? undefined : meta,
        assignee: flags.assignee,
        assignee_kind: flags.assigneeKind,
        assignee_id: flags.assigneeId,
        reporter: flags.reporter,
        reporter_kind: flags.reporterKind,
        reporter_id: flags.reporterId,
        force_create: flags.forceCreate === true,
        idem: flags.idem,
        allow_dup: flags.allowDup === true,
        target: flags.target,
        review_of: flags.reviewOf,
        parent: flags.parent,
      });
      return { data: payload, human: `created ${payload.task.identifier}  ${payload.task.title}` };
    },
  },

  {
    name: "list",
    summary: "List tasks.",
    usage: "issue list [--project <id>] [--status <status>]… [--limit <n>]",
    positionals: [],
    flags: [
      { flag: "project", key: "project", as: "string", value: "<id>" },
      { flag: "status", key: "statuses", as: "string", value: "<status>", repeat: true },
      { flag: "assignee-id", key: "assigneeId", as: "string", value: "<id>" },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
      { flag: "include-archived", key: "includeArchived", as: "boolean" },
    ],
    async run(ctx) {
      const { tasks } = await ctx.client.get("/api/v1/tasks", {
        query: {
          project_id: ctx.flags.project,
          status: ctx.flags.statuses,
          assignee_id: ctx.flags.assigneeId,
          limit: ctx.flags.limit,
          include_archived: ctx.flags.includeArchived === true ? "1" : undefined,
        },
      });
      const human = tasks.length === 0
        ? "no tasks"
        : table(["identifier", "status", "priority", "assignee", "reporter"], tasks.map((task) => [
            task.identifier,
            task.status,
            task.priority,
            task.assignee === null ? "-" : `${task.assignee.display_name}#${task.assignee.id}`,
            task.reporter === null ? "-" : `${task.reporter.display_name}#${task.reporter.id}`,
          ]));
      return { data: { tasks }, human };
    },
  },

  {
    name: "get",
    summary: "Show one task (by id or identifier).",
    usage: "issue get <id|identifier>",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [],
    async run(ctx) {
      const payload = await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`);
      const task = payload.task;
      const extra = [];
      if (task.report_waiver !== null) {
        extra.push(["waiver", `round ${task.report_waiver.round}: ${task.report_waiver.reason}`]);
      }
      if (payload.report_waivers.length > 0) {
        extra.push(["waivers", `${payload.report_waivers.length} on record`]);
      }
      return { data: payload, human: taskHuman(task, extra) };
    },
  },

  {
    name: "update",
    summary: "Update a task's title, priority, labels, metadata or acceptance list.",
    usage: "issue update <id|identifier> [--title <text>] [--acceptance <text>]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "title", key: "title", as: "string", value: "<text>" },
      { flag: "description", key: "description", as: "string", value: "<text>" },
      { flag: "priority", key: "priority", as: "string", value: "<priority>" },
      { flag: "kind", key: "kind", as: "string", value: "<task|epic>" },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "meta", key: "meta", as: "kv" },
      { flag: "acceptance", key: "acceptance", as: "string", value: "<text>", repeat: true },
    ],
    async run(ctx) {
      const flags = ctx.flags;
      const body = {};
      for (const key of ["title", "description", "priority", "kind"]) {
        if (flags[key] !== undefined) body[key] = flags[key];
      }
      if (flags.labels !== undefined) body.labels = flags.labels;
      if (metaOf(flags) !== undefined) body.meta = metaOf(flags);
      if (flags.acceptance !== undefined) body.acceptance = flags.acceptance;
      if (Object.keys(body).length === 0) {
        // Refuse locally: a round trip that changes nothing is never what was meant.
        return {
          data: null,
          human: "",
          warnings: ["nothing to update: pass at least one of --title/--description/--priority/--kind/--label/--meta/--acceptance"],
        };
      }
      const payload = await ctx.client.patch(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`, body);
      return { data: payload, human: `updated ${payload.task.identifier}` };
    },
  },

  {
    name: "move",
    summary: "Move a task to another status (this is where the delivery gate bites).",
    usage: 'issue move <id|identifier> <status> [--no-report --reason "<why>"]',
    positionals: [
      { name: "ref", summary: "Task id or identifier." },
      { name: "to", summary: "Target status." },
    ],
    flags: [
      { flag: "no-report", key: "noReport", as: "boolean", summary: "Waive the report for this round (needs --reason)." },
      { flag: "reason", key: "reason", as: "string", value: "<why>", summary: "Why this delivery is audited without a report." },
    ],
    async run(ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/move`, {
        to: ctx.args.to,
        if_version: ctx.flags.ifVersion,
        no_report: ctx.flags.noReport === true,
        reason: ctx.flags.reason,
      });
      const warnings = payload.task.report_waiver === null
        ? []
        : [`delivered without a report; recorded as report_waived round ${payload.task.report_waiver.round}`];
      const human = payload.task.report_waiver === null
        ? `moved ${payload.task.identifier} → ${payload.task.status}`
        : `moved ${payload.task.identifier} → ${payload.task.status} (waived, round ${payload.task.report_waiver.round})`;
      return { data: payload, human, warnings };
    },
  },

  {
    name: "assign",
    summary: "Assign (or reassign) a task's assignee and reporter.",
    usage: "issue assign <id|identifier> [--assignee <text>] [--reporter <text>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "assignee", key: "assignee", as: "string", value: "<text>" },
      { flag: "assignee-id", key: "assigneeId", as: "string", value: "<id>" },
      { flag: "reporter", key: "reporter", as: "string", value: "<text>" },
      { flag: "reporter-id", key: "reporterId", as: "string", value: "<id>" },
      { flag: "force-create", key: "forceCreate", as: "boolean" },
    ],
    async run(ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/assign`, {
        assignee: ctx.flags.assignee,
        assignee_id: ctx.flags.assigneeId,
        reporter: ctx.flags.reporter,
        reporter_id: ctx.flags.reporterId,
        force_create: ctx.flags.forceCreate === true,
      });
      const task = payload.task;
      return {
        data: payload,
        human: `assigned ${task.identifier}  ${taskLine(task)}`,
      };
    },
  },

  {
    name: "archive",
    summary: "Archive a finished task (done/canceled, after the waiting window).",
    usage: "issue archive <id|identifier> [--days <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [{ flag: "days", key: "days", as: "number", value: "<n>", summary: "Override the 7-day window." }],
    async run(ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/archive`, {
        if_version: ctx.flags.ifVersion,
        days: ctx.flags.days,
      });
      return { data: payload, human: `archived ${payload.task.identifier} (${payload.task.status})` };
    },
  },

  {
    name: "deliver",
    summary: "Write a report and move to in_review, atomically. The compliant path.",
    usage: "issue deliver <id|identifier> --report-file <file|-> [--no-report --reason <why>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "report-file", key: "reportFile", as: "string", value: "<file|->", summary: "Report JSON, or `-` for stdin." },
      { flag: "no-report", key: "noReport", as: "boolean", summary: "Waive the report for this round (needs --reason)." },
      { flag: "reason", key: "reason", as: "string", value: "<why>" },
      { flag: "seg", key: "seg", as: "string", value: "<seg>" },
    ],
    async run(ctx) {
      const flags = ctx.flags;
      const waived = flags.noReport === true;

      // Both refusals happen *here* rather than at the server, so the message
      // names the two flags the user actually typed.
      if (waived && flags.reportFile !== undefined) {
        throw usageError("issue deliver: --no-report and --report-file are mutually exclusive", {
          fix: "send a report, or waive it with a reason — not both",
        });
      }
      if (!waived && flags.reportFile === undefined) {
        throw usageError("issue deliver: --report-file <file|-> is required (or --no-report --reason <why>)", {
          fix: "taskctl issue deliver <id> --report-file -",
        });
      }

      let report = null;
      const warnings = [];
      if (!waived) {
        const raw = flags.reportFile === "-" ? await ctx.readStdin() : await ctx.readFile(flags.reportFile);
        report = parseReport(raw);
        if (typeof report.leftovers === "string" && report.leftovers.includes("TODO:")) {
          warnings.push("delivering a template that still contains TODO placeholders");
        }
        // The author is whoever is running the command, unless the report says.
        // `== null` on purpose: that is both `undefined` and `null`, and the
        // distinction carries no meaning here.
        if (report.author == null) report.author = ctx.actor;
      }

      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/deliver`, {
        report,
        if_version: flags.ifVersion,
        no_report: waived,
        reason: flags.reason,
        seg: flags.seg,
        session_id: flags.sessionId,
      });
      if (payload.waived) {
        warnings.push(`delivering without a report; recorded as report_waived (round ${payload.round})`);
      }
      const human = payload.waived
        ? `delivered ${payload.task.identifier} → ${payload.task.status} (waived, round ${payload.round})`
        : `delivered ${payload.task.identifier} → ${payload.task.status} (report #${payload.report_id}, round ${payload.round})`;
      return { data: payload, human, warnings };
    },
  },
];
