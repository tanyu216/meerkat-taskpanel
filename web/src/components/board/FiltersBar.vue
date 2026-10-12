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
 *
 * R12 — the bar is **one line, always** (`design/fidelity-r12-supplement.md` §2,
 * rulings R-2/R-9): `flex-wrap: nowrap` plus the bar's own overflow policy
 * (`overflow-x: auto` with `min-width: 0`), so a narrow tier scrolls the row
 * **inside the bar** instead of wrapping it onto a second line and instead of
 * pushing a horizontal scrollbar onto the document. The prototype wraps at 430
 * (`flex-wrap: wrap`); that is the one written deviation this round approves.
 * Every control is `flex: 0 0 auto` — the family's metrics never compress, which
 * is the (b) alternative §2.1 rejects.
 *
 * R12 also puts the two `<select>`s back where the prototype keeps them: they are
 * the bar's own children, named by visually-hidden `.td-sr` label **siblings**
 * (`for=` / `id=`), not by wrapper `<label>` boxes. The wrappers were an
 * invention of this component — the prototype's `.td-sr` labels are absolutely
 * positioned and occupy no box at all — and they are what made the bar's direct
 * children stop reading as its control row (the contract's closed-set and
 * relative-order checks are stated over that row, §5.1 A1/A10).
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
  <!-- R12 — one line, always: `flex-nowrap` + the bar's own `overflow-x-auto`
       and `min-w-0`. A narrow tier scrolls this row inside the bar (the
       prototype wraps it onto a second line instead — the round's one approved
       deviation); the document itself stays free of horizontal overflow. -->
  <section class="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto" data-filters :hidden="!filtersOpen" id="td-filters">
    <!-- R12 — the prototype's own shape: two visually-hidden `.td-sr` labels as
         siblings of the controls they name (`for=` / `id=`), so the bar's direct
         children are its control row and nothing else. R9 ②'s finding was that
         wrapper boxes (`mb-3` on a stacked form) floated the selects off the
         row's centre line; the prototype never had boxes there to begin with. -->
    <label class="td-sr" for="td-filter-assignee">{{ $t("filters.assignee") }}</label>
    <select id="td-filter-assignee" v-model="board.filters.assignee" class="select select-sm td-select shrink-0" data-filter-assignee :aria-label="$t('filters.assignee')">
      <option v-for="option in assigneeOptions" :key="option" :value="option">{{ $t(`filters.assignee.${option}`) }}</option>
    </select>

    <label class="td-sr" for="td-filter-priority">{{ $t("filters.priority") }}</label>
    <select id="td-filter-priority" v-model="board.filters.priority" class="select select-sm td-select shrink-0" data-filter-priority :aria-label="$t('filters.priority')">
      <option value="all">{{ $t("filters.priority.all") }}</option>
      <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`filters.priority.${priority}`) }}</option>
    </select>

    <!-- R9 ② — the label control wears the same shell as the two `<select>`s
         beside it: `.td-label-trigger` carries the field's metrics (the family's
         32px height, the 12px/400 ink face, the 14px caret parked at
         `right 6px`), and the value renders as **plain text** inside it, the way
         a `<select>` shows its own. It also takes the light-dismiss attribute,
         so the one document-level rule covers it exactly as it covers the
         project switcher (R9 ①/② are the same rule — §2.1/§2.2). -->
    <details class="dropdown shrink-0" data-filter-label :data-filter-label-value="board.filters.label" data-dismiss-on-outside>
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

    <button type="button" class="btn btn-ghost btn-sm shrink-0" data-filter-clear :data-i18n="'filters.clear'" @click="clearFilters">
      {{ $t("filters.clear") }}
    </button>

    <!-- R12 — the count's `ms-auto` is the wide tier's readout: it pins to the
         bar's **content** right edge (contract §1.2 rule 5 — a geometric
         judgement, since `getComputedStyle` returns `auto`'s used value). In a
         tier where the row has no free space left, `auto` resolves to 0 and the
         count simply follows Clear (the contract's U-5; A7 is stated over the
         wide tiers for exactly this reason). -->
    <span class="ms-auto shrink-0 text-[12px] text-(--brand-text-2)" data-filter-count aria-live="polite">{{ countText }}</span>
  </section>
</template>
