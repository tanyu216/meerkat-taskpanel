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

import { orderDebugEntry, rankProjects } from "../../foundation/project-order.mjs";
import { projectToWire } from "../../foundation/wire.mjs";
import { REQUEST, arr, obj, shape, str, truthy } from "../requests.mjs";

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
  review_policy: REQUEST.reviewPolicy,
  reviewer: str(),
});

/** `PUT /api/v1/projects/:id` — create if absent; an existing row is untouched. */
const ENSURE_BODY = shape({
  name: str(),
  labels: arr(str()),
  meta: obj(),
  readme: str(),
  review_policy: REQUEST.reviewPolicy,
  reviewer: str(),
});

/** `PATCH /api/v1/projects/:id` — a partial update (`meta` merges, F-C3's sibling rule). */
const PATCH_BODY = shape({
  name: str(),
  labels: arr(str()),
  readme: str(),
  meta: obj(),
  review_policy: REQUEST.reviewPolicy,
  reviewer: str(),
});

/** `PUT /api/v1/projects/:id/readme` — the whole document replaces whatever was there. */
const README_BODY = shape({ readme: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerProjectRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/projects", ({ query }) => {
    const includeArchived = truthy(query.get("include_archived"));
    const activity = repos.projects.activityByProject({ now: new Date(surface.board.ctx.now()) });
    const taskCounts = repos.projects.taskCountByProject();
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
      reviewPolicy: body.review_policy,
      reviewer: body.reviewer,
      actor,
    });
    return { project: projectToWire(project) };
  }, { body: CREATE_BODY });

  router.put("/api/v1/projects/:id", ({ params, body, actor }) => {
    const { project, created } = commands.ensureProject({
      id: params.id,
      name: body.name,
      labels: body.labels,
      meta: body.meta,
      readme: body.readme,
      reviewPolicy: body.review_policy,
      reviewer: body.reviewer,
      actor,
    });
    // Same badge number as the list route, so an ensure response and a later
    // list entry cannot disagree about how many tasks the project owns.
    const counts = repos.projects.taskCountByProject(params.id);
    return {
      project: projectToWire({ ...project, taskCount: counts.get(project.id) ?? 0 }),
      created,
    };
  }, { body: ENSURE_BODY });

  router.get("/api/v1/projects/:id", ({ params }) => {
    const project = commands.getProject({ id: params.id });
    if (project === null || project === undefined) return { project: null };
    // Same badge number as the list route, so the single-project wire and the
    // list entry cannot disagree about how many tasks the project owns.
    const counts = repos.projects.taskCountByProject(params.id);
    return { project: projectToWire({ ...project, taskCount: counts.get(project.id) ?? 0 }) };
  });

  router.patch("/api/v1/projects/:id", ({ params, body, actor }) => {
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.labels !== undefined) patch.labels = body.labels;
    if (body.readme !== undefined) patch.readme = body.readme;
    if (body.review_policy !== undefined) patch.reviewPolicy = body.review_policy;
    if (body.reviewer !== undefined) patch.reviewer = body.reviewer;
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

/** What a project with no activity in either window looks like (DESIGN.md §20). */
const EMPTY_ACTIVITY = Object.freeze({ a7: 0, a30: 0, lastActivityAt: null });
