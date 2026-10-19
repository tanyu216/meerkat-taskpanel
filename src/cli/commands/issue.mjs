/**
 * `issue create|list|get|update|meta|move|heartbeat|assign|archive|deliver` (A1–A5).
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
import { TASK_OPS } from "../../core/commands/tasks-input.mjs";
import { fields, table, taskLine } from "../output/human.mjs";
import { parseReport } from "./report.mjs";
import { projectBody, projectFlags } from "./task-input.mjs";

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
    op: TASK_OPS.create,
    usage: "issue create --project <id> --title <text> [--assignee <name>]",
    positionals: [],
    // The flags and the body are both projected from the command's input
    // declaration (`core/commands/tasks-input.mjs`), so neither is a second
    // hand-kept list. The spelling of each flag lives in `./task-input.mjs`.
    flags: projectFlags(TASK_OPS.create),
    async run(ctx) {
      const flags = ctx.flags;
      // `--acceptance` and `--target` are declared CLI-only inputs that fold into
      // the card's `meta` (`--target` because the board owns no project
      // directory, so `target` is not a top-level create field). `projectBody`
      // does that folding; the idempotency key reads `target` back from there.
      const payload = await ctx.client.post("/api/v1/tasks", projectBody(TASK_OPS.create, {
        project_id: flags.project,
        title: flags.title,
        description: flags.description,
        status: flags.status,
        priority: flags.priority,
        kind: flags.kind,
        labels: flags.labels,
        meta: metaOf(flags),
        acceptance: flags.acceptance,
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
      }));
      return { data: payload, human: `created ${payload.task.identifier}  ${payload.task.title}` };
    },
  },

  {
    name: "list",
    summary: "List tasks.",
    usage: "issue list [--project <id>] [--status <status>]… [--limit <n>] [--order board|weight] [--order-debug]",
    positionals: [],
    flags: [
      { flag: "project", key: "project", as: "string", value: "<id>" },
      { flag: "status", key: "statuses", as: "string", value: "<status>", repeat: true },
      { flag: "assignee-id", key: "assigneeId", as: "string", value: "<id>" },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
      { flag: "include-archived", key: "includeArchived", as: "boolean" },
      { flag: "order", key: "order", as: "string", value: "board|weight", summary: "`weight` = the assignee weight order (C-WEIGHT-1); the default is the board's own deterministic order." },
      { flag: "order-debug", key: "orderDebug", as: "boolean", summary: "Also return the weight order's per-card projection (implies --order weight)." },
    ],
    async run(ctx) {
      const { tasks, order_debug: orderDebug } = await ctx.client.get("/api/v1/tasks", {
        query: {
          project_id: ctx.flags.project,
          status: ctx.flags.statuses,
          assignee_id: ctx.flags.assigneeId,
          limit: ctx.flags.limit,
          include_archived: ctx.flags.includeArchived === true ? "1" : undefined,
          order: ctx.flags.order,
          order_debug: ctx.flags.orderDebug === true ? "1" : undefined,
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
      // `--order-debug` rides through untouched: it is the weight order's
      // projection, and re-shaping it here would be a second implementation.
      return { data: { tasks, ...(orderDebug === undefined ? {} : { order_debug: orderDebug }) }, human };
    },
  },

  {
    name: "candidates",
    summary: "List the claimable cards for an assignee (the poll's read; claim still goes through issue move/claim semantics).",
    usage: "issue candidates --assignee <name> [--stale] [--include-unassigned] [--order board|weight] [--order-debug]",
    positionals: [],
    flags: [
      { flag: "assignee", key: "assignee", as: "string", value: "<name>", required: true, summary: "Which assignee to list candidates for." },
      { flag: "stale", key: "stale", as: "boolean", summary: "Also include stale-recovery candidates (in_progress with an expired heartbeat)." },
      { flag: "include-unassigned", key: "includeUnassigned", as: "boolean", summary: "Also include claimable unassigned cards (the public pool) — the supervisor's `claim_unassigned` read." },
      { flag: "order", key: "order", as: "string", value: "board|weight", summary: "`weight` refines the order *within* each claimability bucket (the bucket stays the first key)." },
      { flag: "order-debug", key: "orderDebug", as: "boolean", summary: "Also return the weight order's per-card projection (implies --order weight)." },
    ],
    async run(ctx) {
      const { candidates, order_debug: orderDebug } = await ctx.client.get("/api/v1/tasks/candidates", {
        query: {
          assignee: ctx.flags.assignee,
          stale: ctx.flags.stale === true ? "1" : undefined,
          include_unassigned: ctx.flags.includeUnassigned === true ? "1" : undefined,
          order: ctx.flags.order,
          order_debug: ctx.flags.orderDebug === true ? "1" : undefined,
        },
      });
      const human =
        candidates.length === 0
          ? "no candidates"
          : table(
              ["identifier", "status", "priority", "project", "reason"],
              candidates.map((candidate) => [
                candidate.identifier,
                candidate.status,
                candidate.priority,
                candidate.project,
                candidate.reason,
              ]),
            );
      return { data: { candidates, ...(orderDebug === undefined ? {} : { order_debug: orderDebug }) }, human };
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
    summary: "Update a task's title, description, priority, labels, metadata or acceptance list.",
    op: TASK_OPS.update,
    usage: "issue update <id|identifier> [--title <text>] [--acceptance <text>]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.update),
    async run(ctx) {
      const flags = ctx.flags;
      // Every field is offered; `projectBody` drops the ones the caller did not
      // pass, so "nothing to update" stays measurable below.
      const body = projectBody(TASK_OPS.update, {
        title: flags.title,
        description: flags.description,
        priority: flags.priority,
        kind: flags.kind,
        labels: flags.labels,
        meta: metaOf(flags),
        acceptance: flags.acceptance,
      });
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
    name: "meta",
    summary: "Merge metadata keys into a task, leaving every other key untouched.",
    usage: "issue meta <id|identifier> --meta <key>=<value> [--meta <key>=<value>]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "meta", key: "meta", as: "kv", required: true, summary: "Repeatable key=value metadata." },
    ],
    async run(ctx) {
      // The PATCH route replaces `meta` wholesale, so a merge spelled with
      // `issue update --meta` would erase `acceptance`, `target` and every other
      // key. Merging has to happen here, where the current object (and its value
      // types) is visible; the result is sent as one ordinary update.
      const task = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`)).task;
      const meta = { ...(task.meta ?? {}), ...ctx.flags.meta };
      // The version read above is the CAS guard: if the card moved between the
      // read and this write, the board refuses rather than silently dropping
      // the other writer's change (a merge cannot be expressed on the wire).
      const payload = await ctx.client.patch(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`, {
        meta,
        if_version: task.version,
      });
      return { data: payload, human: `updated metadata on ${payload.task.identifier}` };
    },
  },

  {
    name: "move",
    summary: "Move a task to another status (this is where the delivery gate bites).",
    op: TASK_OPS.move,
    usage:
      'issue move <id|identifier> <status> [--allow-steal --reason "<why>"] ' +
      '[--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--blocked-reason <class>]',
    positionals: [
      { name: "ref", summary: "Task id or identifier." },
      { name: "to", summary: "Target status." },
    ],
    flags: projectFlags(TASK_OPS.move),
    async run(ctx) {
      const allowSteal = ctx.flags.allowSteal === true;
      // A claim on somebody else's card is an audited exception, so it must say
      // why. `8` matches `WAIVER_MIN_REASON_CHARS` in
      // `src/core/domain/delivery-gate.mjs`; the service enforces it again.
      if (allowSteal && (typeof ctx.flags.reason !== "string" || ctx.flags.reason.trim().length < 8)) {
        throw usageError('issue move: --allow-steal needs --reason "<why>" (at least 8 characters)', {
          fix: "say why the card is being taken from its assignee",
        });
      }
      // M1 — `awaiting` is the one move that must name the category of question
      // (design §2.1). Refused here as a usage error so the operator gets the
      // vocabulary; the service enforces the same rule with a domain error.
      if (ctx.args.to === "awaiting" && typeof ctx.flags.awaitingReason !== "string") {
        throw usageError("issue move: `awaiting` needs --awaiting-reason <E1..E5>", {
          fix: "E1 scope · E2 acceptance baseline · E3 design direction · E4 security · E5 architecture",
        });
      }
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/move`, projectBody(TASK_OPS.move, {
        to: ctx.args.to,
        if_version: ctx.flags.ifVersion,
        no_report: ctx.flags.noReport === true,
        allow_steal: allowSteal,
        reason: ctx.flags.reason,
        awaiting_reason: ctx.flags.awaitingReason,
        // 0016 — a `blocked` card may name *what* it is waiting for (SLA
        // inspection contract §7). Optional, unlike `--awaiting-reason`: an
        // unstated class is legal (the inspector reads it as `clarify`), so the
        // only refusal is a value that is not one of the literals. Any move out
        // of `blocked` clears it, service-side — the flag is simply not read.
        blocked_reason: ctx.flags.blockedReason,
      }));
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
    name: "heartbeat",
    summary: "Pulse a claimed card so its heartbeat stays inside the fresh window.",
    op: TASK_OPS.heartbeat,
    usage: "issue heartbeat <id|identifier>",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    // No flags of its own: the card is the positional and the pulsing actor is
    // the caller, whom the global attribution flags (`--agent`, `--actor-kind`,
    // `--session-id`) already name. `projectFlags` returns `[]` here, and that
    // empty list is asserted against the declaration by the route-request gate.
    flags: projectFlags(TASK_OPS.heartbeat),
    async run(ctx) {
      const payload = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/heartbeat`,
        projectBody(TASK_OPS.heartbeat, {}),
      );
      const task = payload.task;
      return {
        data: payload,
        human: `pulsed ${task.identifier}  ${task.status}  heartbeat ${task.heartbeat_at}`,
      };
    },
  },

  {
    name: "assign",
    summary: "Assign (or reassign) a task's assignee and reporter.",
    op: TASK_OPS.assign,
    usage: "issue assign <id|identifier> [--assignee <text>] [--reporter <text>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.assign),
    async run(ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/assign`, projectBody(TASK_OPS.assign, {
        assignee: ctx.flags.assignee,
        assignee_id: ctx.flags.assigneeId,
        reporter: ctx.flags.reporter,
        reporter_id: ctx.flags.reporterId,
        force_create: ctx.flags.forceCreate === true,
      }));
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
    op: TASK_OPS.archive,
    usage: "issue archive <id|identifier> [--days <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.archive),
    async run(ctx) {
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/archive`, projectBody(TASK_OPS.archive, {
        if_version: ctx.flags.ifVersion,
        days: ctx.flags.days,
      }));
      return { data: payload, human: `archived ${payload.task.identifier} (${payload.task.status})` };
    },
  },

  {
    name: "deliver",
    summary: "Write a report and move to in_review, atomically. The compliant path.",
    op: TASK_OPS.deliver,
    usage: "issue deliver <id|identifier> --report-file <file|-> [--no-report --reason <why>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.deliver),
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

      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/deliver`, projectBody(TASK_OPS.deliver, {
        report,
        if_version: flags.ifVersion,
        no_report: waived,
        reason: flags.reason,
        seg: flags.seg,
        session_id: flags.sessionId,
      }));
      if (payload.waived) {
        warnings.push(`delivering without a report; recorded as report_waived (round ${payload.round})`);
      }
      const human = payload.waived
        ? `delivered ${payload.task.identifier} → ${payload.task.status} (waived, round ${payload.round})`
        : `delivered ${payload.task.identifier} → ${payload.task.status} (report #${payload.report_id}, round ${payload.round})`;
      return { data: payload, human, warnings };
    },
  },

  {
    name: "reconcile",
    summary: "Replay the epic start/close rules over the board (the idempotent backstop).",
    usage: "issue reconcile [--dry-run]",
    positionals: [],
    flags: [
      {
        flag: "dry-run",
        key: "dryRun",
        as: "boolean",
        summary: "Report what would change; write nothing.",
      },
    ],
    async run(ctx) {
      const payload = await ctx.client.post("/api/v1/tasks/reconcile", {
        dry_run: ctx.flags.dryRun === true,
      });
      const changed = payload.actions.filter((entry) => entry.action !== "none");
      // An open container the sweep could not close carries the children that
      // held it open. Printing only the actions would let "nothing to
      // reconcile" hide the answer ("which child?").
      const blocked = payload.actions.filter(
        (entry) => entry.action === "none" && Array.isArray(entry.blocking) && entry.blocking.length > 0,
      );
      const verb = payload.dry_run ? "would reconcile" : "reconciled";
      const lines = [
        ...changed.map(
          (entry) =>
            `  ${entry.epic.padEnd(14)} ${entry.action.padEnd(6)} ${entry.reason}` +
            (entry.child === undefined ? "" : `  ${entry.child}`),
        ),
        ...blocked.map(
          (entry) =>
            `  ${entry.epic.padEnd(14)} ${"none".padEnd(6)} ${entry.reason}  ` +
            entry.blocking.map((child) => `${child.identifier} (${child.status})`).join(", "),
        ),
      ];
      const human =
        lines.length === 0
          ? `nothing to reconcile (${payload.scanned} container(s) scanned)`
          : `${verb} ${changed.length} container(s) of ${payload.scanned} scanned` +
            (blocked.length === 0 ? "" : `; ${blocked.length} still waiting`) +
            `\n${lines.join("\n")}`;
      return { data: payload, human };
    },
  },
];
