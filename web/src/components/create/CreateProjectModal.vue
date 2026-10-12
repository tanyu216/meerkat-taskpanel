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
  <div
    class="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-6 bg-(--brand-scrim)"
    data-create-project
    :hidden="!createProjectOpen"
    role="dialog"
    aria-modal="true"
    :aria-label="$t('createProject.title')"
  >
    <!-- R8 ① — same scrim token, same panel hook and same dark edge as the
         create-task dialog: B11 shares B10's geometry, so it shares its
         separation devices (see `CreateTaskModal.vue` and `app.css`). -->
    <div class="w-[min(480px,100%)] border border-(--brand-border) rounded-lg bg-(--brand-surface) [box-shadow:var(--shadow-pop)]" data-create-project-panel>
      <form data-create-project-form @submit.prevent="submit">
        <header class="flex items-center justify-between px-4 py-3 border-b border-b-(--brand-border)">
          <h2 data-i18n="createProject.title">{{ $t("createProject.title") }}</h2>
          <button type="button" class="border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-modal-close :aria-label="$t('modal.close')" @click="createProjectOpen = false">✕</button>
        </header>
        <div class="p-4">
          <label class="flex flex-col gap-1 mb-3">
            <span data-i18n="createProject.field.name">{{ $t("createProject.field.name") }}</span>
            <input v-model="form.name" class="input input-sm td-input w-full" type="text" data-create-project-name />
          </label>
          <label class="flex flex-col gap-1 mb-3">
            <span data-i18n="createProject.field.prefix">{{ $t("createProject.field.prefix") }}</span>
            <input v-model="form.prefix" class="input input-sm td-input td-mono w-full" type="text" maxlength="4" data-create-project-prefix :placeholder="$t('createProject.field.prefixHint')" />
          </label>
        </div>
        <footer class="flex justify-end gap-2 px-4 py-3 border-t border-t-(--brand-border)">
          <button type="button" class="btn btn-ghost btn-sm" @click="createProjectOpen = false">{{ $t("modal.cancel") }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSubmit">{{ $t("createProject.submit") }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>
