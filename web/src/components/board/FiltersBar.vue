<script setup>
/**
 * B04 · Filters bar.
 *
 * Assignee and priority are daisyUI `dropdown` panels in R15 (口径 B,
 * `design/fidelity-r15.md` §2.2): a `<details class="dropdown"
 * data-dismiss-on-outside>` whose `<summary class="btn btn-sm
 * td-label-trigger">` states the chosen row as plain text, and whose chosen
 * value rides the control's own `-value` attribute — a `<details>` has no form
 * value, which is why the hook's carrier moved off the form value the two
 * `<select>`s used. `[data-filter-clear]` is the document's **only** board clear
 * control — the no-results empty state reuses this bar's handler rather than
 * carrying a second hook of its own (B26's activity bar carries a **second**
 * `[data-filter-clear]`, told apart by the bar it sits in — R15 §2.4).
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
 * is the (b) alternative §2.1 rejects. The bar itself is `shrink-0` for the same
 * reason one level up: it is a flex item in `main`'s column, and `overflow-x:
 * auto` makes it its own scroll container, whose automatic minimum size is zero
 * — without the declaration a view taller than the viewport (the list, whose
 * rows are a plain block) took its height out of the bar and clipped the 32px
 * control row inside a near-zero box (reported on both views).
 *
 * R12 also puts the four field controls back where the prototype keeps them:
 * they are the bar's own children, not wrapped in `<label>` boxes. The wrappers
 * were an invention of this component — they are what made the bar's direct
 * children stop reading as its control row (the contract's closed-set and
 * relative-order checks are stated over that row, §5.1 A1/A10). With the two
 * `<select>`s gone (R15 ②) the `.td-sr` sibling seats went with them: a
 * `<details>` is not a labelable element, so each control's summary states its
 * own accessible name, exactly as the prototype's does.
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
 * R13 修订（seg3 · 决定甲）— the assignee control keeps its four static rows and
 * grows the **given name** the roster's press writes, on demand (`namedAssignee`).
 * The `x` that used to sit beside it is **withdrawn** (`design/fidelity-r13.md`
 * §10.1 row 3/4): the removal path is the control's own `Assignee: All` row, which
 * already has a seat (`filters.assignee.all`), so neither the markup, the rule
 * nor the delegated handler survives. The control's own value stays the one truth
 * (`design/fidelity-r13.md` §2.8) — and R15 ② kept that reading while moving the
 * rows from `<option>`s to menu `button`s, so the roster press and a menu press
 * are still the same write.
 *
 * TP-0074 — both panels gain a search row. The row set is
 * `lib/filter-menu.js`'s: the pinned rows first and unfiltered, then actors (or
 * labels) ranked by the query. A non-static assignee row's copy is now
 * `Assignee: <name>`, the same sentence the trigger states, so the control has
 * one voice. ↑/↓ + Enter + Esc and clear-on-close are the panel's own small
 * state machine (`onMenu*` below); the query narrows the **menu**, never the
 * control's value.
 */
import { computed, nextTick, ref } from "vue";

import {
  assigneeMenuRows,
  assigneeTriggerText,
  firstUnpinnedIndex,
  labelMenuRows,
  moveActive,
} from "../../lib/filter-menu.js";
import { dismissMemberFrom } from "../../lib/light-dismiss.js";
import {
  activeFilterCount,
  ASSIGNEE_STATIC_VALUES,
  assigneeFilterValue,
  board,
  labelRoster,
  namedAssignee,
  PRIORITIES,
  priorityFilterValue,
  STATUS_FILTER_KEYS,
  statusFilterValues,
  totalVisible,
  writeAssigneeFilter,
  writePriorityFilter,
  writeStatusFilter,
} from "../../stores/board.js";
import { list } from "../../stores/list.js";
import { boardArea, filtersOpen, pushToast, view } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

/**
 * The board is a **working set** (TP-0092): `board.tasks` holds every active
 * card plus the newest terminal ones, so its length is not the project's size.
 * Unfiltered, the count states the scoped total the server reported (with the
 * loaded length as an older-server fallback); filtered, it states how much of
 * the loaded working set matched.
 */
const countText = computed(() => {
  // TP-0094 — the list is server-paged: its count is the loaded page against
  // the server's filtered total, whether or not a filter is active. The board
  // keeps its working-set reading (unfiltered: the project's real size;
  // filtered: how much of the loaded working set matched).
  if (view.value === "list") {
    return list.loaded
      ? t("filters.count.filtered", list.tasks.length, list.total)
      : t("filters.count.initial");
  }
  const loaded = board.tasks.length;
  const total = board.taskTotal > 0 ? board.taskTotal : loaded;
  if (activeFilterCount.value > 0) return t("filters.count.filtered", totalVisible.value, loaded);
  return total === 1 ? t("filters.count.one") : t("filters.count.many", total);
});

/* ------------------------------------------------- R15 ② · the dropdowns --
 * The assignee and priority controls are the project switcher's component, not
 * lookalikes: a `<details class="dropdown" data-dismiss-on-outside>` whose
 * `<summary class="btn btn-sm td-label-trigger">` states the chosen row as plain
 * text, exactly as the status and label controls beside them already did
 * (`design/fidelity-r15.md` §2.1/§2.2). The value rides the control's own
 * `-value` attribute — a `<details>` has no form value — and the single writer
 * is the one the roster press already went through, so a menu press and a roster
 * press remain the same move (R13 §2.8).
 */

/** The assignee control's chosen value, `all` when unset. */
const assigneeValue = computed(() => assigneeFilterValue());

/** The priority control's chosen value, `all` when unset. */
const priorityValue = computed(() => priorityFilterValue());

/* ------------------------------------------------- TP-0074 · the search menus --
 * The assignee and label panels gain a search row at the top. Their row set is
 * `lib/filter-menu.js`'s pure output: the fixed rows stay pinned and unfiltered,
 * the query ranks the rest with the combobox's own matcher, and the panel clears
 * its query when it closes (acceptance item 5). Keyboard state is a plain index
 * over the rendered rows — `-1` means nothing is highlighted, which is the
 * resting state; a typed query lands on the first non-pinned row so `Enter`
 * picks the top match.
 */
const assigneeQuery = ref("");
const labelQuery = ref("");
const assigneeActive = ref(-1);
const labelActive = ref(-1);
const assigneeSearchEl = ref(null);
const labelSearchEl = ref(null);

const assigneeMenu = computed(() =>
  assigneeMenuRows({
    staticValues: ASSIGNEE_STATIC_VALUES,
    actors: board.assignees,
    named: namedAssignee.value,
    query: assigneeQuery.value,
    t,
  }),
);

const labelMenu = computed(() =>
  labelMenuRows({ labels: labelRoster.value, query: labelQuery.value, t }),
);

/**
 * The trigger's own sentence, read from the **value**, never from the menu: a
 * query narrows the menu while the control still holds its choice, so deriving
 * the trigger from the filtered rows would make typing change what the control
 * claims to be set to. A static value keeps its `filters.assignee.<value>`
 * sentence; a given name is `Assignee: <name>` (acceptance item 2).
 */
const assigneeSummary = computed(() =>
  assigneeTriggerText(assigneeValue.value, ASSIGNEE_STATIC_VALUES, t),
);

/** `all` plus the five priorities, in the board's own order. */
const priorityRows = computed(() =>
  ["all", ...PRIORITIES].map((value) => ({ value, text: t(`filters.priority.${value}`) })),
);

const prioritySummary = computed(
  () => priorityRows.value.find((row) => row.value === priorityValue.value)?.text ?? t("filters.priority.all"),
);

/**
 * Choosing is what the menu was open for, so the panel closes with the choice —
 * the family's own rule (`dismissMemberFrom`), which the label control already
 * followed.
 *
 * @param {string} value
 * @param {MouseEvent} event
 */
function chooseAssignee(value, event) {
  dismissMemberFrom(event);
  writeAssigneeFilter(value);
}

/** @param {string} value @param {MouseEvent} event */
function choosePriority(value, event) {
  dismissMemberFrom(event);
  writePriorityFilter(value);
}

/* --------------------------------------------------- the two search panels --
 * Both `<details>` controls share one behaviour, so it is stated once:
 *   * opening focuses the search box, closing clears the query and the
 *     highlight — a reopened panel is the resting list again (acceptance 5);
 *   * a typed query is ranked by `filter-menu.js` and the highlight lands on
 *     the first non-pinned row, so Enter takes the top match;
 *   * ↑/↓ wrap over every rendered row (the fixed rows included — they are
 *     choices too), Enter takes the highlighted one, Esc closes the panel.
 */
function onMenuToggle(event, query, active, input) {
  if (!event.target.open) {
    query.value = "";
    active.value = -1;
    return;
  }
  nextTick(() => input.value?.focus());
}

function onMenuInput(event, query, active, rows) {
  query.value = event.target.value;
  active.value = firstUnpinnedIndex(rows.value);
}

function onMenuKeydown(event, rows, active, choose) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    active.value = moveActive(active.value, event.key === "ArrowDown" ? 1 : -1, rows.value.length);
    return;
  }
  if (event.key === "Enter") {
    const row = rows.value[active.value];
    if (!row) return;
    event.preventDefault();
    choose(row.value);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.closest?.("[data-dismiss-on-outside]")?.removeAttribute("open");
  }
}

/* The two panels' bindings, kept as named functions so the template stays flat
 * and the choice still carries its keydown event into `dismissMemberFrom`. */
function onAssigneeToggle(event) {
  onMenuToggle(event, assigneeQuery, assigneeActive, assigneeSearchEl);
}
function onLabelToggle(event) {
  onMenuToggle(event, labelQuery, labelActive, labelSearchEl);
}
function onAssigneeInput(event) {
  onMenuInput(event, assigneeQuery, assigneeActive, assigneeMenu);
}
function onLabelInput(event) {
  onMenuInput(event, labelQuery, labelActive, labelMenu);
}
function onAssigneeKeydown(event) {
  onMenuKeydown(event, assigneeMenu, assigneeActive, (value) => chooseAssignee(value, event));
}
function onLabelKeydown(event) {
  onMenuKeydown(event, labelMenu, labelActive, (value) => chooseLabel(value, event));
}

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

function clearFilters() {
  board.filters.search = "";
  writeAssigneeFilter("all");
  writePriorityFilter("all");
  writeStatusFilter([]);
  board.filters.label = "all";
  // The two search panels are filters too: Clear leaves no typed query behind
  // (and a closed panel would clear it anyway; this is the same state, stated).
  assigneeQuery.value = "";
  labelQuery.value = "";
  assigneeActive.value = -1;
  labelActive.value = -1;
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
  <section
    class="flex min-w-0 flex-nowrap shrink-0 items-center gap-2 overflow-x-auto"
    data-filters
    data-i18n-aria-label="filters.label"
    :aria-label="$t('filters.label')"
    :hidden="!filtersOpen || !boardArea"
    id="td-filters"
  >
    <!-- R15 ② — the assignee control: a daisyUI `dropdown` panel, the same
         component the status and label controls beside it wear. R12's finding
         still holds — the bar's direct children are its control row and nothing
         else — and the label seat the `<select>` needed (`for=` / `id=`) is gone
         with it: the summary states its own accessible name, as the prototype's
         does. -->
    <details class="dropdown shrink-0" data-filter-assignee :data-filter-assignee-value="assigneeValue" data-dismiss-on-outside @toggle="onAssigneeToggle">
      <summary
        class="btn btn-sm td-label-trigger cursor-pointer list-none [&::-webkit-details-marker]:hidden"
        role="button"
        aria-haspopup="menu"
        data-filter-assignee-summary
        data-i18n-aria-label="filters.assignee"
        :aria-label="$t('filters.assignee')"
      >
        <span data-filter-assignee-text>{{ assigneeSummary }}</span>
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <!-- R13 — the four static rows, plus the given name the roster's press
           writes, generated **by the control's value** and removed with it. At
           most one given name exists, and every row carries
           `[data-assignee-filter-option]` (its own value) — not B22's
           `[data-assignee-option]`, whose document-wide delegate would otherwise
           answer it (`design/fidelity-r13.md` §2.8/§2.9, R15 §2.2).

           TP-0074 — the first `<li>` is the search box, and `assigneeMenu`
           adds ranked actor rows only while a query is typed. The four fixed
           rows (plus the named one) are pinned first and never filtered, and
           `[data-filter-active]` is the keyboard highlight (all rows carry it,
           so the hook set stays identical). -->
      <ul class="td-details-menu menu">
        <li class="td-menu-search">
          <input
            ref="assigneeSearchEl"
            type="search"
            class="input input-sm w-full"
            data-filter-assignee-search
            autocomplete="off"
            :value="assigneeQuery"
            :placeholder="$t('filters.assigneeSearch')"
            :aria-label="$t('filters.assigneeSearch')"
            @input="onAssigneeInput"
            @keydown="onAssigneeKeydown"
          />
        </li>
        <li v-for="(row, index) in assigneeMenu" :key="row.value">
          <button
            type="button"
            :data-assignee-filter-option="row.value"
            :data-filter-active="index === assigneeActive ? 'true' : 'false'"
            :aria-current="row.value === assigneeValue ? 'true' : 'false'"
            @click="chooseAssignee(row.value, $event)"
          >{{ row.text }}</button>
        </li>
      </ul>
    </details>
    <!-- R13 修订（seg3 · 决定甲）— the `✕` removal affordance is **withdrawn**
         (`design/fidelity-r13.md` §10.1 row 4): no markup, no rule, no delegated
         handler, no aria/i18n seat survive. The control's own `Assignee: All` row
         above is the removal path, and its copy is the existing
         `filters.assignee.all` key — which is why the `assignee.clear` key goes
         back (the catalogue already ships one key fewer). -->

    <!-- R15 ② — the priority control is the same dropdown. Its rows carry the
         6px dot beside the copy, the way the status menu's do, because priority
         is the board's other colour-coded scalar: the dot reads `--pri-color`
         through the row's own `[data-priority]` (the same binding the cards and
         the legend read), so no component names a colour. -->
    <details class="dropdown shrink-0" data-filter-priority :data-filter-priority-value="priorityValue" data-dismiss-on-outside>
      <summary
        class="btn btn-sm td-label-trigger cursor-pointer list-none [&::-webkit-details-marker]:hidden"
        role="button"
        aria-haspopup="menu"
        data-filter-priority-summary
        data-i18n-aria-label="filters.priority"
        :aria-label="$t('filters.priority')"
      >
        <span data-filter-priority-text>{{ prioritySummary }}</span>
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <ul class="td-details-menu td-priority-menu menu">
        <li v-for="row in priorityRows" :key="row.value">
          <button
            type="button"
            data-filter-priority-option
            :data-priority-value="row.value"
            :data-priority="row.value === 'all' ? undefined : row.value"
            :aria-current="row.value === priorityValue ? 'true' : 'false'"
            @click="choosePriority(row.value, $event)"
          >
            <span v-if="row.value !== 'all'" class="status td-status-dot" aria-hidden="true"></span>
            <span>{{ row.text }}</span>
          </button>
        </li>
      </ul>
    </details>

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
    <details class="dropdown shrink-0" data-filter-label :data-filter-label-value="board.filters.label" data-dismiss-on-outside @toggle="onLabelToggle">
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
      <!-- TP-0074 — the label menu gains the same search row. Its rows are the
           existing labels only (plus the pinned `All`), so there is no `· new`
           row to add: this control filters, it never manages the dictionary
           (acceptance item 4). Every row carries `[data-filter-active]`, which
           keeps the identical-hookset rule true. -->
      <ul class="td-details-menu menu">
        <li class="td-menu-search">
          <input
            ref="labelSearchEl"
            type="search"
            class="input input-sm w-full"
            data-filter-label-search
            autocomplete="off"
            :value="labelQuery"
            :placeholder="$t('filters.labelSearch')"
            :aria-label="$t('filters.labelSearch')"
            @input="onLabelInput"
            @keydown="onLabelKeydown"
          />
        </li>
        <li v-for="(row, index) in labelMenu" :key="row.value">
          <button
            type="button"
            data-filter-label-option
            :data-label-value="row.value"
            :data-filter-active="index === labelActive ? 'true' : 'false'"
            :aria-current="row.value === board.filters.label ? 'true' : 'false'"
            @click="chooseLabel(row.value, $event)"
          >{{ row.text }}</button>
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
