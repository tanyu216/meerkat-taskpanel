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
 * `visibility: hidden` pair (`.td-drawer`, `app.css`). Escape returns focus to
 * the opener (handled in `App.vue`).
 *
 * The body is **always in the document** — the contract counts hooks like
 * `[data-detail-labels]` with no `when` precondition, so they must exist while
 * the drawer is closed; only their values are empty at rest.
 */
import { computed, ref, watch } from "vue";

import { board, addComment, closeDetail, labelRoster, platformOf, priorityOf, reporterRoster, saveDetailField } from "../../stores/board.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { activityLine, relativeTime } from "../../lib/activity.js";
import { attachmentRows } from "../../lib/attachments.js";
import { pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

import ComboField from "../combo/ComboField.vue";

const commentDraft = ref("");
const assigneeDraft = ref("");
const reporterDraft = ref("");
const labelDraft = ref([]);

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
const isAgent = computed(() => (task.value?.assignee?.kind ?? "human") === "agent");
/**
 * The assignee's kind as the contract's own attribute value. The prototype
 * carries `data-assignee-kind="agent"` on the value row **and** on its avatar
 * (R14 §2.4 / A19); only an agent has a kind to state, so a human card leaves
 * the attribute off rather than writing an empty one.
 */
const assigneeKind = computed(() => (isAgent.value ? "agent" : "human"));
const platform = computed(() => platformOf(assigneeName.value));
const projectLabel = computed(() => board.projects.find((p) => p.id === task.value?.project_id)?.name ?? "");
const initial = (name) => (name ? name.charAt(0).toUpperCase() : "?");

const comments = computed(() => detail.value?.comments ?? []);
const activities = computed(() => detail.value?.activities ?? []);
const labelNames = computed(() => task.value?.labels ?? []);

/**
 * The attachment rows come from the task's own `meta` bucket — the same place
 * `[data-card-attachment-count]` reads its count. With no task open there is
 * nothing to list *and* nothing to say about it, so the section renders neither
 * rows nor the "no attachments" state.
 */
const attachments = computed(() => attachmentRows(task.value?.meta));

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

const session = computed(() => {
  const sessions = detail.value?.sessions ?? [];
  return sessions.find((row) => row.status === "running") ?? sessions[0] ?? null;
});

const peopleOptions = computed(() => board.assignees.map((entry) => ({ name: entry.display_name, kind: entry.kind, platform: entry.platform })));
const reporterOptions = computed(() => reporterRoster.value.map((name) => ({ name })));
const labelOptions = computed(() => labelRoster.value.map((name) => ({ name })));

const descriptionHtml = computed(() => (task.value?.description ? renderMarkdown(task.value.description) : ""));

/** Identifier of a related task when the board knows it, else the raw id. */
function identifierOf(id) {
  return board.tasks.find((item) => item.id === id)?.identifier ?? id;
}

const relationLinks = computed(() => {
  const rel = detail.value?.relations ?? {};
  return (rel.relations ?? []).map((row) => {
    const other = row.source === task.value?.id ? row.target : row.source;
    return { key: row.id, type: row.type, label: identifierOf(other) };
  });
});

/**
 * R14 D37 — the relations row groups its links by kind, one `.td-rel-item` per
 * label. The catalogue names `parent` and `blocks`; a link of any other kind
 * (`related` is the only one left in the vocabulary, `src/core/domain/enums.mjs`)
 * is listed as a bare link rather than given an invented label — the round adds
 * no catalogue key (`design/fidelity-r14.md` §8.2 ④).
 */
const parentLinks = computed(() => relationLinks.value.filter((link) => link.type === "parent"));
const blockLinks = computed(() => relationLinks.value.filter((link) => link.type === "blocks"));
const otherLinks = computed(() => relationLinks.value.filter((link) => link.type !== "parent" && link.type !== "blocks"));

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
    resetSave();
  },
  { immediate: true },
);

// Accepting a roster row rewrites the draft — that is the `change` half of the
// commit, and the blur half is the control's own `blur` event. Typing into a
// field moves neither, so typing alone commits nothing (contract C-14).
watch(assigneeDraft, () => commitField("assignee", assigneeDraft.value));
watch(reporterDraft, () => commitField("reporter", reporterDraft.value));
watch(labelDraft, () => commitLabels(), { deep: true });

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
    class="td-drawer"
    data-detail-drawer
    :data-identifier="identifier"
    :data-state="board.drawerState"
    role="dialog"
    aria-modal="true"
    aria-labelledby="td-detail-title"
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
        <button
          type="button"
          class="ml-auto shrink-0 border-0 bg-transparent text-(--brand-text-3) cursor-pointer"
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
           (R14 §3): Tailwind's `text-lg` is 18px here, so the value is stated. -->
      <h2 id="td-detail-title" class="text-[16px] font-semibold" data-detail-title>{{ title }}</h2>
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
               its three children (A16/A17). -->
          <button type="button" class="td-prop-value" data-detail-status :data-status="statusValue">
            <span class="td-status-dot" aria-hidden="true"></span>
            <span data-detail-status-label>{{ $t(`status.${statusValue}`) }}</span>
            <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 9.5 12 15.5 18 9.5" />
            </svg>
          </button>

          <span class="td-prop-label" data-i18n="prop.priority">{{ $t("prop.priority") }}</span>
          <button type="button" class="td-prop-value" data-detail-priority :data-priority="priority">
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

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.description">{{ $t("drawer.description") }}</h3>
        <!-- A13 — the hook rides the **content container** (`div.td-gfm`), whose
             parent is the `section`; the empty state is a plain `span` inside it,
             which is the shape the prototype's `fill()` injects (A21/D49). -->
        <div v-if="descriptionHtml" class="td-gfm" data-detail-description v-html="descriptionHtml"></div>
        <div v-else class="td-gfm" data-detail-description>
          <span class="text-xs text-(--brand-text-3)" data-i18n="description.none">{{ $t("description.none") }}</span>
        </div>
      </section>

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.relations">{{ $t("drawer.relations") }}</h3>
        <!-- R14 D37 — the prototype groups its links by kind: one `.td-rel-item`
             per label, holding that kind's `.td-copy` links. The board's relation
             vocabulary is `parent` / `blocks` / `related`
             (`src/core/domain/enums.mjs`) and the catalogue names the first two,
             so a `related` link is listed as a bare link rather than given an
             invented label — no new key, and no bare catalogue key on screen
             (`design/fidelity-r14.md` §8.2 ④). -->
        <div class="td-rel" data-detail-relations>
          <template v-if="relationLinks.length">
            <span v-if="parentLinks.length" class="td-rel-item">
              <span class="text-xs text-(--brand-text-3)" data-i18n="relations.parent">{{ $t("relations.parent") }}</span>
              <button v-for="link in parentLinks" :key="link.key" type="button" class="td-copy" data-relation-link>{{ link.label }}</button>
            </span>
            <span v-if="blockLinks.length" class="td-rel-item">
              <span class="text-xs text-(--brand-text-3)" data-i18n="relations.blocks">{{ $t("relations.blocks") }}</span>
              <button v-for="link in blockLinks" :key="link.key" type="button" class="td-copy" data-relation-link>{{ link.label }}</button>
            </span>
            <button v-for="link in otherLinks" :key="link.key" type="button" class="td-copy" data-relation-link>{{ link.label }}</button>
          </template>
          <span v-else class="text-xs text-(--brand-text-3)" data-i18n="relations.none">{{ $t("relations.none") }}</span>
        </div>
      </section>

      <section class="td-section" data-detail-agent-session :hidden="!isAgent">
        <h3 class="td-section-title" data-i18n="drawer.session">{{ $t("drawer.session") }}</h3>
        <div data-detail-agent-session-body>
          <!-- R14 D43/D44/D45 — the session is one sunken box in two rows:
               platform badge + `--agent-platform` value + the Resume button
               pushed to the row's end, then the id under the prototype's own
               `.td-copy` face. `data-agent-platform` is stated only for an agent
               card — a human card has no platform to name (B16's domain rule). -->
          <div class="td-session" data-agent-session>
            <div class="flex items-center gap-2">
              <span class="badge badge-xs td-agent-badge" :data-agent-platform="isAgent ? platform : undefined">{{ isAgent ? platform : "" }}</span>
              <span class="td-mono text-xs text-(--brand-text-2)" data-agent-platform-value>{{ platform }}</span>
              <button type="button" class="btn btn-outline btn-xs ms-auto" data-agent-resume data-i18n="drawer.resume">{{ $t("drawer.resume") }}</button>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <span class="text-xs text-(--brand-text-3)" data-i18n="session.id">{{ $t("session.id") }}</span>
              <span class="td-copy" data-agent-session-id>{{ session?.session_id ?? "—" }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="td-section">
        <h3 class="td-section-title" data-i18n="drawer.attachments">{{ $t("drawer.attachments") }}</h3>
        <!-- The prototype's rows: a file icon, the name, and the size pushed to
             the row's end (`[data-attachment-row]` and its two hooks are the
             implementation's own test hooks and stay exactly where they are —
             R14 §8 U1(a)). `attachments.none` is the state of a task that has no
             attachments — never the state of a drawer with no task in it. -->
        <div data-detail-attachments>
          <div v-for="file in attachments" :key="file.name" class="td-file" data-attachment-row>
            <svg class="td-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M14 3v5h5M7 3h7l5 5v13H7z" />
            </svg>
            <span class="td-file-name" data-attachment-name>{{ file.name }}</span>
            <span class="td-file-size" data-attachment-size>{{ file.size }}</span>
          </div>
          <span v-if="task && attachments.length === 0" class="text-xs text-(--brand-text-3)" data-i18n="attachments.none">{{ $t("attachments.none") }}</span>
        </div>
      </section>

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
