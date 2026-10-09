<script setup>
/**
 * B04 · Filters bar.
 *
 * Assignee and priority are native `<select>`s (their value domains live on the
 * form value, not on a hook). The label filter is a `<details>` dropdown whose
 * chosen value rides on `[data-filter-label-value]` and is restated on the
 * summary trigger. `[data-filter-clear]` is the document's **only** clear
 * control — the no-results empty state reuses this bar's handler rather than
 * carrying a second hook of its own.
 */
import { computed } from "vue";

import { activeFilterCount, board, labelRoster, PRIORITIES, totalVisible } from "../../stores/board.js";
import { filtersOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

const assigneeOptions = ["all", "me", "human", "agent"];

const countText = computed(() => {
  const total = board.tasks.length;
  if (activeFilterCount.value > 0) return t("filters.count.filtered", totalVisible.value, total);
  return total === 1 ? t("filters.count.one") : t("filters.count.many", total);
});

const labelSummary = computed(() =>
  board.filters.label === "all" ? t("filters.label.all") : t("filters.labelOption", board.filters.label),
);

function clearFilters() {
  board.filters.search = "";
  board.filters.assignee = "all";
  board.filters.priority = "all";
  board.filters.label = "all";
  pushToast(t("toast.filtersCleared"), "info");
}

function chooseLabel(value) {
  board.filters.label = value;
}
</script>

<template>
  <div class="td-filters" data-filters :hidden="!filtersOpen" id="td-filters">
    <label class="td-field" style="margin: 0">
      <span class="sr-only">{{ $t("filters.assignee") }}</span>
      <select v-model="board.filters.assignee" class="td-select" data-filter-assignee :aria-label="$t('filters.assignee')">
        <option v-for="option in assigneeOptions" :key="option" :value="option">{{ $t(`filters.assignee.${option}`) }}</option>
      </select>
    </label>

    <label class="td-field" style="margin: 0">
      <span class="sr-only">{{ $t("filters.priority") }}</span>
      <select v-model="board.filters.priority" class="td-select" data-filter-priority :aria-label="$t('filters.priority')">
        <option value="all">{{ $t("filters.priority.all") }}</option>
        <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`filters.priority.${priority}`) }}</option>
      </select>
    </label>

    <details class="td-details" data-filter-label :data-filter-label-value="board.filters.label">
      <summary class="td-select" data-filter-label-summary>{{ labelSummary }}</summary>
      <ul class="td-details-menu menu">
        <li>
          <button type="button" data-filter-label-option data-label-value="all" :aria-current="board.filters.label === 'all' ? 'true' : 'false'" @click="chooseLabel('all')">
            {{ $t("filters.label.all") }}
          </button>
        </li>
        <li v-for="label in labelRoster" :key="label">
          <button type="button" data-filter-label-option :data-label-value="label" :aria-current="board.filters.label === label ? 'true' : 'false'" @click="chooseLabel(label)">
            {{ $t("filters.labelOption", label) }}
          </button>
        </li>
      </ul>
    </details>

    <button type="button" class="btn btn-ghost btn-sm" data-filter-clear :data-i18n="'filters.clear'" @click="clearFilters">
      {{ $t("filters.clear") }}
    </button>

    <span class="td-filter-count" data-filter-count aria-live="polite">{{ countText }}</span>
  </div>
</template>
