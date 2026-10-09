<script setup>
/**
 * B11 · Create-project modal — name and identifier prefix.
 *
 * Always in the document, toggled by `hidden`, so its single
 * `[data-create-project]` holds whether open or closed.
 */
import { computed, reactive, watch } from "vue";

import { api } from "../../services/api.js";
import { loadProjects, selectProject } from "../../stores/board.js";
import { createProjectOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

const form = reactive({ name: "", prefix: "" });
const canSubmit = computed(() => form.name.trim() !== "");

watch(createProjectOpen, (open) => {
  if (open) {
    form.name = "";
    form.prefix = "";
  }
});

async function submit() {
  if (!canSubmit.value) return;
  const data = await api.createProject({ name: form.name.trim(), meta: form.prefix.trim() ? { prefix: form.prefix.trim().toUpperCase() } : {} });
  await loadProjects();
  if (data?.project?.id) await selectProject(data.project.id);
  pushToast(t("toast.projectCreated"), "success");
  createProjectOpen.value = false;
}
</script>

<template>
  <div class="td-modal" data-create-project :hidden="!createProjectOpen" role="dialog" aria-modal="true" :aria-label="$t('createProject.title')">
    <div class="td-modal-box" style="width: min(480px, 100%)">
      <form data-create-project-form @submit.prevent="submit">
        <header class="td-modal-head">
          <h2 data-i18n="createProject.title">{{ $t("createProject.title") }}</h2>
          <button type="button" class="td-card-menu" data-modal-close :aria-label="$t('modal.close')" @click="createProjectOpen = false">✕</button>
        </header>
        <div class="td-modal-body">
          <label class="td-field">
            <span data-i18n="createProject.field.name">{{ $t("createProject.field.name") }}</span>
            <input v-model="form.name" class="td-input" type="text" data-create-project-name />
          </label>
          <label class="td-field">
            <span data-i18n="createProject.field.prefix">{{ $t("createProject.field.prefix") }}</span>
            <input v-model="form.prefix" class="td-input td-mono" type="text" maxlength="4" data-create-project-prefix :placeholder="$t('createProject.field.prefixHint')" />
          </label>
        </div>
        <footer class="td-modal-foot">
          <button type="button" class="btn btn-ghost btn-sm" @click="createProjectOpen = false">{{ $t("modal.cancel") }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSubmit">{{ $t("createProject.submit") }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>
