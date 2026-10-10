/**
 * Project routes: create, update, list, readme, and "which project owns this
 * working directory".
 *
 * `GET /api/v1/projects/current` is registered **before** `/:id` because routes
 * match in order — `current` is a literal, not an id.
 *
 * `GET /api/v1/projects` is where §4.6 lives: the list is returned **already
 * ordered** by the weight algorithm (activity over 7/30 days + creation age),
 * because §8 says the frontend consumes the order and must not recompute it.
 * The aggregation is a SQL join (`task_activities → tasks → project_id`) and
 * the ranking itself is the pure `shared/project-order.mjs`.
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

/** `GET /api/v1/projects` — the §4.6 list, with the diagnostic `order_debug` opt-in. */
const LIST_QUERY = shape({ include_archived: str(), order_debug: str() });

/** `POST /api/v1/projects`. */
const CREATE_BODY = shape({
  id: str(),
  name: str(),
  workspace_path: str(),
  labels: arr(str()),
  meta: obj(),
  readme: str(),
});

/** `GET /api/v1/projects/current` — the directory to resolve to a project. */
const CURRENT_QUERY = shape({ path: str() });

/** `PATCH /api/v1/projects/:id` — a partial update (`meta` merges, F-C3's sibling rule). */
const PATCH_BODY = shape({
  name: str(),
  workspace_path: str(),
  labels: arr(str()),
  readme: str(),
  meta: obj(),
});

/** `PUT /api/v1/projects/:id/readme` — the whole document replaces whatever was there. */
const README_BODY = shape({ readme: str() });

/** The shape a "no project owns this directory" answer has (§F-C3). */
export function syntheticLocalProject(workspacePath) {
  return projectToWire({
    id: "local",
    name: "local",
    workspacePath,
    labels: [],
    meta: {},
    readme: null,
    archivedAt: null,
    createdAt: null,
    updatedAt: null,
  });
}

/** @param {object} router @param {{board: object}} surface */
export function registerProjectRoutes(router, surface) {
  const { commands } = surface.board;

  router.get("/api/v1/projects", ({ query }) => {
    const includeArchived = truthy(query.get("include_archived"));
    const activity = activityByProject(surface.board, { now: new Date(surface.board.ctx.now()) });
    const ranked = rankProjects(
      commands.listProjects({ includeArchived }).map((project) => ({
        ...project,
        ...(activity.get(project.id) ?? EMPTY_ACTIVITY),
      })),
    );
    return {
      projects: ranked.map((item) => projectToWire(item.entry)),
      // The escape hatch §4.6 asks for: on request, ship the three raw factors,
      // their ranks and their normalised scores so the order can be reconciled
      // by hand. Off by default — it is a diagnostic, not board state.
      ...(truthy(query.get("order_debug")) ? { order_debug: ranked.map(orderDebugEntry) } : {}),
    };
  }, { query: LIST_QUERY });

  router.post("/api/v1/projects", ({ body, actor }) => {
    const project = commands.createProject({
      id: body.id,
      name: body.name,
      workspacePath: body.workspace_path,
      labels: body.labels,
      meta: body.meta,
      readme: body.readme,
      actor,
    });
    return { project: projectToWire(project) };
  }, { body: CREATE_BODY });

  // "Which project is this directory part of?" — a read, so a miss must not
  // create anything. It answers with a synthetic `local` project and
  // `matched: false`, and says how to make it real.
  router.get("/api/v1/projects/current", ({ query }) => {
    const path = query.get("path") ?? "";
    const project = commands.projectForPath({ path });
    if (project !== null) return { project: projectToWire(project), matched: true, hint: null };
    return {
      project: syntheticLocalProject(path),
      matched: false,
      hint: {
        create: `taskctl project create --id local --name local --workspace-path ${path}`,
        note: "reads never create rows: run the command above if this directory should have a project",
      },
    };
  }, { query: CURRENT_QUERY });

  router.get("/api/v1/projects/:id", ({ params }) => {
    const project = commands.getProject({ id: params.id });
    return { project: projectToWire(project) };
  });

  router.patch("/api/v1/projects/:id", ({ params, body, actor }) => {
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.workspace_path !== undefined) patch.workspacePath = body.workspace_path;
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

  router.put("/api/v1/projects/:id/readme", ({ params, body }) => {
    const project = commands.readmeSet({ id: params.id, readme: body.readme ?? null });
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

/** What a project with no activity in either window looks like (§4.6). */
const EMPTY_ACTIVITY = Object.freeze({ a7: 0, a30: 0, lastActivityAt: null });

/**
 * Per-project activity counts for the §4.6 windows.
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
