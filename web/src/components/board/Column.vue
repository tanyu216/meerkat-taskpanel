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
    class="flex min-h-0 w-[300px] flex-[0_0_300px] flex-col border border-(--brand-border) rounded-lg p-2 bg-(--brand-sunken) data-[drag-over=true]:border-(--brand-border-strong)"
    data-column
    :data-status="column.status"
    :data-drag-over="dragOver ? 'true' : 'false'"
  >
    <header class="flex h-7 flex-none items-center gap-2 py-0 pr-0.5 pl-1" data-column-header>
      <span class="status td-status-dot" data-column-dot aria-hidden="true"></span>
      <!-- The column name is the heading of its column, so it is an `<h2>`, not
           a `<span>`: the outline of the board is seven headings, one per status
           (B06). `data-column-name` is unchanged, so the hook set stays put. -->
      <h2 class="font-semibold text-[12px] whitespace-nowrap text-(--brand-text)" data-column-name>{{ $t(`status.${column.status}`) }}</h2>
      <!-- M2c ③ — the count sits **beside the name**, not pushed to the column's
           far edge: the header is `[dot][name][count][+]`, the prototype's own
           order and spacing (`design/prototype/index.html` `[data-column-header]`).
           `ms-auto` had parked the pair on the right since M1. -->
      <span class="badge badge-sm td-count" data-column-count>{{ count }}</span>
      <!-- F4 — the control is the prototype's `button.td-iconbtn.td-col-add`: a
           24×24 icon button holding a stroked `svg.td-icon` plus glyph, 2px clear
           of the count pill. It had been a bare text `＋` in the 14px UI face,
           which is a different object (a glyph in the type scale, not a button in
           the icon set) and the one header cell whose metrics were not the
           design's. `.td-col-add` states the box; `.td-icon`/`.td-icon-sm` are the
           same brand pair the nav glyphs wear. -->
      <button type="button" class="td-iconbtn td-col-add" data-column-add :aria-label="$t('column.add', $t(`status.${column.status}`))" :title="$t('column.add', $t(`status.${column.status}`))" @click="emit('add', column.status)">
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </header>

    <!-- daisyUI `progress`; `progress-xs` is the 4px bar the design uses. The bar
         is decoration — the count badge and `[data-column-count]` already state
         the number — so it is hidden from assistive technology. -->
    <progress class="progress progress-xs mb-2 h-1 accent-(--status-color)" data-column-progress aria-hidden="true" :value="count" :max="progressMax"></progress>

    <div class="flex min-h-[120px] flex-col gap-2 mt-1 overflow-y-auto p-0.5" data-column-body @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
      <Card
        v-for="task in column.tasks"
        :key="task.id"
        :task="task"
        :dragging="dragging === task.id"
        @open="emit('open', $event)"
        @dragstart="(t, e) => emit('dragstart', t, e)"
        @dragend="emit('dragend')"
      />

      <!-- B12 · the column-level empty state. The design's face
           (`.td-empty` + `.td-empty-title` / `.td-empty-hint`, `app.css`) and the
           design's own **residency**: the prototype ships one of these per column
           in the markup and `hidden`s it while the column has cards, so the
           resting document already holds all seven (B12 is explicit that they are
           never counted in the board-level tally — they are the *column's* state).
           `v-if` made the block unobservable at rest, which is the one thing the
           two-state rounds (R9/R10/B26.5) settled everywhere else.

           The Add button is `btn-sm`, the size the prototype's `[data-column-add]`
           wears in this block (28px); it is deliberately **not** given that hook
           — the header's button already carries it, once per column, and the
           manifest counts exactly seven of them (`web/manifests/board.json` B06).

           It does wear the prototype's **static `data-i18n` seat**
           (`design/prototype/index.html`, `column.empty.add`), the same seat the
           block's title and hint lines above already carry. Its copy was
           `$t()`-driven from the start, so the rendered text was right either
           way — what was missing was the *key* the resting document could be
           addressed by, which is why the design counted the seat eight times
           document-wide (the seven columns plus the state gallery's demo card)
           and the built app none. The seat is a hook only: the copy still comes
           from the catalogue through `$t()`, and the click handler is unchanged. -->
      <div
        class="td-empty"
        data-empty
        data-empty-kind="column"
        :hidden="count > 0"
      >
        <span class="td-empty-title" data-i18n="column.empty.title">{{ $t("column.empty.title") }}</span>
        <span class="td-empty-hint" data-i18n="column.empty.hint" :data-i18n-arg="`status.${column.status}`">
          {{ $t("column.empty.hint", $t(`status.${column.status}`)) }}
        </span>
        <button type="button" class="btn btn-outline btn-sm" data-i18n="column.empty.add" @click="emit('add', column.status)">{{ $t("column.empty.add") }}</button>
      </div>

      <div v-if="dragOver" class="h-1.5 rounded-[999px] bg-(--brand-border-strong)" data-drop-placeholder></div>
    </div>
  </section>
</template>
