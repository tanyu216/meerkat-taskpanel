/**
 * The command surface — everything a surface (CLI, HTTP) is allowed to do.
 *
 * Note what is *absent*: there is no `assignee`/`actor` add/remove/rename. The
 * dictionary has no management API by design (§4.4); it grows when tasks are
 * created or reassigned, and `listActors` is read-only.
 */

import * as agentSessions from "./agent-sessions.mjs";
import * as attachments from "./attachments.mjs";
import * as comments from "./comments.mjs";
import * as dictionary from "./dictionary.mjs";
import * as labels from "./labels.mjs";
import * as projects from "./projects.mjs";
import * as relations from "./relations.mjs";
import * as reports from "./reports.mjs";
import * as rollup from "./rollup.mjs";
import * as sla from "./sla.mjs";
import * as tasks from "./tasks.mjs";
import * as workflow from "./workflow.mjs";

export { createContext, actorOf, BOARD_ACTOR } from "./context.mjs";

/**
 * Bind every command to a context.
 *
 * @param {object} ctx from `createContext`
 */
export function createCommands(ctx) {
  return {
    // projects ---------------------------------------------------------------
    createProject: (input) => projects.createProject(ctx, input),
    ensureProject: (input) => projects.ensureProject(ctx, input),
    updateProject: (input) => projects.updateProject(ctx, input),
    getProject: (input) => projects.getProject(ctx, input),
    listProjects: (filter) => projects.listProjects(ctx, filter),
    readmeSet: (input) => projects.readmeSet(ctx, input),
    readmeGet: (input) => projects.readmeGet(ctx, input),

    // tasks ------------------------------------------------------------------
    createTask: (input) => tasks.createTask(ctx, input),
    updateTask: (input) => tasks.updateTask(ctx, input),
    claim: (input) => tasks.claim(ctx, input),
    heartbeat: (input) => tasks.heartbeat(ctx, input),
    moveStatus: (input) => tasks.moveStatus(ctx, input),
    reopenStatus: (input) => tasks.reopenStatus(ctx, input),
    canMove: (input) => tasks.canMove(ctx, input),
    archive: (input) => tasks.archive(ctx, input),
    listTasks: (filter) => tasks.listTasks(ctx, filter),
    // The same two reads, carrying their `order_debug` projection (C-WEIGHT-1).
    listOrderedTasks: (filter) => tasks.listOrderedTasks(ctx, filter),
    listCandidates: (input) => tasks.listCandidates(ctx, input),
    listOrderedCandidates: (input) => tasks.listOrderedCandidates(ctx, input),
    getTask: (input) => ctx.repos.tasks.get(input.id ?? input.taskId),
    getTaskByIdentifier: (input) => ctx.repos.tasks.findByIdentifierAnyProject(input.identifier),
    // The container backstop: replay the epic start/close rules over the board
    // (commands/rollup.mjs). Idempotent; `dryRun` writes nothing.
    reconcileContainers: (input) => rollup.reconcileContainers(ctx, input),
    // The board's workflow decisions (commands/workflow.mjs): reconcile, then
    // the review outcomes/dispatch plan the loop executes. No review writes.
    workflowTick: (input) => workflow.workflowTick(ctx, input),
    // The SLA read (`docs/sla.md`): the six card/board rows over the board's
    // own facts and the effective `TASKD_SLA_*` table. Read-only.
    slaSnapshot: (input) => sla.slaSnapshot(ctx, input),

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
    // One read for one table (`0019`): the two role reads merged with the tables.
    listActors: (input) => dictionary.listActors(ctx, input),

    // labels (read-only by design; the GC is internal housekeeping) ----------
    listLabels: (input) => labels.listLabels(ctx, input),
    collectUnusedLabels: (input) => labels.collectUnusedLabels(ctx, input),

    // agent sessions ---------------------------------------------------------
    registerSession: (input) => agentSessions.registerSession(ctx, input),
    closeSession: (input) => agentSessions.closeSession(ctx, input),
    listSessions: (input) => agentSessions.listSessions(ctx, input),

    // attachments (the write half; reads stay on the repository) -------------
    addAttachment: (input) => attachments.addAttachment(ctx, input),
    storeAttachmentContent: (input) => attachments.storeAttachmentContent(ctx, input),
    removeAttachment: (input) => attachments.removeAttachment(ctx, input),
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
  "addActor",
  "removeActor",
  "renameActor",
  "createActor",
  "deleteActor",
]);

/**
 * Names the label surface deliberately does not expose (§4.4: no management
 * entry). Labels grow from use; there is no add/remove/rename anywhere.
 */
export const FORBIDDEN_LABEL_COMMANDS = Object.freeze([
  "addLabel",
  "removeLabel",
  "renameLabel",
  "createLabel",
  "deleteLabel",
  "archiveLabel",
  "setLabelColor",
]);
