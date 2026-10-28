<script setup>
/**
 * B11 · Create-project modal — name and identifier prefix.
 *
 * Always in the document, toggled by `hidden`, so its single
 * `[data-create-project]` holds whether open or closed.
 *
 * The prefix is sent **verbatim**, as `meta.prefix`, and the server normalizes
 * it (C-PREFIX-1 M1/M2): the UI has no copy of `identifierPrefix` — `web/` and
 * `src/` are two builds with no import between them — so uppercasing here would
 * be a second, weaker normalization (it cannot fold or trim) that only ever
 * agrees with the server by accident. Both fields are required, so an empty
 * prefix never reaches the network.
 *
 * A refusal is answered, never swallowed (C-PREFIX-1 M7): the server's own
 * refusals — a prefix that normalizes away, one the 1-4 rule rejects, one
 * already taken, a conflict — are what `submit()` reports back to the reader,
 * in the app's words, with the dialog still open.
 */
import { computed, reactive, watch } from "vue";

import { ApiError, api } from "../../services/api.js";
import { loadProjects, selectProject } from "../../stores/board.js";
import { createProjectOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

// 0038 — one acceptance default, `auto` unless the creator says otherwise.
const form = reactive({ name: "", prefix: "", acceptance: "auto", reviewer: "" });
const canSubmit = computed(() => form.name.trim() !== "" && form.prefix.trim() !== "");
const acceptances = ["auto", "off", "agent", "human"];

watch(createProjectOpen, (open) => {
  if (open) {
    form.name = "";
    form.prefix = "";
    form.acceptance = "auto";
    form.reviewer = "";
  }
});

/**
 * The copy a refused create answers with (C-PREFIX-1 M7).
 *
 * The wire's own message is English and technical (`project prefix "####" has no
 * usable identifier prefix`), so the dialog speaks the app's vocabulary instead.
 * The 400s are told apart by the refusal's **declared details**, not by its
 * message, and in a fixed order: a prefix another project already numbers its
 * cards with (M5) needs a different repair from one the 1-4 `[A-Z0-9]` rule
 * rejects (M8, which reports `max`), and both differ from a prefix that
 * normalizes away to nothing (M4) — and none of them is what a 409 or an
 * unreachable board means. The collision check runs last on the server, so a
 * value that fails the shape rule never arrives here as a collision.
 */
function refusalText(err) {
  const declared = err instanceof ApiError && err.code === "VALIDATION_FAILED" && err.details?.field === "meta.prefix";
  if (!declared) return t("toast.projectCreateFailed");
  if (err.details.conflictProjectId !== undefined) return t("toast.projectPrefixTaken");
  if (err.details.max !== undefined) return t("toast.projectPrefixTooLong");
  return t("toast.projectPrefixUnusable");
}

async function submit() {
  if (!canSubmit.value) return;
  try {
    const data = await api.createProject({
      name: form.name.trim(),
      meta: { prefix: form.prefix.trim() },
      acceptance: form.acceptance,
      reviewer: form.reviewer.trim() || null,
    });
    await loadProjects();
    if (data?.project?.id) await selectProject(data.project.id);
    pushToast(t("toast.projectCreated"), "success");
    createProjectOpen.value = false;
  } catch (err) {
    // M7 — a refusal is **visible**, and the dialog stays up holding what was
    // typed so the reader repairs the prefix and submits again; the success path
    // above is the only one that closes the dialog or announces a project. The
    // catch covers the reload as well, on purpose: nothing in this flow may end
    // in silence. Only the request can say *why* it was refused, though, so the
    // prefix-specific wording is reserved for the codes that carry a reason.
    pushToast(refusalText(err), "danger");
  }
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
            <!-- C-PREFIX-1 M1/M2 — four characters, typed as upper-case where the
                 keyboard offers it; the input carries no `pattern` (§7.3): the
                 server's 1-4 [A-Z0-9] rule is the one authority, and a native
                 pattern would block the POST whose refusal dom-smoke's M7 leg
                 reads. -->
            <input v-model="form.prefix" class="input input-sm td-input td-mono w-full" type="text" maxlength="4" required autocapitalize="characters" spellcheck="false" autocomplete="off" data-create-project-prefix :placeholder="$t('createProject.field.prefixHint')" />
          </label>
          <label class="flex flex-col gap-1 mb-3">
            <span data-i18n="createProject.field.acceptance">{{ $t("createProject.field.acceptance") }}</span>
            <!-- 0038 — `data-create-project-review-policy` stays as the design's
                 stable hook (B11's selector); the field it names is now the one
                 acceptance vocabulary. -->
            <select v-model="form.acceptance" class="select select-sm td-select w-full" data-create-project-acceptance data-create-project-review-policy>
              <option v-for="acceptance in acceptances" :key="acceptance" :value="acceptance">{{ $t(`createProject.acceptance.${acceptance}`) }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 mb-3">
            <span data-i18n="createProject.field.reviewer">{{ $t("createProject.field.reviewer") }}</span>
            <input v-model="form.reviewer" class="input input-sm td-input w-full" type="text" data-create-project-reviewer :placeholder="$t('createProject.field.reviewerHint')" />
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
