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
import { DomainError } from "../../foundation/errors.mjs";
import { resolveTask } from "../task-view.mjs";
import { bool, shape, str } from "../requests.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
const EXPORT_BODY = shape({ project_id: str(), ref: str(), include_archived: bool() });

/** @param {object} router @param {{board: object}} surface */
export function registerExportRoutes(router, surface) {
  const { repos } = surface.board;

  router.post("/api/v1/export", ({ body }) => {
    const projectId = body.project_id ?? null;
    const ref = body.ref ?? null;
    if (ref !== null && projectId !== null) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "ref and project_id are mutually exclusive",
        details: { fields: ["ref", "project_id"] },
      });
    }

    // `ref` is one card, addressed the same way every other route addresses it.
    // Archived cards resolve too: asking for a card by name is not a board
    // listing, so `include_archived` does not apply. The whole-board shape
    // keeps its default (archived included) exactly as before.
    const tasks = ref === null
      ? repos.tasks.list({
          ...(projectId === null ? {} : { projectId }),
          includeArchived: body.include_archived !== false,
          limit: 10_000,
        })
      : [resolveTask(repos, ref)];

    return {
      cards: tasks.map((task) => ({
        identifier: task.identifier,
        task_id: task.id,
        // The watcher stops itself when every card it follows is `done`; the
        // status rides along so a consumer never has to parse the markdown.
        status: task.status,
        markdown: renderCard(task, { repos }),
      })),
    };
  }, { body: EXPORT_BODY });
}
