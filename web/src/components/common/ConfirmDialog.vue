<script setup>
/**
 * The one confirmation dialog (TP-0125 · B12/B11 geometry).
 *
 * Always in the document and toggled by `hidden`, so its single
 * `[data-confirm-dialog]` holds whether open or closed — the same shape the
 * create dialogs use. It is opened by `askConfirm` and closed by
 * `dismissConfirm` / a completed `acceptConfirm`; the shell owns the Escape
 * branch, and the dialog itself owns focus (dismiss first, the safe choice).
 *
 * The overlay reuses the create dialogs' scrim token and panel edge, so the
 * destructive prompt reads as the same layer as the rest of the app.
 */
import { nextTick, ref, watch } from "vue";

import { acceptConfirm, confirm, dismissConfirm } from "../../stores/confirm.js";

const dismissButton = ref(null);

watch(
  () => confirm.open,
  (open) => {
    if (open) nextTick(() => dismissButton.value?.focus());
  },
);

/**
 * The dialog's own accept press. The gated write's failure is rethrown by
 * `acceptConfirm` for its caller's surface (`moveTask`'s toast, the drawer's
 * error panel); the dialog only has to prevent it becoming an unhandled
 * rejection after the dialog has closed.
 */
async function onAccept() {
  try {
    await acceptConfirm();
  } catch {
    // The write's owner rendered the refusal; the dialog's job is done.
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto p-6 bg-(--brand-scrim)"
    data-confirm-dialog
    :hidden="!confirm.open"
    role="dialog"
    aria-modal="true"
    :aria-label="confirm.titleKey ? $t(confirm.titleKey) : ''"
  >
    <div
      class="w-[min(440px,100%)] border border-(--brand-border) rounded-lg bg-(--brand-surface) [box-shadow:var(--shadow-pop)]"
      data-confirm-panel
    >
      <header class="flex items-center justify-between px-4 py-3 border-b border-b-(--brand-border)">
        <h2 data-confirm-title>{{ confirm.titleKey ? $t(confirm.titleKey) : "" }}</h2>
      </header>
      <div class="p-4">
        <p class="m-0 text-[13px] text-(--brand-text-2)" data-confirm-body>
          {{ confirm.bodyKey ? $t(confirm.bodyKey) : "" }}
        </p>
      </div>
      <footer class="flex justify-end gap-2 px-4 py-3 border-t border-t-(--brand-border)">
        <button
          ref="dismissButton"
          type="button"
          class="btn btn-ghost btn-sm"
          data-confirm-dismiss
          :disabled="confirm.busy"
          @click="dismissConfirm()"
        >
          {{ $t("confirm.keep") }}
        </button>
        <button
          type="button"
          class="btn btn-error btn-sm"
          data-confirm-accept
          :disabled="confirm.busy"
          @click="onAccept"
        >
          {{ confirm.actionKey ? $t(confirm.actionKey) : "" }}
        </button>
      </footer>
    </div>
  </div>
</template>
