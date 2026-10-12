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
 *
 * R9 ② — the label control is the third member of one component family, not a
 * lookalike: `.td-label-trigger` is the `.td-select` shell (`app.css`), the value
 * is flat text inside it, and the control shares the project switcher's
 * light-dismiss rule by carrying `data-dismiss-on-outside`. The label filter
 * stays a dropdown rather than becoming a third `<select>`: the control's whole
 * point is seventeen choices plus a chosen-value readout (`design/fidelity-r9.md`
 * §2.2, fork B2, evaluated and not adopted).
 */
import { computed } from "vue";

import { dismissMemberFrom } from "../../lib/light-dismiss.js";
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

/** Choosing a label is what the menu was open for, so it closes with the choice
 *  — the prototype's own handler calls `closeLabelMenu()` on the option click. */
function chooseLabel(value, event) {
  dismissMemberFrom(event);
  board.filters.label = value;
}
</script>

<template>
  <section class="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-b-(--brand-border) bg-(--brand-surface)" data-filters :hidden="!filtersOpen" id="td-filters">
    <!-- R9 ② — the two selects' wrappers carried a stray `mb-3` from a stacked
         form: with the row's `items-center` that 12px margin made each wrapper
         44px tall, so the two selects floated 6px **above** the row's centre
         line while the label control and Clear sat on it. The prototype's own
         two labels are visually-hidden siblings (`.td-sr`), not boxes, so all
         of its controls share one line; dropping the margin restores that. -->
    <label class="flex flex-col gap-1">
      <span class="sr-only">{{ $t("filters.assignee") }}</span>
      <select v-model="board.filters.assignee" class="select select-sm td-select" data-filter-assignee :aria-label="$t('filters.assignee')">
        <option v-for="option in assigneeOptions" :key="option" :value="option">{{ $t(`filters.assignee.${option}`) }}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="sr-only">{{ $t("filters.priority") }}</span>
      <select v-model="board.filters.priority" class="select select-sm td-select" data-filter-priority :aria-label="$t('filters.priority')">
        <option value="all">{{ $t("filters.priority.all") }}</option>
        <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`filters.priority.${priority}`) }}</option>
      </select>
    </label>

    <!-- R9 ② — the label control wears the same shell as the two `<select>`s
         beside it: `.td-label-trigger` carries the field's metrics (the family's
         32px height, the 12px/400 ink face, the 14px caret parked at
         `right 6px`), and the value renders as **plain text** inside it, the way
         a `<select>` shows its own. It also takes the light-dismiss attribute,
         so the one document-level rule covers it exactly as it covers the
         project switcher (R9 ①/② are the same rule — §2.1/§2.2). -->
    <details class="dropdown" data-filter-label :data-filter-label-value="board.filters.label" data-dismiss-on-outside>
      <summary
        class="btn btn-sm td-label-trigger cursor-pointer list-none [&::-webkit-details-marker]:hidden"
        role="button"
        aria-haspopup="menu"
        :aria-label="$t('filters.labelLabel')"
      >
        <span data-filter-label-summary>{{ labelSummary }}</span>
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <ul class="td-details-menu menu">
        <li>
          <button type="button" data-filter-label-option data-label-value="all" :aria-current="board.filters.label === 'all' ? 'true' : 'false'" @click="chooseLabel('all', $event)">
            {{ $t("filters.label.all") }}
          </button>
        </li>
        <li v-for="label in labelRoster" :key="label">
          <button type="button" data-filter-label-option :data-label-value="label" :aria-current="board.filters.label === label ? 'true' : 'false'" @click="chooseLabel(label, $event)">
            {{ $t("filters.labelOption", label) }}
          </button>
        </li>
      </ul>
    </details>

    <button type="button" class="btn btn-ghost btn-sm" data-filter-clear :data-i18n="'filters.clear'" @click="clearFilters">
      {{ $t("filters.clear") }}
    </button>

    <span class="ms-auto text-[12px] text-(--brand-text-2)" data-filter-count aria-live="polite">{{ countText }}</span>
  </section>
</template>
