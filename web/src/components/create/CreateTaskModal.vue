<script setup>
/**
 * B10 · Create-task modal — the two-column dialog.
 *
 * Left: the title and the Markdown editor (Write / Preview / Split, B23).
 * Right: the eight routing fields — priority, assignee (B22), project, status,
 * reporter (B22), labels (B25), parent (B24), depends-on (B24). The relation
 * fields are UI-only (B24): a relation is never written, so neither reaches the
 * created card.
 *
 * The dialog is always in the document and toggled by `hidden`, so the contract's
 * single `[data-create-task]` holds whether it is open or not.
 */
import { computed, reactive, ref, watch } from "vue";

import { board, assigneeRoster, createTask, labelRoster, reporterRoster, PRIORITIES, taskRoster } from "../../stores/board.js";
import { createTaskOpen, createTaskStatus, pushToast } from "../../stores/ui.js";
import { errorTextKey } from "../../i18n/messages.mjs";
import { t } from "../../i18n/index.js";

import ComboField from "../combo/ComboField.vue";
import MarkdownEditor from "./MarkdownEditor.vue";

// Statuses a task can be *created* in — the creation gate forbids in_review/done.
const createStatuses = ["backlog", "todo", "in_progress", "blocked", "canceled"];

const form = reactive({
  title: "",
  description: "",
  priority: "medium",
  status: "todo",
  project_id: null,
  assignee: "",
  reporter: "",
  labels: [],
  parent: "",
  depends: [],
});

const peopleOptions = computed(() => board.assignees.map((entry) => ({ name: entry.display_name, kind: entry.kind, platform: entry.platform })));
const reporterOptions = computed(() => reporterRoster.value.map((name) => ({ name })));
const labelOptions = computed(() => labelRoster.value.map((name) => ({ name })));
/**
 * Both relation fields are offered the **whole** roster, not the roster minus
 * what is already chosen. The control drops the chosen entries from the menu on
 * its own (they are its chips), which is what lets a chip name its task by
 * identifier *and* title: the title is read back from the roster the row came
 * from, and a pre-filtered list would have removed exactly that row
 * (T-20261014-001418 ②).
 */
const relationOptions = taskRoster;

const canSubmit = computed(() => form.title.trim() !== "" && form.project_id);

/** The parent field, so its clear ✕ can empty the box with the value. */
const parentField = ref(null);

function clearParent() {
  form.parent = "";
  parentField.value?.clear();
}

function reset() {
  form.title = "";
  form.description = "";
  form.priority = "medium";
  form.status = createTaskStatus.value ?? "todo";
  form.project_id = board.currentProjectId;
  form.assignee = "";
  form.reporter = "";
  form.labels = [];
  form.parent = "";
  form.depends = [];
}

watch(createTaskOpen, (open) => {
  if (open) reset();
});

/**
 * Submit, and **answer a refusal** (T-20261014-152924 ④).
 *
 * This used to be a bare `await createTask(payload)`: a refused create rejected
 * into nothing, so the dialog neither closed nor said why — the worst of the two
 * outcomes. The refusal now goes through the same one-sentence-per-code path the
 * board uses, the dialog stays up holding what was typed, and only a success
 * closes it.
 */
async function submit() {
  if (!canSubmit.value) return;
  const payload = {
    project_id: form.project_id,
    title: form.title.trim(),
    description: form.description,
    priority: form.priority,
    status: form.status,
    labels: form.labels,
  };
  if (form.assignee) payload.assignee = form.assignee;
  if (form.reporter) payload.reporter = form.reporter;
  try {
    await createTask(payload);
  } catch (err) {
    pushToast(t(errorTextKey(err)), "danger");
    return;
  }
  createTaskOpen.value = false;
  reset();
}
</script>

<template>
  <div
    class="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-6 bg-(--brand-scrim)"
    data-create-task
    :hidden="!createTaskOpen"
    role="dialog"
    aria-modal="true"
    :aria-label="$t('createTask.title')"
  >
    <!-- R8 ① — the panel carries a hook of its own (`data-create-task-panel`),
         so a machine check can address the edge, the shadow and the surface
         without a positional anchor (`[data-create-task] > div` is a position,
         which the contract's own selector grammar forbids). Its dark edge is the
         strong hairline; see the `dialog dark edge` rule in `app.css`.

         R4 · the box is the prototype's `min(1120px, …)`, not 960. The **field
         track width is the column width**, and the column width is this box
         minus the 20px gutter, the 24px gap and the hairline — so a 960px box
         renders the routing column at 350px against the prototype's 405.391
         (T-20261015-215028 ①: the track *ratio* was never the difference, only
         the box that feeds it). 1120 + 20 + 24 is the prototype's own R4
         geometry (`design/prototype/src/input.css` `.td-modal-box` /
         `.td-two-col`), which is what makes the two sides agree to the pixel. -->
    <div class="w-[min(1120px,100%)] border border-(--brand-border) rounded-lg bg-(--brand-surface) [box-shadow:var(--shadow-pop)]" data-create-task-panel>
      <form data-create-task-form @submit.prevent="submit">
        <header class="flex items-center justify-between px-5 py-3 border-b border-b-(--brand-border)">
          <h2 data-i18n="createTask.title">{{ $t("createTask.title") }}</h2>
          <button type="button" class="border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-modal-close :aria-label="$t('modal.close')" @click="createTaskOpen = false">✕</button>
        </header>

        <!-- Single track by default, the pair only *above* 760px — the boundary
             is inclusive on the narrow side. Tailwind v4 compiles `max-[760px]:`
             to `@media (width < 760px)`, which is exclusive and left 760px
             two-column; DESIGN.md §18.5 wants the dialog single-column *at* 760,
             matching the prototype's own `@media (max-width: 760px)`. The
             `minmax(0, …)` pair is kept: it is what stops a long value or the
             editor from pushing the dialog past its box.

             The gutter (20px) and the gap (24px) are the prototype's own
             (`.td-modal-box`'s 20px padding, `.td-two-col`'s 24px gap) and they
             are load-bearing for the track: the routing column is
             `(1120 − 2·1 − 2·20 − 24) / 2.6 = 405.391px`, which is the number
             T-20261015-215028 aligns to. The header and the footer carry the
             same 20px so the three gutters stay one column. -->
        <div class="grid grid-cols-1 min-[761px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-6 p-5" data-create-two-col>
          <div data-create-left>
            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.title">{{ $t("createTask.field.title") }}</span>
              <input v-model="form.title" class="input input-sm td-input w-full" type="text" data-create-task-title :placeholder="$t('createTask.field.titleHint')" />
            </label>
            <!-- R10 ③ — this field is the one that fills the column: the title
                 above it is content-height, the description takes the rest, and
                 the editor takes the rest of *that* (the chain lives in
                 `app.css`: `[data-create-two-col]` → `[data-create-left]` →
                 `.td-field-grow` → `[data-md-editor]` → `.td-md-panes`). It is
                 the column's **last** field, so it carries no bottom margin:
                 that margin is what the a field-in-a-stack holds to separate it
                 from the next one, and here it would be a band of empty box
                 under the very editor the round is about. -->
            <label class="td-field-grow flex flex-col gap-1">
              <span data-i18n="createTask.field.description">{{ $t("createTask.field.description") }}</span>
              <MarkdownEditor v-model="form.description" />
            </label>
          </div>

          <div data-create-right>
            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.priority">{{ $t("createTask.field.priority") }}</span>
              <select v-model="form.priority" class="select select-sm td-select w-full" data-create-task-priority>
                <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`priority.${priority}`) }}</option>
              </select>
            </label>

            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.assignee">{{ $t("createTask.field.assignee") }}</span>
              <ComboField
                v-model="form.assignee"
                :options="peopleOptions"
                hook-input="data-assignee-input"
                hook-menu="data-assignee-menu"
                hook-option="data-assignee-option"
                hook-value="data-assignee-value"
                kind-attr="data-assignee-kind"
                platform-attr="data-agent-platform"
                placeholder-key="combo.assigneePlaceholder"
                aria-key="createTask.field.assignee"
              />
            </label>

            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.project">{{ $t("createTask.field.project") }}</span>
              <select v-model="form.project_id" class="select select-sm td-select w-full" data-create-task-project>
                <option v-for="project in board.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>

            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.status">{{ $t("createTask.field.status") }}</span>
              <select v-model="form.status" class="select select-sm td-select w-full" data-create-task-status>
                <option v-for="status in createStatuses" :key="status" :value="status">{{ $t(`status.${status}`) }}</option>
              </select>
            </label>

            <label class="flex flex-col gap-1 mb-3">
              <span data-i18n="createTask.field.reporter">{{ $t("createTask.field.reporter") }}</span>
              <ComboField
                v-model="form.reporter"
                :options="reporterOptions"
                hook-input="data-reporter-input"
                hook-menu="data-reporter-menu"
                hook-option="data-reporter-option"
                hook-value="data-reporter-value"
                placeholder-key="combo.reporterPlaceholder"
                aria-key="createTask.field.reporter"
              />
            </label>

            <div class="flex flex-col gap-1 mb-3" data-create-task-labels>
              <span data-i18n="createTask.field.labels">{{ $t("createTask.field.labels") }}</span>
              <ComboField
                v-model="form.labels"
                :options="labelOptions"
                multi
                hook-input="data-label-input"
                hook-menu="data-label-menu"
                hook-option="data-label-option"
                hook-value="data-label-value"
                hook-chips="data-label-chips"
                hook-chip="data-label-chip"
                hook-chip-value="data-label-value"
                hook-chip-remove="data-label-remove"
                placeholder-key="combo.labelsPlaceholder"
                empty-key="combo.noLabels"
                aria-key="createTask.field.labels"
              />
              <span class="text-[11px] text-(--brand-text-3)" data-optional data-i18n="createTask.field.labelsHint">{{ $t("createTask.field.labelsHint") }}</span>
            </div>

            <div class="flex flex-col gap-1 mb-3" data-create-task-parent>
              <span>{{ $t("createTask.field.parent") }} <span class="text-[11px] text-(--brand-text-3)" data-optional>{{ $t("createTask.optional") }}</span></span>
              <!-- The chip row the control renders sits above the box, so the
                   clear ✕ is levelled with the box (`items-end`) rather than
                   stretched over the chips (B24, T-20261014-001418 ②). -->
              <div class="flex items-end gap-1">
                <ComboField
                  ref="parentField"
                  v-model="form.parent"
                  :options="relationOptions"
                  :free-text="false"
                  task-mode
                  hook-input="data-parent-input"
                  hook-menu="data-parent-menu"
                  hook-option="data-parent-option"
                  hook-value="data-parent-value"
                  hook-chips="data-parent-chips"
                  hook-chip="data-parent-chip"
                  hook-chip-value="data-parent-value"
                  hook-chip-remove="data-parent-remove"
                  placeholder-key="combo.parentPlaceholder"
                  empty-key="combo.noTasks"
                  aria-key="createTask.field.parent"
                />
                <button type="button" class="btn btn-ghost btn-sm" data-parent-clear :aria-label="$t('combo.clear')" @click="clearParent">✕</button>
              </div>
            </div>

            <div class="flex flex-col gap-1 mb-3" data-create-task-depends>
              <span>{{ $t("createTask.field.depends") }} <span class="text-[11px] text-(--brand-text-3)" data-optional>{{ $t("createTask.optional") }}</span></span>
              <ComboField
                v-model="form.depends"
                :options="relationOptions"
                :free-text="false"
                multi
                task-mode
                drop-up
                hook-input="data-depends-input"
                hook-menu="data-depends-menu"
                hook-option="data-depends-option"
                hook-value="data-depends-value"
                hook-chips="data-depends-chips"
                hook-chip="data-depends-chip"
                hook-chip-value="data-depends-value"
                hook-chip-remove="data-depends-remove"
                placeholder-key="combo.dependsPlaceholder"
                empty-key="combo.noTasks"
                aria-key="createTask.field.depends"
              />
            </div>
          </div>
        </div>

        <footer class="flex justify-end gap-2 px-5 py-3 border-t border-t-(--brand-border)">
          <button type="button" class="btn btn-ghost btn-sm" @click="createTaskOpen = false">{{ $t("modal.cancel") }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSubmit" data-i18n="createTask.submit">{{ $t("createTask.submit") }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>
