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

import { board, columns, moveTask, openDetail, STATUSES, totalVisible } from "../../stores/board.js";
import { closeMoveMenu, moveMenu, openCreateTask, view } from "../../stores/ui.js";
import Column from "./Column.vue";

const dragging = ref(null);

const moveRows = computed(() => STATUSES.map((status) => ({ status, current: moveMenu.value?.task?.status === status })));

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

    <div v-if="totalVisible === 0" class="td-empty td-empty-lg" data-empty data-empty-kind="no-results">
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
