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
  <section
    class="flex max-h-full flex-[0_0_268px] flex-col border border-(--brand-border) rounded-lg bg-(--brand-sunken) data-[drag-over=true]:border-(--brand-border-strong)"
    data-column
    :data-status="column.status"
    :data-drag-over="dragOver ? 'true' : 'false'"
  >
    <header class="flex items-center gap-2 p-2" data-column-header>
      <span class="status td-status-dot" data-column-dot aria-hidden="true"></span>
      <!-- The column name is the heading of its column, so it is an `<h2>`, not
           a `<span>`: the outline of the board is seven headings, one per status
           (B06). `data-column-name` is unchanged, so the hook set stays put. -->
      <h2 class="font-semibold text-[12px] whitespace-nowrap text-(--brand-text)" data-column-name>{{ $t(`status.${column.status}`) }}</h2>
      <span class="badge badge-sm td-count ms-auto" data-column-count>{{ count }}</span>
      <button type="button" class="border-0 bg-transparent text-(--brand-text-3) cursor-pointer text-[14px]" data-column-add :aria-label="$t('column.add', $t(`status.${column.status}`))" :title="$t('column.add', $t(`status.${column.status}`))" @click="emit('add', column.status)">
        ＋
      </button>
    </header>

    <!-- daisyUI `progress`; `progress-xs` is the 4px bar the design uses. The bar
         is decoration — the count badge and `[data-column-count]` already state
         the number — so it is hidden from assistive technology. -->
    <progress class="progress progress-xs mx-2 mb-2 h-1 accent-(--status-color)" data-column-progress aria-hidden="true" :value="count" :max="progressMax"></progress>

    <div class="flex flex-col gap-2 overflow-y-auto px-2 pb-2" data-column-body @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
      <Card
        v-for="task in column.tasks"
        :key="task.id"
        :task="task"
        :dragging="dragging === task.id"
        @open="emit('open', $event)"
        @dragstart="(t, e) => emit('dragstart', t, e)"
        @dragend="emit('dragend')"
      />

      <div
        v-if="count === 0"
        class="flex flex-col items-center gap-1 p-4 text-center text-(--brand-text-3) border border-dashed border-(--brand-border-strong) rounded-lg"
        data-empty
        data-empty-kind="column"
      >
        <span class="font-medium text-(--brand-text-2)" data-i18n="column.empty.title">{{ $t("column.empty.title") }}</span>
        <span class="text-[12px]" data-i18n="column.empty.hint" :data-i18n-arg="`status.${column.status}`">
          {{ $t("column.empty.hint", $t(`status.${column.status}`)) }}
        </span>
        <button type="button" class="btn btn-outline btn-xs" @click="emit('add', column.status)">{{ $t("column.empty.add") }}</button>
      </div>

      <div v-if="dragOver" class="h-1.5 rounded-[999px] bg-(--brand-border-strong)" data-drop-placeholder></div>
    </div>
  </section>
</template>
