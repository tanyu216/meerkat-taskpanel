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
import { computed, reactive, watch } from "vue";

import { board, assigneeRoster, createTask, labelRoster, reporterRoster, PRIORITIES, taskRoster } from "../../stores/board.js";
import { createTaskOpen, createTaskStatus } from "../../stores/ui.js";
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
const parentOptions = computed(() => taskRoster.value.filter((entry) => entry.identifier !== form.parent));
const dependsOptions = computed(() => taskRoster.value.filter((entry) => !form.depends.includes(entry.identifier)));

const canSubmit = computed(() => form.title.trim() !== "" && form.project_id);

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
  await createTask(payload);
  createTaskOpen.value = false;
  reset();
}
</script>

<template>
  <div class="td-modal" data-create-task :hidden="!createTaskOpen" role="dialog" aria-modal="true" :aria-label="$t('createTask.title')">
    <div class="td-modal-box">
      <form data-create-task-form @submit.prevent="submit">
        <header class="td-modal-head">
          <h2 data-i18n="createTask.title">{{ $t("createTask.title") }}</h2>
          <button type="button" class="td-card-menu" data-modal-close :aria-label="$t('modal.close')" @click="createTaskOpen = false">✕</button>
        </header>

        <div class="td-modal-body td-create-two-col" data-create-two-col>
          <div data-create-left>
            <label class="td-field">
              <span data-i18n="createTask.field.title">{{ $t("createTask.field.title") }}</span>
              <input v-model="form.title" class="td-input" type="text" data-create-task-title :placeholder="$t('createTask.field.titleHint')" />
            </label>
            <label class="td-field">
              <span data-i18n="createTask.field.description">{{ $t("createTask.field.description") }}</span>
              <MarkdownEditor v-model="form.description" />
            </label>
          </div>

          <div data-create-right>
            <label class="td-field">
              <span data-i18n="createTask.field.priority">{{ $t("createTask.field.priority") }}</span>
              <select v-model="form.priority" class="td-select" data-create-task-priority>
                <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`priority.${priority}`) }}</option>
              </select>
            </label>

            <label class="td-field">
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

            <label class="td-field">
              <span data-i18n="createTask.field.project">{{ $t("createTask.field.project") }}</span>
              <select v-model="form.project_id" class="td-select" data-create-task-project>
                <option v-for="project in board.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>

            <label class="td-field">
              <span data-i18n="createTask.field.status">{{ $t("createTask.field.status") }}</span>
              <select v-model="form.status" class="td-select" data-create-task-status>
                <option v-for="status in createStatuses" :key="status" :value="status">{{ $t(`status.${status}`) }}</option>
              </select>
            </label>

            <label class="td-field">
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

            <div class="td-field" data-create-task-labels>
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
              <span class="td-optional" data-i18n="createTask.field.labelsHint">{{ $t("createTask.field.labelsHint") }}</span>
            </div>

            <div class="td-field" data-create-task-parent>
              <span>{{ $t("createTask.field.parent") }} <span class="td-optional">{{ $t("createTask.optional") }}</span></span>
              <div style="display: flex; gap: 4px">
                <ComboField
                  v-model="form.parent"
                  :options="parentOptions"
                  :free-text="false"
                  task-mode
                  hook-input="data-parent-input"
                  hook-menu="data-parent-menu"
                  hook-option="data-parent-option"
                  hook-value="data-parent-value"
                  placeholder-key="combo.parentPlaceholder"
                  empty-key="combo.noTasks"
                  aria-key="createTask.field.parent"
                />
                <button type="button" class="btn btn-ghost btn-sm" data-parent-clear :aria-label="$t('combo.clear')" @click="form.parent = ''">✕</button>
              </div>
            </div>

            <div class="td-field" data-create-task-depends>
              <span>{{ $t("createTask.field.depends") }} <span class="td-optional">{{ $t("createTask.optional") }}</span></span>
              <ComboField
                v-model="form.depends"
                :options="dependsOptions"
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

        <footer class="td-modal-foot">
          <button type="button" class="btn btn-ghost btn-sm" @click="createTaskOpen = false">{{ $t("modal.cancel") }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSubmit" data-i18n="createTask.submit">{{ $t("createTask.submit") }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>
