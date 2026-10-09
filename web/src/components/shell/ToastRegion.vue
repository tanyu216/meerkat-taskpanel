<script setup>
/**
 * B14 · Toast region.
 *
 * One live region (`role="status"`, `aria-live="polite"`), one inert template
 * element carrying the toast markup, and the runtime toasts the UI store pushes.
 * Auto-dismiss is the store's job (2.5 s); this component only renders state.
 */
import { toasts } from "../../stores/ui.js";
</script>

<template>
  <div class="td-toast-region" data-toast-region role="status" aria-live="polite">
    <template data-toast-template>
      <div class="td-toast" data-toast data-toast-kind="info">
        <span data-toast-text></span>
      </div>
    </template>

    <div v-for="toast in toasts" :key="toast.id" class="td-toast" data-toast :data-toast-kind="toast.kind" :data-state="toast.state">
      <span data-toast-text>{{ toast.text }}</span>
    </div>
  </div>
</template>
