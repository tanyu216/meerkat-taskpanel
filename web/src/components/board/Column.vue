<script setup>
/**
 * B06 · Column.
 *
 * Every column carries the identical hook set (C02), so a drop handler never
 * special-cases one. `[data-column-progress]` sits directly under the header and
 * reads this column's share of the board (`value` = the column's visible cards,
 * `max` = the board's visible total, never 0). The empty state stays a drop
 * target.
 */
import { computed, ref } from "vue";

import { totalVisible } from "../../stores/board.js";
import Card from "./Card.vue";

const props = defineProps({ column: { type: Object, required: true }, dragging: { type: Object, default: null } });
const emit = defineEmits(["open", "drop", "add", "dragstart", "dragend"]);

const dragOver = ref(false);
const count = computed(() => props.column.tasks.length);
const progressMax = computed(() => Math.max(totalVisible.value, 1));

function onDragOver(event) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragOver.value = true;
}
function onDragLeave(event) {
  // Ignore the leave events fired while moving between the body's children.
  if (event.currentTarget.contains(event.relatedTarget)) return;
  dragOver.value = false;
}
function onDrop(event) {
  event.preventDefault();
  dragOver.value = false;
  emit("drop", props.column.status, event);
}
</script>

<template>
  <section class="td-col" data-column :data-status="column.status" :data-drag-over="dragOver ? 'true' : 'false'">
    <header class="td-col-header" data-column-header>
      <span class="td-col-dot" data-column-dot aria-hidden="true"></span>
      <span class="td-col-name" data-column-name>{{ $t(`status.${column.status}`) }}</span>
      <span class="td-col-count td-mono" data-column-count>{{ count }}</span>
      <button type="button" class="td-col-add" data-column-add :aria-label="$t('column.add', $t(`status.${column.status}`))" :title="$t('column.add', $t(`status.${column.status}`))" @click="emit('add', column.status)">
        ＋
      </button>
    </header>

    <progress class="td-col-progress" data-column-progress :value="count" :max="progressMax"></progress>

    <div class="td-col-body" data-column-body @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
      <Card
        v-for="task in column.tasks"
        :key="task.id"
        :task="task"
        :dragging="dragging === task.id"
        @open="emit('open', $event)"
        @dragstart="(t, e) => emit('dragstart', t, e)"
        @dragend="emit('dragend')"
      />

      <div v-if="count === 0" class="td-empty" data-empty data-empty-kind="column">
        <span class="td-empty-title" data-i18n="column.empty.title">{{ $t("column.empty.title") }}</span>
        <span class="td-empty-hint" data-i18n="column.empty.hint" :data-i18n-arg="`status.${column.status}`">
          {{ $t("column.empty.hint", $t(`status.${column.status}`)) }}
        </span>
        <button type="button" class="btn btn-outline btn-xs" @click="emit('add', column.status)">{{ $t("column.empty.add") }}</button>
      </div>

      <div v-if="dragOver" class="td-drop-placeholder" data-drop-placeholder></div>
    </div>
  </section>
</template>
