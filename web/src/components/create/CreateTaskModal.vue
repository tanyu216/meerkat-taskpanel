<script setup>
/**
 * B10 · Create-task composer — one description, no routing form.
 *
 * The human writes what should be true when the work is done; the board records
 * an **intake request** (`POST /api/v1/intake`) and the supervisor hands it to
 * the decision lane, which files the cards. Priority, assignee, labels, status
 * and acceptance are the director's decision, not a menu here.
 *
 * Three examples run simple → complex and **fill** the box (editable). The
 * project is the one field the submitter keeps: the request is project-scoped,
 * and the default is the project the board is showing.
 *
 * The dialog is always in the document and toggled by `hidden`, so the
 * contract's single `[data-create-task]` holds whether it is open or not.
 */
import { computed, reactive, ref, watch } from "vue";

import { board, createIntake } from "../../stores/board.js";
import { createTaskOpen, pushToast } from "../../stores/ui.js";
import { errorTextKey } from "../../i18n/messages.mjs";
import { t } from "../../i18n/index.js";

const form = reactive({
  text: "",
  project_id: null,
  // One key per opening: a double submit (a double click, a lost response)
  // resolves to the request that already landed.
  idem: null,
});

const submitting = ref(false);

const examples = computed(() => [
  { key: "simple", text: t("createTask.example.simple") },
  { key: "medium", text: t("createTask.example.medium") },
  { key: "complex", text: t("createTask.example.complex") },
]);

const canSubmit = computed(
  () => form.text.trim() !== "" && Boolean(form.project_id) && !submitting.value,
);

/** A client idempotency key; `crypto.randomUUID` is the browser's own source. */
function newIdem() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `intake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function reset() {
  form.text = "";
  form.project_id = board.currentProjectId ?? null;
  form.idem = newIdem();
  submitting.value = false;
}

watch(createTaskOpen, (open) => {
  if (open) reset();
});

/** A chip fills the box; the human can then edit it. */
function fillExample(example) {
  form.text = example.text;
}

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    await createIntake({
      project_id: form.project_id,
      text: form.text.trim(),
      idem: form.idem,
    });
  } catch (err) {
    // A refusal leaves the composer up holding what was typed; `code` is the
    // half the board renders (the server's message is not a UI string).
    submitting.value = false;
    pushToast(t(errorTextKey(err)), "danger");
    return;
  }
  createTaskOpen.value = false;
  reset();
}
</script>

<template>
  <div
    class="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4 bg-(--brand-scrim)"
    data-create-task
    :hidden="!createTaskOpen"
    role="dialog"
    aria-modal="true"
    :aria-label="$t('createTask.title')"
  >
    <div
      class="w-[min(640px,100%)] border border-(--brand-border) rounded-lg bg-(--brand-surface) [box-shadow:var(--shadow-pop)]"
      data-create-task-panel
    >
      <form data-create-task-form @submit.prevent="submit">
        <header class="flex items-center justify-between px-5 py-3 border-b border-b-(--brand-border)">
          <h2 data-i18n="createTask.title">{{ $t("createTask.title") }}</h2>
          <button type="button" class="border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-modal-close :aria-label="$t('modal.close')" @click="createTaskOpen = false">✕</button>
        </header>

        <div class="flex flex-col gap-4 p-5">
          <label class="flex flex-col gap-1">
            <span data-i18n="createTask.field.description">{{ $t("createTask.field.description") }}</span>
            <textarea
              v-model="form.text"
              class="td-textarea w-full min-h-[8rem]"
              rows="5"
              data-create-task-text
              :placeholder="$t('createTask.textHint')"
              :aria-label="$t('createTask.field.description')"
            ></textarea>
            <span class="text-[11px] text-(--brand-text-3)" data-create-task-hint data-i18n="createTask.intakeHint">
              {{ $t("createTask.intakeHint") }}
            </span>
          </label>

          <div class="flex flex-col gap-2">
            <span data-i18n="createTask.examples">{{ $t("createTask.examples") }}</span>
            <div class="flex flex-col gap-2" data-create-task-examples>
              <button
                v-for="example in examples"
                :key="example.key"
                type="button"
                class="btn btn-xs btn-ghost h-auto w-full max-w-full justify-start whitespace-normal text-left"
                data-create-task-example
                :data-example-kind="example.key"
                @click="fillExample(example)"
              >{{ example.text }}</button>
            </div>
          </div>

          <label class="flex flex-col gap-1">
            <span data-i18n="createTask.field.project">{{ $t("createTask.field.project") }}</span>
            <select v-model="form.project_id" class="select select-sm td-select w-full" data-create-task-project>
              <option v-for="project in board.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </label>
        </div>

        <footer class="flex justify-end gap-2 px-5 py-3 border-t border-t-(--brand-border)">
          <button type="button" class="btn btn-ghost btn-sm" @click="createTaskOpen = false">{{ $t("modal.cancel") }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSubmit" data-create-task-submit data-i18n="createTask.submit">{{ $t("createTask.submit") }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>
