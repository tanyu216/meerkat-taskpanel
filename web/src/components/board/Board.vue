<script setup>
/**
 * B05 · Board.
 *
 * The seven columns (one per status, in board order), the no-results empty state
 * (B12) when the active filters match nothing, and the **single shared** move
 * menu (auxiliary hooks `[data-move-menu]` / `[data-move-to]`) that every card's
 * kebab opens — the keyboard fallback for dragging. The board is the document's
 * only horizontal scroll container.
 */
import { computed, ref, watch } from "vue";

import { allowedTargets, board, columns, moveTask, openDetail, totalVisible } from "../../stores/board.js";
import { closeMoveMenu, moveMenu, openCreateTask, view } from "../../stores/ui.js";
import Column from "./Column.vue";

const dragging = ref(null);

/**
 * The move menu offers exactly the moves the state machine allows from the
 * card's *own* status — never the whole vocabulary with the impossible ones
 * included. M1's reason for tightening this: an `awaiting` card must be offered
 * **no** route to `in_review`, `done` or `blocked` (design §6/§8-13), because
 * offering a move the delivery gate will refuse is the UI half of bypassing it.
 */
const moveRows = computed(() => {
  const status = moveMenu.value?.task?.status;
  return allowedTargets(status).map((target) => ({ status: target, current: false }));
});

function onDragStart(task, event) {
  dragging.value = task.id;
  if (event?.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.identifier);
  }
}
function onDragEnd() {
  dragging.value = null;
}

function onDrop(status, event) {
  const identifier = dragging.value ?? event?.dataTransfer?.getData("text/plain");
  const task = board.tasks.find((item) => item.id === identifier || item.identifier === identifier);
  dragging.value = null;
  if (!task || task.status === status) return;
  moveTask(task, status).catch(() => {});
}

function openCard(task) {
  openDetail(task.identifier);
}

function chooseMove(row) {
  const task = moveMenu.value?.task;
  closeMoveMenu();
  if (!task || task.status === row.status) return;
  moveTask(task, row.status).catch(() => {});
}

function clearFilters() {
  board.filters.search = "";
  board.filters.assignee = "all";
  board.filters.priority = "all";
  board.filters.label = "all";
}

// The move menu belongs to the board view; leaving it (or the board emptying)
// must not leave a floating menu behind.
watch(view, closeMoveMenu);
</script>

<template>
  <div class="td-board" data-board :hidden="view !== 'board'">
    <Column
      v-for="column in columns"
      :key="column.status"
      :column="column"
      :dragging="dragging"
      @open="openCard"
      @drop="onDrop"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @add="openCreateTask"
    />

    <!-- B12 · the large no-results empty state. It stays **in the document**
         while the board has cards — `hidden`, exactly as the prototype states
         it — so the hook and its Sentinel Watch mark exist at rest and only the
         attribute changes when a filter empties the board. -->
    <div class="td-empty td-empty-lg" data-empty data-empty-kind="no-results" :hidden="totalVisible !== 0">
      <!-- The brand mark stands in for a generic no-results glyph. Its two lead
           meerkats drop to `--brand-text-3` (the design's `--color-td-ink-3`) so
           the on-duty sentinel and its watch signal stay the only lit elements
           on an empty board. Its own face-mask id keeps the document's mask ids
           unique — the top bar's mark is rendered at the same time. -->
      <svg class="td-logo td-logo-lg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <defs>
          <mask id="face-knockout-a-lg" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
            <rect x="0" y="0" width="32" height="32" fill="#FFFFFF" />
            <g fill="#000000">
              <circle cx="6.4" cy="20" r="0.42" />
              <circle cx="8" cy="20" r="0.42" />
              <rect x="6.84" y="21.05" width="0.72" height="0.2" rx="0.1" />
              <circle cx="15.2" cy="14.8" r="0.42" />
              <circle cx="16.8" cy="14.8" r="0.42" />
              <rect x="15.64" y="15.85" width="0.72" height="0.2" rx="0.1" />
              <circle cx="24" cy="12" r="0.42" />
              <circle cx="25.6" cy="12" r="0.42" />
              <rect x="24.44" y="13.05" width="0.72" height="0.2" rx="0.1" />
            </g>
          </mask>
        </defs>
        <g mask="url(#face-knockout-a-lg)">
          <g fill="var(--brand-text-3)">
            <rect x="4.6" y="17.6" width="5.2" height="9.4" rx="2.6" />
            <circle cx="7.2" cy="20.2" r="2.6" />
            <circle cx="4.8" cy="19.3" r="1.2" />
            <circle cx="9.6" cy="19.3" r="1.2" />
          </g>
          <g fill="var(--brand-text-3)">
            <rect x="13.4" y="12.4" width="5.2" height="14.6" rx="2.6" />
            <circle cx="16" cy="15" r="2.6" />
            <circle cx="13.6" cy="14.1" r="1.2" />
            <circle cx="18.4" cy="14.1" r="1.2" />
          </g>
          <g fill="var(--color-primary)">
            <rect x="22.2" y="9.6" width="5.2" height="17.4" rx="2.6" />
            <circle cx="24.8" cy="12.2" r="2.6" />
            <circle cx="22.4" cy="11.3" r="1.2" />
            <circle cx="27.2" cy="11.3" r="1.2" />
          </g>
        </g>
        <circle cx="24.8" cy="3.4" r="2.1" fill="var(--color-primary)" />
      </svg>
      <span class="td-empty-title" data-i18n="noResults.title">{{ $t("noResults.title") }}</span>
      <span class="td-empty-hint" data-i18n="noResults.hint">{{ $t("noResults.hint") }}</span>
      <button type="button" class="btn btn-outline btn-sm" @click="clearFilters">{{ $t("noResults.clear") }}</button>
    </div>

    <ul
      v-if="moveMenu"
      class="td-details-menu menu"
      data-move-menu
      :style="{ position: 'fixed', top: `${moveMenu.top}px`, left: `${moveMenu.left}px` }"
    >
      <li v-for="row in moveRows" :key="row.status">
        <button type="button" data-move-to :aria-current="row.current ? 'true' : 'false'" @click="chooseMove(row)">
          {{ $t(`status.${row.status}`) }}
        </button>
      </li>
    </ul>
  </div>
</template>
