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
 *
 * R11 ① — the **status** filter is the bar's third field and its only
 * multiple-choice control (`design/fidelity-r11.md` §2.1): a `<details>` dropdown
 * wearing the field family's `.td-label-trigger` shell, a chosen set riding on
 * `data-filter-status-value` as a comma-joined subset of the seven first-class
 * statuses (or `all`). Multiple choice is OR, and it is ANDed with the other
 * three filters. `data-dismiss-on-outside` puts it in the same light-dismiss
 * membership as the project switcher and the label dropdown; the option press
 * deliberately does **not** close the menu, so the two in-flight statuses can be
 * picked in a row (the card's U1 ruling).
 *
 * R13 — the assignee `<select>` keeps its four static rows and grows the **given
 * name** the roster's press writes, on demand (`namedAssignee`); beside it sits
 * the one `[data-assignee-clear]`, which removes that name and nothing else. Both
 * are driven by the control's own value, which stays the one truth
 * (`design/fidelity-r13.md` §2.8).
 */
import { computed } from "vue";

import { dismissMemberFrom } from "../../lib/light-dismiss.js";
import {
  activeFilterCount,
  ASSIGNEE_STATIC_VALUES,
  board,
  labelRoster,
  namedAssignee,
  PRIORITIES,
  STATUS_FILTER_KEYS,
  statusFilterValues,
  totalVisible,
  writeStatusFilter,
} from "../../stores/board.js";
import { filtersOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

const assigneeOptions = ASSIGNEE_STATIC_VALUES;

const countText = computed(() => {
  const total = board.tasks.length;
  if (activeFilterCount.value > 0) return t("filters.count.filtered", totalVisible.value, total);
  return total === 1 ? t("filters.count.one") : t("filters.count.many", total);
});

const labelSummary = computed(() =>
  board.filters.label === "all" ? t("filters.label.all") : t("filters.labelOption", board.filters.label),
);

/** R11 ① — the trigger's three states: `Status: All`, one chosen status, or the
 *  first chosen one plus a `+n` count (`Status: In Progress +1`). */
const statusSelection = computed(() => statusFilterValues());
const statusSummary = computed(() => {
  const values = statusSelection.value;
  if (values.length === 0) return t("filters.status.all");
  const first = t("filters.statusOption", t(`status.${values[0]}`));
  return values.length === 1 ? first : `${first} ${t("filters.statusMore", values.length - 1)}`;
});

/**
 * R11 ① — a press toggles one status in or out of the chosen set; `all` is not a
 * toggle, it clears. The menu stays open across presses (the card's U1 ruling),
 * so the two in-flight statuses are picked in a row.
 *
 * @param {string} key
 */
function toggleStatus(key) {
  if (key === "all") {
    writeStatusFilter([]);
    return;
  }
  const values = statusSelection.value;
  writeStatusFilter(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
}

/**
 * R13 ④ — the bar's `x` removes the assignee condition **alone**: no view
 * switch, no status / priority / label / search change, no toast. `stop` keeps
 * the press from travelling on to whatever sits behind the bar.
 *
 * @param {MouseEvent} event
 */
function clearAssignee(event) {
  event.stopPropagation();
  board.filters.assignee = "all";
}

function clearFilters() {
  board.filters.search = "";
  board.filters.assignee = "all";
  board.filters.priority = "all";
  writeStatusFilter([]);
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
      <!-- R13 — the given name the roster's press writes, generated **by the
           control's value** and removed with it. At most one exists, it lives
           inside the control, and it carries `[data-assignee-filter-option]` (not
           B22's `[data-assignee-option]`, whose document-wide delegate would
           otherwise answer it) — `design/fidelity-r13.md` §2.8/§2.9. -->
      <option
        v-if="namedAssignee"
        :data-assignee-filter-option="namedAssignee"
        :value="namedAssignee"
      >{{ namedAssignee }}</option>
    </select>
    <!-- R13 ④ — the one removal affordance, the assignee control's **sibling**
         (B04). Static markup, `hidden` at rest, shown only while the control
         states a *name*: `all` is the select's own first row and the three kinds
         are its rows, so neither needs a second exit. It sits here rather than
         inside the roster's capsule — that row is one line with no width to
         spare (`design/fidelity-r13.md` §2.1/§3.3). -->
    <button
      type="button"
      class="td-assignee-clear shrink-0"
      data-assignee-clear
      :hidden="!namedAssignee"
      data-i18n-aria-label="assignee.clear"
      :aria-label="$t('assignee.clear')"
      @click="clearAssignee"
    >✕</button>

    <label class="td-sr" for="td-filter-priority">{{ $t("filters.priority") }}</label>
    <select id="td-filter-priority" v-model="board.filters.priority" class="select select-sm td-select shrink-0" data-filter-priority :aria-label="$t('filters.priority')">
      <option value="all">{{ $t("filters.priority.all") }}</option>
      <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ $t(`filters.priority.${priority}`) }}</option>
    </select>

    <!-- R11 ① — the status filter, the bar's third field and its only
         multiple-choice one. Multiple choice states itself on **every** row's
         `aria-pressed` (the label menu's single-choice `aria-current` cannot
         express a set), and the chosen set rides on `data-filter-status-value`
         so the trigger can state what is in force without being opened. The
         seven non-`all` rows are `STATUS_FILTER_KEYS` — the same seven the board
         is a column per, so no status the board does not carry can ever be
         named here. -->
    <details class="dropdown shrink-0" data-filter-status :data-filter-status-value="board.filters.status" data-dismiss-on-outside>
      <summary
        class="btn btn-sm td-label-trigger cursor-pointer list-none [&::-webkit-details-marker]:hidden"
        role="button"
        aria-haspopup="menu"
        data-filter-status-summary
        data-i18n-aria-label="filters.status"
        :aria-label="$t('filters.status')"
      >
        <span data-filter-status-text>{{ statusSummary }}</span>
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <ul class="td-details-menu menu td-status-menu">
        <li>
          <button
            type="button"
            data-filter-status-option
            data-status-value="all"
            :aria-pressed="statusSelection.length === 0 ? 'true' : 'false'"
            @click="toggleStatus('all')"
          >{{ $t("filters.status.all") }}</button>
        </li>
        <li v-for="key in STATUS_FILTER_KEYS" :key="key">
          <button
            type="button"
            data-filter-status-option
            :data-status-value="key"
            :data-status="key"
            :aria-pressed="statusSelection.includes(key) ? 'true' : 'false'"
            @click="toggleStatus(key)"
          >
            <span class="td-status-dot" aria-hidden="true"></span>
            <span>{{ $t(`status.${key}`) }}</span>
          </button>
        </li>
      </ul>
    </details>

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
