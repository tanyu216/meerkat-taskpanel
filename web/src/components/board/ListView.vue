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
 *
 * R9 ③ — the view is in exactly one of two states, `loading` or `data`, named on
 * `[data-list][data-list-state]`. Both groups stay resident (the skeleton never
 * unmounts; the data group keeps its six-column head), and the state picks which
 * one the reader sees. Entering the view is one read: `loading` until it
 * returns, `data` after — never both at once, which is what Terry saw when the
 * skeleton sat above twelve live rows.
 */
import { computed, watch } from "vue";

import { identifierText } from "../../lib/identifier.js";
import { board, kindLabel, loadTasks, openDetail, priorityOf, projectLoading, visibleTasks } from "../../stores/board.js";
import { listState, setListState, view } from "../../stores/ui.js";

/**
 * R9 ③ — entering the list view is **one read**: the view goes to `loading`
 * (the skeleton alone) and settles on `data` (the rows alone) when the read
 * returns. The two halves are never on screen together, and that is stated as a
 * rule on `[data-list][data-list-state]` in `app.css` rather than as a `v-if` on
 * each half — the rule also holds for the resting document, which a pair of
 * independent `v-if`s cannot promise (contract R6).
 *
 * The wait is the read's, not a fixed beat: whatever the transport takes is how
 * long the skeleton shows. A re-render from the filters does **not** re-enter
 * `loading` (only entering the view is a read), so filtering never flashes the
 * placeholder.
 */
watch(
  view,
  async (next) => {
    if (next !== "list") return;
    setListState("loading");
    try {
      await loadTasks();
    } finally {
      // A failed read leaves the real error surface (B17) to speak; the list
      // itself must not be stranded on the skeleton.
      setListState("data");
    }
  },
);

/**
 * The one value the whole view reads. Two things enter the loading window: the
 * view's own entry read (`listState`, set by the watcher above) and a project
 * switch while the list is already open (`projectLoading` — `selectProject`
 * withdraws the reading and empties the list, and nothing touches `listState`).
 *
 * All three bindings — the state attribute, the skeleton's `hidden`, and the
 * rows' `v-if` — must come off **this** value. Reading the raw `listState` in
 * any of them would put the attribute on `loading` while leaving the rows
 * mounted and the skeleton hidden: a blank list.
 */
const listLoading = computed(() => projectLoading.value || listState.value === "loading");

const rows = computed(() =>
  visibleTasks.value.map((task) => ({
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: priorityOf(task),
    assignee: task.assignee?.display_name ?? "—",
    // Two-valued for the closed design attribute; the kind itself is a platform.
    assigneeKind: kindLabel(task.assignee?.kind),
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
  <div
    class="flex min-w-0 flex-col gap-3 p-3"
    data-list
    :data-list-state="listLoading ? 'loading' : 'data'"
    :hidden="view !== 'list'"
  >
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
         check asserts the prototype's real count.

         R9 ③ — residency is unchanged; what the group *does* is follow the
         state. It is the `loading` state's only carrier, so `data` hides it —
         by attribute here (the `hidden` the contract's B10 asserts) and by the
         rule on `[data-list][data-list-state="data"]` in `app.css`, which is
         what makes the pair exclusive even before the script runs. -->
    <div class="td-list-group" data-skeleton aria-hidden="true" :hidden="!listLoading">
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
        <span class="td-mono td-id text-[12px] text-(--brand-text-3)" data-list-identifier></span>
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
      <!-- R8 ② — the head names all six columns, in the rows' own track order,
           and the three middle labels are the ones the ≤759px rule drops on both
           sides (`td-hide-sm`). Before this the head held one label — the
           identifier — while the rows were a six-track grid, so five columns had
           no heading and none of the head had a width to line up with. The
           template itself is shared with `.td-list-row` in `app.css`, so the head
           and the rows cannot drift. -->
      <div class="td-list-head">
        <span data-i18n="list.columns.identifier">{{ $t("list.columns.identifier") }}</span>
        <span data-i18n="list.columns.title">{{ $t("list.columns.title") }}</span>
        <span class="td-hide-sm" data-i18n="list.columns.status">{{ $t("list.columns.status") }}</span>
        <span class="td-hide-sm" data-i18n="list.columns.assignee">{{ $t("list.columns.assignee") }}</span>
        <span class="td-hide-sm" data-i18n="list.columns.priority">{{ $t("list.columns.priority") }}</span>
        <span data-i18n="list.columns.revision">{{ $t("list.columns.revision") }}</span>
      </div>
      <div data-list-rows>
        <!-- R9 ③ — the rows are the `data` state's own half, so they exist only
             in it: the state rule hides this group, and the rows *inside* it are
             absent rather than merely invisible, which is what the contract's
             A5 states (a loading list holds no rows to read). -->
        <template v-if="!listLoading">
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
            <!-- R8 ③ — the text is the capped display value, the `title` is the
                 full identifier, and both come from the same `row.identifier`: the
                 cap is a character slice (`lib/identifier.js`), never a width. The
                 full value also stays on the row's `data-identifier`, which is what
                 every lookup resolves an entity from — nothing reads this text
                 back. -->
            <span
              class="td-mono td-id text-[12px] text-(--brand-text-3)"
              data-list-identifier
              :title="row.identifier"
            >{{ identifierText(row.identifier) }}</span>
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

          <!-- B08 · no rows. The prototype appends exactly this pair into
               `[data-list-rows]` when the filter leaves nothing
               (`design/prototype/app.js` `renderList()`: a `.td-empty` holding
               one `.td-empty-title`), so the list's own empty state is the same
               object as every other one rather than a `<p>` with its own
               utility stack. The hook moves onto the title, where the
               prototype carries it. -->
          <div v-if="!board.loading && rows.length === 0" class="td-empty">
            <span class="td-empty-title" data-i18n="list.emptyRow">{{ $t("list.emptyRow") }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
