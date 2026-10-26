/**
 * The board data store (M6b · S3/S4).
 *
 * The single place that talks to `services/api.js` and holds the working set:
 * projects (in the **server's** order — never re-sorted here), the current
 * project's tasks, the actor roster, the label roster, filters, the open
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
// The reading of a kind (`human`? a platform? nothing?) lives in `lib/` so the
// pure row builders can use it without pulling Vue into their unit tests. It is
// re-exported here so a component has one import site.
import { actorMatches } from "../lib/assignee-filter.js";
import { isAgentKind, kindLabel, platformForActor, platformOfKind } from "../lib/actor-kind.js";

export { isAgentKind, kindLabel, platformForActor, platformOfKind };
import { safeFileName } from "../lib/attachments.js";
import { acceptanceWaitingTasks, payloadCommentOf } from "../lib/waiting-queue.js";
import {
  detailRefetch,
  invalidatesWaitingPayload,
  isKnownEvent,
  taskEventNeedsRefresh,
  tasklessNeedsReload,
} from "../lib/events.js";
import { createEventClient } from "../services/events.js";
import { t } from "../i18n/index.js";
import { errorTextKey } from "../i18n/messages.mjs";
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
 *
 * The terminal rows stay **empty** even though the domain now has the reopen
 * edge: that edge is audited (it requires a reason), so it must not ride the
 * generic move menu or a drag-and-drop, which cannot ask for one. The drawer's
 * dedicated Reopen control (`reopenTask` below) is its UI.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  backlog: Object.freeze(["todo", "canceled"]),
  todo: Object.freeze(["backlog", "in_progress", "blocked", "canceled"]),
  in_progress: Object.freeze(["in_review", "blocked", "todo", "canceled", AWAITING]),
  // 0034 — `todo` is the post-answer requeue (the asking worker had stopped);
  // `in_progress` stays for a worker that is still live.
  awaiting: Object.freeze(["in_progress", "todo", "canceled"]),
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
export function allowedTargets(status, task = null) {
  const base = ALLOWED_TRANSITIONS[status] ?? Object.freeze([]);
  // 0038 — an `off` card may go straight to done from in_progress.
  if (status === "in_progress" && task?.acceptance_mode === "off" && !base.includes("done")) {
    return Object.freeze([...base, "done"]);
  }
  return base;
}

/** @type {Record<string, any>} */
export const board = reactive({
  projects: [],
  /** id → `order_debug` entry (score/rank) from `/projects?order_debug=1`. */
  orderDebug: {},
  currentProjectId: null,
  tasks: [],
  // One actor list since 0019 (the `assignees`/`reporters` tables merged into
  // `actors`). Kept under the name the components already read; it now holds
  // every actor, not only assignees.
  assignees: [],
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
  /**
   * How many waiting-payload reads are in flight. The 「等你回复」view's own read:
   * `waitingTasks` comes off the task list, but each row's `since` comes from its
   * triggering comment, so a queue whose comments are still being read is not yet
   * a queue — the view shows its skeleton until this reaches zero. A counter, not
   * a flag, because the watcher can start a second read before the first lands.
   */
  waitingPending: 0,
});

/* --------------------------------------------------------------- accessors */

export const currentProject = computed(() => board.projects.find((p) => p.id === board.currentProjectId) ?? null);

/** id → project name, for a card's `data-project` scalar. */
const projectNames = computed(() => Object.fromEntries(board.projects.map((p) => [p.id, p.name])));

/**
 * The generic actor kinds name **no** platform — they say "an agent" / "a human",
 * not *which* agent. The dictionary's `platform` column is gone (0019): "which
 * agent" now belongs in `kind`, so an actor's platform is its kind — but only a
 * kind that actually names one. The generic kinds are skipped, which leaves the
 * platform badge absent exactly as it was while `platform` was never written; a
 * kind that carries a platform name fills it in.
 */

const platforms = computed(() =>
  Object.fromEntries(
    board.assignees
      // The kind is the platform when it names one; an agent written with only
      // the generic `agent` kind still gets a platform when its handle is one
      // (`platformForActor`). A human is never given one.
      .map((a) => [a.display_name, platformForActor(a.display_name, a.kind)])
      .filter(([, platform]) => platform !== null),
  ),
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
      // One predicate for the board, the activity feed and the waiting queue
      // (`lib/assignee-filter.js`): an **unassigned** card is in neither the
      // human row nor the agent row, and since 0023 a kind is a platform — so
      // `agent` means "not the human", never "the literal string `agent`".
      if (!actorMatches(assignee, task.assignee?.display_name ?? "", task.assignee?.kind, ME)) return false;
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
 * Is the current project's task read still in flight? This is the single signal
 * every view skeleton reads (`Board` / `List` / `Activity` / `Waiting`), and its
 * whole meaning is the pair: a read is running **and** its reading has not landed.
 *
 * `board.loaded` is what makes that distinction: the list re-reads the same
 * project every time its view is entered, and the live stream re-reads it on a
 * project-level event — neither is a reason to replace the cards on screen with
 * placeholders. A project switch (`selectProject`) is: it withdraws `loaded` and
 * clears `tasks` before the request leaves, so the previous project's cards can
 * never paint under the new project's name.
 */
export const projectLoading = computed(() => board.loading && !board.loaded);

/**
 * The cards the 「等你回复」view shows, and the number its nav pill prints.
 *
 * One predicate for both (design §8-05): the view and the count read the same
 * derivation, so they cannot disagree — and both are built on `visibleTasks`, so
 * a card hidden by an active filter is in neither.
 */
export const waitingTasks = computed(() => visibleTasks.value.filter(isAwaiting));

/**
 * The cards whose **delivery** waits on this human: an `in_review` card whose
 * own `acceptance_mode` is `human`, with its current-round reviews and
 * children resolved.
 *
 * Derived from `board.tasks` — the whole reading, unfiltered — rather than
 * `visibleTasks`: an acceptance is not a board column, so a status filter must
 * not make it disappear, and the derivation needs the children and review cards
 * that no filter was asked to show. It is a computed value, so when the live
 * stream replaces a review card or a child, the original's row appears without
 * re-reading the original.
 */
export const acceptanceTasks = computed(() => acceptanceWaitingTasks(board.tasks));

/**
 * The acceptance rows the assignee narrowing leaves.
 *
 * The **derivation** above runs over the whole reading (it needs children and
 * review cards no filter was asked to show); the narrowing is applied to its
 * result, never to its input — filtering the input would let a child assigned to
 * someone else count as resolved (`lib/waiting-queue.js#acceptanceRowsFrom`).
 *
 * Only the assignee condition applies: an acceptance is not a board column, so
 * a status/priority/label filter must not make it disappear.
 */
export const visibleAcceptanceTasks = computed(() =>
  acceptanceTasks.value.filter((task) =>
    actorMatches(assigneeFilterValue(), task.assignee?.display_name ?? "", task.assignee?.kind, ME),
  ),
);

/** The nav pill: the awaiting rows plus the acceptance rows the narrowing leaves. */
export const waitingCount = computed(() => waitingTasks.value.length + visibleAcceptanceTasks.value.length);

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
const waitingInflight = new Set();
const waitingGen = new Map();
let waitingDirty = false;

/**
 * Drop a card's cached payload after an event that can change its question.
 * A read that is already in flight is told to re-run rather than being allowed
 * to write the pre-event answer.
 */
function invalidateWaitingPayload(taskId) {
  waitingGen.set(taskId, (waitingGen.get(taskId) ?? 0) + 1);
  if (Object.hasOwn(board.waitingPayload, taskId)) {
    const next = { ...board.waitingPayload };
    delete next[taskId];
    board.waitingPayload = next;
  }
  if (waitingInflight.has(taskId)) waitingDirty = true;
  else void loadWaitingPayloads();
}

export async function loadWaitingPayloads() {
  const pending = waitingTasks.value.filter(
    (task) => board.waitingPayload[task.id] === undefined && !waitingInflight.has(task.id),
  );
  if (pending.length === 0) return;
  // This read is the queue's own: a row's `since` (and therefore the oldest-first
  // order) is unknown until its comment arrives, so the view shows its skeleton
  // while this is above zero. A counter because the awaiting set can change again
  // before the first fan-out lands.
  board.waitingPending += 1;
  try {
    await Promise.all(
      pending.map(async (task) => {
        // The generation at read time: an event that invalidates the payload
        // while this request is in flight makes its answer history.
        const generation = waitingGen.get(task.id) ?? 0;
        waitingInflight.add(task.id);
        try {
          const data = await api.taskComments(task.identifier, { limit: 50 });
          const comments = data.comments ?? [];
          // 0034 — the payload is the newest **question**, falling back to the
          // newest human comment for a card that predates the kind (the M1 rule).
          // The selector is the domain's `payloadOf`, mirrored in lib/.
          const payload = payloadCommentOf(comments);
          if ((waitingGen.get(task.id) ?? 0) === generation) {
            board.waitingPayload = { ...board.waitingPayload, [task.id]: payload };
          } else {
            waitingDirty = true;
          }
        } catch {
          if ((waitingGen.get(task.id) ?? 0) === generation) {
            board.waitingPayload = { ...board.waitingPayload, [task.id]: null };
          } else {
            waitingDirty = true;
          }
        } finally {
          waitingInflight.delete(task.id);
        }
      }),
    );
  } finally {
    board.waitingPending = Math.max(0, board.waitingPending - 1);
    if (waitingDirty) {
      waitingDirty = false;
      void loadWaitingPayloads();
    }
  }
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
  // One actor list now serves both rosters (0019): a reporter is an actor like
  // any other. The task reporter names are still folded in, so a name a card
  // carries but the dictionary has not (yet) returned still appears.
  const names = new Set(board.assignees.map((r) => r.display_name));
  for (const task of board.tasks) if (task.reporter?.display_name) names.add(task.reporter.display_name);
  return [...names];
});

/**
 * The identifier+title roster for parent / depends-on (B24).
 *
 * `id` rides along beside the identifier it is the roster key: the drawer's
 * candidate filter below compares against the board's own task ids, and reading
 * them off the roster is what lets that filter be one expression rather than a
 * second lookup into `board.tasks`.
 */
export const taskRoster = computed(() =>
  board.tasks.map((task) => ({
    id: task.id,
    name: task.identifier,
    identifier: task.identifier,
    title: task.title,
    keys: [task.identifier, task.title],
  })),
);

/**
 * The drawer's prerequisite candidates: the card roster **minus the open card
 * itself and its own parent chain** (both directions) — the two halves of the
 * set the board refuses.
 *
 * The board refuses a prerequisite two ways, and the picker mirrors both:
 *
 *   * an edge joining an ancestor and a descendant — `0019_block_chain.sql` and
 *     `domain/relation.mjs#assertBlockEdgeAllowed` refuse it with
 *     `RELATION_CYCLE`, because such a card can never be offered to the poll
 *     again. That half arrives as `parent_chain` (T-20261015-104813).
 *   * the card itself — `domain/relation.mjs#normalizeRelation` refuses a
 *     self-edge, from the drawer's own write path, with `SELF_REFERENCE`. A card
 *     is *not* on its own parent chain (that set is the ancestor/descendant half
 *     only), so this half has to be subtracted here or not at all
 *     (T-20261015-132952).
 *
 * The board is the guarantee; the picker's job is not to *offer* what the board
 * will refuse, since a refusal here is a dead end the reader cannot resolve from
 * the drawer. The two different codes are why this is one exclusion expressed
 * over two sources rather than a wider `parent_chain`.
 *
 * The chain half is the board's, not the browser's: `parent_chain` comes off the
 * card's own relations read (`GET /tasks/:ref/relations`), computed by the walks
 * the guard uses. The self half is the identity the drawer is already open on,
 * not a rule the browser re-implements. With neither to subtract (no open card,
 * no chain read) the roster is offered whole, exactly as it was before.
 *
 * The cross-project half of the same rule needs nothing here: the roster is
 * already one project's cards.
 *
 * @returns {{id: string, name: string, identifier: string, title: string}[]}
 */
export const dependsCandidates = computed(() => {
  const self = board.detail?.task?.id;
  const chain = board.detail?.relations?.parent_chain ?? [];
  if (self === undefined && chain.length === 0) return taskRoster.value;
  const excluded = new Set(chain);
  if (self !== undefined) excluded.add(self);
  return taskRoster.value.filter((entry) => !excluded.has(entry.id));
});

/* -------------------------------------------------------------- mutations */

function replaceTask(task) {
  // A card that names another project does not belong in this list. The live
  // stream can deliver a `task_updated` for the project the reader just left
  // (and a switch empties the list before its own read lands), so an unguarded
  // insert would prepend a foreign card into the new project's board.
  if (task?.project_id !== undefined && task.project_id !== board.currentProjectId) return;
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
    const next = board.projects[0]?.id ?? null;
    if (next !== board.currentProjectId) {
      // A project that vanished (removed by another writer, delivered by the live
      // stream) is a switch like any other: withdraw the reading and the cards, so
      // the view holds its skeleton until the adopted project's own read lands
      // rather than painting the gone project's data under the new name.
      board.currentProjectId = next;
      board.loaded = false;
      board.tasks = [];
    }
  }
}

export async function loadRosters() {
  const [actors, labels] = await Promise.all([
    api.actors({ limit: 200 }),
    api.labels({ limit: 200 }),
  ]);
  board.assignees = actors.entries ?? [];
  board.labels = labels.labels ?? [];
}

/**
 * Which task read owns the board. Two can overlap (a view entry and a project
 * switch, two quick project presses, the live stream and either), and only the
 * newest may commit: an older response that lands last must not repaint the list
 * with a project the reader has already left, nor clear the `loading` flag of a
 * read still in flight.
 */
let loadToken = 0;
/** Per-task live-refresh sequence: only the newest response may write. */
const taskRefreshSeq = new Map();
const taskRefreshTimers = new Map();

export async function loadTasks() {
  const projectId = board.currentProjectId;
  if (!projectId) {
    board.tasks = [];
    return;
  }
  const token = ++loadToken;
  board.loading = true;
  try {
    const data = await api.tasks({ project_id: projectId, include_archived: 0, limit: 500 });
    if (token !== loadToken || board.currentProjectId !== projectId) return;
    board.tasks = data.tasks ?? [];
    // The read landed, so the board may now say what it read — including "nothing"
    // (see `boardEmpty`). A throw skips this on purpose: a failed read is not a
    // reading, and the shell's error surface carries it instead.
    board.loaded = true;
    board.error = null;
  } catch (err) {
    // The shell's B17 panel is the document's one load-failure surface; a failed
    // project switch must not leave an empty board with no explanation.
    if (token === loadToken && board.currentProjectId === projectId) board.error = err;
    throw err;
  } finally {
    if (token === loadToken) board.loading = false;
  }
}

export async function refreshTask(taskId) {
  const seq = (taskRefreshSeq.get(taskId) ?? 0) + 1;
  taskRefreshSeq.set(taskId, seq);
  try {
    const data = await api.task(taskId);
    // Two events can overlap; a slower earlier response must not regress a card
    // a newer one already replaced.
    if (taskRefreshSeq.get(taskId) !== seq) return;
    const task = data?.task;
    if (!task) return;
    if (task.archived_at) {
      board.tasks = board.tasks.filter((item) => item.id !== taskId);
      if (board.detail?.task?.id === taskId) closeDetail();
      return;
    }
    replaceTask(task);
  } catch {
    /* a task that vanished mid-flight is not worth a toast */
  }
}

/** 100 ms per card: a burst of field edits costs one read, not one per frame. */
function scheduleTaskRefresh(taskId) {
  if (taskRefreshTimers.has(taskId)) clearTimeout(taskRefreshTimers.get(taskId));
  taskRefreshTimers.set(
    taskId,
    setTimeout(() => {
      taskRefreshTimers.delete(taskId);
      void refreshTask(taskId);
    }, 100),
  );
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
  // A press on the project already in force is not a switch: re-reading it would
  // withdraw the reading and flash the skeleton for a change nobody asked for.
  if (projectId === board.currentProjectId) return;
  board.currentProjectId = projectId;
  board.selectedRef = null;
  board.drawerState = "closed";
  board.detail = null;
  /** one project's reading never describes another — the view holds `data` until
   *  this project's own read lands (see `boardEmpty`). */
  board.loaded = false;
  // …and the cards go with the reading. Order matters only for the synchronous
  // window: `loaded` first, so no instant exists in which the emptied list reads
  // as "this project is empty" (`boardEmpty` needs both).
  board.tasks = [];
  await loadTasks();
}

/* ------------------------------------------------------------ task moves */

/**
 * Move a card, optimistically. The local status flips first; the request carries
 * `if_version` so a concurrent writer is detected rather than overwritten.
 *
 * A refusal is always read as a **code**, never as the wire's `message`
 * (T-20261014-152924 ④): the server's message describes the failing write
 * (`CHECK constraint failed: …` is what a reader saw here when the claim was not
 * released), while `errorTextKey` maps the code to a sentence in the reader's
 * language, with `error.generic` for anything unmapped. The version conflict
 * keeps its own surface (a sticky panel) *and* its sentence.
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
    const conflict = err instanceof ApiError && err.isVersionConflict;
    if (conflict) {
      // The panel carries the two versions the reader needs and the reload that
      // repairs them; the wire's prose is deliberately not copied into it.
      board.conflict = {
        identifier: task.identifier,
        expectedVersion: err.details?.expectedVersion ?? baseVersion,
        currentVersion: err.details?.currentVersion ?? null,
      };
    }
    // One sentence per refusal, chosen by its `code`. A conflict is sticky —
    // it needs the reader to act before the board is trustworthy again — and
    // every other refusal is an ordinary toast that expires on its own.
    const text = t(errorTextKey(err), task.identifier);
    if (conflict) pushStickyToast(text, "danger");
    else pushToast(text, "danger");
    throw err;
  }
}

/**
 * Reopen a terminal card to `todo`.
 *
 * Deliberately **not** optimistic: unlike a status flip, the server also
 * advances the delivery round and releases the finished row's `idem` /
 * `archived_at`, so the returned record is the only truthful one. The reason
 * is required by the service and recorded as a `task_reopened` activity.
 *
 * @param {object} task the wire task
 * @param {string} reason why the finished work is active again
 */
export async function reopenTask(task, reason) {
  const baseVersion = task.version;
  try {
    const data = await api.reopenTask(task.identifier, { reason, if_version: baseVersion });
    replaceTask(data.task);
    pushToast(`${t("toast.reopened")} · ${task.identifier} → ${t("status.todo")}`, "success");
    return data.task;
  } catch (err) {
    const conflict = err instanceof ApiError && err.isVersionConflict;
    if (conflict) {
      board.conflict = {
        identifier: task.identifier,
        expectedVersion: err.details?.expectedVersion ?? baseVersion,
        currentVersion: err.details?.currentVersion ?? null,
      };
    }
    const text = t(errorTextKey(err), task.identifier);
    if (conflict) pushStickyToast(text, "danger");
    else pushToast(text, "danger");
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
  try {
    const data = await api.addComment(ref, { body, kind: "discuss" });
    if (board.detail && board.detail.task?.identifier === ref) {
      // Newest first — the same order the drawer's read asks for (`order=desc`)
      // and the order the activity trail already uses. The author is the wire's
      // own ref (the browser is the local human), so the row does not flash a
      // different name and then change when the re-read lands.
      const author = data.comment?.author ?? { display_name: ME };
      board.detail = {
        ...board.detail,
        comments: [{ ...data.comment, author }, ...board.detail.comments],
      };
      patchTaskLocal(board.detail.task.id, {});
    }
    pushToast(t("toast.commented"), "success");
    return data.comment;
  } catch (err) {
    // One vocabulary for every refusal: the human sees why the comment did not
    // land, and the caller keeps the draft so it can be retried without retyping.
    pushToast(t(errorTextKey(err), ref), "danger");
    throw err;
  }
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
 * @param {{ifVersion?: number}} [options] the drawer may pin the version it opened
 *   with, so a dirty draft loses the race visibly instead of overwriting a remote edit
 */
export async function saveDetailField(field, value, options = {}) {
  const task = board.detail?.task;
  if (!task) return;
  const ifVersion = options.ifVersion ?? task.version;

  // T-20261014-212017-4 — the drawer's four new edit surfaces. Each one keeps
  // the M6b shape: state the new value locally, carry `if_version`, roll back on
  // a refusal **before** re-throwing so the drawer's state machine lands on
  // `error` with the board showing what is actually stored.
  //
  // `status` is deliberately not a PATCH: G6 (T-20261014-212017-2) records that
  // the server has no status patch on purpose, so a status edit is a **move** —
  // it inherits the state machine, the delivery gate and the claim lock, and
  // reaches `VERSION_CONFLICT`/`INVALID_TRANSITION`/`REPORT_REQUIRED` as codes
  // the drawer renders as sentences.
  if (field === "status") return saveDetailStatus(task, value);
  if (field === "priority") return patchDetailField(task, "priority", value, { priority: value }, ifVersion);
  if (field === "description") return patchDetailField(task, "description", value, { description: value }, ifVersion);

  const before = field === "labels" ? { labels: task.labels ?? [] } : { [field]: task[field] ?? null };
  const next =
    field === "labels"
      ? { labels: value }
      : { [field]: { ...(task[field] ?? {}), display_name: value, kind: personKind(field, value) } };

  patchTaskLocal(task.id, next);
  try {
    await adoptPatch(task, await api.patchTask(task.identifier, { [field]: value, if_version: ifVersion }));
  } catch (err) {
    patchTaskLocal(task.id, before);
    throw err;
  }
}

/**
 * Take only the **version** the write returned, and leave the rest of the record
 * as the local edit left it.
 *
 * Why this is needed at all: `if_version` is optimistic concurrency, and the
 * M6b path relied on the live stream's `task_updated` re-read to carry the new
 * version back. That is fine for one edit — the drawer is opened, read and
 * closed around it — but two edits in a row (choose a status, then a priority;
 * type a description and save) happen faster than a round trip, and the second
 * one would be refused as `VERSION_CONFLICT` on a version the board had already
 * moved past. The card's own acceptance asks for `--if-version` semantics *and*
 * a working surface, and those two only hold together if the writer keeps its
 * version current.
 *
 * The rest of the payload is deliberately **not** adopted: `updateTask` records
 * a `task_updated` activity and the live stream re-reads the task on every
 * activity, so the canonical form arrives by the path that owns it — whereas
 * copying the envelope here would let a payload that says nothing about this
 * card overwrite the edit that was just made.
 */
function adoptPatch(task, data) {
  const version = data?.task?.version;
  if (typeof version === "number" && version !== task.version) patchTaskLocal(task.id, { version });
  return data;
}

/**
 * A status edit is a **move** (see `saveDetailField`). Optimistic and
 * version-guarded exactly as the drag path is, but the refusal is *re-thrown*
 * rather than toasted here: the drawer owns the reporting for this surface, and
 * two voices for one refusal is one too many.
 *
 * @param {object} task the wire task
 * @param {string} to
 */
async function saveDetailStatus(task, to) {
  const from = task.status;
  if (to === from) return;
  patchTaskLocal(task.id, { status: to });
  try {
    const data = await api.moveTask(task.identifier, { to, if_version: task.version });
    replaceTask(data.task);
  } catch (err) {
    patchTaskLocal(task.id, { status: from });
    throw err;
  }
}

/**
 * A single-valued field that the server patches. `local` is what the record
 * states while the request is in flight; `before` is what it said.
 *
 * @param {object} task
 * @param {string} field
 * @param {unknown} value the wire value
 * @param {object} local the optimistic patch
 */
async function patchDetailField(task, field, value, local, ifVersion) {
  const before = { [field]: task[field] ?? null };
  patchTaskLocal(task.id, local);
  try {
    await adoptPatch(task, await api.patchTask(task.identifier, { [field]: value, if_version: ifVersion ?? task.version }));
  } catch (err) {
    patchTaskLocal(task.id, before);
    throw err;
  }
}

/* -------------------------------------------------- dependencies (T-212017-4) */

/**
 * A card's `depends_on`, resolved into the drawer's chips.
 *
 * `depends_on` is not a column and not a relation type: it is the **reverse view
 * of the `blocks` edge** (`T-20261014-212017-2` §④) — the wire's `blocked_by`
 * array, whose rows carry `source` = the prerequisite and `target` = this card.
 * The chip needs both the relation id (to remove the edge) and the
 * prerequisite's identifier (to show it), which is why this reads the relation
 * list rather than either of the task's own fields.
 *
 * @returns {{relationId: number, identifier: string, title: string}[]}
 */
export const detailDepends = computed(() => {
  const rows = board.detail?.relations?.blocked_by ?? [];
  const current = board.detail?.task?.id ?? null;
  return rows
    .filter((row) => row.target === current)
    .map((row) => {
      const other = board.tasks.find((item) => item.id === row.source);
      return {
        relationId: row.id,
        identifier: other?.identifier ?? row.source,
        title: other?.title ?? "",
      };
    });
});

/**
 * Add a `depends_on`: "this card waits on `identifier`" is stored as a `blocks`
 * edge with **source = the prerequisite** and target = this card.
 *
 * A cycle (including the one-node case, "this card depends on itself") is refused
 * by the board — `RELATION_CYCLE` / `SELF_REFERENCE` — and the drawer turns that
 * code into a sentence. The check is the server's: the board's relation guards
 * are the guarantee, and this client does not duplicate the graph walk it could
 * only get wrong.
 *
 * @param {string} identifier the prerequisite's identifier
 */
export async function addDepends(identifier) {
  const task = board.detail?.task;
  if (!task) return;
  const target = board.tasks.find((item) => item.identifier === identifier);
  const ref = target?.id ?? identifier;
  await api.addRelation(ref, { type: "blocks", target: task.id });
  await reloadDetailRelations();
}

/**
 * Remove a `depends_on` by its relation id. The board removes edges by id (there
 * is no `depends_on` sugar), and the id is what the chip carries.
 *
 * @param {number} relationId
 */
export async function removeDepends(relationId) {
  const task = board.detail?.task;
  if (!task) return;
  await api.removeRelation(task.identifier, relationId);
  await reloadDetailRelations();
}

/** Re-read the edges after a change, so the chips are the board's own answer. */
async function reloadDetailRelations() {
  const task = board.detail?.task;
  if (!task) return;
  board.detail = { ...board.detail, relations: await api.taskRelations(task.identifier) };
}

/* ------------------------------------------------ attachments (T-212017-4) */

/**
 * Upload a file onto the open card: the metadata row first, then the bytes.
 *
 * Two requests, deliberately. The board stores an attachment as a row **and** a
 * file, and the byte half is the endpoint that already owns the staging-plus-
 * rename write discipline (`src/server/routes/attachments.mjs`, T-20261013-014304).
 * The window between them is closed from this side: if the byte half fails, the
 * row is removed before the error propagates, so a failed upload does not leave
 * a zero-byte ghost in the list.
 *
 * All three of the board's refusals — over the 64 MiB limit, a type outside the
 * allow-list, a name that is not a name — arrive as codes and are rendered as
 * sentences by the caller.
 *
 * @param {File} file
 */
export async function uploadAttachment(file) {
  const task = board.detail?.task;
  if (!task) return null;
  const filename = safeFileName(file?.name);
  const created = await api.addAttachment(task.identifier, {
    filename,
    ...(file?.type ? { content_type: normaliseBrowserType(file.type) } : {}),
    size: Number.isFinite(file?.size) ? file.size : 0,
  });
  const id = created.attachment.id;
  try {
    await api.uploadAttachmentContent(id, file, created.attachment.content_type ?? "application/octet-stream");
  } catch (err) {
    await api.removeAttachment(id).catch(() => {});
    throw err;
  }
  await reloadDetailAttachments();
  return created.attachment;
}

/**
 * The browser's `File.type` carries parameters the board's allow-list does not
 * name (`text/plain;charset=utf-8` is not `text/plain`), and an empty type is
 * "no declaration" rather than an unknown one.
 *
 * @param {string} type
 * @returns {string|undefined}
 */
function normaliseBrowserType(type) {
  const base = String(type).split(";")[0].trim().toLowerCase();
  return base === "" ? undefined : base;
}

/** Remove an attachment for good (the board hard-deletes the row and its bytes). */
export async function removeAttachment(id) {
  await api.removeAttachment(id);
  await reloadDetailAttachments();
}

/** Re-read the file list after a change, so it is the board's own answer. */
async function reloadDetailAttachments() {
  const task = board.detail?.task;
  if (!task) return;
  const listing = await api.taskAttachments(task.identifier);
  board.detail = { ...board.detail, attachments: listing.attachments ?? [] };
}

/**
 * The kind a re-assignment writes into the optimistic record. A named roster
 * entry keeps its own kind; a name the board has never seen is `human`, the same
 * default the combobox gives an unknown handle (B22) — no platform is invented.
 */
function personKind(field, name) {
  if (field === "reporter") return "human";
  // The roster's kind **verbatim**, which is what the server will record too: since
  // 0023 the registry read reports the kind the person's references last recorded
  // — a platform, or the generic `agent` for one that has not named a platform.
  // Copying it is the point; narrowing it to a platform here would make the
  // optimistic record disagree with the answer that replaces it.
  return board.assignees.find((entry) => entry.display_name === name)?.kind ?? "human";
}

/* ------------------------------------------------------------------ detail */

/** Monotonic detail generation: an older fan-out may never land over a newer patch. */
let detailToken = 0;

export async function openDetail(identifier) {
  board.selectedRef = identifier;
  board.drawerState = "open";
  board.detail = null;
  const token = ++detailToken;
  /**
   * The card this read is *for* is still the card the reader is on. A switch to
   * another card while this one's fan-out is in flight makes this response
   * history: adopting it would put the first card's head over the second card's
   * name. (The drawer's loading skeleton is the same window — `detail === null`
   * while `drawerState === "open"`.)
   */
  const current = () => board.selectedRef === identifier && detailToken === token;
  try {
    const [taskData, relations, activities, sessions, reports] = await Promise.all([
      api.task(identifier),
      api.taskRelations(identifier).catch(() => ({ relations: [] })),
      // Newest first: `limit` with ASC returned the OLDEST 50 rows.
      api.taskActivities(identifier, { limit: 50, order: "desc" }).catch(() => ({ activities: [] })),
      api.taskSessions(identifier).catch(() => ({ sessions: [] })),
      api.taskReports(identifier).catch(() => ({ reports: [] })),
    ]);
    if (!current()) return;
    // Newest first, like the activity trail; the waiting-payload read below
    // stays ascending because `payloadCommentOf` scans the trail from its tail.
    const comments = await api.taskComments(identifier, { limit: 200, order: "desc" }).catch(() => ({ comments: [] }));
    if (!current()) return;
    // T-20261014-212017-4 / G2 — the attachment rows come from the `attachments`
    // **table**, not from `task.meta`. A board that predates the write surface
    // (or a card with none) answers `[]`, which is the drawer's empty state —
    // never an error, because "this card has no files" is not a failure.
    const attachments = await api.taskAttachments(identifier).catch(() => ({ attachments: [] }));
    if (!current()) return;
    board.detail = {
      task: taskData.task,
      reportWaivers: taskData.report_waivers ?? [],
      relations,
      activities: activities.activities ?? [],
      sessions: sessions.sessions ?? [],
      reports: reports.reports ?? [],
      comments: comments.comments ?? [],
      attachments: attachments.attachments ?? [],
    };
  } catch (err) {
    if (!current()) return;
    board.drawerState = "closed";
    // The wire's message is never shown (④) — the code names the sentence, and
    // the card's own ref makes it answer "which one?".
    pushToast(t(errorTextKey(err), identifier), "danger");
  }
}

export function closeDetail() {
  detailToken += 1;
  board.drawerState = "closed";
  board.selectedRef = null;
}

/**
 * Re-read only the drawer sub-resources an activity invalidated. The drawer is
 * a snapshot loaded by `openDetail`; this is what keeps it live without turning
 * every frame into a full fan-out.
 */
let detailWanted = new Set();
let detailTargetId = null;
let detailTimer = null;

function scheduleDetailRefresh(activity, taskId) {
  if (board.detail?.task?.id !== taskId) return;
  detailTargetId = taskId;
  for (const resource of detailRefetch(activity)) detailWanted.add(resource);
  if (detailTimer !== null) clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    detailTimer = null;
    const wanted = [...detailWanted];
    const target = detailTargetId;
    detailWanted = new Set();
    detailTargetId = null;
    void refreshDetail(wanted, target);
  }, 100);
}

async function refreshDetail(wanted, taskId) {
  const current = board.detail;
  if (current?.task?.id !== taskId) return;
  const identifier = current.task.identifier;
  const token = ++detailToken;
  const patch = {};
  const jobs = [];
  const want = new Set(wanted);

  const read = (resource, request, apply) => {
    if (!want.has(resource)) return;
    jobs.push(
      request()
        .then((data) => apply(data))
        .catch(() => {}),
    );
  };

  read("task", () => api.task(identifier), (data) => {
    if (data?.task) patch.task = data.task;
  });
  read("comments", () => api.taskComments(identifier, { limit: 200, order: "desc" }), (data) => {
    patch.comments = data.comments ?? [];
  });
  read("relations", () => api.taskRelations(identifier), (data) => {
    patch.relations = data;
  });
  read("activities", () => api.taskActivities(identifier, { limit: 50, order: "desc" }), (data) => {
    patch.activities = data.activities ?? [];
  });
  read("sessions", () => api.taskSessions(identifier), (data) => {
    patch.sessions = data.sessions ?? [];
  });
  read("reports", () => api.taskReports(identifier), (data) => {
    patch.reports = data.reports ?? [];
  });
  read("attachments", () => api.taskAttachments(identifier), (data) => {
    patch.attachments = data.attachments ?? [];
  });

  await Promise.all(jobs);
  // The drawer may have closed, switched cards, or been overtaken by a newer
  // refresh while these reads were in flight.
  if (detailToken !== token || board.detail?.task?.id !== taskId) return;

  if (patch.task) {
    if (patch.task.archived_at) {
      board.tasks = board.tasks.filter((item) => item.id !== taskId);
      closeDetail();
      return;
    }
    replaceTask(patch.task);
  }
  board.detail = { ...board.detail, ...patch };
}

/* -------------------------------------------------------------- live stream */

let client = null;
/** Unknown event names are warned about once, not once per frame. */
const unknownEvents = new Set();
let tasklessTimer = null;
let sharedTimer = null;

/**
 * One frame, routed to the smallest refresh that keeps every surface honest.
 *
 * Task-scoped events patch the card and the open drawer; task-less events reload
 * the shared lists. The relation case is the one asymmetry worth naming: the
 * activity hangs off `target`, so it must refresh `source` too.
 */
function handleActivity(activity, revision) {
  board.revision = Math.max(board.revision, revision);
  for (const listener of streamListeners) listener(activity);

  const event = activity?.event;
  if (!isKnownEvent(event) && !unknownEvents.has(event)) {
    unknownEvents.add(event);
    console.warn(`[board] unknown activity event: ${event}`);
  }

  const target = activity?.task_id;
  if (typeof target === "string" && target !== "") {
    if (invalidatesWaitingPayload(event)) invalidateWaitingPayload(target);
    if (taskEventNeedsRefresh(event) || !isKnownEvent(event)) scheduleTaskRefresh(target);

    // A relation names both ends; refreshing only the target would leave the
    // source card's drawer stale.
    const endpoints = new Set([target]);
    if (event === "relation_added" || event === "relation_removed") {
      for (const key of ["source", "target"]) {
        const id = activity?.changes?.[key];
        if (typeof id === "string" && id !== "") endpoints.add(id);
      }
    }
    for (const id of endpoints) {
      if (board.detail?.task?.id === id) scheduleDetailRefresh(activity, id);
    }

    // Project counts/order and the actor/label rosters move with task writes.
    // A trailing refresh keeps them honest without a read per frame.
    scheduleSharedRefresh();
  } else if (tasklessNeedsReload(event)) {
    scheduleTasklessReload();
  }
}

/** 250 ms trailing: one project/roster/task reload per burst. */
function scheduleTasklessReload() {
  if (tasklessTimer !== null) clearTimeout(tasklessTimer);
  tasklessTimer = setTimeout(async () => {
    tasklessTimer = null;
    try {
      await loadProjects();
    } catch {
      /* the shell's error surface owns a failed read */
    }
    try {
      await loadRosters();
    } catch {
      /* the roster is a suggestion; the board still renders */
    }
    try {
      await loadTasks();
    } catch {
      /* idem */
    }
  }, 250);
}

/** 2 s trailing: project counts/order and rosters are advisory, not card state. */
function scheduleSharedRefresh() {
  if (sharedTimer !== null) return;
  sharedTimer = setTimeout(async () => {
    sharedTimer = null;
    const before = board.currentProjectId;
    try {
      await loadProjects();
    } catch {
      /* a later event retries */
    }
    if (before !== board.currentProjectId) {
      try {
        await loadTasks();
      } catch {
        /* idem */
      }
    }
    try {
      await loadRosters();
    } catch {
      /* idem */
    }
  }, 2000);
}

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
    onActivity: handleActivity,
  });
  // Seed only a real reading. `seed(0)` would be a cursor, and the server would
  // faithfully replay the entire audit trail into a brand-new page.
  if (board.revision > 0) client.seed(board.revision);
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
  // `/meta` carries the current revision. Taking it before the stream opens is
  // what makes the first connection live rather than a replay of every activity
  // the board has ever recorded.
  try {
    const meta = await api.meta();
    board.revision = Number(meta?.revision) || board.revision;
  } catch {
    /* the board may be down; loadBoard reports it */
  }
  try {
    await loadBoard();
  } catch {
    /* board.error carries it; the shell renders B17 */
  }
  startEvents();
}
