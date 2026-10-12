<script setup>
/**
 * B08 · List view, with B13's loading skeleton.
 *
 * Rows are projected from the cards that survive the active filters, so the
 * board and the list can never disagree. The list is mutually exclusive with the
 * board — toggled by the `hidden` attribute, never by a stylesheet rule (C06) —
 * and while it is the active view it must not itself be hidden. Every row
 * carries the identical hook set (C02's sibling invariant for rows).
 *
 * The view is a **group shell with a head row** (R6 ⑤): a surface box holding
 * the column names, then the rows. The prototype's own class names
 * (`.td-list-group` / `.td-list-head` / `.td-list-row`) are used verbatim, and
 * the six-track column template lives in one declaration in `app.css` — the
 * widths are the row's contract, not six independent utilities. The status cell
 * is the same chip the drawer's head wears and the priority cell the same
 * `.td-pri` the card wears, so a status or a priority reads identically wherever
 * it appears.
 */
import { computed } from "vue";

import { board, openDetail, priorityOf, visibleTasks } from "../../stores/board.js";
import { view } from "../../stores/ui.js";

const rows = computed(() =>
  visibleTasks.value.map((task) => ({
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: priorityOf(task),
    assignee: task.assignee?.display_name ?? "—",
    assigneeKind: task.assignee?.kind ?? "human",
    version: task.version,
  })),
);

// B13 · the loading skeleton's three rows and their six cell widths, taken
// verbatim from the prototype (`index.html:2206-2211`): the identifier column,
// the title (the one flexible track), then the four fixed-width trailing
// columns. Only the title width varies row to row, which is what makes three
// stacked rows read as a list rather than as one block repeated. The three
// middle cells are the ones the ≤759px rule drops, exactly as the prototype
// marks them (`td-hide-sm`).
const SKELETON_ROWS = [
  ["48px", "60%", "64px", "80px", "56px", "40px"],
  ["48px", "72%", "64px", "80px", "56px", "40px"],
  ["48px", "52%", "64px", "80px", "56px", "40px"],
];
const SKELETON_HIDE = [false, false, true, true, true, false];
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 p-3" data-list :hidden="view !== 'list'">
    <!-- B13 · loading skeleton: the same group shell and the same row grid as
         the real list, so the placeholder stands in the list it previews rather
         than approximating it. Each cell is a daisyUI `skeleton`, which owns the
         shimmer and the box; the widths are the inline metrics the prototype
         states.

         M2c ⑦ — the group is **resident**, not `v-if="board.loading"`. The
         prototype's list view holds two `.td-list-group` at rest (this one and
         the data group); rendering it only while loading left the rest state one
         group short, which is why the machine check had to hedge with `min: 1`.
         The group is now the second thing the list view always renders, so the
         check asserts the prototype's real count. -->
    <div class="td-list-group" data-skeleton aria-hidden="true">
      <div class="td-list-head">
        <span>{{ $t("list.loading") }}</span>
      </div>
      <div v-for="(cells, row) in SKELETON_ROWS" :key="row" class="td-list-row is-skeleton">
        <span
          v-for="(width, cell) in cells"
          :key="cell"
          class="skeleton"
          :class="{ 'td-hide-sm': SKELETON_HIDE[cell] }"
          :style="{ height: '12px', width }"
        ></span>
      </div>
    </div>

    <template data-list-row-template>
      <button type="button" class="td-list-row" data-list-row>
        <span class="td-mono text-[12px] text-(--brand-text-3)" data-list-identifier></span>
        <span class="truncate text-[14px]" data-list-title></span>
        <span class="badge badge-sm td-chip td-chip-status td-hide-sm" data-list-status>
          <span class="td-status-dot" aria-hidden="true"></span>
          <span data-list-status-label></span>
        </span>
        <span class="td-mono text-[12px] text-(--brand-text-3) td-hide-sm" data-list-assignee></span>
        <span class="td-pri td-hide-sm" data-list-priority role="img">
          <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
          <span data-list-priority-label></span>
        </span>
        <span class="td-mono text-[12px] text-(--brand-text-3)" data-list-revision></span>
      </button>
    </template>

    <div class="td-list-group">
      <div class="td-list-head">
        <span>{{ $t("list.columns.identifier") }}</span>
      </div>
      <div data-list-rows>
        <button
          v-for="row in rows"
          :key="row.id"
          type="button"
          class="td-list-row border-0 bg-transparent text-left text-inherit"
          data-list-row
          :data-identifier="row.identifier"
          :aria-selected="board.selectedRef === row.identifier ? 'true' : 'false'"
          @click="openDetail(row.identifier)"
        >
          <span class="td-mono text-[12px] text-(--brand-text-3)" data-list-identifier>{{ row.identifier }}</span>
          <span class="truncate text-[14px]" data-list-title>{{ row.title }}</span>
          <span class="badge badge-sm td-chip td-chip-status td-hide-sm" data-list-status :data-status="row.status">
            <span class="td-status-dot" aria-hidden="true"></span>
            <span data-list-status-label>{{ $t(`status.${row.status}`) }}</span>
          </span>
          <span class="td-mono text-[12px] text-(--brand-text-3) td-hide-sm" data-list-assignee>{{ row.assignee }}</span>
          <span
            class="td-pri td-hide-sm"
            data-list-priority
            :data-priority="row.priority"
            role="img"
            :aria-label="$t('prop.priorityValue', $t(`priority.${row.priority}`))"
          >
            <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            </svg>
            <span data-list-priority-label>{{ $t(`priority.${row.priority}`) }}</span>
          </span>
          <span class="td-mono text-[12px] text-(--brand-text-3)" data-list-revision>{{ row.version }}</span>
        </button>

        <p
          v-if="!board.loading && rows.length === 0"
          class="flex flex-col items-center gap-1 p-4 text-center text-(--brand-text-3) border border-dashed border-(--brand-border-strong) rounded-lg"
          data-i18n="list.emptyRow"
        >{{ $t("list.emptyRow") }}</p>
      </div>
    </div>
  </div>
</template>
