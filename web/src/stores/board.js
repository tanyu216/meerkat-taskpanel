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

/**
 * The canonical statuses: the seven board stages, in board order, plus M1's
 * `awaiting` overlay appended after them.
 *
 * `awaiting` is **not** an eighth column. It is an attention state a card wears
 * while staying on its stage (`in_progress`), so it is deliberately *absent*
 * from `COLUMN_STATUSES` below — the board still renders exactly seven columns,
 * and the contract's `DOMAINS.STATUS` (which names the columns) is unchanged.
 * The vocabulary is here because the move menu, the i18n labels and the waiting
 * view all need to know the word.
 */
export const STATUSES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled", "awaiting"]);
/** M1 — running, but parked on a human. */
export const AWAITING = "awaiting";
/** The seven *stage* statuses — the board's columns, and `[data-card]`'s `data-status`. */
export const COLUMN_STATUSES = Object.freeze(STATUSES.filter((status) => status !== AWAITING));
/** The five priorities (contract `DOMAINS.PRIORITY`). */
export const PRIORITIES = Object.freeze(["urgent", "high", "medium", "low", "none"]);
/** The human owner the "Assignee: Me" filter resolves to (the prototype's `ME`). */
export const ME = "Terry";

/**
 * The card's **stage** — the status that names its column and its `data-status`.
 *
 * An `awaiting` card stays where it was (`in_progress`): the badge is an
 * overlay, not a column transfer. Everything that reads "which column is this
 * in" goes through here, so the two never disagree.
 *
 * @param {{status?: string}|null|undefined} task
 */
export function stageOf(task) {
  return task?.status === AWAITING ? "in_progress" : (task?.status ?? null);
}

/** Is this card waiting on a human? @param {{status?: string}} [task] */
export function isAwaiting(task) {
  return task?.status === AWAITING;
}

/**
 * The transitions the move menu may offer — a mirror of
 * `src/core/domain/status.mjs#ALLOWED_TRANSITIONS`, which is the one fact
 * source. The web mirrors it for the same reason it mirrors `DOMAINS.STATUS`:
 * the UI must not *offer* a move the server will refuse, and M1's rule is that
 * an `awaiting` card is offered no route to `in_review`, `done` or `blocked`
 * (design §6/§8-13) — the delivery gate's UI half.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  backlog: Object.freeze(["todo", "canceled"]),
  todo: Object.freeze(["backlog", "in_progress", "blocked", "canceled"]),
  in_progress: Object.freeze(["in_review", "blocked", "todo", "canceled", AWAITING]),
  awaiting: Object.freeze(["in_progress", "canceled"]),
  in_review: Object.freeze(["done", "in_progress", "blocked"]),
  blocked: Object.freeze(["todo", "in_progress", "in_review", "canceled"]),
  done: Object.freeze([]),
  canceled: Object.freeze([]),
});

/**
 * The statuses a card in `status` may move to, in menu order.
 * @param {string|undefined|null} status
 * @returns {readonly string[]}
 */
export function allowedTargets(status) {
  return ALLOWED_TRANSITIONS[status] ?? Object.freeze([]);
}

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
  /**
   * M1 — the 「等你回复」payload, per task id: the human comment that triggered
   * the entry (design §2.2). The list endpoint does not carry comments, so the
   * waiting view reads them; a card whose payload has not loaded yet renders
   * its summary line as absent rather than as an invented one.
   */
  waitingPayload: {},
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
  COLUMN_STATUSES.map((status) => ({
    status,
    // Bucketed by **stage**, so an `awaiting` card is listed under
    // `in_progress` — it never left its column (design §3.1/§8-08).
    tasks: visibleTasks.value.filter((task) => stageOf(task) === status),
  })),
);

export const totalVisible = computed(() => visibleTasks.value.length);

/**
 * The cards the 「等你回复」view shows, and the number its nav pill prints.
 *
 * One predicate for both (design §8-05): the view and the count read the same
 * derivation, so they cannot disagree — and both are built on `visibleTasks`, so
 * a card hidden by an active filter is in neither.
 */
export const waitingTasks = computed(() => visibleTasks.value.filter(isAwaiting));
export const waitingCount = computed(() => waitingTasks.value.length);

/**
 * The first sentence of a payload comment — the text up to the first
 * sentence-final punctuation (`。．.！!？?`) or the first newline, whichever
 * comes first, punctuation included.
 *
 * Mirrors `src/core/domain/awaiting.mjs#firstSentence`; the web cannot import
 * from `src/`, so the rule is restated here and asserted against a fixture
 * rather than trusted to stay in step.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function firstSentence(body) {
  const text = String(body ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n" || "。．.！!？?".includes(ch)) return text.slice(0, i + 1).trim();
  }
  return text.trim();
}

/**
 * Load the payload comment for every awaiting card of the current project.
 *
 * Read-only and idempotent: a card whose payload is already known is skipped,
 * so a re-entrant call (the view is re-entered, the board re-syncs) does not
 * re-fetch. A failure leaves that card's payload absent — never a fabricated
 * summary — and is swallowed per card, because one unreadable comment must not
 * blank the whole view.
 */
export async function loadWaitingPayloads() {
  const pending = waitingTasks.value.filter((task) => board.waitingPayload[task.id] === undefined);
  await Promise.all(
    pending.map(async (task) => {
      try {
        const data = await api.taskComments(task.identifier, { limit: 50 });
        const comments = data.comments ?? [];
        // The payload is the *newest human* comment (design §2.2/§2.3): an agent
        // comment written afterwards is commentary, not the question.
        const payload = [...comments].reverse().find((comment) => comment.author_kind === "human") ?? null;
        board.waitingPayload = { ...board.waitingPayload, [task.id]: payload };
      } catch {
        board.waitingPayload = { ...board.waitingPayload, [task.id]: null };
      }
    }),
  );
}

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
