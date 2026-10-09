<script setup>
/**
 * B18 · States showcase (a prototype review surface), plus B17 · the error state.
 *
 * The gallery puts every non-default state in one frame for the UI/UX review:
 * the loading skeleton, the empty column and no-results states, the error state
 * and the three toast kinds. It is opened from `[data-states-open]` in the
 * sidebar; it adds no framework — a scrim, a panel and two handlers.
 *
 * The error state lives **here** and not on the board, because the contract
 * allows exactly one `[data-error-state]` in the document; a real board load
 * failure shows a separate, hook-less banner (see `App.vue`).
 */
import { initBoard } from "../../stores/board.js";
import { pushToast, statesOpen } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

const toastSamples = [
  { kind: "info", key: "toast.sample.info" },
  { kind: "success", key: "toast.sample.success" },
  { kind: "danger", key: "toast.sample.danger" },
];

function retry() {
  initBoard();
  pushToast(t("toast.reloaded"), "success");
}
</script>

<template>
  <div class="td-panel-overlay" data-states-overlay data-state="closed" :hidden="!statesOpen" @click="statesOpen = false"></div>

  <section
    class="td-panel"
    data-states-panel
    :data-state="statesOpen ? 'open' : 'closed'"
    :hidden="!statesOpen"
    role="dialog"
    aria-modal="true"
    :aria-label="$t('states.title')"
  >
    <header class="td-panel-head">
      <h2 data-i18n="states.title">{{ $t("states.title") }}</h2>
      <button type="button" class="td-card-menu" data-states-close :aria-label="$t('states.close')" @click="statesOpen = false">✕</button>
    </header>

    <section class="td-state-block" data-loading-state>
      <h3 data-i18n="states.loading">{{ $t("states.loading") }}</h3>
      <p class="td-state-note" data-i18n="states.loadingNote">{{ $t("states.loadingNote") }}</p>
      <div class="td-skeleton">
        <div class="td-skeleton-row"></div>
        <div class="td-skeleton-row"></div>
      </div>
    </section>

    <section class="td-state-block" data-empty-column>
      <h3 data-i18n="states.emptyColumn">{{ $t("states.emptyColumn") }}</h3>
      <p class="td-state-note" data-i18n="states.emptyColumnNote">{{ $t("states.emptyColumnNote") }}</p>
      <div class="td-empty">
        <span class="td-empty-title" data-i18n="column.empty.title">{{ $t("column.empty.title") }}</span>
        <span class="td-empty-hint" data-i18n="column.empty.hint" :data-i18n-arg="'status.backlog'">{{ $t("column.empty.hint", $t("status.backlog")) }}</span>
      </div>
    </section>

    <section class="td-state-block" data-empty-results>
      <h3 data-i18n="states.emptyResults">{{ $t("states.emptyResults") }}</h3>
      <p class="td-state-note" data-i18n="states.emptyResultsNote">{{ $t("states.emptyResultsNote") }}</p>
      <div class="td-empty">
        <span class="td-empty-title" data-i18n="noResults.title">{{ $t("noResults.title") }}</span>
        <span class="td-empty-hint" data-i18n="noResults.hint">{{ $t("noResults.hint") }}</span>
      </div>
    </section>

    <!-- B17 · the document's single error state. -->
    <section class="td-state-block">
      <h3 data-i18n="states.error">{{ $t("states.error") }}</h3>
      <p class="td-state-note" data-i18n="states.errorNote">{{ $t("states.errorNote") }}</p>
      <div class="td-error" data-error-state role="alert" hidden>
        <span class="td-empty-title" data-i18n="error.title">{{ $t("error.title") }}</span>
        <span class="td-empty-hint" data-i18n="error.hint">{{ $t("error.hint") }}</span>
        <button type="button" class="btn btn-outline btn-sm" data-error-retry data-i18n="error.retry" @click="retry">
          {{ $t("error.retry") }}
        </button>
      </div>
    </section>

    <section class="td-state-block" data-toast-states>
      <h3 data-i18n="states.toasts">{{ $t("states.toasts") }}</h3>
      <p class="td-state-note" data-i18n="states.toastsNote">{{ $t("states.toastsNote") }}</p>
      <div class="td-toast-region" style="position: static">
        <div v-for="sample in toastSamples" :key="sample.kind" class="td-toast" data-toast :data-toast-kind="sample.kind" data-state="static">
          <span data-toast-text>{{ $t(sample.key) }}</span>
        </div>
      </div>
    </section>
  </section>
</template>
