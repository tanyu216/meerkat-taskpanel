/**
 * The command surface — everything a surface (CLI, MCP, HTTP) is allowed to do.
 *
 * Note what is *absent*: there is no `assignee add/remove/rename`. The
 * dictionary has no management API by design (§4.4); it grows when tasks are
 * created or reassigned, and `listAssignees`/`listReporters` are read-only.
 */

import * as agentSessions from "./agent-sessions.mjs";
import * as comments from "./comments.mjs";
import * as dictionary from "./dictionary.mjs";
import * as projects from "./projects.mjs";
import * as relations from "./relations.mjs";
import * as reports from "./reports.mjs";
import * as tasks from "./tasks.mjs";

export { createContext, actorOf, SYSTEM_ACTOR } from "./context.mjs";

/**
 * Bind every command to a context.
 *
 * @param {object} ctx from `createContext`
 */
export function createCommands(ctx) {
  return {
    // projects ---------------------------------------------------------------
    createProject: (input) => projects.createProject(ctx, input),
    updateProject: (input) => projects.updateProject(ctx, input),
    getProject: (input) => projects.getProject(ctx, input),
    listProjects: (filter) => projects.listProjects(ctx, filter),
    projectForPath: (input) => projects.projectForPath(ctx, input),
    readmeSet: (input) => projects.readmeSet(ctx, input),
    readmeGet: (input) => projects.readmeGet(ctx, input),

    // tasks ------------------------------------------------------------------
    createTask: (input) => tasks.createTask(ctx, input),
    updateTask: (input) => tasks.updateTask(ctx, input),
    claim: (input) => tasks.claim(ctx, input),
    heartbeat: (input) => tasks.heartbeat(ctx, input),
    moveStatus: (input) => tasks.moveStatus(ctx, input),
    canMove: (input) => tasks.canMove(ctx, input),
    archive: (input) => tasks.archive(ctx, input),
    listTasks: (filter) => tasks.listTasks(ctx, filter),
    getTask: (input) => ctx.repos.tasks.get(input.id ?? input.taskId),
    getTaskByIdentifier: (input) => ctx.repos.tasks.findByIdentifierAnyProject(input.identifier),

    // reports ----------------------------------------------------------------
    writeReport: (input) => reports.writeReport(ctx, input),
    deliver: (input) => reports.deliver(ctx, input),
    listReports: (input) => reports.listReports(ctx, input),
    getReport: (input) => reports.getReport(ctx, input),

    // comments ---------------------------------------------------------------
    addComment: (input) => comments.addComment(ctx, input),
    listComments: (filter) => comments.listComments(ctx, filter),
    listDecisions: (input) => comments.listDecisions(ctx, input),

    // relations --------------------------------------------------------------
    addRelation: (input) => relations.addRelation(ctx, input),
    removeRelation: (input) => relations.removeRelation(ctx, input),
    listRelations: (input) => relations.listRelations(ctx, input),

    // dictionary (read-only by design) ---------------------------------------
    listAssignees: (input) => dictionary.listAssignees(ctx, input),
    listReporters: (input) => dictionary.listReporters(ctx, input),

    // agent sessions ---------------------------------------------------------
    registerSession: (input) => agentSessions.registerSession(ctx, input),
    closeSession: (input) => agentSessions.closeSession(ctx, input),
    listSessions: (input) => agentSessions.listSessions(ctx, input),
  };
}

/** Names the dictionary deliberately does not expose (asserted in the tests). */
export const FORBIDDEN_DICTIONARY_COMMANDS = Object.freeze([
  "addAssignee",
  "removeAssignee",
  "renameAssignee",
  "createAssignee",
  "addReporter",
  "removeReporter",
  "renameReporter",
  "createReporter",
]);
