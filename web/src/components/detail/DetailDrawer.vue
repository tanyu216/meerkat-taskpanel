<script setup>
/**
 * B09 · Task detail drawer, with B16's agent-session provenance and the drawer
 * families of the assignee/reporter (B22) and label (B25) controls.
 *
 * One drawer component renders for any card (the prototype's per-card
 * `<template>` clones are a jQuery mechanism; the *hooks* are the contract, the
 * template multiplicity is not). The drawer is toggled by `data-state` and
 * `hidden`, never by a stylesheet rule (C06), and Escape returns focus to the
 * opener (handled in `App.vue`).
 *
 * The body is **always in the document** — the contract counts hooks like
 * `[data-detail-labels]` with no `when` precondition, so they must exist while
 * the drawer is closed; only their values are empty at rest.
 */
import { computed, nextTick, ref, watch } from "vue";

import { board, addComment, closeDetail, labelRoster, platformOf, priorityOf, reporterRoster, saveDetailField } from "../../stores/board.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { activityLine, relativeTime } from "../../lib/activity.js";
import { attachmentRows } from "../../lib/attachments.js";
import { pushToast } from "../../stores/ui.js";
import { has, t } from "../../i18n/index.js";

import ComboField from "../combo/ComboField.vue";

const commentDraft = ref("");
const assigneeDraft = ref("");
const reporterDraft = ref("");
const labelDraft = ref([]);

/** The head's ✕ — the element the drawer hands focus to when it opens (C2). */
const closeButton = ref(null);

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
 */
const activityRows = computed(() =>
  activities.value.map((row) => ({
    id: row.id,
    actor: row.actor_id ?? "—",
    line: activityLine(row),
    stamp: relativeTime(row.created_at),
  })),
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
    return { key: row.id, category: has(key) ? t(key) : row.type, label: identifierOf(other) };
  });
});

/* ----------------------------------------- R14 §2.1 C2 · focus enters the drawer */

/**
 * Opening the drawer moves focus to its close button, the way the prototype's
 * `focusWhenOpen($("[data-detail-close]"), $panel)` does
 * (`design/prototype/app.js`, which measures `[data-detail-close]` `focused:
 * true` once the drawer is up).
 *
 * The prototype defers the move by one transition length because its panel is
 * `visibility: hidden` on the frame it opens, and a box that is not rendered
 * cannot take focus. Here the panel is `hidden` — i.e. `display: none`
 * (`.td-drawer[hidden]`, `styles/app.css`) — until the task arrives, so the
 * equivalent moment is the post-flush one: `nextTick` after `open` flips, by
 * which time Vue has withdrawn `hidden` and the button is focusable. The re-read
 * of `open` inside the callback is the prototype's own `data-state === "open"`
 * guard, so a drawer closed within that beat is never focused.
 *
 * This is the *only* focus this component moves, and only ever **into** the
 * panel: Escape and the ✕ still close the drawer through `App.vue`'s keydown arm
 * exactly as before. (The card's "关闭回 opener" half has no drawer-side
 * implementation to preserve — `web/src` focuses nothing on close, and neither
 * does the prototype's `closeDetail`, which only clears `aria-selected` on the
 * cards. The opener-return the contract states is the access panel's,
 * `test/web/blocks.contract.mjs` B19.)
 */
watch(open, (isOpen) => {
  if (!isOpen) return;
  void nextTick(() => {
    if (open.value) closeButton.value?.focus();
  });
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
  <div class="fixed inset-0 z-50 bg-(--brand-scrim)" data-detail-overlay :data-state="board.drawerState" :hidden="!open" @click="closeDetail"></div>

  <aside
    class="td-drawer"
    data-detail-drawer
    :data-identifier="identifier"
    :data-state="board.drawerState"
    :hidden="!open"
    :aria-hidden="open ? 'false' : 'true'"
    role="dialog"
    aria-modal="true"
  >
    <header class="flex flex-col gap-1 p-4 border-b border-b-(--brand-border)">
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
        <span class="td-mono td-id td-id-full" data-detail-identifier :title="identifier">{{ identifier }}</span>
        <!-- The status chip is a dot **and** a word (B09/§2.4: colour is never
             the only signal). daisyUI's `badge-sm` owns the box, `td-chip` the
             brand's metrics, `td-chip-status` the 6px dot. -->
        <span class="badge badge-sm td-chip td-chip-status" data-detail-status-chip :data-status="statusValue">
          <span class="td-status-dot" aria-hidden="true"></span>
          <span data-detail-status-chip-label>{{ $t(`status.${statusValue}`) }}</span>
        </span>
        <button
          ref="closeButton"
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
      <h2 data-detail-title>{{ title }}</h2>
    </header>

    <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      <!-- R10 ② — the drawer's save state, one region for all three editable
           fields. `data-save-state` is the source of truth (`idle` ships, as the
           resting state) and the alert below is its only visible half: hidden
           unless the state is `error`, written in the same act so the attribute
           and the block can never disagree (contract R5). The carrier is an
           attribute, not a message — see `design/fidelity-r10.md` §2.2. -->
      <span data-detail-save :data-save-state="saveState" hidden></span>
      <span class="td-save-error" data-detail-save-error :hidden="!saveError" role="alert" data-i18n="detail.saveError">{{ $t("detail.saveError") }}</span>

      <!-- The property grid is the prototype's plain two-column `<div>` grid
           (`[data-detail-props]` is a `<div>` there), not a definition list: the
           rows pair a label with a *control* — buttons and comboboxes — which is
           not what `<dt>/<dd>` describe. Labels and values are therefore spans
           and divs, and the stylesheet selects them by class. -->
      <div class="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]" data-detail-props>
        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.status") }}</span>
        <div class="inline-flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-status :data-status="statusValue"><span data-detail-status-label>{{ $t(`status.${statusValue}`) }}</span></div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.priority") }}</span>
        <div class="inline-flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-priority :data-priority="priority"><span data-detail-priority-label>{{ $t(`priority.${priority}`) }}</span></div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.assignee") }}</span>
        <div class="flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-assignee data-detail-save-field="assignee">
          <span class="inline-flex size-5 items-center justify-center rounded-[999px] bg-(--brand-active) text-[11px] font-medium text-(--brand-text-2)" data-detail-assignee-avatar>{{ initial(assigneeName) }}</span>
          <span v-if="isAgent" data-detail-assignee-platform>{{ platform }}</span>
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
        </div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.reporter") }}</span>
        <div class="flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-reporter data-detail-save-field="reporter">
          <span class="inline-flex size-5 items-center justify-center rounded-[999px] bg-(--brand-active) text-[11px] font-medium text-(--brand-text-2)" data-detail-reporter-avatar>{{ initial(reporterName) }}</span>
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

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.project") }}</span>
        <div class="inline-flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-project><span data-detail-project-label>{{ projectLabel }}</span></div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.id") }}</span>
        <div class="inline-flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)">
          <span class="td-mono" data-detail-id>{{ idText }}</span>
          <button type="button" class="border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-detail-id-copy :data-copy-value="idText" :aria-label="$t('toast.copied')" @click="copyId">⧉</button>
        </div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.version") }}</span>
        <div class="td-mono inline-flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)" data-detail-version>{{ versionText }}</div>

        <span class="text-[12px] text-(--brand-text-3)">{{ $t("prop.labels") }}</span>
        <div class="flex min-h-7 min-w-0 items-center gap-1 px-1 text-[13px] text-(--brand-text)">
          <div data-detail-labels data-detail-save-field="labels">
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
        </div>
      </div>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-description>
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.description") }}</h3>
        <div v-if="descriptionHtml" class="td-gfm" v-html="descriptionHtml"></div>
        <p v-else class="text-[12px] text-(--brand-text-3)" data-i18n="description.none">{{ $t("description.none") }}</p>
      </section>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-relations>
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.relations") }}</h3>
        <ul v-if="relationLinks.length" class="m-0 pl-4">
          <li v-for="link in relationLinks" :key="link.key">
            <a href="#" class="td-mono" data-relation-link @click.prevent>{{ link.category }} · {{ link.label }}</a>
          </li>
        </ul>
        <p v-else class="text-[12px] text-(--brand-text-3)" data-i18n="relations.none">{{ $t("relations.none") }}</p>
      </section>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-agent-session :hidden="!isAgent">
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.session") }}</h3>
        <div data-detail-agent-session-body>
          <div data-agent-session>
            <p>{{ $t("session.id") }}: <span class="td-mono" data-agent-session-id>{{ session?.session_id ?? "—" }}</span></p>
            <p><span :data-agent-platform="isAgent ? platform : undefined">{{ platform }}</span> · <span data-agent-platform-value>{{ platform }}</span></p>
            <button type="button" class="btn btn-ghost btn-xs" data-agent-resume>{{ $t("drawer.resume") }}</button>
          </div>
        </div>
      </section>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-attachments>
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.attachments") }}</h3>
        <!-- The prototype's rows: a file icon, the name, and the size pushed to
             the row's end. `attachments.none` is the state of a task that has no
             attachments — never the state of a drawer with no task in it. -->
        <div v-for="file in attachments" :key="file.name" class="flex items-center gap-2 border border-(--brand-border) rounded-[6px] bg-(--brand-surface) px-2 py-1 [&+&]:mt-2" data-attachment-row>
          <svg class="td-icon size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 3v5h5M7 3h7l5 5v13H7z" />
          </svg>
          <span class="text-[12px] font-medium text-(--brand-text)" data-attachment-name>{{ file.name }}</span>
          <span class="td-mono ms-auto text-[11px] text-(--brand-text-3)" data-attachment-size>{{ file.size }}</span>
        </div>
        <p v-if="task && attachments.length === 0" class="text-[12px] text-(--brand-text-3)" data-i18n="attachments.none">{{ $t("attachments.none") }}</p>
      </section>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-comments>
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.comments") }}</h3>
        <article v-for="comment in comments" :key="comment.id" class="flex flex-col gap-1 py-2 border-b border-b-(--brand-border)">
          <div class="flex items-center gap-2 text-[12px] text-(--brand-text-3)">
            <span>{{ comment.author_id ?? comment.author?.display_name ?? "—" }}</span>
            <span>{{ $t(`comment.${comment.author_kind ?? 'human'}`) }}</span>
          </div>
          <p>{{ comment.body }}</p>
        </article>
        <form data-comment-form @submit.prevent="submitComment">
          <textarea v-model="commentDraft" class="min-h-16 w-full resize-y rounded-[6px] border border-(--brand-border-strong) bg-(--brand-surface) p-2 text-(--brand-text)" data-comment-input :placeholder="$t('drawer.commentPlaceholder')"></textarea>
          <button type="submit" class="btn btn-primary btn-sm" data-comment-submit>{{ $t("drawer.submit") }}</button>
        </form>
      </section>

      <section class="border-t border-t-(--brand-border) pt-3" data-detail-activity>
        <h3 class="m-0 mb-2 text-[13px] font-semibold">{{ $t("drawer.activity") }}</h3>
        <!-- Each row is actor · sentence · relative time. The sentence is a
             catalogue key where the prototype names the event, the prototype's
             mono `status: from → to` line for a move, and the event's own name
             otherwise. The timestamp's `title` carries the absolute stamp. -->
        <div v-for="row in activityRows" :key="row.id" class="flex items-baseline gap-2 py-[3px] text-[12px] text-(--brand-text-2)" data-activity-row>
          <span class="td-activity-actor td-mono" data-activity-actor>{{ row.actor }}</span>
          <span v-if="row.line.sentence" :data-i18n="`activity.${row.line.sentence}`">{{ $t(`activity.${row.line.sentence}`) }}</span>
          <span v-else class="td-mono">{{ row.line.text }}</span>
          <span v-if="row.stamp" class="td-mono ms-auto whitespace-nowrap text-[11px] text-(--brand-text-3)" data-activity-ts :title="row.stamp.absolute">{{ $t(row.stamp.key, row.stamp.arg) }}</span>
        </div>
      </section>
    </div>

    <!-- The contract's inert slot templates: the hooks survive the framework,
         the multiplicity does not. One template holds one slot per SLOT value. -->
    <div data-detail-templates hidden>
      <div data-detail-for="*">
        <div data-detail-slot-source hidden></div>
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
