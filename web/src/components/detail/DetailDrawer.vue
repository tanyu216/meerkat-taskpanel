<script setup>
/**
 * B09 · Task detail drawer, with B16's agent-session provenance and the drawer
 * families of the assignee/reporter (B22) and label (B25) controls.
 *
 * One drawer component renders for any card (the prototype's per-card
 * `<template>` clones are a jQuery mechanism; the *hooks* are the contract, the
 * template multiplicity is not). The drawer is toggled by **`data-state`** — the
 * one state source, which is C06's own vocabulary and is unchanged — and never by
 * a stylesheet rule; since R14 §8 U4 the `aside` carries no `hidden` attribute at
 * all, its closed face being the prototype's `translateX(100%)` +
 * `visibility: hidden` pair (`.td-drawer`, `app.css`). Escape closes through
 * `App.vue`'s own `keydown` arm (it calls `closeDetail`); this drawer restores
 * no focus to the opener.
 *
 * The body is **always in the document** — the contract counts hooks like
 * `[data-detail-labels]` with no `when` precondition, so they must exist while
 * the drawer is closed; only their values are empty at rest.
 */
import { computed, nextTick, ref, watch } from "vue";

import {
  board,
  addComment,
  addDepends,
  COLUMN_STATUSES,
  closeDetail,
  dependsCandidates,
  detailDepends,
  isAgentKind,
  kindLabel,
  labelRoster,
  platformOf,
  platformOfKind,
  priorityOf,
  removeAttachment,
  removeDepends,
  reporterRoster,
  saveDetailField,
  uploadAttachment,
} from "../../stores/board.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { activityLine, relativeTime } from "../../lib/activity.js";
import { attachmentRows } from "../../lib/attachments.js";
import { errorTextKey } from "../../i18n/messages.mjs";
import { api, ApiError } from "../../services/api.js";
import { pushToast } from "../../stores/ui.js";
import { has, t } from "../../i18n/index.js";

import ComboField from "../combo/ComboField.vue";
import MarkdownEditor from "../create/MarkdownEditor.vue";

const commentDraft = ref("");
const assigneeDraft = ref("");
const reporterDraft = ref("");
const labelDraft = ref([]);
/** The `depends_on` chips' identifiers (the edge itself lives on the board). */
const dependsDraft = ref([]);
/** Description is the one section with two faces; the attribute is the switch. */
const descriptionMode = ref("read");
const descriptionDraft = ref("");
/** The two in-place property menus (status / priority). */
const statusMenuOpen = ref(false);
const priorityMenuOpen = ref(false);
const fileInput = ref(null);
/** The id of the attachment whose download is in flight (the row's busy beat). */
const busyAttachment = ref("");

/** The drawer panel itself — the seat that takes focus when it opens (C2). */
const drawerEl = ref(null);

const detail = computed(() => board.detail);
const task = computed(() => detail.value?.task ?? null);
const open = computed(() => board.drawerState !== "closed" && task.value !== null);

const identifier = computed(() => task.value?.identifier ?? "");
const title = computed(() => task.value?.title ?? "");
const status = computed(() => task.value?.status ?? "backlog");
const priority = computed(() => priorityOf(task.value));
const versionText = computed(() => task.value?.version ?? "");
const idText = computed(() => task.value?.id ?? "");
const assigneeName = computed(() => task.value?.assignee?.display_name ?? "");
const reporterName = computed(() => task.value?.reporter?.display_name ?? "");
// A kind is a platform since 0023, so "is this an agent" is "is it not the human".
const isAgent = computed(() => isAgentKind(task.value?.assignee?.kind));
/**
 * The assignee's kind as the contract's own attribute value. The prototype
 * carries `data-assignee-kind="agent"` on the value row **and** on its avatar
 * (R14 §2.4 / A19); only an agent has a kind to state, so a human card leaves
 * the attribute off rather than writing an empty one.
 */
const assigneeKind = computed(() => kindLabel(task.value?.assignee?.kind));
// The card's own reference first (the act's platform), the registry aggregate as
// the fallback for a reference that recorded none.
const platform = computed(() => platformOfKind(task.value?.assignee?.kind) ?? platformOf(assigneeName.value));
const projectLabel = computed(() => board.projects.find((p) => p.id === task.value?.project_id)?.name ?? "");
const initial = (name) => (name ? name.charAt(0).toUpperCase() : "?");

const comments = computed(() => detail.value?.comments ?? []);
const activities = computed(() => detail.value?.activities ?? []);
const labelNames = computed(() => task.value?.labels ?? []);

/**
 * The attachment rows come from the **`attachments` table** — the listing
 * `openDetail` reads (`GET /api/v1/tasks/:ref/attachments`), which is the G2
 * ruling (T-20261014-212017-2: the table is the one source; `meta.attachments`
 * has no writer and is not introduced). With no task open there is nothing to
 * list *and* nothing to say about it, so the section renders neither rows nor
 * the "no attachments" state.
 */
const attachments = computed(() => attachmentRows(detail.value?.attachments));

/**
 * The two property menus' value domains, in the prototype's own order: the
 * seven **stage** statuses (not the eight-value `STATUSES`, which carries M1's
 * `awaiting` overlay — a state a card wears while staying on its stage, never a
 * menu row) and the five priorities ascending.
 */
const STATUS_MENU = COLUMN_STATUSES;
const PRIORITY_MENU = ["none", "low", "medium", "high", "urgent"];

/**
 * `done`/`canceled` are terminal (E-2): the drawer opens read-only, every
 * writable control is disabled, and the badge says why. Elon's reopen is a
 * privileged path and is deliberately not offered here.
 */
const readonly = computed(() => status.value === "done" || status.value === "canceled");

/**
 * The activity rows: actor + a localised sentence + a relative timestamp whose
 * `title` carries the absolute one. `event` is the core's vocabulary, so an
 * event without a catalogue sentence reads as its own name (see `lib/activity.js`).
 * `agent` picks the actor's face — an agent's handle is monospaced, exactly as
 * the prototype's `font-medium td-mono` states it (R14 D46).
 */
const activityRows = computed(() =>
  activities.value.map((row) => ({
    id: row.id,
    actor: row.actor_id ?? "—",
    agent: row.actor_kind === "agent",
    line: activityLine(row),
    stamp: relativeTime(row.created_at),
  })),
);

/**
 * The comment rows (B09's `[data-detail-comments]`): avatar, meta line and body.
 * The meta line names three things — the author, the kind, and when — and the
 * kind is the comment's own `decision` first, then the author's `agent`/`human`
 * (the catalogue's `comment.*` trio, R14 D40). A decision comment is *quoted*
 * (`[data-detail-comments] .td-comment-decision`) and its kind rides a chip, as
 * the prototype has it.
 */
const commentRows = computed(() =>
  comments.value.map((row) => {
    const name = row.author?.display_name ?? row.author_id ?? "—";
    const kind = row.author_kind ?? "human";
    const decision = row.kind === "decision";
    return {
      id: row.id,
      name,
      initials: initial(name),
      agent: kind === "agent",
      decision,
      stamp: relativeTime(row.created_at),
      body: row.body ?? "",
    };
  }),
);

/* ---------------------------------------------------------- v4 · tab shell */
/**
 * The drawer's six tabs, in the prototype's order (Sessions last: at 430px the
 * five existing tabs still fit one row, and only the new one wraps). The
 * Sessions tab is data-driven — `sessions.length > 0` — not assignee-kind:
 * the server does not tie a session to the card's assignee, so a human card can
 * carry real session rows and must show them.
 */
const TAB_ORDER = ["details", "activity", "reports", "acceptance", "leftovers", "sessions"];
const activeTab = ref("details");
const tabEls = new Map();
function setTabRef(name, el) {
  if (el) tabEls.set(name, el);
  else tabEls.delete(name);
}
const sessions = computed(() => detail.value?.sessions ?? []);
const hasSessions = computed(() => sessions.value.length > 0);
const tabs = computed(() =>
  TAB_ORDER.map((name) => ({
    name,
    key: `drawer.tab.${name}`,
    visible: name !== "sessions" || hasSessions.value,
  })),
);
function selectTab(name) {
  if (!tabs.value.find((tab) => tab.name === name)?.visible) return;
  activeTab.value = name;
}
function onTabKeydown(event) {
  const visible = tabs.value.filter((tab) => tab.visible).map((tab) => tab.name);
  const index = visible.indexOf(activeTab.value);
  if (index === -1) return;
  let next = null;
  if (event.key === "ArrowRight") next = (index + 1) % visible.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + visible.length) % visible.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = visible.length - 1;
  if (next === null) return;
  event.preventDefault();
  selectTab(visible[next]);
  nextTick(() => tabEls.get(visible[next])?.focus());
}
/* A different card starts on Details; a card without sessions can never leave
   a hidden Sessions tab selected. */
watch(() => task.value?.id, () => { activeTab.value = "details"; });
watch(hasSessions, (present) => {
  if (!present && activeTab.value === "sessions") activeTab.value = "details";
});

/**
 * The session trail: the running session first, then the closed/failed ones
 * newest-first. The API returns `ts ASC`, so the client owns this order; the
 * old single-session view picked `sessions[0]` — the OLDEST — when nothing was
 * running, which is the wrong handle to resume from.
 */
const sessionTrail = computed(() => {
  const rows = [...sessions.value];
  rows.sort((a, b) => {
    const ar = a.status === "running" ? 0 : 1;
    const br = b.status === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return String(b.ts ?? "").localeCompare(String(a.ts ?? ""));
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    backend: row.backend ?? "—",
    sessionId: row.session_id ?? "—",
    owner: row.owner ?? "—",
    seg: row.seg ?? null,
    phase: row.phase ?? null,
    running: row.status === "running",
    stamp: relativeTime(row.ts),
  }));
});

/* ------------------------------------------------------- v4 · report family */
/**
 * The report family (`GET /api/v1/tasks/:ref/reports`, `reportToWire`): the
 * Reports tab lists every round in the API's own ASC order; Acceptance reads
 * the latest round's criteria; Leftovers lists each round's remaining note.
 * The read is best-effort in `openDetail` (a board that predates the route
 * answers `[]`, which is the empty state — never an error).
 */
const reports = computed(() => detail.value?.reports ?? []);
const reportRows = computed(() =>
  reports.value.map((report) => {
    const name = report.author?.display_name ?? report.author_id ?? "—";
    return {
      id: report.id,
      round: report.round,
      conclusion: report.conclusion ?? "",
      author: name,
      agent: isAgentKind(report.author_kind),
      stamp: relativeTime(report.created_at),
    };
  }),
);
const latestReport = computed(() => {
  const rows = [...reports.value].sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
  return rows[0] ?? null;
});
const acceptanceRows = computed(() =>
  (latestReport.value?.acceptance ?? []).map((item, index) => ({
    id: `${latestReport.value?.id ?? "latest"}-${index}`,
    text: item?.text ?? "",
    status: item?.status ?? "not_applicable",
  })),
);
const leftoverRows = computed(() =>
  reports.value.map((report) => ({
    id: report.id,
    round: report.round,
    text: report.leftovers ?? "",
  })),
);

const peopleOptions = computed(() => board.assignees.map((entry) => ({ name: entry.display_name, kind: kindLabel(entry.kind), platform: platformOf(entry.display_name) })));
const reporterOptions = computed(() => reporterRoster.value.map((name) => ({ name })));
const labelOptions = computed(() => labelRoster.value.map((name) => ({ name })));

const descriptionHtml = computed(() => (task.value?.description ? renderMarkdown(task.value.description) : ""));

/** Identifier of a related task when the board knows it, else the raw id. */
function identifierOf(id) {
  return board.tasks.find((item) => item.id === id)?.identifier ?? id;
}

/**
 * R14 ① — the category word is the catalogue's, the way every other word in the
 * drawer is: `relations.<type>` over the three kinds the domain allows
 * (`parent`, `blocks`, `related` — `RELATION_TYPES`,
 * `src/core/domain/enums.mjs`). The wire's `type` is vocabulary, not copy, so it
 * used to reach the UI verbatim as a bare enum word. A kind the catalogue has
 * not named keeps its own wire value rather than rendering a bare
 * `relations.<type>` key — the same "read as its own name" fallback
 * `lib/activity.js` gives an unnamed event.
 */
const relationLinks = computed(() => {
  const rel = detail.value?.relations ?? {};
  return (rel.relations ?? []).map((row) => {
    const other = row.source === task.value?.id ? row.target : row.source;
    const key = `relations.${row.type}`;
    return { key: row.id, type: row.type, category: has(key) ? t(key) : row.type, label: identifierOf(other) };
  });
});

/* ----------------------------------------- R14 §2.1 C2 · focus enters the drawer */

/**
 * Focus enters the drawer, but **not** on the ✕. The prototype's
 * `focusWhenOpen($("[data-detail-close]"), $panel)` seats the default focus on
 * the close button; the product override is to put it on the drawer panel
 * itself instead (`tabindex="-1"` on the root: programmatically focusable, not
 * in the tab order). Keyboard focus still enters the dialog, and the ✕ stays
 * reachable with Tab — only the default seat changed.
 *
 * The move waits **one transition length** and only then focuses — and only if
 * the panel still reads `data-state === "open"`, which is the prototype's own
 * guard, so a drawer closed within that beat is never focused. (`focusWhenOpen`
 * is itself a 200 ms `setTimeout` around exactly that attribute check; the
 * app's panel transition is `--dur-2` = 180 ms, `styles/tokens.css`.)
 *
 * The wait is load-bearing, not cosmetic. `.td-drawer` is `visibility: hidden` on
 * its closed face and `visibility: visible` on its open one (R14 §8 U4: the panel
 * carries no `hidden` at all), and `visibility` is a *discrete* transition — at
 * progress 0 it still resolves to `hidden`, so on the first frame of the open
 * beat the panel is not focusable and a `.focus()` there is silently a no-op. A
 * `nextTick` flushes the *attribute*, not the style, so it lands inside that
 * frame. (082552 wrote the `nextTick` beat against the pre-U4 panel, whose
 * `hidden`/`display: none` was withdrawn synchronously; U4 is what makes the wait
 * necessary.)
 *
 * This is the *only* focus this component moves, and only ever **into** the
 * panel: Escape and the ✕ still close the drawer through `App.vue`'s keydown arm
 * exactly as before. (The card's "关闭回 opener" half has no drawer-side
 * implementation to preserve — `web/src` focuses nothing on close, and neither
 * does the prototype's `closeDetail`, which only clears `aria-selected` on the
 * cards. The opener-return the contract states is the access panel's,
 * `test/web/blocks.contract.mjs` B19.)
 */
const FOCUS_BEAT_MS = 200;
watch(open, (isOpen) => {
  if (!isOpen) return;
  window.setTimeout(() => {
    if (board.drawerState === "open") drawerEl.value?.focus();
  }, FOCUS_BEAT_MS);
});

/**
 * R14 D37 / BLOCKS.md §R14 — the relations row groups its links by kind, one
 * `.td-rel-item` per kind, each led by that kind's own catalogue name. The order
 * is the domain's own vocabulary order (`parent`, `blocks`, `related` —
 * `RELATION_TYPES`, `src/core/domain/enums.mjs`, which the web may not import
 * and therefore spells here, as the board store spells its transitions); a kind
 * outside the vocabulary still gets a group of its own, after the three, named
 * by its wire value so nothing goes missing. Groups merge links of one kind in
 * the order the wire returned them.
 */
const RELATION_ORDER = ["parent", "blocks", "related"];
/** The vocabulary rank of a kind; anything the vocabulary does not name sorts after it. */
const relationRank = (type) => {
  const index = RELATION_ORDER.indexOf(type);
  return index === -1 ? RELATION_ORDER.length : index;
};
const relationGroups = computed(() => {
  const groups = new Map();
  for (const link of relationLinks.value) {
    // T-20261014-212017-3 §4.4 — the `blocks` group is no longer a read-only
    // row. It is the card's `depends_on`, and the drawer owns it as an editable
    // chip control below; leaving the row in place would be a second source for
    // the same fact. The prototype withdraws exactly this one group and keeps
    // `parent` / `related` read-only.
    if (link.type === "blocks") continue;
    if (!groups.has(link.type)) groups.set(link.type, { type: link.type, category: link.category, links: [] });
    groups.get(link.type).links.push(link);
  }
  return [...groups.values()].sort((a, b) => relationRank(a.type) - relationRank(b.type));
});

/** `data-status` on the status chip/prop falls back to a valid domain value at rest. */
const statusValue = computed(() => status.value);

/* ------------------------------------------------- R10 ② · detail auto-save */

/**
 * How long `saved` stays up before the state returns to `idle`. It is a reading
 * beat, not a contract: the contract fixes the four states and that a commit
 * leaves `idle`, never how long any of them lasts (`design/fidelity-r10.md`
 * §5 C′7). The prototype's own demo beat is the same number.
 */
const SAVE_BEAT_MS = 420;

const saveState = ref("idle");
const saveError = computed(() => saveState.value === "error");

/**
 * The token decides which commit owns the state: a newer commit (or a failure
 * decided locally) invalidates the one in flight, so a slow response can never
 * overwrite the verdict of the edit that followed it. `savedTimer` is cleared on
 * every commit for the same reason — `saved` is only left behind by the commit
 * that actually reached it.
 */
let saveToken = 0;
let savedTimer = null;

/**
 * What each field said when the drawer was opened. A commit is "the value
 * moved", not "the field was touched": the drawer is opened, read and closed
 * constantly and none of that is a write (contract ②-11).
 */
let saveBaseline = { assignee: "", reporter: "", labels: [] };

/**
 * `assignee` and `reporter` are committed on focus loss; `labels` on a chip
 * arriving or leaving. A single-valued field that is blank after trimming is the
 * one failure the drawer can decide on its own, with no server involved — and it
 * is the only deterministic failure path a pure-frontend check can drive
 * (contract §2.2). A blank that did **not** move the field is not a failure: an
 * empty value left empty is a no-op, not an error.
 */
function commitField(field, raw) {
  const value = String(raw ?? "").trim();
  if (value === saveBaseline[field]) return;
  if (value === "") return failSave();
  void save(field, value);
}

/** The label set, which may legitimately be empty — so it has no failure path. */
function commitLabels() {
  const next = [...labelDraft.value];
  if (sameSet(next, saveBaseline.labels)) return;
  void save("labels", next);
}

async function save(field, value) {
  const token = (saveToken += 1);
  clearTimeout(savedTimer);
  saveState.value = "saving";
  try {
    await saveDetailField(field, value);
    if (token !== saveToken) return;
    saveBaseline = { ...saveBaseline, [field]: field === "labels" ? [...value] : value };
    saveState.value = "saved";
    savedTimer = setTimeout(() => {
      if (token === saveToken) saveState.value = "idle";
    }, SAVE_BEAT_MS);
  } catch {
    if (token !== saveToken) return;
    saveState.value = "error";
  }
}

/**
 * The same state machine for a commit that is **not** one value moving: the
 * drawer's four new surfaces write through their own store actions (a status
 * edit is a `move`, a `depends_on` edit is an edge add/remove, an upload is a
 * row plus its bytes), and a rejection must land on `error` exactly as a
 * PATCH's does.
 *
 * A failure is reported **twice, in the two registers the board already uses**
 * (T-20261014-152924 ④): the section's own alert — the prototype's
 * `[data-detail-save-error]`, the visible half of the state — and a toast
 * carrying the failure's `code` turned into a sentence by `errorTextKey`. The
 * alert says *that* it failed, the toast says *why* (a refused transition and a
 * lost version race need different repairs), and neither ever prints the wire's
 * own prose.
 *
 * @param {() => Promise<unknown>} commit
 */
async function runCommit(commit) {
  const token = (saveToken += 1);
  clearTimeout(savedTimer);
  saveState.value = "saving";
  try {
    await commit();
    if (token !== saveToken) return;
    saveState.value = "saved";
    savedTimer = setTimeout(() => {
      if (token === saveToken) saveState.value = "idle";
    }, SAVE_BEAT_MS);
  } catch (err) {
    if (token !== saveToken) return;
    saveState.value = "error";
    pushToast(t(errorTextKey(err), identifier.value), "danger");
  }
}

/* -------------------------------------------- status / priority (B22 menu) */

/** Only one property menu is open at a time, the way `.td-combo` behaves. */
function toggleStatusMenu() {
  const next = !statusMenuOpen.value;
  closePropMenus();
  statusMenuOpen.value = next;
}
function togglePriorityMenu() {
  const next = !priorityMenuOpen.value;
  closePropMenus();
  priorityMenuOpen.value = next;
}
function closePropMenus() {
  statusMenuOpen.value = false;
  priorityMenuOpen.value = false;
}

/**
 * Choose a status. It is a **move**, so the board's state machine, delivery
 * gate and claim lock all apply; an illegal transition comes back as
 * `INVALID_TRANSITION` and is rendered as a sentence rather than as a rule
 * number. The menu closes first — the reader's choice is made either way.
 */
async function chooseStatus(to) {
  closePropMenus();
  if (to === status.value) return;
  await runCommit(() => saveDetailField("status", to));
}

async function choosePriority(to) {
  closePropMenus();
  if (to === priority.value) return;
  await runCommit(() => saveDetailField("priority", to));
}

/* ------------------------------------------------- sentence (the md editor) */

function startDescriptionEdit() {
  if (readonly.value) return;
  descriptionDraft.value = task.value?.description ?? "";
  descriptionMode.value = "edit";
}

function cancelDescriptionEdit() {
  descriptionMode.value = "read";
  descriptionDraft.value = task.value?.description ?? "";
}

/**
 * Save the markdown. An empty description is the drawer's one deterministic
 * local failure — the same rule the single-valued people fields follow ("a
 * single-valued field that is blank is the one failure the drawer can decide on
 * its own", contract §2.2) — so it never reaches the board and the editor stays
 * open with the draft intact.
 */
async function saveDescription() {
  if (descriptionDraft.value.trim() === "") return failSave();
  await save("description", descriptionDraft.value);
  if (saveState.value !== "error") descriptionMode.value = "read";
}

/* ------------------------------------------------- depends_on (the DAG edge) */

/**
 * The chips are the card's `depends_on`, and the board stores each one as a
 * `blocks` edge. A change is therefore an **edge add or remove**, not a value:
 * the diff between what the control now holds and what the board returned is
 * replayed one edge at a time, and a refusal (a cycle, a self-reference, a
 * cross-project edge) stops the walk and lands on `error` with a sentence.
 *
 * The draft is re-read from the board afterwards rather than trusted, so what
 * the chips show is what is stored even when a refusal left the walk half done.
 */
async function commitDepends(next) {
  const current = detailDepends.value;
  const had = current.map((row) => row.identifier);
  const added = next.filter((x) => !had.includes(x));
  const removed = current.filter((row) => !next.includes(row.identifier));
  if (added.length === 0 && removed.length === 0) return;
  await runCommit(async () => {
    for (const id of added) await addDepends(id);
    for (const row of removed) await removeDepends(row.relationId);
  });
  dependsDraft.value = detailDepends.value.map((row) => row.identifier);
}

/* ------------------------------------------------------- attachments (files) */

function chooseFiles() {
  if (readonly.value) return;
  fileInput.value?.click();
}

/** Every file the picker returned, uploaded one at a time, in the order picked. */
async function onFiles(event) {
  const files = [...(event.target?.files ?? [])];
  event.target.value = "";
  for (const file of files) await runCommit(() => uploadAttachment(file));
}

/**
 * Download the stored bytes.
 *
 * The prototype's row shows a busy beat and transfers nothing — it has no
 * network at all (§⑨.2) — so the *behaviour* here is the implementation's: the
 * busy beat is kept (the reader gets the same acknowledgement) and the bytes are
 * fetched and handed to the browser as a file. A failure (a row whose bytes were
 * never stored answers an honest 404) is caught and reported as a sentence
 * rather than left to the browser's own console.
 */
async function downloadAttachment(row) {
  if (!row?.id) return;
  busyAttachment.value = row.id;
  try {
    const response = await fetch(api.attachmentContentUrl(row.id));
    if (!response.ok) throw new ApiError({ code: "NOT_FOUND", http: response.status });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = row.name;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    pushToast(t(errorTextKey(err), row.name), "danger");
  } finally {
    busyAttachment.value = "";
  }
}

async function removeAttachmentRow(row) {
  if (readonly.value) return;
  await runCommit(() => removeAttachment(row.id));
}

/** A local rejection is a verdict of its own: it takes the state and holds it. */
function failSave() {
  clearTimeout(savedTimer);
  saveToken += 1;
  saveState.value = "error";
}

/** Order-insensitive set equality — labels are a set, not a sequence. */
function sameSet(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Opening a card resets the state and takes that card's assignee and reporter as
 * the baseline, so the first edit is measured against what the card actually
 * said (`design/fidelity-r10.md` §2.2, "打开卡片即复位"). The drafts and the
 * baseline are written in the same act, which is what makes a re-fill — setting
 * the drafts from the newly opened task — not count as a commit: by the time the
 * draft watchers below flush, the baseline already agrees with them.
 */
function resetSave() {
  clearTimeout(savedTimer);
  saveToken += 1;
  saveState.value = "idle";
  saveBaseline = { assignee: assigneeName.value, reporter: reporterName.value, labels: [...labelNames.value] };
}

// Keep the drafts in step with whichever task is open.
watch(
  () => task.value?.id,
  () => {
    assigneeDraft.value = assigneeName.value;
    reporterDraft.value = reporterName.value;
    labelDraft.value = [...labelNames.value];
    commentDraft.value = "";
    // T-20261014-212017-4 — opening a card also resets the round's own four
    // surfaces: the description goes back to its rendered face with the card's
    // own markdown as the seed, the chips take the board's `blocked_by`, and both
    // property menus are closed. The read-only judgement is derived, so it needs
    // no resetting — it cannot outlive the card it belongs to (§4.5, "关抽屉即清除").
    descriptionMode.value = "read";
    descriptionDraft.value = task.value?.description ?? "";
    dependsDraft.value = detailDepends.value.map((row) => row.identifier);
    closePropMenus();
    busyAttachment.value = "";
    resetSave();
  },
  { immediate: true },
);

// The chips follow the board's own relations whenever they are re-read (an
// upload's SSE refresh can re-open the detail), so the control never shows a
// set the board does not have.
watch(
  () => detailDepends.value.map((row) => row.identifier).join("\u0000"),
  () => {
    const next = detailDepends.value.map((row) => row.identifier);
    if (next.join("\u0000") !== dependsDraft.value.join("\u0000")) dependsDraft.value = next;
  },
);

// Accepting a roster row rewrites the draft — that is the `change` half of the
// commit, and the blur half is the control's own `blur` event. Typing into a
// field moves neither, so typing alone commits nothing (contract C-14).
watch(assigneeDraft, () => commitField("assignee", assigneeDraft.value));
watch(reporterDraft, () => commitField("reporter", reporterDraft.value));
watch(labelDraft, () => commitLabels(), { deep: true });
watch(dependsDraft, () => commitDepends(dependsDraft.value), { deep: true });

async function submitComment() {
  const body = commentDraft.value.trim();
  if (!body || !task.value) return;
  await addComment(task.value.identifier, body);
  commentDraft.value = "";
}

/** The prototype reports a toast without touching the clipboard; so do we. */
function copyId() {
  pushToast(t("toast.copied"), "info");
}
</script>

<template>
  <!-- R8 ① — the veil is the shared scrim token, not its own alpha: the create
       dialogs wear it too, so every veil in the app deepens together in the dark
       (`design/fidelity-r8.md` §2.1). Its **light** appearance is byte-identical
       to what `bg-neutral` + `opacity-32` composited to. -->
  <!-- R14 D06/A22 — the veil sits at **z 40**, one rung *under* the drawer's 50:
       the pair the prototype states (`.td-scrim` / `.td-drawer`). It is also the
       half of the state pair that keeps a `hidden` attribute. -->
  <div class="fixed inset-0 z-40 bg-(--brand-scrim)" data-detail-overlay :data-state="board.drawerState" :hidden="!open" @click="closeDetail"></div>

  <!-- R14 §2.1 / §8 U4 — the drawer carries **no `hidden`**: `data-state` is the
       one state source (closed | open | closing) and the closed face is the
       prototype's own `translateX(100%)` + `visibility: hidden` pair, stated in
       `.td-drawer` (app.css). `aria-hidden` is gone with it — the prototype
       never had it, and the section is what "off screen" already means there.
       The scrim keeps `hidden`: that half of the pair *is* the contract's. -->
  <aside
    ref="drawerEl"
    class="td-drawer"
    data-detail-drawer
    tabindex="-1"
    :data-identifier="identifier"
    :data-state="board.drawerState"
    role="dialog"
    aria-modal="true"
    aria-labelledby="td-detail-title"
    :data-readonly="readonly && open ? 'true' : undefined"
  >
    <header class="td-drawer-head">
      <!-- R7 ④ — identifier, chip and the close button share one flex row, with
           the close pushed to its inline end (`ml-auto`). It used to be the
           header's third line, *below* the title: the prototype puts it in the
           top row, level with the identifier, and behind an `svg.td-icon` ✕
           rather than a text glyph. -->
      <div class="flex items-center gap-2">
        <!-- R8 ③ / R12 — the `title` and the drawer root's `data-identifier`
             carry the full value, and since R12 so does the text itself: the head
             shows the identifier **verbatim** (`design/fidelity-r12.md` §2.1),
             which is why it wears `.td-id-full` beside `.td-id` — the variant
             lifts the `9ch` width cap that would otherwise re-clip a long id
             (§2.2). The root's attribute is still the one thing that may be read
             back to resolve the task: the rendered text is a display value, and
             its being the whole id now is a coincidence of this round, not a
             licence to parse it (R8 §2.3, restated in R12 §2.1). -->
        <span class="td-mono text-xs text-(--brand-text-3) td-id td-id-full" data-detail-identifier :title="identifier">{{ identifier }}</span>
        <!-- The status chip is a dot **and** a word (B09/§2.4: colour is never
             the only signal). daisyUI's `badge-sm` owns the box, `td-chip` the
             brand's metrics, `td-chip-status` the 6px dot. -->
        <span class="badge badge-sm td-chip td-chip-status" data-detail-status-chip :data-status="statusValue">
          <span class="td-status-dot" aria-hidden="true"></span>
          <span data-detail-status-chip-label>{{ $t(`status.${statusValue}`) }}</span>
        </span>
        <!-- E-2 (T-20261014-212017-3) — a terminal card's drawer is read-only:
             the root states it, this badge says so, and every writable control
             below is disabled. Elon's reopen is a privileged path and is
             deliberately not offered here. -->
        <span class="badge badge-sm td-chip" data-detail-readonly :hidden="!(readonly && open)">{{ $t("drawer.readonly") }}</span>
        <!-- I-1 (T-20261014-154730) — the button **is** the design's `.td-iconbtn`,
             the same class the column header's `+` (F4) and the topbar filters
             toggle (F10) already wear. The design's `32×32` (§3) is that box, so
             the only honest way to state it is to wear it: the four utilities this
             carried (`ml-auto shrink-0 border-0 bg-transparent
             text-(--brand-text-3) cursor-pointer`) described a 16×16 box with no
             edge and the wrong ink, which is what the visual leg measured
             (`T-20261014-150729`, impl `16×16` vs proto `32×32`).
             `.td-iconbtn` is unlayered in `app.css`, so it outranks the `ml-auto`
             utility it still needs for the row-end push. -->
        <button
          type="button"
          class="td-iconbtn ml-auto"
          data-detail-close
          :aria-label="$t('drawer.close')"
          @click="closeDetail"
        >
          <svg class="td-icon size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <!-- R14 D20 — `aria-labelledby` on the root needs a seat to point at: the
           id lands on this `<h2>`, exactly as `design/prototype/index.html`
           carries it. The 16px/600 face is the prototype's own measured one
           (R14 §3): Tailwind's `text-lg` is 18px here, so the value is stated.

           I-1 (T-20261014-154730) — the *leading* is stated for the same reason
           and had been left to inherit: the design's `--text-lg` is the pair
           `16px / 1.35` (`design/prototype/tw.css` §:root), and `text-lg`
           applies both, so the prototype's head reads 16px on a 21.6px line.
           Stating only the size left the title on the body's `1.5` — 24px — and
           that 2.41px is the whole of the head's remaining disagreement once the
           close button is the design's 32×32 box (measured: prototype head
           78.59 vs implementation 81). `--leading-title` is this layer's name
           for the design's 1.35, so the pair is whole again with no new value. -->
      <h2 id="td-detail-title" class="text-[16px] leading-(--leading-title) font-semibold" data-detail-title>{{ title }}</h2>
    </header>

    <div class="td-drawer-body">
      <!-- R10 ② — the drawer's save state, one region for all three editable
           fields. `data-save-state` is the source of truth (`idle` ships, as the
           resting state) and the alert below is its only visible half: hidden
           unless the state is `error`, written in the same act so the attribute
           and the block can never disagree (contract R5). The carrier is an
           attribute, not a message — see `design/fidelity-r10.md` §2.2. -->
      <span data-detail-save :data-save-state="saveState" hidden></span>
      <span class="td-save-error" data-detail-save-error :hidden="!saveError" role="alert" data-i18n="detail.saveError">{{ $t("detail.saveError") }}</span>

      <!-- v4 — the drawer's tab shell. The panels stay in the DOM (`hidden`,
           not `v-if`): the contract counts hooks while the drawer is closed.
           Sessions is hidden by data (`hasSessions`), not by assignee kind. -->
      <div class="tabs td-drawer-tabs" role="tablist" :aria-label="$t('drawer.tabs.label')" data-detail-tabs @keydown="onTabKeydown">
        <button
          v-for="tab in tabs"
          :key="tab.name"
          v-show="tab.visible"
          :ref="(el) => setTabRef(tab.name, el)"
          type="button"
          class="tab td-drawer-tab"
          role="tab"
          :id="`td-dv-tab-${tab.name}`"
          :data-detail-tab="tab.name"
          :aria-controls="`td-dv-panel-${tab.name}`"
          :aria-selected="activeTab === tab.name ? 'true' : 'false'"
          :tabindex="activeTab === tab.name ? 0 : -1"
          @click="selectTab(tab.name)"
        >{{ $t(tab.key) }}</button>
      </div>

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-details" data-detail-panel="details" aria-labelledby="td-dv-tab-details" tabindex="0" :hidden="activeTab !== 'details'">

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.properties">{{ $t("drawer.properties") }}</h3>
        <!-- The property grid is the prototype's plain two-column `<div>` grid
             (`[data-detail-props]` is a `<div>` there), not a definition list: the
             rows pair a label with a *control* — buttons and comboboxes — which is
             not what `<dt>/<dd>` describe. The grid's own box (the 96px label
             track, the 4px row rhythm and the **absent** column gap) is
             `.td-props` in `app.css`, where the prototype states it (R14 D23). -->
        <div class="td-props" data-detail-props>
          <span class="td-prop-label" data-i18n="prop.status">{{ $t("prop.status") }}</span>
          <!-- R14 D26 — the three single-choice properties are **controls**, not
               text: the prototype's row is a `<button class="td-prop-value">`
               that opens a menu. The dot, the label and the disclosure caret are
               its three children (A16/A17).

               T-20261014-212017-3 — the button is now **in place editable**: the
               row is the prototype's `.td-combo.td-prop-combo` wrapper and the
               menu its `ul.menu`, so choosing a status is a move, not a
               navigation. `data-status` stays on the option buttons (it is what
               the existing `[data-status=…]` colour rules key on) and
               `data-status-value` carries the value the control writes back. -->
          <div class="td-combo td-prop-combo" data-detail-status-combo data-detail-save-field="status">
            <button
              type="button"
              class="td-prop-value"
              data-detail-status
              :data-status="statusValue"
              aria-haspopup="listbox"
              :aria-expanded="statusMenuOpen ? 'true' : 'false'"
              aria-controls="td-status-menu-detail"
              :disabled="readonly"
              :aria-disabled="readonly ? 'true' : undefined"
              @click="toggleStatusMenu"
              @keydown.esc="closePropMenus"
              @blur="closePropMenus"
            >
              <span class="td-status-dot" aria-hidden="true"></span>
              <span data-detail-status-label>{{ $t(`status.${statusValue}`) }}</span>
              <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 9.5 12 15.5 18 9.5" />
              </svg>
            </button>
            <ul id="td-status-menu-detail" class="menu td-combo-menu" role="listbox" data-detail-status-menu :hidden="!statusMenuOpen">
              <li v-for="value in STATUS_MENU" :key="value" role="none">
                <button
                  type="button"
                  class="td-combo-option"
                  role="option"
                  :aria-selected="value === statusValue ? 'true' : 'false'"
                  data-detail-status-option
                  :data-status="value"
                  :data-status-value="value"
                  @mousedown.prevent="chooseStatus(value)"
                >
                  <span class="status td-status-dot" aria-hidden="true"></span>
                  <span :data-i18n="`status.${value}`">{{ $t(`status.${value}`) }}</span>
                </button>
              </li>
            </ul>
          </div>

          <span class="td-prop-label" data-i18n="prop.priority">{{ $t("prop.priority") }}</span>
          <!-- Priority takes the same dropdown. Unlike status, the priority
               colour rides on the `.td-pri` wrapper inside each row rather than
               on the row itself, so the row's label text keeps the ink colour and
               only the glyph is tinted — the shape the trigger button already
               uses (T-20261014-212017-3 §4.1). -->
          <div class="td-combo td-prop-combo" data-detail-priority-combo data-detail-save-field="priority">
            <button
              type="button"
              class="td-prop-value"
              data-detail-priority
              :data-priority="priority"
              aria-haspopup="listbox"
              :aria-expanded="priorityMenuOpen ? 'true' : 'false'"
              aria-controls="td-priority-menu-detail"
              :disabled="readonly"
              :aria-disabled="readonly ? 'true' : undefined"
              @click="togglePriorityMenu"
              @keydown.esc="closePropMenus"
              @blur="closePropMenus"
            >
              <span class="td-pri" :aria-label="$t(`priority.${priority}`)" role="img">
                <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                  <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
                  <line x1="2" y1="6" x2="10" y2="6" />
                </svg>
              </span>
              <span data-detail-priority-label>{{ $t(`priority.${priority}`) }}</span>
              <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 9.5 12 15.5 18 9.5" />
              </svg>
            </button>
            <ul id="td-priority-menu-detail" class="menu td-combo-menu" role="listbox" data-detail-priority-menu :hidden="!priorityMenuOpen">
              <li v-for="value in PRIORITY_MENU" :key="value" role="none">
                <button
                  type="button"
                  class="td-combo-option"
                  role="option"
                  :aria-selected="value === priority ? 'true' : 'false'"
                  data-detail-priority-option
                  :data-priority-value="value"
                  @mousedown.prevent="choosePriority(value)"
                >
                  <span class="td-pri" :data-priority="value" aria-hidden="true">
                    <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                      <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
                      <line x1="2" y1="6" x2="10" y2="6" />
                    </svg>
                  </span>
                  <span :data-i18n="`priority.${value}`">{{ $t(`priority.${value}`) }}</span>
                </button>
              </li>
            </ul>
          </div>

          <span class="td-prop-label" data-i18n="prop.assignee">{{ $t("prop.assignee") }}</span>
          <!-- R14 D26/B13 — the people rows are combos: the value box carries
               `data-assignee-kind`, and its avatar carries it too (A19), so the
               dashed agent ring resolves on both. The platform badge is the row's
               own `[data-agent-platform]` seat. -->
          <div class="td-prop-value" data-detail-assignee data-detail-save-field="assignee" :data-assignee-kind="assigneeKind">
            <span class="avatar"><span class="td-avatar" data-detail-assignee-avatar :data-assignee-kind="assigneeKind">{{ initial(assigneeName) }}</span></span>
            <ComboField
              v-model="assigneeDraft"
              :options="peopleOptions"
              seed
              hook-input="data-assignee-input"
              hook-label="data-detail-assignee-label"
              hook-menu="data-assignee-menu"
              hook-option="data-assignee-option"
              hook-value="data-assignee-value"
              kind-attr="data-assignee-kind"
              platform-attr="data-agent-platform"
              placeholder-key="combo.assigneePlaceholder"
              aria-key="prop.assignee"
              @blur="(value) => commitField('assignee', value)"
            />
            <span v-if="isAgent" class="badge badge-xs td-agent-badge" data-detail-assignee-platform :data-agent-platform="platform">{{ platform }}</span>
          </div>

          <span class="td-prop-label" data-i18n="prop.reporter">{{ $t("prop.reporter") }}</span>
          <div class="td-prop-value" data-detail-reporter data-detail-save-field="reporter">
            <span class="avatar"><span class="td-avatar" data-detail-reporter-avatar>{{ initial(reporterName) }}</span></span>
            <ComboField
              v-model="reporterDraft"
              :options="reporterOptions"
              seed
              hook-input="data-reporter-input"
              hook-label="data-detail-reporter-label"
              hook-menu="data-reporter-menu"
              hook-option="data-reporter-option"
              hook-value="data-reporter-value"
              placeholder-key="combo.reporterPlaceholder"
              aria-key="prop.reporter"
              @blur="(value) => commitField('reporter', value)"
            />
          </div>

          <span class="td-prop-label" data-i18n="prop.project">{{ $t("prop.project") }}</span>
          <button type="button" class="td-prop-value" data-detail-project>
            <span class="td-mono" data-detail-project-label>{{ projectLabel }}</span>
          </button>

          <span class="td-prop-label" data-i18n="prop.labels">{{ $t("prop.labels") }}</span>
          <!-- R14 B16/D27 — the labels row's **root** is the value box itself
               (`.td-prop-value.td-prop-combo`): the row's 28px measure and its
               6px gutters belong to the row, not to a wrapper inside it. -->
          <div class="td-prop-value td-prop-combo" data-detail-labels data-detail-save-field="labels">
            <ComboField
              v-model="labelDraft"
              :options="labelOptions"
              multi
              hook-input="data-detail-label-input"
              hook-menu="data-detail-label-menu"
              hook-option="data-detail-label-option"
              hook-value="data-detail-label-value"
              hook-chips="data-detail-label-chips"
              hook-chip="data-detail-label-chip"
              hook-chip-value="data-detail-label-value"
              hook-chip-remove="data-detail-label-remove"
              placeholder-key="combo.labelsPlaceholder"
              empty-key="combo.noLabels"
              aria-key="prop.labels"
            />
          </div>

          <span class="td-prop-label" data-i18n="prop.id">{{ $t("prop.id") }}</span>
          <!-- R14 D28/B17 — the copy control is `.td-copy` and holds two things:
               the internal id and the `svg.td-icon-sm` glyph (the prototype's
               two children; a text `⧉` is the shape it replaces). -->
          <button type="button" class="td-copy" data-detail-id-copy :data-copy-value="idText" :aria-label="$t('toast.copied')" @click="copyId">
            <span data-detail-id>{{ idText }}</span>
            <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M8 8h11v11H8zM5 16V5h11" />
            </svg>
          </button>

          <span class="td-prop-label" data-i18n="prop.version">{{ $t("prop.version") }}</span>
          <span class="td-prop-value td-mono" data-detail-version>{{ versionText }}</span>
        </div>
      </section>

      <section class="td-section" data-detail-description-section :data-detail-description-mode="descriptionMode" data-detail-save-field="description">
        <div class="td-section-head">
          <h3 class="td-section-title" data-i18n="drawer.description">{{ $t("drawer.description") }}</h3>
          <!-- T-20261014-212017-3 §4.2 — the pencil turns the rendered markdown
               into the B23 editor in place. The section's `data-detail-description-mode`
               is the one switch and the stylesheet holds both readings, so the
               two faces can never both be showing. -->
          <button
            type="button"
            class="td-iconbtn"
            data-detail-description-edit
            :aria-label="$t('drawer.editDescription')"
            :title="$t('drawer.editDescription')"
            :disabled="readonly"
            :aria-disabled="readonly ? 'true' : undefined"
            @click="startDescriptionEdit"
          >
            <svg class="td-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 20h4l10-10-4-4L4 16z" />
              <path d="M14 6l4 4" />
            </svg>
          </button>
        </div>
        <!-- A13 — the hook rides the **content container** (`div.td-gfm`), whose
             parent is the `section`; the empty state is a plain `span` inside it,
             which is the shape the prototype's `fill()` injects (A21/D49).

             The `v-html` half is the board's one rendering sink and it is the
             prototype's own vendored renderer: `lib/markdown.js` escapes its
             input before it emits anything (`MarkdownLite.escape`) and falls back
             to escaped plain text when the renderer is absent, so a description
             can never inject markup the board did not write. The stored text is
             opaque to the server on purpose (T-20261014-212017-2 §①), which makes
             this the only boundary that matters for it. -->
        <div v-if="descriptionHtml" class="td-gfm" data-detail-description v-html="descriptionHtml"></div>
        <div v-else class="td-gfm" data-detail-description>
          <span class="text-xs text-(--brand-text-3)" data-i18n="description.none">{{ $t("description.none") }}</span>
        </div>

        <MarkdownEditor v-model="descriptionDraft" :source-hooks="[]" :hidden="descriptionMode !== 'edit'">
          <div class="td-desc-actions">
            <button
              type="button"
              class="btn btn-xs"
              data-detail-description-save
              :aria-busy="saveState === 'saving' ? 'true' : undefined"
              :disabled="saveState === 'saving'"
              @click="saveDescription"
            >
              {{ $t("drawer.save") }}
            </button>
            <button type="button" class="btn btn-outline btn-xs" data-detail-description-cancel @click="cancelDescriptionEdit">
              {{ $t("modal.cancel") }}
            </button>
          </div>
        </MarkdownEditor>
      </section>

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.relations">{{ $t("drawer.relations") }}</h3>
        <!-- R14 D37 / BLOCKS.md §R14 — the prototype groups its links by kind:
             one `.td-rel-item` per kind, holding that kind's `.td-copy` links,
             and **each group is led by that kind's own name** — not just the
             first two. The board's relation vocabulary is `parent` / `blocks` /
             `related` (`src/core/domain/enums.mjs`) and all three are named in
             the catalogue (`relations.parent|blocks|related`), so `related` gets
             its own labelled group here rather than the bare link 154930-2
             shipped while the third key was still being written (082533 named
             it; 082552 consumes it). A kind outside the vocabulary keeps its own
             wire value rather than rendering a bare catalogue key — the same
             "read as its own name" fallback `lib/activity.js` gives an unnamed
             event. -->
        <div class="td-rel" data-detail-relations>
          <template v-if="relationGroups.length">
            <span v-for="group in relationGroups" :key="group.type" class="td-rel-item">
              <span class="text-xs text-(--brand-text-3)" :data-i18n="`relations.${group.type}`">{{ group.category }}</span>
              <button v-for="link in group.links" :key="link.key" type="button" class="td-copy" data-relation-link>{{ link.label }}</button>
            </span>
          </template>
          <!-- The empty state is the card that has **nothing at all** — no
               read-only edge and no dependency. A card whose only relation was
               `blocks` reads as an empty group here, exactly as the prototype's
               own `fill()` leaves it once its Blocks row is withdrawn in favour
               of the chips below. -->
          <span v-else-if="dependsDraft.length === 0" class="text-xs text-(--brand-text-3)" data-i18n="relations.none">{{ $t("relations.none") }}</span>
        </div>

        <!-- T-20261014-212017-3 §4.4 — `depends_on` ⇄ the `blocks` edge
             (PROTOCOL §①). The card's prerequisites are an editable multi-select
             of this project's cards; the value the control holds is each
             prerequisite's **identifier**, and the store resolves it to a task id
             to write the edge (`stores/board.js#addDepends`). A cycle, a
             self-reference or a cross-project edge is refused by the board's
             relation guards, and the refusal is a sentence, not a stack.
             The candidates are `dependsCandidates`, not the whole roster: the
             board's own parent chain of this card is left out, so a card the
             `blocks` guard would refuse is not offered in the first place
             (T-20261015-104813) — and so is this card's own row, which
             `normalizeRelation` refuses with `SELF_REFERENCE` (T-20261015-132952). -->
        <div class="td-combo td-prop-combo" data-detail-depends data-detail-save-field="depends">
          <span class="td-prop-label" data-i18n="relations.blocks">{{ $t("relations.blocks") }}</span>
          <ComboField
            v-model="dependsDraft"
            :options="dependsCandidates"
            multi
            task-mode
            :free-text="false"
            :disabled="readonly"
            hook-input="data-detail-depends-input"
            hook-menu="data-detail-depends-menu"
            hook-option="data-detail-depends-option"
            hook-value="data-detail-depends-value"
            hook-chips="data-detail-depends-chips"
            hook-chip="data-detail-depends-chip"
            hook-chip-value="data-detail-depends-value"
            hook-chip-remove="data-detail-depends-remove"
            placeholder-key="combo.dependsPlaceholder"
            empty-key="combo.noTasks"
            aria-key="relations.blocks"
          />
        </div>
      </section>

      <section class="td-section" data-detail-attachments-section data-detail-save-field="attachments">
        <div class="td-section-head">
          <h3 class="td-section-title" data-i18n="drawer.attachments">{{ $t("drawer.attachments") }}</h3>
          <!-- T-20261014-212017-3 §4.3 — the section's own upload control. The
               file input is the browser's picker and is never shown: it is
               reached through the button, so it is `.sr-only` and out of the tab
               order, exactly as the prototype states it. -->
          <button
            type="button"
            class="btn btn-outline btn-xs"
            data-attachment-upload
            :disabled="readonly"
            :aria-disabled="readonly ? 'true' : undefined"
            @click="chooseFiles"
          >
            {{ $t("drawer.upload") }}
          </button>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="sr-only"
            data-attachment-file
            aria-hidden="true"
            tabindex="-1"
            @change="onFiles"
          />
        </div>
        <!-- The prototype's rows: a file icon, the name, its size, and now the
             row's own two affordances. `[data-attachment-row]` and its two hooks
             are the implementation's own test hooks and stay exactly where they
             are (R14 §8 U1(a)); the download/remove pair is the prototype's
             (`[data-attachment-download]` / `[data-attachment-remove]`).
             `attachments.none` is the state of a task that has no attachments —
             never the state of a drawer with no task in it. -->
        <div data-detail-attachments>
          <div v-for="file in attachments" :key="file.id || file.name" class="td-file" data-attachment-row>
            <svg class="td-icon size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M14 3v5h5M7 3h7l5 5v13H7z" />
            </svg>
            <span class="td-file-name" data-attachment-name>{{ file.name }}</span>
            <span class="td-file-size" data-attachment-size>{{ file.size }}</span>
            <span class="td-file-actions">
              <button
                type="button"
                class="td-iconbtn"
                data-attachment-download
                :aria-label="$t('drawer.attachDownload')"
                :title="$t('drawer.attachDownload')"
                :aria-busy="busyAttachment === file.id ? 'true' : undefined"
                :disabled="readonly"
                :aria-disabled="readonly ? 'true' : undefined"
                @click="downloadAttachment(file)"
              >
                <svg class="td-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
                </svg>
              </button>
              <button
                type="button"
                class="td-iconbtn"
                data-attachment-remove
                :aria-label="$t('drawer.attachRemove')"
                :title="$t('drawer.attachRemove')"
                :disabled="readonly"
                :aria-disabled="readonly ? 'true' : undefined"
                @click="removeAttachmentRow(file)"
              >
                <svg class="td-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </span>
          </div>
          <span v-if="task && attachments.length === 0" class="text-xs text-(--brand-text-3)" data-i18n="attachments.none">{{ $t("attachments.none") }}</span>
        </div>
      </section>

      </div><!-- /Details panel -->

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-activity" data-detail-panel="activity" aria-labelledby="td-dv-tab-activity" tabindex="0" :hidden="activeTab !== 'activity'">

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.comments">{{ $t("drawer.comments") }}</h3>
        <div data-detail-comments>
          <!-- R14 D39/D40/D41 — avatar, meta line (author + kin + stamp) and the
               pre-lined body; a decision comment is quoted by `.td-comment-decision`
               and its kin is the chip the prototype gives it. -->
          <article v-for="row in commentRows" :key="row.id" class="td-comment" :class="{ 'td-comment-decision': row.decision }">
            <span class="avatar"><span class="td-avatar" :data-assignee-kind="row.agent ? 'agent' : undefined">{{ row.initials }}</span></span>
            <div>
              <div class="td-comment-meta">
                <span class="font-medium text-(--brand-text)" :class="{ 'td-mono': row.agent }">{{ row.name }}</span>
                <span v-if="row.decision" class="badge badge-sm td-chip" data-i18n="comment.decision">{{ $t("comment.decision") }}</span>
                <span v-else :data-i18n="`comment.${row.agent ? 'agent' : 'human'}`">{{ $t(`comment.${row.agent ? 'agent' : 'human'}`) }}</span>
                <span v-if="row.stamp" class="td-mono" :title="row.stamp.absolute" :data-i18n="`${row.stamp.key}`">{{ $t(row.stamp.key, row.stamp.arg) }}</span>
              </div>
              <div class="td-comment-body">{{ row.body }}</div>
            </div>
          </article>

          <!-- R14 D47 — the form is four pieces: the visually-hidden label (the
               prototype's `.td-sr`, whose `for` names the field), the field, the
               hint, and the submit button on the hint's line. -->
          <form class="mt-2" data-comment-form @submit.prevent="submitComment">
            <label class="td-sr" for="td-comment-input" data-i18n="drawer.comment">{{ $t("drawer.comment") }}</label>
            <textarea id="td-comment-input" class="td-textarea" data-comment-input v-model="commentDraft" :placeholder="$t('drawer.commentPlaceholder')"></textarea>
            <div class="mt-2 flex items-center justify-between">
              <span class="text-[11px] text-(--brand-text-3)" data-i18n="drawer.commentHint">{{ $t("drawer.commentHint") }}</span>
              <button type="submit" class="btn btn-primary btn-sm" data-comment-submit>{{ $t("drawer.submit") }}</button>
            </div>
          </form>
        </div>
      </section>

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.activity">{{ $t("drawer.activity") }}</h3>
        <!-- Each row is actor · sentence · relative time. The sentence is a
             catalogue key where the prototype names the event, the prototype's
             mono `status: from → to` line for a move, and the event's own name
             otherwise. The timestamp's `title` carries the absolute stamp.
             R14 D46 — the row wears `.td-activity`, the drawer's own short family;
             B26's view rows keep `.td-activity-*`/`.td-activity-view` to
             themselves, which is why the actor here is the prototype's plain
             `font-medium` span (mono for an agent) and not `.td-activity-actor`. -->
        <div data-detail-activity>
          <div v-for="row in activityRows" :key="row.id" class="td-activity" data-activity-row>
            <span class="font-medium" :class="{ 'td-mono': row.agent }" data-activity-actor>{{ row.actor }}</span>
            <span v-if="row.line.sentence" :data-i18n="`activity.${row.line.sentence}`">{{ $t(`activity.${row.line.sentence}`) }}</span>
            <span v-else class="td-mono">{{ row.line.text }}</span>
            <span v-if="row.stamp" class="td-activity-ts" data-activity-ts :title="row.stamp.absolute">{{ $t(row.stamp.key, row.stamp.arg) }}</span>
          </div>
        </div>
      </section>

      </div><!-- /Activity panel -->

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-reports" data-detail-panel="reports" aria-labelledby="td-dv-tab-reports" tabindex="0" :hidden="activeTab !== 'reports'">
        <section class="td-section" data-dv-tab-block="reports">
          <h3 class="td-section-title" data-i18n="drawer.tab.reports">{{ $t("drawer.tab.reports") }}</h3>
          <div class="td-dv-reports">
            <article v-for="row in reportRows" :key="row.id" class="td-dv-report" :data-dv-round="row.round">
              <div class="td-dv-report-head">
                <span class="badge badge-sm td-chip td-dv-round">{{ $t("drawer.report.round", row.round) }}</span>
                <span class="td-dv-author td-mono">{{ row.author }}</span>
                <span class="td-dv-kind">{{ $t(row.agent ? "comment.agent" : "comment.human") }}</span>
                <span v-if="row.stamp" class="td-dv-ts td-mono" :title="row.stamp.absolute">{{ row.stamp.absolute }}</span>
              </div>
              <p class="td-dv-conclusion">{{ row.conclusion }}</p>
            </article>
            <p v-if="reportRows.length === 0" class="td-dv-empty" data-i18n="drawer.reports.empty">{{ $t("drawer.reports.empty") }}</p>
          </div>
        </section>
      </div>

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-acceptance" data-detail-panel="acceptance" aria-labelledby="td-dv-tab-acceptance" tabindex="0" :hidden="activeTab !== 'acceptance'">
        <section class="td-section" data-dv-tab-block="acceptance">
          <h3 class="td-section-title" data-i18n="drawer.tab.acceptance">{{ $t("drawer.tab.acceptance") }}</h3>
          <ul class="td-dv-list">
            <li v-for="row in acceptanceRows" :key="row.id" class="td-dv-item">
              <span class="td-dv-mark" :data-acceptance-status="row.status" role="img" :aria-label="$t(`drawer.acceptance.${row.status}`)">
                <svg v-if="row.status === 'met'" class="td-dv-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 13l4.5 4.5L19 7" /></svg>
                <svg v-else-if="row.status === 'not_met'" class="td-dv-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>
                <svg v-else class="td-dv-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 12h12" /></svg>
              </span>
              <span class="td-dv-text">{{ row.text }}</span>
            </li>
          </ul>
          <p v-if="acceptanceRows.length === 0" class="td-dv-empty" data-i18n="drawer.acceptance.empty">{{ $t("drawer.acceptance.empty") }}</p>
        </section>
      </div>

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-leftovers" data-detail-panel="leftovers" aria-labelledby="td-dv-tab-leftovers" tabindex="0" :hidden="activeTab !== 'leftovers'">
        <section class="td-section" data-dv-tab-block="leftovers">
          <h3 class="td-section-title" data-i18n="drawer.tab.leftovers">{{ $t("drawer.tab.leftovers") }}</h3>
          <ul class="td-dv-list">
            <li v-for="row in leftoverRows" :key="row.id" class="td-dv-item" :data-dv-leftover-round="row.round" :data-dv-leftover-empty="row.text ? undefined : 'true'">
              <span class="td-dv-round-mono td-mono">{{ $t("drawer.leftovers.round", row.round) }}</span>
              <span v-if="row.text" class="td-dv-text">{{ row.text }}</span>
              <span v-else class="td-dv-empty" data-i18n="drawer.leftovers.empty">{{ $t("drawer.leftovers.empty") }}</span>
            </li>
          </ul>
          <p v-if="leftoverRows.length === 0" class="td-dv-empty" data-i18n="drawer.leftovers.empty">{{ $t("drawer.leftovers.empty") }}</p>
        </section>
      </div>

      <div class="td-dv-panel" role="tabpanel" id="td-dv-panel-sessions" data-detail-panel="sessions" aria-labelledby="td-dv-tab-sessions" tabindex="0" :hidden="activeTab !== 'sessions'">
        <section class="td-section" data-detail-agent-session :hidden="!hasSessions">
          <h3 class="td-section-title" data-i18n="drawer.session">{{ $t("drawer.session") }}</h3>
          <div data-detail-agent-session-body>
            <!-- The trail: running first, then newest-first. The first row
                 carries B16's platform seat; historical rows name their own
                 backend in a plain badge. Resume is stated only for a running
                 session (kept in the DOM with v-show so the contract's hook
                 survives a card whose sessions have all closed). -->
            <div v-for="(row, index) in sessionTrail" :key="row.id" class="td-session" :class="{ 'mt-2': index > 0 }" data-agent-session>
              <div class="flex items-center gap-2">
                <span v-if="index === 0" class="badge badge-xs td-agent-badge" :data-agent-platform="isAgent ? platform : undefined">{{ isAgent ? platform : row.backend }}</span>
                <span v-else class="badge badge-xs td-agent-badge">{{ row.backend }}</span>
                <span class="td-mono text-xs text-(--brand-text-2)" :data-agent-platform-value="index === 0 ? platform || row.backend : undefined">{{ index === 0 ? (platform || row.backend) : row.backend }}</span>
                <span class="badge badge-xs" :data-session-status="row.status">{{ $t(`drawer.session.status.${row.status}`) }}</span>
                <button v-if="index === 0" v-show="row.running" type="button" class="btn btn-outline btn-xs ms-auto" data-agent-resume data-i18n="drawer.resume">{{ $t("drawer.resume") }}</button>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-xs text-(--brand-text-3)" data-i18n="session.id">{{ $t("session.id") }}</span>
                <span class="td-copy" data-agent-session-id>{{ row.sessionId }}</span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-(--brand-text-3)" :data-session-owner="row.owner" :data-session-seg="row.seg ?? undefined" :data-session-phase="row.phase ?? undefined">
                <span>{{ $t("drawer.session.owner") }} <span class="font-medium td-mono">{{ row.owner }}</span></span>
                <span v-if="row.seg !== null">{{ $t("drawer.session.seg") }} {{ row.seg }}</span>
                <span v-if="row.phase">{{ $t("drawer.session.phase") }} {{ row.phase }}</span>
                <span v-if="row.stamp" class="td-activity-ts" :title="row.stamp.absolute">{{ $t(row.stamp.key, row.stamp.arg) }}</span>
              </div>
            </div>
            <!-- The contract's B16 hooks must exist at rest even when the card
                 has no session rows; the section is hidden in that case. -->
            <div v-if="sessionTrail.length === 0" class="td-session" data-agent-session hidden>
              <div class="flex items-center gap-2">
                <span class="badge badge-xs td-agent-badge" :data-agent-platform="isAgent ? platform : undefined">{{ isAgent ? platform : "" }}</span>
                <span class="td-mono text-xs text-(--brand-text-2)" data-agent-platform-value>{{ platform }}</span>
                <button type="button" class="btn btn-outline btn-xs ms-auto" data-agent-resume data-i18n="drawer.resume">{{ $t("drawer.resume") }}</button>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-xs text-(--brand-text-3)" data-i18n="session.id">{{ $t("session.id") }}</span>
                <span class="td-copy" data-agent-session-id>—</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- The contract's inert slot templates: the hooks survive the framework,
         the multiplicity does not. One template holds one slot per SLOT value.

         R14 §8 U1(b) — `[data-detail-slot-source]` was the one hook of the three
         self-invented families with no backing in either contract test, and the
         implementation has no consumer for it: the prototype's `app.js` builds
         that transient wrapper while copying a `<template>` into the drawer, and
         a component-based drawer renders its sections directly. It is **removed**
         here (with its `AUXILIARY_HOOKS` record), which is the ruling's first
         branch; the six `[data-slot]` containers below are what the contract
         actually counts (A5/A26). -->
    <div data-detail-templates hidden>
      <div data-detail-for="*">
        <div data-slot="description"></div>
        <div data-slot="relations"></div>
        <div data-slot="agent-session"></div>
        <div data-slot="attachments"></div>
        <div data-slot="comments"></div>
        <div data-slot="activity"></div>
      </div>
    </div>
  </aside>
</template>
