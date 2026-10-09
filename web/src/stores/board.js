/**
 * The board data store (M6b · S3/S4).
 *
 * The single place that talks to `services/api.js` and holds the working set:
 * projects (in the **server's** order — never re-sorted here), the current
 * project's tasks, the two people rosters, the label roster, filters, the open
 * task's detail, and the live cursor.
 *
 * Two rules this store exists to enforce:
 *
 *   * **Optimistic moves roll back visibly.** A drag updates the card
 *     immediately but remembers `baseVersion`; the `move` request carries
 *     `if_version`. On `409 VERSION_CONFLICT` the local change is reverted and a
 *     sticky, dismissible conflict panel appears — it is *never* retried with a
 *     bumped version and *never* silently overwritten (F4).
 *   * **The order is consumed, not computed** (`/projects?order_debug=1` ships
 *     the score; the sidebar prints it and sorts nothing) (O4).
 */
import { computed, reactive } from "vue";

import { api, ApiError } from "../services/api.js";
import { createEventClient } from "../services/events.js";
import { t } from "../i18n/index.js";
import { pushStickyToast, pushToast } from "./ui.js";

/** The seven board statuses, in board order (contract `DOMAINS.STATUS`). */
export const STATUSES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]);
/** The five priorities (contract `DOMAINS.PRIORITY`). */
export const PRIORITIES = Object.freeze(["urgent", "high", "medium", "low", "none"]);
/** The human owner the "Assignee: Me" filter resolves to (the prototype's `ME`). */
export const ME = "Terry";

/** @type {Record<string, any>} */
export const board = reactive({
  projects: [],
  /** id → `order_debug` entry (score/rank) from `/projects?order_debug=1`. */
  orderDebug: {},
  currentProjectId: null,
  tasks: [],
  assignees: [],
  reporters: [],
  labels: [],
  loading: false,
  error: null,
  revision: 0,
  connection: "closed",
  filters: { search: "", assignee: "all", priority: "all", label: "all" },
  selectedRef: null,
  drawerState: "closed",
  detail: null,
  conflict: null,
});

/* --------------------------------------------------------------- accessors */

export const currentProject = computed(() => board.projects.find((p) => p.id === board.currentProjectId) ?? null);
export const currentProjectName = computed(() => currentProject.value?.name ?? "");

/** id → project name, for a card's `data-project` scalar. */
const projectNames = computed(() => Object.fromEntries(board.projects.map((p) => [p.id, p.name])));

/** assignee display name → platform (the wire drops platform; the dictionary restores it). */
const platforms = computed(() =>
  Object.fromEntries(board.assignees.filter((a) => a.platform).map((a) => [a.display_name, a.platform])),
);

export function platformOf(name) {
  return platforms.value[name] ?? null;
}

export function projectNameOf(id) {
  return projectNames.value[id] ?? "";
}

export function priorityOf(task) {
  return PRIORITIES.includes(task?.priority) ? task.priority : "none";
}

/* ----------------------------------------------------------- filtered board */

function matchesSearch(task, needle) {
  if (needle === "") return true;
  const hay = [task.identifier, task.title, ...(task.labels ?? [])].join(" ").toLowerCase();
  return hay.includes(needle);
}

export const visibleTasks = computed(() => {
  const { search, assignee, priority, label } = board.filters;
  const needle = search.trim().toLowerCase();
  return board.tasks.filter((task) => {
    if (!matchesSearch(task, needle)) return false;
    if (assignee !== "all") {
      const name = task.assignee?.display_name ?? "";
      if (assignee === "me" && name !== ME) return false;
      if (assignee === "human" && task.assignee?.kind !== "human") return false;
      if (assignee === "agent" && task.assignee?.kind !== "agent") return false;
    }
    if (priority !== "all" && priorityOf(task) !== priority) return false;
    if (label !== "all" && !(task.labels ?? []).some((l) => l.toLowerCase() === label.toLowerCase())) return false;
    return true;
  });
});

export const columns = computed(() =>
  STATUSES.map((status) => ({ status, tasks: visibleTasks.value.filter((task) => task.status === status) })),
);

export const totalVisible = computed(() => visibleTasks.value.length);

export const activeFilterCount = computed(() => {
  const { search, assignee, priority, label } = board.filters;
  return [search.trim() !== "", assignee !== "all", priority !== "all", label !== "all"].filter(Boolean).length;
});

/** The label roster, read off the dictionary plus what the cards already carry. */
export const labelRoster = computed(() => {
  const byNorm = new Map();
  for (const entry of board.labels) if (!byNorm.has(entry.norm)) byNorm.set(entry.norm, entry.display_name);
  for (const task of board.tasks) {
    for (const name of task.labels ?? []) {
      const norm = name.trim().toLowerCase();
      if (!byNorm.has(norm)) byNorm.set(norm, name.trim());
    }
  }
  return [...byNorm.values()];
});

export const assigneeRoster = computed(() => board.assignees.map((a) => a.display_name));
export const reporterRoster = computed(() => {
  const names = new Set(board.reporters.map((r) => r.display_name));
  for (const task of board.tasks) if (task.reporter?.display_name) names.add(task.reporter.display_name);
  return [...names];
});

/** The identifier+title roster for parent / depends-on (B24). */
export const taskRoster = computed(() =>
  board.tasks.map((task) => ({ name: task.identifier, identifier: task.identifier, title: task.title, keys: [task.identifier, task.title] })),
);

/* -------------------------------------------------------------- mutations */

function replaceTask(task) {
  const index = board.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) board.tasks = [task, ...board.tasks];
  else board.tasks = board.tasks.map((item) => (item.id === task.id ? task : item));
  if (board.detail?.task?.id === task.id) board.detail = { ...board.detail, task };
}

function patchTaskLocal(id, patch) {
  board.tasks = board.tasks.map((item) => (item.id === id ? { ...item, ...patch } : item));
  if (board.detail?.task?.id === id) board.detail = { ...board.detail, task: { ...board.detail.task, ...patch } };
}

/* ------------------------------------------------------------------ loads */

export async function loadProjects() {
  const data = await api.projects({ order_debug: 1, include_archived: 1 });
  board.projects = data.projects ?? [];
  board.orderDebug = Object.fromEntries((data.order_debug ?? []).map((entry) => [entry.id, entry]));
  if (!board.projects.some((p) => p.id === board.currentProjectId)) {
    board.currentProjectId = board.projects[0]?.id ?? null;
  }
}

export async function loadRosters() {
  const [assignees, reporters, labels] = await Promise.all([
    api.assignees({ limit: 200 }),
    api.reporters({ limit: 200 }),
    api.labels({ limit: 200 }),
  ]);
  board.assignees = assignees.entries ?? [];
  board.reporters = reporters.entries ?? [];
  board.labels = labels.labels ?? [];
}

export async function loadTasks() {
  if (!board.currentProjectId) {
    board.tasks = [];
    return;
  }
  board.loading = true;
  try {
    const data = await api.tasks({ project_id: board.currentProjectId, include_archived: 0, limit: 500 });
    board.tasks = data.tasks ?? [];
    board.error = null;
  } finally {
    board.loading = false;
  }
}

export async function refreshTask(taskId) {
  try {
    const data = await api.task(taskId);
    if (data?.task) replaceTask(data.task);
  } catch {
    /* a task that vanished mid-flight is not worth a toast */
  }
}

/** Full (re)load of the board for the current project. */
export async function loadBoard() {
  board.loading = true;
  board.error = null;
  try {
    await loadProjects();
    await Promise.all([loadRosters(), loadTasks()]);
    board.revision = Math.max(board.revision, 0);
  } catch (err) {
    board.error = err;
    throw err;
  } finally {
    board.loading = false;
  }
}

export async function selectProject(projectId) {
  board.currentProjectId = projectId;
  board.selectedRef = null;
  board.drawerState = "closed";
  board.detail = null;
  await loadTasks();
}

/* ------------------------------------------------------------ task moves */

/**
 * Move a card, optimistically. The local status flips first; the request carries
 * `if_version` so a concurrent writer is detected rather than overwritten.
 *
 * @param {object} task the wire task
 * @param {string} to target status
 */
export async function moveTask(task, to) {
  const from = task.status;
  if (to === from || board.loading) return;
  if (!STATUSES.includes(to)) return;

  const baseVersion = task.version;
  patchTaskLocal(task.id, { status: to }); // optimistic
  try {
    const data = await api.moveTask(task.identifier, { to, if_version: baseVersion });
    replaceTask(data.task);
    const dangerous = to === "blocked" || to === "canceled";
    pushToast(`${t("toast.moved")} · ${task.identifier} → ${t(`status.${to}`)}`, dangerous ? "danger" : "success");
  } catch (err) {
    patchTaskLocal(task.id, { status: from }); // roll back, visibly
    if (err instanceof ApiError && err.isVersionConflict) {
      board.conflict = {
        identifier: task.identifier,
        expectedVersion: err.details?.expectedVersion ?? baseVersion,
        currentVersion: err.details?.currentVersion ?? null,
        message: err.message,
      };
      pushStickyToast(`${t("toast.moveConflict", task.identifier)}`, "danger");
    } else if (err?.code === "REPORT_REQUIRED") {
      pushToast(t("toast.reportRequired", task.identifier), "danger");
    } else if (err?.code === "INVALID_TRANSITION" || err?.code === "TERMINAL_STATE") {
      pushToast(t("toast.moveFailed", task.identifier), "danger");
    } else {
      pushToast(err?.message ?? t("toast.moveFailed", task.identifier), "danger");
    }
    throw err;
  }
}

/** Re-read the task in the conflict panel (the only recovery the UI offers). */
export async function reloadConflict() {
  const identifier = board.conflict?.identifier;
  board.conflict = null;
  if (identifier) await refreshTask(identifier);
}

/* --------------------------------------------------------- create / comment */

export async function createTask(payload) {
  const data = await api.createTask({ project_id: board.currentProjectId, ...payload });
  if (data?.task) replaceTask(data.task);
  pushToast(`${t("toast.created")} · ${data?.task?.identifier ?? ""}`, "success");
  return data.task;
}

export async function addComment(ref, body) {
  const data = await api.addComment(ref, { body, kind: "discuss" });
  if (board.detail && board.detail.task?.identifier === ref) {
    board.detail = { ...board.detail, comments: [...board.detail.comments, { ...data.comment, author: { display_name: ME } }] };
    patchTaskLocal(board.detail.task.id, {});
  }
  pushToast(t("toast.commented"), "success");
  return data.comment;
}

/* ------------------------------------------------------------------ detail */

export async function openDetail(identifier) {
  board.selectedRef = identifier;
  board.drawerState = "open";
  board.detail = null;
  try {
    const [taskData, relations, activities, sessions] = await Promise.all([
      api.task(identifier),
      api.taskRelations(identifier).catch(() => ({ relations: [] })),
      api.taskActivities(identifier, { limit: 50 }).catch(() => ({ activities: [] })),
      api.taskSessions(identifier).catch(() => ({ sessions: [] })),
    ]);
    const comments = await api.taskComments(identifier, { limit: 200 }).catch(() => ({ comments: [] }));
    board.detail = {
      task: taskData.task,
      reportWaivers: taskData.report_waivers ?? [],
      relations,
      activities: activities.activities ?? [],
      sessions: sessions.sessions ?? [],
      comments: comments.comments ?? [],
    };
  } catch (err) {
    board.drawerState = "closed";
    pushToast(err?.message ?? "failed to open", "danger");
  }
}

export function closeDetail() {
  board.drawerState = "closed";
  board.selectedRef = null;
}

/* -------------------------------------------------------------- live stream */

let client = null;

export function startEvents() {
  if (client) return client;
  client = createEventClient({
    onStatus: (status) => {
      board.connection = status;
    },
    onActivity: (activity, revision) => {
      board.revision = Math.max(board.revision, revision);
      const target = activity?.task_id;
      if (typeof target === "string" && target !== "") {
        refreshTask(target);
        if (board.detail?.task?.id === target) {
          api.taskComments(board.detail.task.identifier, { limit: 200 })
            .then((data) => {
              if (board.detail?.task?.id === target) board.detail = { ...board.detail, comments: data.comments ?? [] };
            })
            .catch(() => {});
        }
      } else {
        loadProjects().catch(() => {});
        loadTasks().catch(() => {});
      }
    },
  });
  client.seed(board.revision);
  client.connect();
  return client;
}

export function resync() {
  if (!client) return startEvents();
  client.resync();
  pushToast(t("toast.resynced"), "info");
  return client;
}

/** Wire the board up: initial load, then the live stream. Swallows the load error. */
export async function initBoard() {
  try {
    await loadBoard();
  } catch {
    /* board.error carries it; the shell renders B17 */
  }
  startEvents();
}
