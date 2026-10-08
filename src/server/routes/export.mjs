/**
 * Markdown export.
 *
 * The service renders, the **client writes**. `POST /api/v1/export` returns
 * `{cards: [{identifier, markdown}]}` and never touches a path the caller named:
 * a board reachable over the network must not be able to write into an arbitrary
 * directory because somebody passed `--out`.
 *
 * The rendering itself is core's (`renderCard`), which is what keeps
 * `taskctl export --md` byte-identical to the md golden fixtures.
 */

import { renderCard } from "../../core/index.mjs";

/** @param {object} router @param {{board: object}} surface */
export function registerExportRoutes(router, surface) {
  const { repos } = surface.board;

  router.post("/api/v1/export", ({ body }) => {
    const tasks = repos.tasks.list({
      ...(body.project_id === undefined || body.project_id === null ? {} : { projectId: body.project_id }),
      includeArchived: body.include_archived !== false,
      limit: 10_000,
    });
    return {
      cards: tasks.map((task) => ({
        identifier: task.identifier,
        task_id: task.id,
        markdown: renderCard(task, { repos, project: repos.projects.get(task.projectId) }),
      })),
    };
  });
}
