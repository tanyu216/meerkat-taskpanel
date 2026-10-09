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
 * `resolveTask` is exported because comments, relations and sessions all address
 * a task by the same `id-or-identifier` reference the CLI hands them.
 */

import { DomainError } from "../../shared/errors.mjs";
import {
  reportToWire,
  taskToWire,
  waiversFromActivities,
} from "../../shared/wire.mjs";
import { intOrUndefined, truthy } from "./projects.mjs";

/**
 * `PROJ-0007` or a UUID — whichever the caller has.
 * @param {object} repos
 * @param {string} ref
 */
export function resolveTask(repos, ref) {
  const task = repos.tasks.get(ref) ?? repos.tasks.findByIdentifierAnyProject(ref);
  if (task === null) {
    throw new DomainError("NOT_FOUND", { message: `no task ${ref}`, details: { taskRef: ref } });
  }
  return task;
}

/** Dictionary lookup for the wire projection (`display_name` for an id). */
export function lookupFor(repos) {
  return (kind, id) => repos.dictionary.getById(kind, id);
}

/** A task plus the audit trail a reviewer needs: who waived delivery, and why. */
export function taskPayload(repos, task) {
  return {
    task: taskToWire(task, { lookup: lookupFor(repos) }),
    report_waivers: waiversFromActivities(repos.activities.list({ taskId: task.id, limit: 1000 })),
  };
}

/** @param {object} router @param {{board: object}} surface */
export function registerTaskRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks", ({ query }) => {
    const statuses = query.getAll("status").filter((value) => value !== "");
    const filter = {
      ...(query.get("project_id") === null ? {} : { projectId: query.get("project_id") }),
      ...(statuses.length === 0 ? {} : { status: statuses.length === 1 ? statuses[0] : statuses }),
      ...(query.get("assignee_id") === null ? {} : { assigneeId: query.get("assignee_id") }),
      includeArchived: truthy(query.get("include_archived")),
      ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
      ...(intOrUndefined(query.get("offset")) === undefined ? {} : { offset: intOrUndefined(query.get("offset")) }),
    };
    const lookup = lookupFor(repos);
    return { tasks: commands.listTasks(filter).map((task) => taskToWire(task, { lookup })) };
  });

  router.post("/api/v1/tasks", ({ body, actor }) => {
    const task = commands.createTask({
      projectId: body.project_id,
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      kind: body.kind,
      labels: body.labels,
      meta: body.meta,
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
      reviewOf: body.review_of,
      parent: body.parent,
      target: body.target,
      actor,
    });
    return taskPayload(repos, task);
  });

  router.get("/api/v1/tasks/:ref", ({ params }) => taskPayload(repos, resolveTask(repos, params.ref)));

  router.patch("/api/v1/tasks/:ref", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const patch = {};
    for (const field of ["title", "description", "priority", "kind", "labels"]) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    // `--meta k=v` **merges** into what the task already carries, and
    // `--acceptance` is sugar over `meta.acceptance` (F-D1). Both are merges
    // because a CLI flag is a delta, not a document: sending
    // `--meta team=panel` must not silently erase everything else, and the
    // caller should not have to read-modify-write to say one thing.
    const meta = {};
    let metaTouched = false;
    if (body.meta !== undefined) {
      Object.assign(meta, body.meta);
      metaTouched = true;
    }
    if (body.acceptance !== undefined) {
      meta.acceptance = body.acceptance;
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
      actor,
    });
    return taskPayload(repos, task);
  });

  router.post("/api/v1/tasks/:ref/move", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const task = commands.moveStatus({
      id: current.id,
      to: body.to,
      ifVersion: body.if_version,
      noReport: body.no_report === true,
      reason: body.reason,
      actor,
    });
    return { ...taskPayload(repos, task), status: task.status };
  });

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
      report: reportToWire(result.report),
      report_id: result.report?.id ?? null,
      round: result.report?.round ?? result.task.reportWaiverRound,
      status: result.task.status,
      waived: result.waived,
    };
  });

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
  });

  router.post("/api/v1/tasks/:ref/archive", ({ params, body, actor }) => {
    const current = resolveTask(repos, params.ref);
    const task = commands.archive({
      id: current.id,
      ifVersion: body.if_version,
      days: body.days,
      actor,
    });
    return taskPayload(repos, task);
  });

  router.get("/api/v1/tasks/:ref/reports", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    return { reports: commands.listReports({ taskId: task.id }).map(reportToWire) };
  });
}
