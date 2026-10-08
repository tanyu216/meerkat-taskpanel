/**
 * The six task tools — including the two the milestone turns on:
 *
 *   `task_move`     the delivery gate, visible and unbypassable
 *   `task_deliver`  the atomic "write the report and enter review"
 *
 * Each handler is a *projection* and nothing more: tool arguments in, one HTTP
 * call out, the service's answer back. No handler decides anything. In
 * particular `task_move` does not check whether a report exists — there is
 * exactly one place in this process that could make that judgement and it does
 * not exist, which is what makes acceptance criterion #3 true by construction
 * rather than by discipline.
 *
 * Two consequences of that stance are load-bearing and easy to get wrong:
 *
 *   * `task_move`'s schema has **no `no_report`/`reason`**. The card makes
 *     `task_deliver` the only tool that may reach `in_review`, so the audited
 *     waiver is expressible only there. `task_move → in_review` therefore fails
 *     with `REPORT_REQUIRED` every time — one branch, no exceptions.
 *   * `task_deliver` replicates the CLI's two *local* refusals (no report and no
 *     waiver; or both), because those are usage errors about the request the
 *     caller typed, not policy about the board. They are `-32602`, not
 *     `isError` — nothing ran. The waiver's *content* (a reason of at least 8
 *     characters) is left to the service, which already has the rule.
 *
 * `acceptance` is folded into `meta.acceptance` on create, exactly as
 * `taskctl issue create --acceptance` does: the service has one home for the
 * list, and a tool that invented a second body field would be a second meaning.
 */

import { reportWarnings } from "../../shared/report-warning.mjs";
import { invalidParams } from "../result.mjs";
import { boolean, input, integer, object, oneOf, string, stringArray } from "./schema.mjs";

/** The seven canonical statuses (`src/core/domain/enums.mjs`). */
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const KINDS = ["task", "epic"];

/** Every task route is addressed by id-or-identifier, which may need escaping. */
const ref = (value) => encodeURIComponent(value);

/** Copy only the keys the caller actually sent — `undefined` is "not mentioned". */
function present(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

export const TASK_TOOLS = [
  {
    name: "task_list",
    readOnly: true,
    description:
      "List tasks from the board, optionally filtered by project, status or assignee. Archived tasks are excluded unless include_archived is true.",
    inputSchema: input(
      {
        project_id: string("Restrict to one project id."),
        status: {
          description: "One status, or several (a task matches any of them).",
          anyOf: [
            { type: "string", enum: STATUSES },
            { type: "array", items: { type: "string", enum: STATUSES } },
          ],
        },
        assignee_id: string("Restrict to one assignee id."),
        limit: integer("Maximum number of tasks to return."),
        include_archived: boolean("Include archived tasks (default false)."),
      },
      [],
    ),
    async handler(args, ctx) {
      const { tasks } = await ctx.client.get("/api/v1/tasks", {
        query: {
          project_id: args.project_id,
          status: args.status,
          assignee_id: args.assignee_id,
          limit: args.limit,
          include_archived: args.include_archived,
        },
      });
      return { payload: { tasks } };
    },
  },

  {
    name: "task_get",
    readOnly: true,
    description:
      "Read one task by id or identifier, with its report waivers. This is the read that shows the current delivery round and status.",
    inputSchema: input({ ref: string("Task id (uuid) or human identifier, e.g. DEMO-0001.") }, ["ref"]),
    async handler(args, ctx) {
      return { payload: await ctx.client.get(`/api/v1/tasks/${ref(args.ref)}`) };
    },
  },

  {
    name: "task_create",
    readOnly: false,
    description:
      "Create a task in a project. Returns the created task, including its generated identifier. Use force_create to skip dictionary fuzzy matching on assignee/reporter.",
    inputSchema: input(
      {
        project_id: string("Project the task belongs to (required)."),
        title: string("One-line title (required)."),
        description: string("Longer description."),
        status: oneOf(STATUSES, "Initial status (defaults to todo). in_review and done are refused at creation: a task must deliver a report before it can enter review."),
        priority: oneOf(PRIORITIES, "Priority."),
        kind: oneOf(KINDS, "task, or epic for a grouping card."),
        labels: stringArray("Label names; unknown ones are created in the project."),
        meta: object("Free-form metadata object."),
        acceptance: stringArray("Acceptance criteria; stored as meta.acceptance."),
        assignee: string("Assignee by name; resolved against the dictionary."),
        assignee_kind: oneOf(["agent", "human"], "Kind to record when creating a new assignee."),
        assignee_id: string("Assignee by dictionary id — bypasses name resolution."),
        reporter: string("Reporter by name; resolved against the dictionary."),
        reporter_kind: oneOf(["agent", "human"], "Kind to record when creating a new reporter."),
        reporter_id: string("Reporter by dictionary id."),
        force_create: boolean("Skip fuzzy dictionary matching and create the entry as given."),
      },
      ["project_id", "title"],
    ),
    async handler(args, ctx) {
      const meta = { ...(args.meta ?? {}) };
      if (args.acceptance !== undefined) meta.acceptance = args.acceptance;

      const body = present(args, [
        "project_id",
        "title",
        "description",
        "status",
        "priority",
        "kind",
        "labels",
        "assignee",
        "assignee_kind",
        "assignee_id",
        "reporter",
        "reporter_kind",
        "reporter_id",
      ]);
      if (Object.keys(meta).length > 0) body.meta = meta;
      if (args.force_create !== undefined) body.force_create = args.force_create === true;

      return { payload: await ctx.client.post("/api/v1/tasks", body) };
    },
  },

  {
    name: "task_update",
    readOnly: false,
    description:
      "Update a task's title, description, priority, kind, labels, metadata or acceptance list. Status is not patchable: use task_move or task_deliver. meta merges into what the task already carries.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        title: string("New title."),
        description: string("New description."),
        priority: oneOf(PRIORITIES, "New priority."),
        kind: oneOf(KINDS, "New kind."),
        labels: stringArray("Replacement label list."),
        meta: object("Metadata to merge into the task's existing meta."),
        acceptance: stringArray("Replacement acceptance list (stored as meta.acceptance)."),
        if_version: integer("Optimistic-concurrency guard: the version you last read."),
      },
      ["ref"],
    ),
    async handler(args, ctx) {
      // `status` is deliberately absent from the schema above *and* refused by
      // the service. The tool cannot express it, so the two can never disagree.
      const body = present(args, ["title", "description", "priority", "kind", "labels", "meta", "acceptance", "if_version"]);
      return { payload: await ctx.client.patch(`/api/v1/tasks/${ref(args.ref)}`, body) };
    },
  },

  {
    name: "task_move",
    readOnly: false,
    description:
      "Move a task to another status. Moving to in_review requires a report for the current delivery round: without one the board refuses with REPORT_REQUIRED, and the fix is the task_deliver tool.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        to: oneOf(STATUSES, "Target status (required)."),
        if_version: integer("Optimistic-concurrency guard: the version you last read."),
      },
      ["ref", "to"],
    ),
    async handler(args, ctx) {
      // Nothing here inspects `to`. The gate lives in `src/core/domain/delivery-gate.mjs`,
      // is enforced again by a database trigger, and reaches this caller as a 422
      // that `client/http.mjs` turns back into the very same DomainError the CLI
      // sees. A local check would be a second gate — and a second gate is a gate
      // that can disagree.
      return {
        payload: await ctx.client.post(`/api/v1/tasks/${ref(args.ref)}/move`, {
          to: args.to,
          if_version: args.if_version,
        }),
      };
    },
  },

  {
    name: "task_deliver",
    readOnly: false,
    description:
      "Write a report and move the task to in_review in one transaction — the compliant way to finish a card. Alternatively waive the report with no_report plus a reason of at least 8 characters; the waiver is audited as a report_waived event.",
    inputSchema: input(
      {
        ref: string("Task id or identifier (required)."),
        report: object(
          "The report: conclusion, acceptance items and evidence anchors. Its author defaults to this MCP agent.",
        ),
        no_report: boolean("Deliver without a report. Requires reason; recorded as an audited waiver."),
        reason: string("Why this delivery is audited without a report (at least 8 characters)."),
        if_version: integer("Optimistic-concurrency guard: the version you last read."),
        seg: string("Segment this delivery belongs to."),
        session_id: string("Agent session id to attribute the report to."),
      },
      ["ref"],
    ),
    validate(args) {
      const waived = args.no_report === true;
      if (waived && args.report !== undefined) {
        throw invalidParams("task_deliver: report and no_report are mutually exclusive", {
          details: { fields: ["report", "no_report"] },
          hint: { fix: "send a report, or waive it with a reason — not both" },
        });
      }
      if (!waived && args.report === undefined) {
        throw invalidParams("task_deliver: report is required (or no_report: true with a reason)", {
          details: { fields: ["report", "no_report"] },
          hint: { fix: 'task_deliver {"ref": "<id>", "report": {…}}' },
        });
      }
      // The reason's *length* is not checked here: `assertWaiverRequest` in core
      // owns that rule, and duplicating it is exactly the kind of second copy
      // this milestone is built to avoid.
    },
    async handler(args, ctx) {
      const waived = args.no_report === true;
      const body = present(args, ["if_version", "reason", "seg", "session_id"]);
      body.no_report = waived;

      const report = waived ? null : { ...(args.report ?? {}) };
      if (report !== null && report.author == null) report.author = ctx.actor;
      if (report !== null) body.report = report;

      const payload = await ctx.client.post(`/api/v1/tasks/${ref(args.ref)}/deliver`, body);

      const warnings = reportWarnings(report);
      if (payload.waived === true) {
        warnings.push(`delivering without a report; recorded as report_waived (round ${payload.round})`);
      }
      return { payload, warnings };
    },
  },
];
