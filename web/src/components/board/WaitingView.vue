<script setup>
/**
 * M1 · B-view 「等你回复」 — the filter view for cards parked on a human.
 *
 * Three things this view is careful about, all of them design requirements:
 *
 *   * **It is not a column.** `[data-waiting-view]` is a *view* of the same
 *     cards the board holds; the rows reuse the existing card component
 *     unchanged, so nothing about a card moves when it appears here (§3.2).
 *   * **The payload is the triggering human comment, read, never invented.**
 *     `[data-waiting-payload-summary]` is the comment's first sentence and
 *     `[data-waiting-payload-full]` its verbatim text behind a native
 *     `<details>` that is **closed by default** — a silent view, and one that
 *     works with the keyboard and the browser's own find-in-page without a line
 *     of script (§3.4).
 *   * **List and count read one predicate.** Both come from the store's
 *     `waitingTasks`, so a card hidden by an active filter is in neither (§3.5).
 *
 * The rows are `awaiting` cards, so they carry `data-status="awaiting"` on the
 * *wrapper* — the card inside keeps its stage (its column), which is what keeps
 * the board's "no eighth column" and "no repainted stripe" promises intact.
 */
import { computed, onMounted, watch } from "vue";

import { board, firstSentence, loadWaitingPayloads, openDetail, waitingTasks } from "../../stores/board.js";
import { view } from "../../stores/ui.js";

import Card from "./Card.vue";

/** The payload comment for a card, or `null` when it has not loaded / has none. */
function payloadOf(task) {
  return board.waitingPayload[task.id] ?? null;
}

/** The first sentence shown above the fold; empty when there is nothing to read. */
function summaryOf(task) {
  const payload = payloadOf(task);
  return payload === null ? "" : firstSentence(payload.body);
}

const isEmpty = computed(() => waitingTasks.value.length === 0);

async function refresh() {
  await loadWaitingPayloads();
}

onMounted(refresh);
// Re-entering the view (or the board re-syncing under it) picks up payloads for
// cards that appeared since — the loader skips what it already knows.
watch(view, (next) => {
  if (next === "waiting") refresh();
});
</script>

<template>
  <section id="td-waiting" class="td-waiting" data-waiting-view>
    <div class="td-waiting-list" data-waiting-list>
      <!-- Pinned first: an awaiting row is what blocks a machine, so it leads
           the view (§3.5). The row is a wrapper — the card itself is untouched. -->
      <article
        v-for="task in waitingTasks"
        :key="task.id"
        class="td-waiting-row"
        data-waiting-card
        data-waiting-pinned="true"
        data-status="awaiting"
      >
        <Card :task="task" @open="openDetail(task.identifier)" />

        <div class="td-waiting-payload" data-waiting-payload>
          <p class="td-waiting-summary" data-waiting-payload-summary>{{ summaryOf(task) }}</p>
          <details data-waiting-payload-details>
            <summary>{{ $t("waiting.payload.expand") }}</summary>
            <div class="td-waiting-full" data-waiting-payload-full>{{ payloadOf(task)?.body ?? "" }}</div>
          </details>
        </div>
      </article>
    </div>

    <!-- The existing empty-state component (B12: `.td-empty .td-empty-lg`),
         with M1's own hook. Deliberately *not* `[data-empty]`: that hook is the
         board's, and B12 allows exactly one no-results state per board view. -->
    <div v-if="isEmpty" class="td-empty td-empty-lg" data-waiting-empty>
      <span class="td-empty-title">{{ $t("waiting.empty") }}</span>
    </div>
  </section>
</template>
