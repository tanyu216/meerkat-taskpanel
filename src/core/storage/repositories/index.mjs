/**
 * One bag of repositories over one connection.
 *
 * `src/core/commands` receives this and nothing else, which is what keeps the
 * command layer from reaching for `db` directly and (say) forgetting to map a
 * SQLite error.
 */

import { createActivitiesRepository } from "./activities.mjs";
import { createAgentSessionsRepository } from "./agent-sessions.mjs";
import { createAttachmentsRepository } from "./attachments.mjs";
import { createCommentsRepository } from "./comments.mjs";
import { createDictionaryRepository } from "./dictionary.mjs";
import { createProjectsRepository } from "./projects.mjs";
import { createRelationsRepository } from "./relations.mjs";
import { createReportsRepository } from "./reports.mjs";
import { createTasksRepository } from "./tasks.mjs";

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createRepositories(db) {
  return {
    projects: createProjectsRepository(db),
    tasks: createTasksRepository(db),
    relations: createRelationsRepository(db),
    comments: createCommentsRepository(db),
    reports: createReportsRepository(db),
    dictionary: createDictionaryRepository(db),
    sessions: createAgentSessionsRepository(db),
    attachments: createAttachmentsRepository(db),
    activities: createActivitiesRepository(db),
  };
}

export {
  createActivitiesRepository,
  createAgentSessionsRepository,
  createAttachmentsRepository,
  createCommentsRepository,
  createDictionaryRepository,
  createProjectsRepository,
  createRelationsRepository,
  createReportsRepository,
  createTasksRepository,
};
