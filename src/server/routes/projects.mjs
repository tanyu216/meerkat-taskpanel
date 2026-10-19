/**
 * Project routes: create, update, list, readme.
 *
 * A project carries no working-directory information (O3): the board stores no
 * path for it, and there is no "which directory is this?" endpoint. The mapping
 * from a local directory to a project lives on the agent side.
 *
 * `GET /api/v1/projects` is where DESIGN.md §20 lives: the list is returned **already
 * ordered** by the weight algorithm (activity over 7/30 days + creation age),
 * because §8 says the frontend consumes the order and must not recompute it.
 * The aggregation is a SQL join (`task_activities → tasks → project_id`) and
 * the ranking itself is the pure `shared/project-order.mjs`.
 *
 * Each entry also carries `taskCount` → `task_count`, the sidebar badge's
 * number. It is a plain `COUNT(*)` over the project's tasks and, unlike the
 * activity factors, is **independent of the order** — see `taskCountByProject`.
 *
 * Bodies are snake_case (§F-C1); the projection to and from the domain's
 * camelCase happens here and in `shared/wire.mjs`, nowhere else.
 */

import { PROJECT_ACTIVITY_WINDOW_DAYS, SSE_NOISE_EVENTS } from "../../shared/constants.mjs";
import { orderDebugEntry, rankProjects } from "../../shared/project-order.mjs";
import { projectToWire } from "../../shared/wire.mjs";
import { arr, obj, shape, str } from "../requests.mjs";

// Declared request schemas — the shape the contract snapshot freezes
// (`routes[].request`). See `src/server/requests.mjs` for the vocabulary and the
// "declared, not enforced" stance.

/** `GET /api/v1/projects` — the DESIGN.md §20 list, with the diagnostic `order_debug` opt-in. */
const LIST_QUERY = shape({ include_archived: str(), order_debug: str() });

/** `POST /api/v1/projects`. */
const CREATE_BODY = shape({
  id: str(),
  name: str(),
  labels: arr(str()),
  meta: obj(),
  readme: str(),
});

/** `PATCH /api/v1/projects/:id` — a partial update (`meta` merges, F-C3's sibling rule). */
const PATCH_BODY = shape({
  name: str(),
  labels: arr(str()),
  readme: str(),
  meta: obj(),
});

/** `PUT /api/v1/projects/:id/readme` — the whole document replaces whatever was there. */
const README_BODY = shape({ readme: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerProjectRoutes(router, surface) {
  const { commands } = surface.board;

  router.get("/api/v1/projects", ({ query }) => {
    const includeArchived = truthy(query.get("include_archived"));
    const activity = activityByProject(surface.board, { now: new Date(surface.board.ctx.now()) });
    const taskCounts = taskCountByProject(surface.board);
    const ranked = rankProjects(
      commands.listProjects({ includeArchived }).map((project) => ({
        ...project,
        ...(activity.get(project.id) ?? EMPTY_ACTIVITY),
        // The badge's number rides along with the entry so `projectToWire` can
        // project it without reaching for the database (it stays pure).
        taskCount: taskCounts.get(project.id) ?? 0,
      })),
    );
    return {
      projects: ranked.map((item) => projectToWire(item.entry)),
      // The escape hatch DESIGN.md §20 asks for: on request, ship the three raw factors,
      // their ranks and their normalised scores so the order can be reconciled
      // by hand. Off by default — it is a diagnostic, not board state.
      ...(truthy(query.get("order_debug")) ? { order_debug: ranked.map(orderDebugEntry) } : {}),
    };
  }, { query: LIST_QUERY });

  router.post("/api/v1/projects", ({ body, actor }) => {
    const project = commands.createProject({
      id: body.id,
      name: body.name,
      labels: body.labels,
      meta: body.meta,
      readme: body.readme,
      actor,
    });
    return { project: projectToWire(project) };
  }, { body: CREATE_BODY });

  router.get("/api/v1/projects/:id", ({ params }) => {
    const project = commands.getProject({ id: params.id });
    if (project === null || project === undefined) return { project: null };
    // Same badge number as the list route, so the single-project wire and the
    // list entry cannot disagree about how many tasks the project owns.
    const counts = taskCountByProject(surface.board, params.id);
    return { project: projectToWire({ ...project, taskCount: counts.get(project.id) ?? 0 }) };
  });

  router.patch("/api/v1/projects/:id", ({ params, body, actor }) => {
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.labels !== undefined) patch.labels = body.labels;
    if (body.readme !== undefined) patch.readme = body.readme;
    // `--meta k=v` merges, for the same reason it does on a task: a flag is a
    // delta, not a replacement document.
    if (body.meta !== undefined) {
      // A missing project is `updateProject`'s NOT_FOUND to raise; here we only
      // need whatever meta it currently has.
      const current = commands.getProject({ id: params.id });
      patch.meta = { ...(current?.meta ?? {}), ...body.meta };
    }
    const project = commands.updateProject({ id: params.id, patch, actor });
    return { project: projectToWire(project) };
  }, { body: PATCH_BODY });

  router.get("/api/v1/projects/:id/readme", ({ params }) => ({
    readme: commands.readmeGet({ id: params.id }),
  }));

  router.put("/api/v1/projects/:id/readme", ({ params, body, actor }) => {
    const project = commands.readmeSet({ id: params.id, readme: body.readme ?? null, actor });
    return { project: projectToWire(project), readme: project.readme };
  }, { body: README_BODY });
}

/** `?include_archived=1|true|yes` — query strings have no types, so be liberal. */
export function truthy(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** `?limit=50` — an integer, or undefined so the repository default applies. */
export function intOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** What a project with no activity in either window looks like (DESIGN.md §20). */
const EMPTY_ACTIVITY = Object.freeze({ a7: 0, a30: 0, lastActivityAt: null });

/**
 * Per-project activity counts for the DESIGN.md §20 windows.
 *
 * "Activity" is the reproducible definition the architecture fixes: the number
 * of `task_activities` rows in the window that belong to a task of the project,
 * **excluding pure heartbeats** (they bump the revision but change no board
 * state). Timestamps are ISO-8601 UTC, so a lexicographic `>=` is a
 * chronological one and no date parsing is needed.
 *
 * Rows with no task (`project_created`, the label GC's own entries) do not
 * belong to any project and are correctly absent from the join.
 *
 * @param {{db: object}} board
 * @param {{now?: Date}} [options]
 * @returns {Map<string, {a7: number, a30: number, lastActivityAt: string|null}>}
 */
export function activityByProject(board, options = {}) {
  const now = options.now ?? new Date();
  const since = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const noise = SSE_NOISE_EVENTS.map(() => "?").join(", ");
  const rows = board.db
    .prepare(
      `SELECT t.project_id AS project_id,
              SUM(CASE WHEN a.created_at >= ? THEN 1 ELSE 0 END) AS a7,
              COUNT(*) AS a30,
              MAX(a.created_at) AS last_activity
         FROM task_activities a
         JOIN tasks t ON t.id = a.task_id
        WHERE a.event NOT IN (${noise}) AND a.created_at >= ?
        GROUP BY t.project_id`,
    )
    .all(since(PROJECT_ACTIVITY_WINDOW_DAYS.a7), ...SSE_NOISE_EVENTS, since(PROJECT_ACTIVITY_WINDOW_DAYS.a30));

  const out = new Map();
  for (const row of rows) {
    out.set(row.project_id, {
      a7: Number(row.a7 ?? 0),
      a30: Number(row.a30 ?? 0),
      lastActivityAt: row.last_activity ?? null,
    });
  }
  return out;
}

/**
 * Per-project **task counts** — what the sidebar badge prints.
 *
 * This is deliberately *not* a ranking input and deliberately not the activity
 * count above: DESIGN.md §20 orders by trailing-window activity, while the badge is the
 * project's **total** number of tasks (every status, archived included, and
 * whatever order the list happens to be in). A project with no tasks is simply
 * absent from the map — the caller defaults it to `0` rather than inventing a
 * row here.
 *
 * @param {{db: object}} board
 * @param {string} [projectId] restrict to one project (the single-project route)
 * @returns {Map<string, number>} project id → task count
 */
export function taskCountByProject(board, projectId) {
  const where = projectId === undefined ? "" : " WHERE project_id = ?";
  const rows = board.db
    .prepare(`SELECT project_id, COUNT(*) AS n FROM tasks${where} GROUP BY project_id`)
    .all(...(projectId === undefined ? [] : [projectId]));

  const out = new Map();
  for (const row of rows) out.set(row.project_id, Number(row.n ?? 0));
  return out;
}
