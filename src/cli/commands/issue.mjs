/**
 * `issue create|list|get|update|meta|move|reopen|heartbeat|assign|archive|deliver` (A1–A5).
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

import { CLI_EXIT } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { norm } from "../../foundation/norm.mjs";
import {
  catalogAgentNames,
  catalogHasAssignee,
} from "../../foundation/role-catalog.mjs";
import {
  defaultRoleCatalogPath,
  readRoleCatalog,
} from "../../foundation/role-catalog-file.mjs";
import {
  isHumanComment,
  isQuestionComment,
  newestAgentQuestion,
  releasedAfterQuestion,
} from "../../foundation/question-settle.mjs";
import { reportWarnings } from "../../foundation/report-warning.mjs";
import { usageError } from "../../foundation/transport/errors.mjs";
import { TASK_OPS } from "../../core/commands/tasks-input.mjs";
import { fields, table, taskLine } from "../output/human.mjs";
import { sizeLabel } from "./attachment.mjs";
import { parseReport } from "./report.mjs";
import { projectBody, projectFlags } from "./task-input.mjs";

/** `--meta k=v` repeated → object. */
const metaOf = (flags) => flags.meta;

/**
 * The local role catalog is the assignee range — a **CLI guard**, not a board
 * invariant. `taskd` never learns roles, so a caller that speaks HTTP directly
 * bypasses this by design; every supported surface (the `meerkat` skill, the
 * worker, the director, a human) goes through `taskctl`.
 *
 * The guard looks at the **assignee**, never the writer: `system`/`Orchestrator`
 * are writer identities for task closure and cannot become assignees through
 * this path. A review card is an ordinary create with one extra rule: its
 * assignee must name a reviewer-lane role, it defaults to the catalog's
 * reviewer, and the structural escapes cannot bypass that rule. The rework
 * child remains the `--assignee-id` structural spelling.
 *
 * Skipped when: `--force-create` (the documented escape on ordinary cards),
 * `--assignee-id`, an explicit human assignee, no assignee at all, or no
 * usable catalog (bootstrap — before the supervisor's first sync).
 */
function catalogRoleNamed(catalog, assignee) {
  if (typeof assignee !== "string" || assignee.trim() === "") return null;
  const key = assignee.trim().toLowerCase();
  return (
    (catalog?.roles ?? []).find(
      (role) => role.agent.toLowerCase() === key || role.id.toLowerCase() === key,
    ) ?? null
  );
}

/** The role catalog's default reviewer, then any reviewer-lane role, then the
 * conventional name. The board never learns roles; this is the CLI's fallback. */
function defaultReviewerAgent(catalog) {
  const roles = Array.isArray(catalog?.roles) ? catalog.roles : [];
  const role =
    roles.find((candidate) => candidate.default_reviewer === true) ??
    roles.find((candidate) => Array.isArray(candidate.lanes) && candidate.lanes.includes("reviewer"));
  return role?.agent ?? "Reviewer";
}

/**
 * The create/assign assignee range. A review card has one extra rule: its
 * assignee must name a reviewer-lane role, and the structural escapes
 * (`--assignee-id`, `--force-create`, a human assignee) cannot bypass it.
 * Returns the effective assignee so a review create can apply the default.
 */
function assertAssigneeInCatalog(ctx, { assignee, assigneeId, assigneeKind, forceCreate, reviewOf }) {
  const read = readRoleCatalog(defaultRoleCatalogPath(ctx.env ?? {}, { cwd: ctx.cwd }));
  // Absent, unreadable or still-empty: the open range, so a first card can be
  // created before any poll has published a catalog. A malformed file reads the
  // same way — the next sync repairs it, and a half-read range is worse.
  const catalog = read.ok && read.present === true ? read.catalog : null;
  const hasCatalog = catalog !== null && catalog.roles.length > 0;
  const review = typeof reviewOf === "string" && reviewOf.trim() !== "";

  if (review) {
    if (assigneeKind === "human") {
      throw new DomainError("ASSIGNEE_NOT_REVIEWER", {
        message: "a review card must be assigned to an agent role in the reviewer lane",
        details: { field: "assignee", assignee_kind: "human" },
      });
    }
    if (typeof assigneeId === "string" && assigneeId.trim() !== "") {
      throw new DomainError("ASSIGNEE_NOT_REVIEWER", {
        message: "a review card cannot be assigned by --assignee-id; name a reviewer-lane role",
        details: { field: "assignee_id" },
      });
    }
    if (forceCreate === true) {
      throw new DomainError("ASSIGNEE_NOT_REVIEWER", {
        message: "--force-create cannot bypass the reviewer-lane rule on a review card",
        details: { field: "force_create" },
      });
    }
    const effective =
      typeof assignee === "string" && assignee.trim() !== ""
        ? assignee.trim()
        : defaultReviewerAgent(catalog);
    if (hasCatalog) {
      const role = catalogRoleNamed(catalog, effective);
      if (role === null) {
        throw new DomainError("ASSIGNEE_NOT_IN_CATALOG", {
          message: `assignee ${JSON.stringify(effective)} is not a role in the local role catalog`,
          details: { field: "assignee", assignee: effective, roles: catalogAgentNames(catalog) },
          hint: { fix: "use a discovered role name from `taskctl role list`" },
        });
      }
      if (!Array.isArray(role.lanes) || !role.lanes.includes("reviewer")) {
        throw new DomainError("ASSIGNEE_NOT_REVIEWER", {
          message: `assignee ${JSON.stringify(effective)} is not a reviewer-lane role`,
          details: {
            field: "assignee",
            assignee: effective,
            lanes: role.lanes ?? [],
            roles: catalog.roles
              .filter((candidate) => (candidate.lanes ?? []).includes("reviewer"))
              .map((candidate) => candidate.agent),
          },
          hint: { fix: "assign a reviewer-lane role (for example Reviewer)" },
        });
      }
    }
    return effective;
  }

  if (forceCreate === true) return assignee;
  if (typeof assigneeId === "string" && assigneeId.trim() !== "") return assignee;
  if (assigneeKind === "human") return assignee;
  if (typeof assignee !== "string" || assignee.trim() === "") return assignee;
  if (!hasCatalog) return assignee;
  if (catalogHasAssignee(catalog, assignee)) return assignee;

  throw new DomainError("ASSIGNEE_NOT_IN_CATALOG", {
    message: `assignee ${JSON.stringify(assignee)} is not a role in the local role catalog`,
    details: {
      field: "assignee",
      assignee,
      roles: catalogAgentNames(catalog),
    },
    hint: {
      fix:
        "use a discovered role name from `taskctl role list`, or pass --force-create " +
        "to allow an assignee outside the catalog",
    },
  });
}

/**
 * The sections `issue get --include` can add to the payload.
 *
 * Exported because the documentation gate checks the same list: one constant, so
 * a new section cannot exist in the CLI and be missing from the skill page (or
 * the reverse). Each name is also the payload key it produces.
 */
export const GET_INCLUDE_SECTIONS = Object.freeze(["comments", "reports", "relations", "sessions"]);

/**
 * The default cap for the included comment trail.
 *
 * `comment list` is unbounded, which is right for a read whose whole purpose is
 * the trail. A one-shot progress answer is different: it should not grow with a
 * card's history unless the caller asks, so the default is bounded and `0`
 * restores the unbounded read.
 */
const DEFAULT_INCLUDED_COMMENT_LIMIT = 50;

// ---------------------------------------------------------------------------
// `issue wait` — the worker's bounded in-turn hold
// ---------------------------------------------------------------------------

/**
 * The default hold. Kept under a 120s tool default (the common bound for an
 * agent's shell call) so the worker receives the outcome instead of a killed
 * process; a hold that needs longer is re-entered, not stretched.
 */
const WAIT_DEFAULT_TIMEOUT_MS = 110_000;
/** Hard ceiling: a tool call must not outlive the turn/agent bounds. */
const WAIT_MAX_TIMEOUT_MS = 540_000;
const WAIT_DEFAULT_INTERVAL_MS = 2_000;
const WAIT_DEFAULT_HEARTBEAT_SEC = 240;
/** How many questions to scan for the worker's own cursor. */
const WAIT_QUESTION_SCAN = 20;
/** The answer trail is read with an `after` cursor, bounded for the terminal. */
const WAIT_SNAPSHOT_COMMENTS = 50;
const WAIT_MAX_READ_FAILURES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Render the answer trail bounded, like `readRedispatchContext`. */
function waitAnswerText(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => isHumanComment(comment) || !isQuestionComment(comment))
    .slice()
    .reverse()
    .map((comment) => {
      const text = String(comment?.body ?? "").trim();
      return `${isHumanComment(comment) ? "[human]" : "[agent]"} ${text}`;
    })
    .filter((line) => line.trim() !== "[human]" && line.trim() !== "[agent]")
    .join("\n")
    .slice(0, 2000);
}

/**
 * Read the card and the newest questions once. The caller counts failures; a
 * throw here is a transport problem, never an answer.
 *
 * The question is read by `kind`, not sliced out of the newest N comments: on a
 * long-lived card the question can fall out of a fixed comment window while the
 * wait is still open. The answer trail is then read with
 * `after=<question.created_at>`, so growth in either direction cannot hide it.
 */
async function waitSnapshot(client, ref) {
  const [taskRead, questionsRead] = await Promise.all([
    client.get(`/api/v1/tasks/${encodeURIComponent(ref)}`),
    client.get(`/api/v1/tasks/${encodeURIComponent(ref)}/comments`, {
      query: { kind: "question", limit: WAIT_QUESTION_SCAN, order: "desc" },
    }),
  ]);
  return {
    task: taskRead?.task ?? {},
    questions: Array.isArray(questionsRead?.comments) ? questionsRead.comments : [],
  };
}

/** The comments written after the question, newest first.
 *
 * `after` is the repository's **created_at** cursor, not a comment id (see
 * `repositories/comments.mjs`): the server filters `created_at > ?`.
 */
async function waitAnswerTrail(client, ref, question) {
  const askedAt = question?.created_at ?? question?.createdAt ?? null;
  if (askedAt === null || askedAt === undefined || askedAt === "") return [];
  const read = await client.get(`/api/v1/tasks/${encodeURIComponent(ref)}/comments`, {
    query: { after: String(askedAt), limit: WAIT_SNAPSHOT_COMMENTS, order: "desc" },
  });
  return Array.isArray(read?.comments) ? read.comments : [];
}

/** The task payload the service returns is `{task, report_waivers}`. */
function taskHuman(task, extra) {
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  return fields([
    ["identifier", task.identifier],
    ["title", task.title],
    ["status", task.status],
    ["priority", task.priority],
    ["kind", task.kind],
    ["labels", Array.isArray(task.labels) && task.labels.length > 0 ? task.labels.join(", ") : "-"],
    ["assignee", task.assignee === null ? "-" : `${task.assignee.display_name}#${task.assignee.id}`],
    ["reporter", task.reporter === null ? "-" : `${task.reporter.display_name}#${task.reporter.id}`],
    ["claimed_by", task.claimed_by_actor === null ? "-" : `${task.claimed_by_actor.display_name}#${task.claimed_by_actor.id}`],
    ["heartbeat_at", task.heartbeat_at ?? "-"],
    ["delivery_round", task.delivery_round],
    ["acceptance_mode", task.acceptance_mode ?? "auto"],
    // The column is an internal id; the human read wants the identifier the
    // worker can pass back. `meta.review_of` is the readable mirror (0025).
    ["review_of", task.review_of ?? task.review_of_id ?? "-"],
    ["review_round", task.review_round ?? "-"],
    ["parent", task.parent_id ?? "-"],
    ["awaiting_reason", task.awaiting_reason ?? "-"],
    ["acceptance_revision", task.acceptance_revision ?? 0],
    [
      "acceptance",
      acceptance.length === 0
        ? "none (vacuous)"
        : acceptance.map((text, index) => `${index + 1}) ${text}`).join("; "),
    ],
    ["meta", JSON.stringify(task.meta ?? {})],
    ["description", task.description ?? ""],
    ["version", task.version],
    ...extra,
  ]);
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a task.",
    op: TASK_OPS.create,
    usage: "issue create --project <id> --title <text> [--acceptance-mode off|auto|human] [--assignee <name>]",
    positionals: [],
    // The flags and the body are both projected from the command's input
    // declaration (`core/commands/tasks-input.mjs`), so neither is a second
    // hand-kept list. The spelling of each flag lives in `./task-input.mjs`.
    flags: projectFlags(TASK_OPS.create),
    async run(ctx) {
      const flags = ctx.flags;
      // The assignee range is the local role catalog; refuse before the board call.
      // A review card also defaults its assignee to the catalog's reviewer and
      // must name a reviewer-lane role.
      const assignee = assertAssigneeInCatalog(ctx, {
        assignee: flags.assignee,
        assigneeId: flags.assigneeId,
        assigneeKind: flags.assigneeKind,
        forceCreate: flags.forceCreate === true,
        reviewOf: flags.reviewOf,
      });
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
        assignee,
        assignee_kind: flags.assigneeKind,
        assignee_id: flags.assigneeId,
        reporter: flags.reporter,
        reporter_kind: flags.reporterKind,
        reporter_id: flags.reporterId,
        force_create: flags.forceCreate === true,
        idem: flags.idem,
        allow_dup: flags.allowDup === true,
        target: flags.target,
        // 0038 — the single acceptance decision.
        acceptance_mode: flags.acceptanceMode,
        review_of: flags.reviewOf,
        review_round: flags.reviewRound,
        parent: flags.parent,
      }));
      return { data: payload, human: `created ${payload.task.identifier}  ${payload.task.title}` };
    },
  },

  {
    name: "list",
    summary: "List tasks.",
    usage: "issue list [--project <id>] [--status <status>]… [--assignee <name>|--assignee-id <id>] [--parent <ref>] [--kind <kind>] [--label <label>]… [--target <value>] [--meta <key>=<value>]… [--review-of <ref>] [--limit <n>] [--order-debug]",
    positionals: [],
    flags: [
      { flag: "project", key: "project", as: "string", value: "<id>" },
      { flag: "status", key: "statuses", as: "string", value: "<status>", repeat: true },
      { flag: "assignee", key: "assignee", as: "string", value: "<name>", summary: "Resolved against the dictionary; an unknown name matches nothing (not everything)." },
      { flag: "assignee-id", key: "assigneeId", as: "string", value: "<id>", summary: "The structural spelling of --assignee; the two are refused together." },
      { flag: "parent", key: "parent", as: "string", value: "<ref>", summary: "Only the child cards of that parent (id or identifier)." },
      { flag: "kind", key: "kind", as: "string", value: "<kind>", summary: "task|epic|review (review = cards that audit another card; an ordinary task still matches task); an unknown kind is a VALIDATION_FAILED, not an empty page." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true, summary: "Exact display name; repeatable, every label must be present." },
      { flag: "target", key: "target", as: "string", value: "<value>", summary: "The card's `meta.target`, compared as text." },
      { flag: "meta", key: "meta", as: "string", value: "<key>=<value>", repeat: true, summary: "Filter on the card's meta; repeatable, every pair must hold. The key must match [A-Za-z0-9_.-]+." },
      { flag: "review-of", key: "reviewOf", as: "string", value: "<ref>", summary: "Only the cards that review this task (id or identifier), across every round." },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
      { flag: "include-archived", key: "includeArchived", as: "boolean" },
      { flag: "order-debug", key: "orderDebug", as: "boolean", summary: "Also return the weight order's per-card projection (the order itself is always the weight order)." },
    ],
    async run(ctx) {
      const { tasks, order_debug: orderDebug } = await ctx.client.get("/api/v1/tasks", {
        query: {
          project_id: ctx.flags.project,
          status: ctx.flags.statuses,
          assignee: ctx.flags.assignee,
          assignee_id: ctx.flags.assigneeId,
          parent: ctx.flags.parent,
          kind: ctx.flags.kind,
          label: ctx.flags.labels,
          target: ctx.flags.target,
          meta: ctx.flags.meta,
          review_of: ctx.flags.reviewOf,
          limit: ctx.flags.limit,
          include_archived: ctx.flags.includeArchived === true ? "1" : undefined,
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
    usage: "issue candidates --assignee <name> [--stale] [--include-unassigned] [--order-debug]",
    positionals: [],
    flags: [
      { flag: "assignee", key: "assignee", as: "string", value: "<name>", required: true, summary: "Which assignee to list candidates for." },
      { flag: "stale", key: "stale", as: "boolean", summary: "Also include stale-recovery candidates (in_progress with an expired heartbeat)." },
      { flag: "include-unassigned", key: "includeUnassigned", as: "boolean", summary: "Also include claimable unassigned cards (the public pool) — the supervisor's `claim_unassigned` read." },
      { flag: "order-debug", key: "orderDebug", as: "boolean", summary: "Also return the weight order's per-card projection (the order itself is always the weight order, within each claimability bucket)." },
    ],
    async run(ctx) {
      const { candidates, order_debug: orderDebug } = await ctx.client.get("/api/v1/tasks/candidates", {
        query: {
          assignee: ctx.flags.assignee,
          stale: ctx.flags.stale === true ? "1" : undefined,
          include_unassigned: ctx.flags.includeUnassigned === true ? "1" : undefined,
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
    summary: "Show one task (by id or identifier), optionally with its trail and edges.",
    usage:
      "issue get <id|identifier> [--include comments|reports|relations|sessions]… [--limit <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      {
        flag: "include",
        key: "include",
        as: "string",
        value: "<section>",
        repeat: true,
        summary: `${GET_INCLUDE_SECTIONS.join("|")} (repeatable); each adds its own payload key`,
      },
      {
        flag: "limit",
        key: "limit",
        as: "number",
        value: "<n>",
        summary: `Cap for --include comments (default ${DEFAULT_INCLUDED_COMMENT_LIMIT}; 0 = no cap)`,
      },
    ],
    async run(ctx) {
      const requested = ctx.flags.include ?? [];
      const unknown = requested.filter((section) => !GET_INCLUDE_SECTIONS.includes(section));
      if (unknown.length > 0) {
        throw usageError(`unknown --include section ${unknown[0]}`, {
          hint: { fix: `use --include ${GET_INCLUDE_SECTIONS.join("|")}` },
        });
      }
      const wanted = new Set(requested);
      // `--limit` has exactly one meaning here. Silently ignoring it would make a
      // caller believe a trail was capped when it was not.
      if (ctx.flags.limit !== undefined && !wanted.has("comments")) {
        throw usageError("--limit applies to --include comments", {
          hint: { fix: "add --include comments, or drop --limit" },
        });
      }

      const ref = encodeURIComponent(ctx.args.ref);
      const payload = await ctx.client.get(`/api/v1/tasks/${ref}`);
      const task = payload.task;
      const extra = [];
      if (task.report_waiver !== null) {
        extra.push(["waiver", `round ${task.report_waiver.round}: ${task.report_waiver.reason}`]);
      }
      if (payload.report_waivers.length > 0) {
        extra.push(["waivers", `${payload.report_waivers.length} on record`]);
      }

      // The sections are composed from the same routes the standalone reads use,
      // so there is no second projection to keep in step; the payload key is the
      // section name, and a section the caller did not ask for is not fetched.
      const included = { ...payload };
      const summary = [];
      if (wanted.has("comments")) {
        const limit = ctx.flags.limit === undefined
          ? DEFAULT_INCLUDED_COMMENT_LIMIT
          : ctx.flags.limit;
        const { comments } = await ctx.client.get(`/api/v1/tasks/${ref}/comments`, {
          query: { limit: limit === 0 ? undefined : limit, order: "desc" },
        });
        included.comments = comments;
        summary.push(`${comments.length} comment${comments.length === 1 ? "" : "s"}`);
      }
      if (wanted.has("reports")) {
        const { reports } = await ctx.client.get(`/api/v1/tasks/${ref}/reports`);
        included.reports = reports;
        summary.push(`${reports.length} report${reports.length === 1 ? "" : "s"}`);
      }
      if (wanted.has("relations")) {
        // `relation list` answers the same object; `task_id` is dropped because
        // the card read already carries it, and the CLI's own `token_source` is
        // added by the dispatcher, not by the card read.
        const { task_id: _taskId, ...relations } = await ctx.client.get(
          `/api/v1/tasks/${ref}/relations`,
        );
        included.relations = relations;
        summary.push(
          `${relations.blocked_by.length} blockers, ${relations.children.length} children`,
        );
      }
      if (wanted.has("sessions")) {
        const { sessions } = await ctx.client.get(`/api/v1/tasks/${ref}/sessions`);
        included.sessions = sessions;
        summary.push(`${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
      }

      const human = taskHuman(task, extra);
      const attachments = payload.attachments ?? [];
      const body = attachments.length === 0
        ? human
        : `${human}\n\n${table(
            ["id", "filename", "size", "type"],
            attachments.map((row) => [row.id, row.filename, sizeLabel(row.size), row.content_type ?? "-"]),
          )}`;
      return {
        data: included,
        human: summary.length === 0 ? body : `${body}\n\nincluded: ${summary.join(" · ")}`,
      };
    },
  },

  {
    name: "update",
    summary:
      "Update a task's title, description, priority, labels, metadata, acceptance list or acceptance mode.",
    op: TASK_OPS.update,
    usage:
      'issue update <id|identifier> [--title <text>] [--acceptance <text>]… ' +
      '[--drop-acceptance <text> --reason "<why>" --acceptance-revision <n>] ' +
      '[--acceptance-mode off|auto|human [--reason "<why>"]]',
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.update),
    async run(ctx) {
      const flags = ctx.flags;
      if (
        flags.reason !== undefined &&
        flags.acceptanceMode === undefined &&
        flags.acceptanceDrop === undefined
      ) {
        throw usageError(
          "issue update: --reason is only used with --acceptance-mode or --drop-acceptance",
          {
            fix:
              'pass --acceptance-mode off --reason "<why>" to waive a review, ' +
              'or --drop-acceptance <text> --reason "<why>" to prune a baseline',
          },
        );
      }
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
        acceptance_drop: flags.acceptanceDrop,
        acceptance_revision: flags.acceptanceRevision,
        acceptance_mode: flags.acceptanceMode,
        reason: flags.reason,
        // A global the CLI accepts is either forwarded or refused — never
        // silently dropped, so a caller cannot believe it holds a CAS it does
        // not have.
        if_version: flags.ifVersion,
      });
      // `--if-version` is a guard, not a change: a call carrying only the guard
      // still has nothing to update and must not become a round trip.
      const changes = Object.keys(body).filter((key) => key !== "if_version");
      if (changes.length === 0) {
        // Refuse locally: a round trip that changes nothing is never what was meant.
        return {
          data: null,
          human: "",
          warnings: ["nothing to update: pass at least one of --title/--description/--priority/--kind/--label/--meta/--acceptance/--drop-acceptance/--acceptance-mode"],
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
      // The PATCH route merges `meta` into what the card already carries, so a
      // plain `issue update --meta` is additive. This command exists for the two
      // things `--meta` cannot express: an explicit read-modify-write with the
      // `--if-version` CAS below, and preserving the existing value types (the
      // CLI's `--meta` values are strings).
      const task = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`)).task;
      const meta = { ...(task.meta ?? {}), ...ctx.flags.meta };
      // The caller's `--if-version`, when given, is the CAS guard: a global the
      // CLI accepts is forwarded, never silently dropped, so a caller cannot
      // believe it holds a guard it does not have. Without it the version read
      // above guards the merge instead — if the card moved between the read and
      // this write, the board refuses rather than silently dropping the other
      // writer's change (a merge cannot be expressed on the wire).
      const payload = await ctx.client.patch(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`, {
        meta,
        if_version: ctx.flags.ifVersion ?? task.version,
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
      '[--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--question "<text>"] ' +
      '[--blocked-reason <class>]',
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
        // 0034 — the question is written as a `question` comment in the same
        // transaction as the move. An agent entering `awaiting` must supply it
        // (or have an unanswered question already); a human need not.
        question: ctx.flags.question,
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
    name: "reopen",
    summary: "Reopen a done/canceled card to todo (audited: --reason required).",
    op: TASK_OPS.reopen,
    usage: 'issue reopen <id|identifier> --reason "<why>"',
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.reopen),
    async run(ctx) {
      // Same audited-exception rule as --allow-steal; the service enforces it
      // again with a DomainError, so a direct HTTP caller cannot skip it.
      if (typeof ctx.flags.reason !== "string" || ctx.flags.reason.trim().length < 8) {
        throw usageError('issue reopen: --reason "<why>" is required (at least 8 characters)', {
          fix: "say why accepted/canceled work is being reopened",
        });
      }
      const payload = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/reopen`,
        projectBody(TASK_OPS.reopen, {
          reason: ctx.flags.reason,
          if_version: ctx.flags.ifVersion,
        }),
      );
      return { data: payload, human: `reopened ${payload.task.identifier} → ${payload.task.status}` };
    },
  },

  {
    name: "claim",
    summary: "Claim a card — including a stale in_progress claim (reuse, re-claim or takeover).",
    op: TASK_OPS.claim,
    usage: 'issue claim <id|identifier> [--check-blockers] [--allow-steal --reason "<why>"]',
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: projectFlags(TASK_OPS.claim),
    async run(ctx) {
      const allowSteal = ctx.flags.allowSteal === true;
      // Same audited exception as a `todo → in_progress` move: taking a card
      // from its assignee must say why (8 characters, service-enforced again).
      if (allowSteal && (typeof ctx.flags.reason !== "string" || ctx.flags.reason.trim().length < 8)) {
        throw usageError('issue claim: --allow-steal needs --reason "<why>" (at least 8 characters)', {
          fix: "say why the card is being taken from its assignee",
        });
      }
      const payload = await ctx.client.post(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/claim`,
        projectBody(TASK_OPS.claim, {
          if_version: ctx.flags.ifVersion,
          allow_steal: allowSteal,
          reason: ctx.flags.reason,
          check_blockers: ctx.flags.checkBlockers === true,
        }),
      );
      // `reuse` is not an error: the same holder asking again keeps the claim.
      const verb = payload.reused === true ? "reused the claim on" : payload.stole === true ? "took over" : "claimed";
      return { data: payload, human: `${verb} ${payload.task.identifier}` };
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
    name: "wait",
    summary: "Hold this turn until the question is answered or escalated; never writes (except its own heartbeat).",
    usage:
      "issue wait <id|identifier> [--question <comment-id>] [--timeout <ms>] " +
      "[--interval <ms>] [--heartbeat <sec>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      {
        flag: "question",
        key: "question",
        as: "string",
        value: "<comment-id>",
        summary: "The question comment to wait on (default: the newest one).",
      },
      {
        flag: "timeout",
        key: "timeout",
        as: "number",
        value: "<ms>",
        summary: `Bounded hold (default ${WAIT_DEFAULT_TIMEOUT_MS}; max ${WAIT_MAX_TIMEOUT_MS}).`,
      },
      {
        flag: "interval",
        key: "interval",
        as: "number",
        value: "<ms>",
        summary: `Board poll interval (default ${WAIT_DEFAULT_INTERVAL_MS}).`,
      },
      {
        flag: "heartbeat",
        key: "heartbeat",
        as: "number",
        value: "<sec>",
        summary: `Pulse the caller's heartbeat every N seconds while waiting (default ${WAIT_DEFAULT_HEARTBEAT_SEC}; 0 disables).`,
      },
    ],
    async run(ctx) {
      const ref = String(ctx.args.ref);
      const rawTimeout = Number(ctx.flags.timeout ?? WAIT_DEFAULT_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(rawTimeout)
        ? Math.min(Math.max(0, rawTimeout), WAIT_MAX_TIMEOUT_MS)
        : WAIT_DEFAULT_TIMEOUT_MS;
      const intervalMs = Math.max(1, Number(ctx.flags.interval ?? WAIT_DEFAULT_INTERVAL_MS));
      const heartbeatMs = Math.max(0, Number(ctx.flags.heartbeat ?? WAIT_DEFAULT_HEARTBEAT_SEC)) * 1000;
      const pinned = typeof ctx.flags.question === "string" && ctx.flags.question !== ""
        ? String(ctx.flags.question)
        : null;
      const started = Date.now();
      const deadline = started + timeoutMs;
      const mine = String(ctx.identity?.id ?? "");
      // The wire carries the holder's display name, not the caller's actor id;
      // `norm` is the repository's one identity rule for names (case/whitespace).
      const mineNorm = mine === "" ? null : norm(mine);
      let lastHeartbeat = started;
      let failures = 0;
      let question = null;
      let comments = [];
      let lastTask = {};

      const timedOut = () => ({
        data: {
          ref,
          outcome: "timeout",
          status: typeof lastTask.status === "string" ? lastTask.status : null,
          claimed_by: lastTask.claimed_by_actor?.display_name ?? null,
          question_id: question?.id ?? null,
          answer: waitAnswerText(comments),
          waited_ms: Date.now() - started,
        },
        human:
          `wait ${ref}: no answer within ${Math.round((Date.now() - started) / 1000)}s — ` +
          "re-invoke once when the runtime allows it, then stop; the loop resumes this session " +
          "when the answer lands",
        exit: CLI_EXIT.DIFFERENCES,
      });

      for (;;) {
        let task;
        try {
          const snapshot = await waitSnapshot(ctx.client, ref);
          task = snapshot.task;
          lastTask = task;
          if (question === null) {
            question = pinned === null
              ? newestAgentQuestion(snapshot.questions)
              : snapshot.questions.find((comment) => String(comment?.id) === pinned) ?? null;
            if (question === null) {
              throw usageError(
                pinned === null
                  ? `issue wait: ${ref} has no question to wait on`
                  : `issue wait: question ${pinned} is not on ${ref}'s trail`,
                { hint: { fix: "add the question comment first, or pass the id from `comment add --json`" } },
              );
            }
          }
          comments = await waitAnswerTrail(ctx.client, ref, question);
          failures = 0;
        } catch (err) {
          if (err?.code === "CLI_USAGE") throw err;

          failures += 1;
          if (failures >= WAIT_MAX_READ_FAILURES) {
            return {
              data: {
                ref,
                outcome: "error",
                status: null,
                claimed_by: null,
                question_id: question?.id ?? null,
                answer: null,
                waited_ms: Date.now() - started,
              },
              human: `wait ${ref}: the board was unreadable ${WAIT_MAX_READ_FAILURES} times — stop`,
              exit: CLI_EXIT.ERROR,
            };
          }
          if (Date.now() >= deadline) return timedOut();
          await sleep(Math.max(1, Math.min(intervalMs, deadline - Date.now())));
          continue;
        }

        const status = typeof task.status === "string" ? task.status : null;
        const owner = task.claimed_by_actor?.display_name ?? null;
        const ownerNorm = owner === null ? null : norm(owner);
        const ownedByMe = ownerNorm === null || (mineNorm !== null && ownerNorm === mineNorm);
        const show = (outcome) => ({
          data: {
            ref,
            outcome,
            status,
            claimed_by: owner,
            question_id: question.id ?? null,
            answer: waitAnswerText(comments),
            waited_ms: Date.now() - started,
          },
          human:
            outcome === "escalated"
              ? `wait ${ref}: escalated for a human (awaiting) — stop this turn; a human answer resumes the session`
              : `wait ${ref}: card is ${status ?? "unknown"}${owner === null ? "" : ` (claimed by ${owner})`} — stop`,
          exit: CLI_EXIT.DIFFERENCES,
        });

        if (status === "awaiting") return show("escalated");
        if (status !== null && status !== "in_progress" && status !== "todo") return show("moved");
        if (status === "in_progress" && !ownedByMe) return show("moved");

        // The release is the answer. A note — the Director's or the worker's own
        // — does not end the hold: the settle is the release, not the author, so
        // a comment can never prove the ladder answered, and the retry turn owns
        // the release.
        const released = status === "todo" || releasedAfterQuestion(task, question);
        if (released) {
          const answer = waitAnswerText(comments);
          return {
            data: {
              ref,
              outcome: "answered",
              status,
              claimed_by: owner,
              question_id: question.id ?? null,
              answer,
              waited_ms: Date.now() - started,
            },
            human:
              `wait ${ref}: answered (${status ?? "unknown"}) after ` +
              `${Math.round((Date.now() - started) / 1000)}s` +
              (answer === "" ? "" : `\n${answer}`),
            exit: CLI_EXIT.OK,
          };
        }

        // A long hold must keep its own claim fresh; check it before the deadline
        // so the final iteration does not skip a due pulse and return timeout.
        if (heartbeatMs > 0 && Date.now() - lastHeartbeat >= heartbeatMs) {
          try {
            await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ref)}/heartbeat`, {});
          } catch {
            // The card may have moved; the next read decides, and the wait must
            // not turn a heartbeat refusal into a false answer.
          }
          lastHeartbeat = Date.now();
        }
        if (Date.now() >= deadline) return timedOut();
        await sleep(Math.max(1, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
      }
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
      assertAssigneeInCatalog(ctx, {
        assignee: ctx.flags.assignee,
        assigneeId: ctx.flags.assigneeId,
        assigneeKind: ctx.flags.assigneeKind,
        forceCreate: ctx.flags.forceCreate === true,
      });
      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/assign`, projectBody(TASK_OPS.assign, {
        assignee: ctx.flags.assignee,
        assignee_id: ctx.flags.assigneeId,
        reporter: ctx.flags.reporter,
        reporter_id: ctx.flags.reporterId,
        force_create: ctx.flags.forceCreate === true,
        // Same rule as `update`: the global rides the wire or is refused.
        if_version: ctx.flags.ifVersion,
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
    summary: "Write a report and move to in_review (or straight to done for an `off` card), atomically.",
    op: TASK_OPS.deliver,
    usage:
      "issue deliver <id|identifier> --report-file <file|-> [--to done] " +
      "[--no-report --reason <why>]",
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
      // 0038 — the only destination a delivery may name is `done` (the `off`
      // card's direct acceptance). `in_review` is the default, and a waiver
      // never reaches `done`: the direct path is the one that must carry the
      // evidence.
      if (flags.to !== undefined && flags.to !== "done") {
        throw usageError(`issue deliver: --to accepts only "done" (got ${JSON.stringify(flags.to)})`, {
          fix: "omit --to to deliver to in_review",
        });
      }
      if (flags.to === "done" && waived) {
        throw usageError("issue deliver: --to done needs a report; --no-report cannot accept a card", {
          fix: "send the report, or deliver to in_review with the waiver",
        });
      }

      let report = null;
      const warnings = [];
      if (!waived) {
        const raw = flags.reportFile === "-" ? await ctx.readStdin() : await ctx.readFile(flags.reportFile);
        report = parseReport(raw);
        warnings.push(...reportWarnings(report));
        // The author is whoever is running the command, unless the report says.
        // `== null` on purpose: that is both `undefined` and `null`, and the
        // distinction carries no meaning here.
        if (report.author == null) report.author = ctx.actor;
      }

      const payload = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/deliver`, projectBody(TASK_OPS.deliver, {
        report,
        to: flags.to,
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
    summary: "Replay the epic rules and, with --workflow, return the board's workflow plan.",
    usage:
      'issue reconcile [--dry-run] [--workflow] [--assignee <agent>] ' +
      "[--review-aging-ms <n>] [--rework-max-rounds <n>] [--max-actions <n>] [--board-limit <n>]",
    positionals: [],
    flags: [
      {
        flag: "dry-run",
        key: "dryRun",
        as: "boolean",
        summary: "Report what would change; write nothing.",
      },
      {
        flag: "workflow",
        key: "workflow",
        as: "boolean",
        summary: "Also return the board's workflow plan (reconcile → outcomes → dispatch).",
      },
      {
        flag: "assignee",
        key: "assignee",
        as: "string",
        value: "<agent>",
        summary: "The review card's assignee the plan dispatches to.",
      },
      {
        flag: "reviewer",
        key: "assignee",
        as: "string",
        value: "<agent>",
        summary: "Deprecated alias for --assignee.",
      },
      {
        flag: "review-aging-ms",
        key: "reviewAgingMs",
        as: "string",
        value: "<n>",
        summary: "Silent-review threshold, in milliseconds.",
      },
      {
        flag: "rework-max-rounds",
        key: "reworkMaxRounds",
        as: "string",
        value: "<n>",
        summary: "Delivery rounds since the last hold before a card is parked.",
      },
      {
        flag: "max-actions",
        key: "maxActions",
        as: "string",
        value: "<n>",
        summary: "Cap on the plan's actions.",
      },
      {
        flag: "board-limit",
        key: "boardLimit",
        as: "string",
        value: "<n>",
        summary: "Cap on the board snapshot read.",
      },
    ],
    async run(ctx) {
      const integerFlag = (name, value) => {
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(String(value).trim())) {
          throw usageError(`issue reconcile: ${name} needs a non-negative integer`, {
            fix: `pass ${name} <n>`,
          });
        }
        return Number(value);
      };
      const payload = await ctx.client.post("/api/v1/tasks/reconcile", {
        dry_run: ctx.flags.dryRun === true,
        workflow: ctx.flags.workflow === true ? true : undefined,
        assignee: ctx.flags.assignee,
        review_aging_ms: integerFlag("--review-aging-ms", ctx.flags.reviewAgingMs),
        rework_max_rounds: integerFlag("--rework-max-rounds", ctx.flags.reworkMaxRounds),
        max_actions: integerFlag("--max-actions", ctx.flags.maxActions),
        board_limit: integerFlag("--board-limit", ctx.flags.boardLimit),
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
      const workflow =
        payload.workflow === undefined
          ? ""
          : `\nworkflow: ${changed.length} reconcile change(s), ` +
            `${payload.workflow.summary.actions} action(s), ` +
            `${payload.workflow.summary.alerts} alert(s)` +
            (payload.dry_run ? " (dry-run)" : "");
      return { data: payload, human: human + workflow };
    },
  },
];
