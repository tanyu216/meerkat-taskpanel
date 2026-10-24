/**
 * Task routes — including the two that matter most for M2:
 *
 *   `POST /api/v1/tasks/:ref/move`     the delivery gate, visible
 *   `POST /api/v1/tasks/:ref/deliver`  the atomic "report + in_review"
 *
 * Both accept `--no-report`'s wire form (`no_report` + `reason`, F-B1); both
 * refuse it in the same places the core does, because this layer *is* core
 * called over HTTP — it validates nothing the commands do not.
 *
 * Addressing a card and projecting it to the wire are not this module's
 * business: `server/task-view.mjs` owns that seam, because five sibling routes
 * answer with a task too.
 */

import { TASK_KINDS, TASK_OPS } from "../../core/index.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { attachmentToWire, reportToWire, taskToWire, workflowToWire } from "../../foundation/wire.mjs";
import { arr, bool, int, intOrUndefined, project, REQUEST, shape, str, truthy } from "../requests.mjs";
import { lookupFor, resolveTask, taskPayload } from "../task-view.mjs";

// Declared request schemas — what the contract snapshot freezes
// (`routes[].request`); `src/server/requests.mjs` owns the vocabulary and the
// "declared, not enforced" stance. A field a handler reads but a declaration
// omits would be invisible to the contract, so these are written from the
// handler bodies below, field for field.

/**
 * `GET /api/v1/tasks` — the board read's filters.
 *
 * `order` selects between the existing `board` order and the opt-in `weight`
 * order; `order_debug` asks for the weight order's per-card projection (and, by
 * asking, selects that order). Both are the C-WEIGHT-1 contract's §7.1 surface.
 */
const LIST_QUERY = shape({
  project_id: str(),
  status: REQUEST.statuses, // `?status=a&status=b` — a repeated query param
  assignee_id: str(),
  // `assignee` is a free-text name resolved against the dictionary; it and
  // `assignee_id` are two spellings of the same filter and are refused together.
  assignee: str(),
  review_of: str(), // a task ref; resolved below to the structural id
  parent: str(), // a task ref; the child cards of that parent
  kind: str(),
  label: arr(str()), // repeated: every label must be present (exact display name)
  target: str(), // meta.target, compared as text
  meta: arr(str()), // repeated `key=value`; every pair must hold
  include_archived: str(),
  limit: str(),
  offset: str(),
  order: str(),
  order_debug: str(),
});

/** A `--meta` key the JSON path can name as one top-level property. */
const META_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * `?meta=key=value` pairs → `{key, value}`.
 *
 * The key whitelist keeps the JSON path well-formed (the path is a *bound
 * parameter*, never interpolated, so this is about correctness, not injection).
 * A value may itself contain `=`; only the first one splits.
 *
 * @param {string[]} pairs
 * @returns {{key: string, value: string}[]}
 */
function parseMetaFilters(pairs) {
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    const key = at === -1 ? "" : pair.slice(0, at);
    if (key === "" || !META_KEY.test(key)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `meta filter ${JSON.stringify(pair)} is not key=value with a [A-Za-z0-9_.-] key`,
        details: { field: "meta", received: pair },
      });
    }
    return { key, value: pair.slice(at + 1) };
  });
}

/** `GET /api/v1/tasks/candidates` — `assignee` is the one field the route insists on. */
const CANDIDATES_QUERY = shape(
  { assignee: str(), stale: str(), include_unassigned: str(), order: str(), order_debug: str() },
  ["assignee"],
);

// The six task bodies are **projected** from the command's own input declaration
// (`src/core/commands/tasks-input.mjs`), so this route's shape, the CLI's flags
// and the CLI's body all read from one record instead of three hand-kept lists.
// Adding a field there adds it here; `scripts/verify/route-request.mjs` still
// proves the projection equals what each handler below actually reads.

/** `POST /api/v1/tasks` — the create body, every field the command is handed. */
const CREATE_BODY = project(TASK_OPS.create);

/**
 * `POST /api/v1/tasks/reconcile` — the container sweep, and (with `workflow`)
 * the board's workflow plan.
 *
 * Without `workflow`, only `dry_run` is read: the sweep takes no scope, because
 * "every non-terminal epic" is the scope (commands/rollup.mjs#reconcileContainers).
 * `workflow` adds the review outcomes/dispatch decisions; the loop supplies its
 * own reviewer/age/cap knobs; the cards carry their own acceptance mode.
 */
const RECONCILE_BODY = shape({
  dry_run: bool(),
  workflow: bool(),
  reviewer: str(),
  review_aging_ms: int(),
  max_actions: int(),
  board_limit: int(),
});

/**
 * `PATCH /api/v1/tasks/:ref` — a partial update.
 *
 * `status` is deliberately absent: the route **refuses** it (`INVALID_TRANSITION`,
 * "use move or deliver"), and a declared shape lists what a route accepts, not
 * what it recognises in order to reject.
 */
const PATCH_BODY = project(TASK_OPS.update);

/** `POST /api/v1/tasks/:ref/move` — the transition, plus the audited waiver (F-B1). */
const MOVE_BODY = project(TASK_OPS.move);
/**
 * `POST /api/v1/tasks/:ref/reopen` — `done|canceled → todo`, with its reason.
 *
 * The destination is not on the wire: reopening has exactly one target, and a
 * caller that wants a general move uses `/move`. `reason` is the audited
 * exception; `if_version` is the same CAS the other writes carry.
 */
const REOPEN_BODY = project(TASK_OPS.reopen);
/**
 * `POST /api/v1/tasks/:ref/claim` — the claim/reclaim verb.
 *
 * A claim is not always a transition: a stale `in_progress` claim is reused,
 * re-claimed or taken over **without the status changing**, so it cannot ride
 * the move route (the transition table has no `in_progress → in_progress`).
 * This is the wire face of `commands.claim`.
 */
const CLAIM_BODY = project(TASK_OPS.claim);

/**
 * `POST /api/v1/tasks/:ref/deliver` — the report, or the waiver that replaces it.
 *
 * `to` is declared (optional — the command defaults it to `in_review`) but the
 * "a report *or* `no_report` + `reason`" rule is a conditional no `properties`
 * map can state, so it stays where it is enforced: `deliver` itself.
 */
const DELIVER_BODY = project(TASK_OPS.deliver);

/** `POST /api/v1/tasks/:ref/assign` — `assign` is `update` with the dictionary in play. */
const ASSIGN_BODY = project(TASK_OPS.assign);

/** `POST /api/v1/tasks/:ref/archive` — a soft delete, optionally backdated. */
const ARCHIVE_BODY = project(TASK_OPS.archive);

/**
 * `POST /api/v1/tasks/:ref/heartbeat` — the pulse of a live claim.
 *
 * The body is empty by design: the card is the path's `:ref` and the pulsing
 * actor is the caller's own identity, so there is nothing for a caller to send.
 * The declaration rides along anyway — it is what pairs this route with
 * `issue heartbeat` in `scripts/verify/route-request.mjs`.
 */
const HEARTBEAT_BODY = project(TASK_OPS.heartbeat);

/** @param {object} router @param {{board: object}} surface */
export function registerTaskRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks", ({ query }) => {
    const statuses = query.getAll("status").filter((value) => value !== "");
    // The filter names a card the caller has in hand, so it accepts either
    // spelling. `requireAnyRef` refuses an identifier that exists in two
    // projects rather than guessing, and a miss is `NOT_FOUND` — an empty page
    // would read as "this card has no reviews".
    const reviewOfRef = query.get("review_of");
    const parentRef = query.get("parent");
    const labels = query.getAll("label").filter((value) => value !== "");
    // Two spellings of one filter. Accepting both would silently pick one; the
    // caller has to say which scope it means.
    const assigneeName = query.get("assignee");
    const assigneeId = query.get("assignee_id");
    if (assigneeName !== null && assigneeId !== null) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "assignee and assignee_id are two spellings of one filter; send one",
        details: { fields: ["assignee", "assignee_id"] },
      });
    }
    // An unknown kind is a caller mistake, not an empty page — the declaration
    // states the vocabulary but does not enforce it.
    const kind = query.get("kind");
    if (kind !== null && !TASK_KINDS.includes(kind)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `unknown kind ${JSON.stringify(kind)}`,
        details: { field: "kind", received: kind, allowed: TASK_KINDS },
      });
    }
    const filter = {
      ...(query.get("project_id") === null ? {} : { projectId: query.get("project_id") }),
      ...(statuses.length === 0 ? {} : { status: statuses.length === 1 ? statuses[0] : statuses }),
      ...(assigneeId === null ? {} : { assigneeId }),
      // A name resolves to every dictionary entry it matches; no match is the
      // empty scope (`assigneeId: []` reads as `1 = 0`), never "no filter".
      ...(assigneeName === null ? {} : { assigneeId: commands.resolveAssigneeIds(assigneeName) }),
      ...(kind === null ? {} : { kind }),
      ...(labels.length === 0 ? {} : { labels }),
      ...(query.get("target") === null ? {} : { target: query.get("target") }),
      ...(query.getAll("meta").length === 0 ? {} : { metaEquals: parseMetaFilters(query.getAll("meta")) }),
      ...(reviewOfRef === null ? {} : { reviewOfId: resolveTask(repos, reviewOfRef).id }),
      ...(parentRef === null ? {} : { parentId: resolveTask(repos, parentRef).id }),
      includeArchived: truthy(query.get("include_archived")),
      ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
      ...(intOrUndefined(query.get("offset")) === undefined ? {} : { offset: intOrUndefined(query.get("offset")) }),
    };
    const lookup = lookupFor(repos);
    const { tasks, orderDebug } = commands.listOrderedTasks({
      ...filter,
      order: query.get("order") ?? undefined,
      orderDebug: truthy(query.get("order_debug")),
    });
    // One batched edge read: `parent_id` rides on every card so a client can
    // derive "is this a child?" without a second request (the waiting view does
    // exactly that). Scoped to the project when the read is.
    const parents = new Map(
      repos.relations.listParentEdges(filter.projectId).map((edge) => [edge.target, edge.source]),
    );
    return {
      tasks: tasks.map((task) => taskToWire(task, { lookup, parentId: parents.get(task.id) ?? null })),
      // Only present when asked for: the diagnostic is opt-in, and an always-on
      // re-derivation of every card's score would be paid by every board poll.
      ...(orderDebug === null ? {} : { order_debug: orderDebug }),
    };
  }, { query: LIST_QUERY });

  router.post("/api/v1/tasks", ({ body, actor }) => {
    // `target` is the card's own value, carried in its meta (the board owns no
    // project directory, so `target` is not a top-level create field). Folding
    // it into `meta` keeps the field working and feeds the idempotency key.
    const meta = body.target === undefined ? body.meta : { ...(body.meta ?? {}), target: body.target };
    const task = commands.createTask({
      projectId: body.project_id,
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      kind: body.kind,
      labels: body.labels,
      meta,
      identifier: body.identifier,
      sourcePath: body.source_path,
      assignee: body.assignee,
      assigneeKind: body.assignee_kind,
      assigneeId: body.assignee_id,
      reporter: body.reporter,
      reporterKind: body.reporter_kind,
      reporterId: body.reporter_id,
      forceCreate: body.force_create === true,
      // Creation idempotency (see `domain/idem.mjs`). A key match returns the
      // existing task with HTTP 200 — `task.id`/`identifier` *are* the answer —
      // so a re-submitted create is a no-op, not a second card.
      idem: body.idem,
      allowDup: body.allow_dup === true,
      // 0037 — the single acceptance decision; `review_required` is the legacy
      // alias the command layer still accepts for one release.
      acceptanceMode: body.acceptance_mode,
      reviewRequired: body.review_required,
      reviewOf: body.review_of,
      reviewRound: body.review_round,
      parent: body.parent,
      actor,
    });
    return taskPayload(repos, task);
  }, { body: CREATE_BODY });

  // The container backstop: replay "a child started ⇒ start the epic" and "all
  // children done ⇒ deliver the epic" over the board. Idempotent; `dry_run`
  // computes the plan and writes nothing. This is the repair path for writes
  // that bypassed the service hooks and for children attached after the fact.
  router.post("/api/v1/tasks/reconcile", ({ body }) => {
    if (body.workflow === true) {
      const result = commands.workflowTick({
        reviewer: body.reviewer ?? null,
        reviewAgingMs: body.review_aging_ms,
        maxActions: body.max_actions,
        boardLimit: body.board_limit,
        dryRun: body.dry_run === true,
      });
      return {
        dry_run: result.dryRun,
        scanned: result.scanned,
        actions: result.actions,
        workflow: workflowToWire(result.workflow),
      };
    }
    const result = commands.reconcileContainers({ dryRun: body.dry_run === true });
    // The wire is snake_case like every other route; the command layer is
    // camelCase like every other command.
    return { dry_run: result.dryRun, scanned: result.scanned, actions: result.actions };
  }, { body: RECONCILE_BODY });

  // The poll's read: which claimable cards does `assignee` have? Registered
  // before `/api/v1/tasks/:ref` so the literal `candidates` segment wins over
  // the parameterised one (router matches in registration order).
  router.get("/api/v1/tasks/candidates", ({ query }) => {
    const assignee = query.get("assignee");
    if (assignee === null || assignee.trim() === "") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "assignee is required",
        details: { field: "assignee" },
        hint: { fix: "GET /api/v1/tasks/candidates?assignee=<name>" },
      });
    }
    const { candidates, orderDebug } = commands.listOrderedCandidates({
      assignee: assignee.trim(),
      stale: truthy(query.get("stale")),
      includeUnassigned: truthy(query.get("include_unassigned")),
      order: query.get("order") ?? undefined,
      orderDebug: truthy(query.get("order_debug")),
    });
    return { candidates, ...(orderDebug === null ? {} : { order_debug: orderDebug }) };
  }, { query: CANDIDATES_QUERY });

  router.get("/api/v1/tasks/:ref", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    // The detail read carries the attachment metadata. The board list does not
    // (an unbounded array on every card), and neither do mutation responses —
    // `taskPayload` stays lean; this route composes the extra collection.
    return {
      ...taskPayload(repos, task),
      attachments: repos.attachments.listByTask(task.id).map(attachmentToWire),
    };
  });

  router.patch("/api/v1/tasks/:ref", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const patch = {};
    for (const field of ["title", "description", "priority", "kind", "labels"]) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    // `--meta k=v` **merges** into what the task already carries. The
    // acceptance baseline is not a meta key since 0032: `acceptance` appends to
    // `tasks.acceptance_json`, and `acceptance_drop` is the audited human prune.
    // Sending `--meta team=panel` must not silently erase anything else, so the
    // merge itself stays.
    const meta = {};
    let metaTouched = false;
    if (body.meta !== undefined) {
      Object.assign(meta, body.meta);
      metaTouched = true;
    }
    if (metaTouched) patch.meta = { ...(current.meta ?? {}), ...meta };
    if (body.status !== undefined) {
      throw new DomainError("INVALID_TRANSITION", {
        message: "status is not a patchable field — use move or deliver",
        details: { field: "status" },
        hint: { fix: `taskctl issue move ${current.identifier} <status>` },
      });
    }

    const task = commands.updateTask({
      id: current.id,
      ifVersion: body.if_version,
      patch,
      assignee: body.assignee,
      reporter: body.reporter,
      forceCreate: body.force_create === true,
      acceptanceMode: body.acceptance_mode,
      reviewRequired: body.review_required,
      reason: body.reason,
      acceptance: body.acceptance,
      acceptanceDrop: body.acceptance_drop,
      acceptanceRevision: body.acceptance_revision,
      actor,
    });
    return taskPayload(repos, task);
  }, { body: PATCH_BODY });

  router.post("/api/v1/tasks/:ref/move", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const task = commands.moveStatus({
      id: current.id,
      to: body.to,
      ifVersion: body.if_version,
      noReport: body.no_report === true,
      reason: body.reason,
      // A `todo → in_progress` move is a claim; `allow_steal` is its audited
      // override (T-20261009-230500).
      allowSteal: body.allow_steal === true,
      // M1 — the `awaiting` entry category (`E1..E5`), required only when the
      // destination is `awaiting`; the command layer is what enforces that.
      awaitingReason: body.awaiting_reason,
      // 0034 — the question an agent asks when it stops in `awaiting`; written
      // as a `question` comment in the same transaction as the move.
      question: body.question,
      // 0016 — the `blocked` card's class (`clarify`…`unknown`, SLA-inspection
      // contract §7), optional; written when the destination is `blocked`, and
      // cleared on any other destination. The command layer enforces both.
      blockedReason: body.blocked_reason,
      actor,
    });
    return { ...taskPayload(repos, task), status: task.status };
  }, { body: MOVE_BODY });

  // The reopen verb. Its own route (rather than a `/move` shape) so the reason
  // is part of the contract and the UI's drawer has a single, auditable action.
  router.post("/api/v1/tasks/:ref/reopen", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const task = commands.reopenStatus({
      id: current.id,
      ifVersion: body.if_version,
      reason: body.reason,
      actor,
    });
    return { ...taskPayload(repos, task), status: task.status };
  }, { body: REOPEN_BODY });

  // The claim/reclaim verb. `performClaim` decides between reuse, a stale
  // re-claim, and a takeover; the route only forwards the actor's intent.
  router.post("/api/v1/tasks/:ref/claim", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const result = commands.claim({
      id: current.id,
      ifVersion: body.if_version,
      allowSteal: body.allow_steal === true,
      reason: body.reason,
      checkBlockers: body.check_blockers === true,
      actor,
    });
    return {
      ...taskPayload(repos, result.task),
      status: result.task.status,
      reused: result.reused === true,
      stole: result.stole === true,
    };
  }, { body: CLAIM_BODY });

  router.post("/api/v1/tasks/:ref/deliver", ({ params, body, actor, session, seg }) => {
    const current = resolveTask(repos, params.ref);
    const result = commands.deliver({
      taskId: current.id,
      report: body.report ?? null,
      to: body.to,
      ifVersion: body.if_version,
      noReport: body.no_report === true,
      reason: body.reason,
      seg: body.seg ?? seg,
      sessionId: body.session_id ?? session,
      actor,
    });
    return {
      ...taskPayload(repos, result.task),
      report: reportToWire(result.report, { lookup: lookupFor(repos) }),
      report_id: result.report?.id ?? null,
      round: result.report?.round ?? result.task.reportWaiverRound,
      status: result.task.status,
      waived: result.waived,
    };
  }, { body: DELIVER_BODY });

  // The other half of a claim: the pulse a long-running card owes the board, so
  // its `heartbeat_at` stays inside the fresh window and the `heartbeat_stale`
  // SLA row never opens. It refreshes the heartbeat and **nothing else** — never
  // the status, never the holder — so pulsing cannot resurrect work somebody
  // else has finished, and only the holder can pulse at all (the repository's
  // `claimed_by = ?` predicate; a non-holder gets `EXECUTION_ACTIVE`).
  router.post("/api/v1/tasks/:ref/heartbeat", ({ params, actor }) => {
    const current = resolveTask(repos, params.ref);
    return taskPayload(repos, commands.heartbeat({ id: current.id, actor }));
  }, { body: HEARTBEAT_BODY });

  // `assign` is `update` with the dictionary in play. An id bypasses the
  // dictionary entirely (`patch`), a name goes through it (`assignee`/`reporter`)
  // — which is exactly the §4.4 contract, and why there is no add/rm command.
  router.post("/api/v1/tasks/:ref/assign", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const patch = {};
    if (body.assignee_id !== undefined) patch.assigneeId = body.assignee_id;
    if (body.reporter_id !== undefined) patch.reporterId = body.reporter_id;
    const task = commands.updateTask({
      id: current.id,
      ifVersion: body.if_version,
      patch,
      assignee: body.assignee,
      reporter: body.reporter,
      forceCreate: body.force_create === true,
      actor,
    });
    return taskPayload(repos, task);
  }, { body: ASSIGN_BODY });

  router.post("/api/v1/tasks/:ref/archive", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const task = commands.archive({
      id: current.id,
      ifVersion: body.if_version,
      days: body.days,
      actor,
    });
    return taskPayload(repos, task);
  }, { body: ARCHIVE_BODY });

  router.get("/api/v1/tasks/:ref/reports", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    const lookup = lookupFor(repos);
    return { reports: commands.listReports({ taskId: task.id }).map((report) => reportToWire(report, { lookup })) };
  });
}
