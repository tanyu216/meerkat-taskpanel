<script setup>
/**
 * B08 · List view, with B13's loading skeleton.
 *
 * Rows are projected from the cards that survive the active filters, so the
 * board and the list can never disagree. The list is mutually exclusive with the
 * board — toggled by the `hidden` attribute, never by a stylesheet rule (C06) —
 * and while it is the active view it must not itself be hidden. Every row
 * carries the identical hook set (C02's sibling invariant for rows).
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
</script>

<template>
  <div class="p-3" data-list :hidden="view !== 'list'">
    <!-- B13 · loading skeleton (no hooks of its own; three shimmer rows). -->
    <div v-if="board.loading" class="flex flex-col gap-2 p-3" data-skeleton aria-hidden="true">
      <div class="skeleton td-skeleton-row"></div>
      <div class="skeleton td-skeleton-row"></div>
      <div class="skeleton td-skeleton-row"></div>
    </div>

    <template data-list-row-template>
      <button type="button" data-list-row>
        <span class="td-mono" data-list-identifier></span>
        <span data-list-title></span>
        <span data-list-status><span data-list-status-label></span></span>
        <span data-list-assignee></span>
        <span data-list-priority><span data-list-priority-label></span></span>
        <span class="td-mono" data-list-revision></span>
      </button>
    </template>

    <div class="flex flex-col" data-list-rows>
      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="grid cursor-pointer grid-cols-[92px_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 p-2 border-0 border-b border-b-(--brand-border) bg-transparent text-left text-inherit hover:bg-(--brand-hover)"
        data-list-row
        :data-identifier="row.identifier"
        :aria-selected="board.selectedRef === row.identifier ? 'true' : 'false'"
        @click="openDetail(row.identifier)"
      >
        <span class="td-mono" data-list-identifier>{{ row.identifier }}</span>
        <span data-list-title>{{ row.title }}</span>
        <span data-list-status :data-status="row.status"><span data-list-status-label>{{ $t(`status.${row.status}`) }}</span></span>
        <span class="td-mono" data-list-assignee>{{ row.assignee }}</span>
        <span data-list-priority :data-priority="row.priority" :aria-label="$t('prop.priorityValue', $t(`priority.${row.priority}`))">
          <span data-list-priority-label>{{ $t(`priority.${row.priority}`) }}</span>
        </span>
        <span class="td-mono" data-list-revision>{{ row.version }}</span>
      </button>
    </div>

    <p
      v-if="!board.loading && rows.length === 0"
      class="flex flex-col items-center gap-1 p-4 text-center text-(--brand-text-3) border border-dashed border-(--brand-border-strong) rounded-lg"
      data-i18n="list.emptyRow"
    >{{ $t("list.emptyRow") }}</p>
  </div>
</template>
