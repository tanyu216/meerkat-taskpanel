/**
 * Project routes: create, update, list, readme, and "which project owns this
 * working directory".
 *
 * `GET /api/v1/projects/current` is registered **before** `/:id` because routes
 * match in order — `current` is a literal, not an id.
 *
 * Bodies are snake_case (§F-C1); the projection to and from the domain's
 * camelCase happens here and in `shared/wire.mjs`, nowhere else.
 */

import { projectToWire } from "../../shared/wire.mjs";

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

  router.get("/api/v1/projects", ({ query }) => ({
    projects: commands
      .listProjects({ includeArchived: truthy(query.get("include_archived")) })
      .map(projectToWire),
  }));

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
  });

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
  });

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
  });

  router.get("/api/v1/projects/:id/readme", ({ params }) => ({
    readme: commands.readmeGet({ id: params.id }),
  }));

  router.put("/api/v1/projects/:id/readme", ({ params, body }) => {
    const project = commands.readmeSet({ id: params.id, readme: body.readme ?? null });
    return { project: projectToWire(project), readme: project.readme };
  });
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
