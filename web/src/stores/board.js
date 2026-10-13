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
 * R11 ① — the status filter's value domain, in board order.
 *
 * The seven **stage** statuses, and deliberately not `awaiting`: the M1 overlay
 * is a state a card wears while staying on its stage, so it is not an eighth
 * column and not an eighth choice. This is the same derivation `COLUMN_STATUSES`
 * carries, so the menu's rows and the board's columns cannot disagree — the
 * contract's "no magic numbers" (R1) holds by construction, the way the
 * prototype's menu-as-domain does (`design/fidelity-r11.md` §2.1).
 */
export const STATUS_FILTER_KEYS = COLUMN_STATUSES;

/**
 * R13 — the assignee control's four **static** values (B04's own domain).
 * Anything else the control holds is a *given name*, written on demand: see
 * `writeAssigneeFilter()` and `namedAssignee()` below.
 */
export const ASSIGNEE_STATIC_VALUES = Object.freeze(["all", "me", "human", "agent"]);

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
  /**
   * Has a task read for the **current** project landed? `loading` says a read is
   * in flight; this says one has finished, which is the only thing that lets the
   * board view claim its `empty` state (see `boardEmpty`). Cleared when the
   * project changes, so one project's reading never describes another.
   */
  loaded: false,
  error: null,
  revision: 0,
  connection: "closed",
  filters: { search: "", assignee: "all", priority: "all", status: "all", label: "all" },
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

/**
 * R11 ① — the chosen statuses, in board order.
 *
 * `all` (and the empty string) is the un-filtered resting value, so the clause is
 * skipped rather than special-cased. Any other value is the comma-joined
 * selection, **restated in menu order on the way out** — one set is always one
 * string however it was built, which is what the control's own attribute holds
 * (`design/fidelity-r11.md` §2.1, `design/fidelity-r13.md` §2.8).
 *
 * @returns {string[]}
 */
export function statusFilterValues() {
  const raw = board.filters.status || "all";
  if (raw === "all") return [];
  const chosen = String(raw).split(",");
  return STATUS_FILTER_KEYS.filter((key) => chosen.includes(key));
}

/**
 * R11 ① — the single writer of the status condition. `[]` writes `all` (the
 * un-filtered state, the same thing a press on the menu's `all` row means).
 *
 * @param {readonly string[]} values
 */
export function writeStatusFilter(values) {
  const chosen = STATUS_FILTER_KEYS.filter((key) => values.includes(key));
  board.filters.status = chosen.length ? chosen.join(",") : "all";
}

/** The assignee control's current value, with `""`/`null` read as `all`. */
export function assigneeFilterValue() {
  const value = board.filters.assignee;
  return value == null || value === "" ? "all" : String(value);
}

/**
 * R13 — write the assignee condition. Apart from the four static values this
 * accepts a **given name** (the roster's own names), which is what makes a
 * roster press a narrowing and nothing more (`design/fidelity-r13.md` §10.1
 * row 1 — the press writes the value the way the control's own row would).
 *
 * @param {string} value
 */
export function writeAssigneeFilter(value) {
  board.filters.assignee = value;
}

/** The priority control's current value, with `""`/`null` read as `all`. */
export function priorityFilterValue() {
  const value = board.filters.priority;
  return value == null || value === "" ? "all" : String(value);
}

/**
 * R15 ② — the priority control's single writer, the assignee one's twin: the
 * dropdown's row press and `resetFilters()` both go through here, so the value
 * attribute, the chosen row's `aria-current` and the trigger's copy are one
 * write (`design/fidelity-r15.md` §2.2).
 *
 * @param {string} value
 */
export function writePriorityFilter(value) {
  board.filters.priority = value;
}

/**
 * R13 — the given name the control states, or `null` when it holds one of the
 * four static values. This is the **one** reading that drives the named
 * `<option>`, so the control's row set can never contradict its value
 * (`design/fidelity-r13.md` §2.8; with the `x` withdrawn in §10.1 row 4 the
 * on-demand option is the whole of what the name adds to the control).
 */
export const namedAssignee = computed(() =>
  ASSIGNEE_STATIC_VALUES.includes(board.filters.assignee) ? null : board.filters.assignee,
);

function matchesSearch(task, needle) {
  if (needle === "") return true;
  const hay = [task.identifier, task.title, ...(task.labels ?? [])].join(" ").toLowerCase();
  return hay.includes(needle);
}

export const visibleTasks = computed(() => {
  const { search, assignee, priority, label } = board.filters;
  const needle = search.trim().toLowerCase();
  const byStatus = statusFilterValues();
  return board.tasks.filter((task) => {
    if (!matchesSearch(task, needle)) return false;
    /* R13 — `me` is the local human, the two *kinds* compare the assignee's kind,
     * and everything else the control holds is a given name compared against the
     * card's own assignee. Before R13 the third arm did not exist: a name matched
     * nothing and every row came through, which is the defect Terry reported
     * (`design/fidelity-r13.md` §2.6). */
    if (assignee !== "all") {
      const name = task.assignee?.display_name ?? "";
      if (assignee === "me") {
        if (name !== ME) return false;
      } else if (assignee === "human" || assignee === "agent") {
        if (task.assignee?.kind !== assignee) return false;
      } else if (name !== assignee) {
        return false;
      }
    }
    if (priority !== "all" && priorityOf(task) !== priority) return false;
    /* R11 ① — multiple choice is **OR** (a card passes when it is in *any* chosen
     * status), and it is ANDed with the clauses above. The comparison is against
     * the card's own **stage** — the value `[data-card][data-status]` carries —
     * so the list shows the same cards the board's
     * `in_progress` / `in_review` columns show, M1's `awaiting` overlay included. */
    if (byStatus.length && !byStatus.includes(stageOf(task))) return false;
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
 * R10 ① / T-20261013-160505 — whether the board view is in its `empty` state,
 * and the one word a visible count cannot supply on its own: *has the board been
 * read yet?* `visibleTasks` projects whatever is in hand, so before the current
 * project's first read lands every board looks bare — and the view answered that
 * with the board-level no-results block ("No tasks match your filters" over a
 * Clear-filters button) on **every cold paint**, until the cards arrived.
 *
 * The design's own resting document settles which reading is the right one: it
 * ships `data-board-state="data"` with the no-results block `hidden`
 * (`design/prototype/index.html`, R10 ①) and only ever says `empty` from
 * `applyFilters()`, i.e. *after* it has read the cards. `empty` is a finding about
 * a board, never a statement made before there is one — so this reads the count
 * through `board.loaded`. A **failed** read is not a reading either (the B17
 * banner carries it and `loaded` stays false), and the list's own no-rows block
 * has gated on the same idea since M1 (`!board.loading`, `ListView.vue`).
 */
export const boardEmpty = computed(() => board.loaded && totalVisible.value === 0);

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
  const { search, assignee, priority, status, label } = board.filters;
  return [
    search.trim() !== "",
    assignee !== "all",
    priority !== "all",
    status !== "all",
    label !== "all",
  ].filter(Boolean).length;
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
    // The read landed, so the board may now say what it read — including "nothing"
    // (see `boardEmpty`). A throw skips this on purpose: a failed read is not a
    // reading, and the shell's error surface carries it instead.
    board.loaded = true;
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
  /** one project's reading never describes another — the view holds `data` until
   *  this project's own read lands (see `boardEmpty`). */
  board.loaded = false;
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

/* ------------------------------------------------------- detail auto-save */

/**
 * R10 ② — persist one editable field of the card the drawer has open:
 * `assignee`, `reporter` or `labels`.
 *
 * Optimistic in the same shape `moveTask` uses: the local record states the new
 * value first (the drawer reads it back immediately), the PATCH carries
 * `if_version` so a concurrent writer is detected rather than overwritten, and a
 * rejection rolls the record back **before** re-throwing, so the caller's state
 * machine lands on `error` with the board showing what is actually stored.
 *
 * The response is deliberately **not** read back as the record. `updateTask`
 * records a `task_updated` activity, and the live stream already re-reads the
 * task on every activity (`startEvents`), so the canonical form arrives by the
 * path that owns it — whereas assigning the envelope here would let a payload
 * that says nothing about this task overwrite the edit that was just made.
 *
 * @param {string} field one of `assignee` | `reporter` | `labels`
 * @param {string|string[]} value the wire value (`assignee`/`reporter` are names)
 */
export async function saveDetailField(field, value) {
  const task = board.detail?.task;
  if (!task) return;

  const before = field === "labels" ? { labels: task.labels ?? [] } : { [field]: task[field] ?? null };
  const next =
    field === "labels"
      ? { labels: value }
      : { [field]: { ...(task[field] ?? {}), display_name: value, kind: personKind(field, value) } };

  patchTaskLocal(task.id, next);
  try {
    await api.patchTask(task.identifier, { [field]: value, if_version: task.version });
  } catch (err) {
    patchTaskLocal(task.id, before);
    throw err;
  }
}

/**
 * The kind a re-assignment writes into the optimistic record. A named roster
 * entry keeps its own kind; a name the board has never seen is `human`, the same
 * default the combobox gives an unknown handle (B22) — no platform is invented.
 */
function personKind(field, name) {
  if (field === "reporter") return "human";
  return board.assignees.find((entry) => entry.display_name === name)?.kind ?? "human";
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

/**
 * R12x · B26 — the stream's other consumer.
 *
 * The activity view's ledger wants every event the board already receives, and
 * this is the seam that gives it them without a second connection and without a
 * cycle between the two stores: `board` owns the transport, and any store that
 * wants the tail subscribes here (see `stores/activity.js`).
 *
 * @type {Set<(activity: object) => void>}
 */
const streamListeners = new Set();

/** Subscribe to the live activity tail. Returns the unsubscribe. */
export function onActivityStream(listener) {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
}

export function startEvents() {
  if (client) return client;
  client = createEventClient({
    onStatus: (status) => {
      board.connection = status;
    },
    onActivity: (activity, revision) => {
      board.revision = Math.max(board.revision, revision);
      for (const listener of streamListeners) listener(activity);
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
