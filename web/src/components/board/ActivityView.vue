<script setup>
/**
 * B26 · the Activity view (R12x).
 *
 * The sidebar's third destination and the view it opens: the project's ledger —
 * what happened, newest first, grouped by day, with the machine noise dropped.
 * Authority: `design/activity/DESIGN-activity.md` §10 (block list), `design/
 * BLOCKS.md` B26, `design/DESIGN.md` §29. The derivation lives in
 * `lib/activity-feed.js`; this file is its rendering plus the three controls.
 *
 * Five things it is careful about, each of them a design rule rather than a
 * rendering detail:
 *
 *   * **The row body is the pointer's, the button is the keyboard's.**
 *     `[data-activity-line]` opens the task's drawer and `[data-activity-open]`
 *     is its keyboard twin, carrying the accessible name (`Open TD-134`). They
 *     sit on the row's first level and never nest: a row that were itself a
 *     button would make the task link inside it a nested interactive element (§6).
 *   * **The detail is a native `<details>`.** It costs one item on the 30px line,
 *     and its panel is positioned against the row, so opening a row never
 *     reflows the feed (§4 L3).
 *   * **One number, three readers** — the sidebar pill, the boundary and the
 *     boundary's count all read one derivation, so they cannot disagree, and a
 *     filter that hides the new rows takes all three off screen together (§6).
 *   * **The address bar shadows the filters.** The three controls write
 *     `#/activity?actor=…&event=…&task=…` through `replaceState`, so a narrowed
 *     feed is shareable and survives a reload — and never touches `#/task/<id>`,
 *     which is the drawer's own path back to the board (§6).
 *   * **`j` / `k` walk the rows.** The keyboard's route through the feed, over
 *     the same `[data-activity-open]` buttons the row already has, standing down
 *     while the reader is typing in a field (§6).
 */
import { computed, onMounted, onUnmounted, watch } from "vue";

import { changeLines } from "../../lib/activity-feed.js";
import { dismissMemberFrom } from "../../lib/light-dismiss.js";
import { t } from "../../i18n/index.js";
import {
  activity,
  feed,
  loadActivities,
  loadOlder,
  markAllRead,
  readActivityHash,
  resetActivityFilters,
  unreadCount,
  writeActivityFilter,
  writeActivityHash,
} from "../../stores/activity.js";
import { board, openDetail } from "../../stores/board.js";
import { pushToast, view } from "../../stores/ui.js";

/**
 * The three filter domains, from the design's own value tables (§3.4).
 *
 * R15 ① (口径 B) — each control is now the **same component** as the board bar's
 * four: a daisyUI `dropdown` panel (`<details class="dropdown"
 * data-dismiss-on-outside>` + `<summary class="btn btn-sm td-label-trigger">` +
 * a menu of rows), not a native `<select>`. The chosen value rides the control's
 * own `data-activity-filter-value`, because a `<details>` has no form value —
 * which is also why the `.td-select-caret` wrapper and its inline glyph are
 * gone: a `<select>` cannot hold a child, so that caret had to be a sibling
 * glyph, and a `<summary>` holds the family's own (`design/fidelity-r15.md`
 * §2.1/§2.3).
 */
const ACTOR_OPTIONS = ["all", "human", "agent"];
const EVENT_OPTIONS = ["all", "status", "comment", "delivery"];

/** The three slots, in the bar's own order (the address's order, §6). */
const CONTROLS = Object.freeze(["actor", "event", "task"]);

const days = computed(() => feed.value.days);
const taskOptions = computed(() => feed.value.taskOptions);

/** The catalogue's copy for a filter row: `activity.filter.<slot>.<value>`. */
const optionText = (slot, value) => t(`activity.filter.${slot}.${value}`);

/**
 * Each control's rows, as `{ value, text }`. A row's text is the trigger's text:
 * a domain value's own sentence, or — for the task control, whose domain is open
 * — the identifier itself, because an identifier is data and not a catalogue key
 * (`design/fidelity-r15.md` §2.3).
 */
const filterRows = computed(() => ({
  actor: ACTOR_OPTIONS.map((value) => ({ value, text: optionText("actor", value) })),
  event: EVENT_OPTIONS.map((value) => ({ value, text: optionText("event", value) })),
  task: ["all", ...taskOptions.value.map((entry) => entry.identifier)].map((value) => ({
    value,
    text: value === "all" ? optionText("task", value) : value,
  })),
}));

/** The control's chosen value, `all` when unset — the same reading the hash uses. */
const filterValue = (slot) => activity.filters[slot] ?? "all";

/** The trigger states the chosen row's own copy, in the active language. */
function filterSummary(slot) {
  const value = filterValue(slot);
  return filterRows.value[slot].find((row) => row.value === value)?.text ?? value;
}

/**
 * §4 L3 / §5 — the lines a row's `<details>` unfolds, as `{member, lines}`: the
 * row's own lines, or (for a burst) one entry per folded member carrying its own
 * instant — which is what the machine check reads the five-minute window off.
 */
function detailLines(item) {
  if (item.burst) return item.burst.items.map((member) => ({ member, lines: changeLines(member) }));
  return [
    { member: null, lines: changeLines(item) },
    ...(item.extra ?? []).map((extra) => ({ member: null, lines: changeLines(extra) })),
  ];
}

/* ---------------------------------------------------------------- actions */

/** A press on the row's body — but not on its own controls — opens the drawer. */
function onLine(event, item) {
  if (event.target.closest("a, button, details, summary")) return;
  openDetail(item.identifier);
}

/**
 * §6 — the task anchor is a real link for a reader without the script; with it,
 * the press returns to the board and lands on the same task.
 */
function onTask(event, item) {
  event.preventDefault();
  view.value = "board";
  openDetail(item.identifier);
}

/** R15 ① — a press on a row writes the value, closes the panel (choosing is what
 *  the panel was open for — the family's own rule) and re-runs the pass. */
function chooseFilter(slot, value, event) {
  dismissMemberFrom(event);
  onFilter(slot, value);
}

function onFilter(slot, value) {
  writeActivityFilter(slot, value);
  writeActivityHash();
}

/** The filter-empty state's own button: the three slots back to `all`, no toast
 *  (it is a way out of an empty feed, not a command the reader gave the bar). */
function onReset() {
  resetActivityFilters();
  writeActivityHash();
}

/**
 * R15 ③ — the bar's clear control is B04's own: `[data-filter-clear]` wearing
 * `filters.clear`, in the bar's tail. The document-level rule tells the two
 * apart by **the bar the press came from**, so this one resets the three
 * activity slots and touches no board filter (`design/fidelity-r15.md` §2.4).
 * The confirmation toast is the board bar's own behaviour, which the ruling
 * extends here (Elon 2026-10-13T10:45Z, ④).
 */
function onClear() {
  resetActivityFilters();
  writeActivityHash();
  pushToast(t("toast.filtersCleared"), "info");
}

/* -------------------------------------------------------------- keyboard */

/** §6 — `j` / `k` walk the *visible* rows' open buttons, with wrap-around. */
function focusableButtons() {
  const root = globalThis.document?.querySelector("[data-activity-view]");
  if (!root) return [];
  return [...root.querySelectorAll("[data-activity-open]")].filter((node) => node.closest("[hidden]") === null);
}

function moveFocus(delta, from) {
  const buttons = focusableButtons();
  if (buttons.length === 0) return false;
  const at = buttons.indexOf(from);
  const next = at === -1 ? (delta > 0 ? 0 : buttons.length - 1) : (at + delta + buttons.length) % buttons.length;
  buttons[next].focus();
  return true;
}

function onKeydown(event) {
  if (event.key !== "j" && event.key !== "k") return;
  if (view.value !== "activity") return;
  if (event.target?.matches?.("input, textarea, select")) return;
  const from = event.target?.closest?.("[data-activity-open]") ?? null;
  if (moveFocus(event.key === "j" ? 1 : -1, from)) event.preventDefault();
}

/* ---------------------------------------------------------------- wiring */

/** Entering the view is one read — the backfill the store memoises per project. */
watch(
  view,
  (next) => {
    if (next === "activity") loadActivities();
  },
  { immediate: true },
);

/**
 * A project switch invalidates the ledger — and so does the *arrival* of that
 * project's task list, which is what the fan-out reads. The two are watched
 * together: the id flips first (with the old project's tasks still in hand) and
 * the array is replaced when the read lands, so the second trigger is the one
 * that reads a complete project. `loadActivities` memoises per project, so the
 * pair costs one fan-out, not two.
 */
watch(
  () => [board.currentProjectId, board.tasks],
  () => {
    if (view.value === "activity") loadActivities();
  },
);

onMounted(() => {
  // §6 — a `#/activity` address is a link *into* the view, so opening it enters
  // the feed as well as restoring its three filters: a shared link and a reload
  // both land where the reader left off. Any other address (the drawer's
  // `#/task/<id>`, an empty hash) leaves the default view alone.
  if ((globalThis.location?.hash ?? "").startsWith("#/activity")) view.value = "activity";
  readActivityHash();
  globalThis.document?.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  globalThis.document?.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <section class="td-activity-view" data-activity-view :hidden="view !== 'activity'">
    <header class="td-activity-head">
      <div class="td-activity-head-text">
        <h1 class="td-activity-title" data-activity-title data-i18n="activity.title">{{ $t("activity.title") }}</h1>
        <p class="td-activity-sub" data-i18n="activity.subtitle">{{ $t("activity.subtitle") }}</p>
      </div>
      <div class="td-activity-head-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-activity-mark-read data-i18n="activity.markRead" @click="markAllRead">
          {{ $t("activity.markRead") }}
        </button>
      </div>
    </header>

    <!-- B26.1 · header + filters. Three controls, three domains; the count is the
         number of rows the reader can see, `aria-live` so a narrowing announces
         itself without stealing focus.

         R15 ①/③ — the bar is a named `section` whose control row is the board
         bar's component, hook for hook (`[data-activity-filter]` +
         `data-activity-filter-value` + a `[data-activity-filter-option]` row
         carrying `data-activity-value` + the `[data-activity-filter-text]`
         restatement), and whose tail is B04's own `[data-filter-clear]`. The
         bar's accessible name is the one word this surface does **not** share
         with the board's: two landmarks reading "Filters" would be the same
         region twice to a screen reader (Elon 2026-10-13T10:45Z, ⑤). -->
    <section
      class="flex min-w-0 flex-wrap items-center gap-2"
      data-activity-filters
      data-i18n-aria-label="activity.filters.label"
      :aria-label="$t('activity.filters.label')"
    >
      <details
        v-for="slot in CONTROLS"
        :key="slot"
        class="dropdown shrink-0"
        :data-activity-filter="slot"
        :data-activity-filter-value="filterValue(slot)"
        data-dismiss-on-outside
      >
        <summary
          class="btn btn-sm td-label-trigger cursor-pointer list-none [&::-webkit-details-marker]:hidden"
          role="button"
          aria-haspopup="menu"
          data-activity-filter-summary
          :data-i18n-aria-label="`activity.filter.${slot}.label`"
          :aria-label="$t(`activity.filter.${slot}.label`)"
        >
          <span data-activity-filter-text>{{ filterSummary(slot) }}</span>
          <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 9.5 12 15.5 18 9.5" />
          </svg>
        </summary>
        <ul class="td-details-menu menu">
          <li v-for="row in filterRows[slot]" :key="row.value">
            <button
              type="button"
              data-activity-filter-option
              :data-activity-value="row.value"
              :aria-current="row.value === filterValue(slot) ? 'true' : 'false'"
              @click="chooseFilter(slot, row.value, $event)"
            >{{ row.text }}</button>
          </li>
        </ul>
      </details>

      <button type="button" class="btn btn-ghost btn-sm" data-filter-clear data-i18n="filters.clear" @click="onClear">
        {{ $t("filters.clear") }}
      </button>
      <span
        class="ms-auto shrink-0 text-[12px] text-(--brand-text-2)"
        data-activity-filter-count
        aria-live="polite"
        data-i18n="activity.filter.count"
        :data-i18n-arg="feed.shown"
      >{{ $t("activity.filter.count", feed.shown) }}</span>
    </section>

    <!-- B26.2 · the feed -->
    <div class="td-activity-feed" data-activity-feed>
      <section
        v-for="day in days"
        :key="day.day"
        class="td-activity-day"
        data-activity-day
        :data-day="day.day"
        :data-activity-day-kind="day.kind"
        :data-activity-page="day.page"
      >
        <!-- The two relative headings are catalogue sentences, so they are the two
             static hooks; an absolute day is a *date* and has no sentence to
             translate — it is localised by `Intl` in `lib/activity-feed.js`, which
             is why it is the one heading with no `data-i18n` seat (§4 L1). -->
        <h2 class="td-activity-day-label" data-activity-day-label>
          <span v-if="day.kind === 'today'" data-i18n="activity.day.today">{{ $t("activity.day.today") }}</span>
          <span v-else-if="day.kind === 'yesterday'" data-i18n="activity.day.yesterday">{{ $t("activity.day.yesterday") }}</span>
          <span v-else>{{ day.text }}</span>
        </h2>
        <ol class="td-activity-rows">
          <template v-for="(item, index) in day.items" :key="item.id">
            <li
              class="td-activity-row"
              data-activity-row
              :data-actor="item.actor"
              :data-assignee-kind="item.actorKind"
              :data-event="item.event"
              :data-activity-group="item.group"
              :data-task="item.identifier"
              :data-at="item.at"
              :data-activity-unread="feed.unread.has(item.id) ? '' : undefined"
              :data-activity-burst="item.burst ? '' : undefined"
            >
              <div class="td-activity-line" data-activity-line @click="onLine($event, item)">
                <span class="td-activity-tick" aria-hidden="true"></span>
                <span class="td-activity-actor td-mono" data-activity-actor :data-assignee-kind="item.actorKind">{{ item.actor }}</span>
                <span class="td-activity-sentence" data-activity-sentence :data-i18n="`activity.verb.${item.verb}`">{{ $t(`activity.verb.${item.verb}`) }}</span>
                <a class="td-activity-task" data-activity-task :href="`#/task/${item.identifier}`" @click="onTask($event, item)">
                  <span class="td-activity-task-id td-mono" data-activity-task-id>{{ item.identifier }}</span>
                  <span class="td-activity-task-title" data-activity-task-title>{{ item.title }}</span>
                </a>
                <span
                  v-if="item.burst"
                  class="badge td-activity-burst-count"
                  :data-activity-burst-count="item.burst.count"
                  :aria-label="$t('activity.burstCount', item.burst.count)"
                  :title="$t('activity.burstCount', item.burst.count)"
                >×{{ item.burst.count }}</span>
                <time
                  v-if="item.stamp !== null"
                  class="td-activity-at td-mono"
                  data-activity-at
                  :datetime="item.at"
                  :title="item.stamp.absolute"
                >{{ $t(item.stamp.key, item.stamp.arg) }}</time>
                <button
                  type="button"
                  class="td-iconbtn td-activity-open"
                  data-activity-open
                  :aria-label="$t('activity.open', item.identifier)"
                  @click.stop="openDetail(item.identifier)"
                >
                  <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 4h16v16H4zM15 4v16" /></svg>
                </button>
                <details class="td-activity-detail" data-activity-detail>
                  <summary>
                    <span
                      v-if="item.burst"
                      data-activity-burst-count-label
                      data-i18n="activity.burstCount"
                      :data-i18n-arg="item.burst.count"
                    >{{ $t("activity.burstCount", item.burst.count) }}</span>
                    <span v-else data-i18n="activity.detail.changes">{{ $t("activity.detail.changes") }}</span>
                  </summary>
                  <ul class="td-activity-changes">
                    <li
                      v-for="(entry, position) in detailLines(item)"
                      :key="`${item.id}-${position}`"
                      class="td-activity-change"
                      :data-activity-change="entry.lines[0]?.kind ?? item.event"
                      :data-activity-burst-item="entry.member ? '' : undefined"
                      :data-at="entry.member ? entry.member.at : undefined"
                    >
                      <template v-for="(line, at) in entry.lines" :key="at">
                        <!-- The field label is copy, not a hook: the change line's
                             own `[data-activity-change]` already names the kind,
                             and B26's `data-activity-*` list is closed at 35. -->
                        <span class="td-activity-change-field">{{ $t(line.field) }}</span>
                        <span v-if="line.transition" class="td-activity-change-value td-mono td-activity-transition">
                          <span class="status td-status-dot" :data-status="line.transition.from" aria-hidden="true"></span>
                          <span :data-i18n="`status.${line.transition.from}`">{{ $t(`status.${line.transition.from}`) }}</span>
                          <span aria-hidden="true">→</span>
                          <span class="status td-status-dot" :data-status="line.transition.to" aria-hidden="true"></span>
                          <span :data-i18n="`status.${line.transition.to}`">{{ $t(`status.${line.transition.to}`) }}</span>
                        </span>
                        <span v-else-if="line.tokens" class="td-activity-change-value">
                          <span v-for="token in line.tokens" :key="token" class="badge td-chip td-chip-label">{{ token }}</span>
                        </span>
                        <span v-else class="td-activity-change-value">{{ line.value }}</span>
                      </template>
                    </li>
                  </ul>
                </details>
              </div>
            </li>

            <!-- B26.3 · the unread boundary, inside the day group that holds it and
                 directly after the last unread row: everything above the line is new,
                 and a filter that hides a row takes its own boundary with it. -->
            <li v-if="day.boundary === index" class="td-activity-unread-divider" data-activity-unread-divider>
              <span class="td-activity-unread-rule" aria-hidden="true"></span>
              <span class="td-activity-unread-text" data-i18n="activity.unread">{{ $t("activity.unread") }}</span>
              <span class="badge badge-sm td-activity-unread-count" data-activity-unread-count>{{ unreadCount }}</span>
              <span class="td-activity-unread-rule" aria-hidden="true"></span>
            </li>
          </template>
        </ol>
      </section>

      <!-- B26.5 · the two empty states. Both are **resident** and mutually
           exclusive by the `hidden` attribute (never by `v-if`): the project one
           means no admissible event exists, the filter one that none of them
           match, and the resting document carries both — which is what makes the
           pair machine-checkable and is the same two-state reading B05/B12 use. -->
      <div
        class="td-activity-empty flex flex-col items-center gap-1 p-4 text-center text-(--brand-text-3) border border-dashed border-(--brand-border-strong) rounded-lg"
        data-activity-empty
        data-activity-empty-kind="project"
        :hidden="feed.emptyKind !== 'project'"
      >
        <span class="font-medium text-(--brand-text-2)" data-i18n="activity.empty.project.title">{{ $t("activity.empty.project.title") }}</span>
        <span class="text-[12px]" data-i18n="activity.empty.project.hint">{{ $t("activity.empty.project.hint") }}</span>
      </div>

      <div
        class="td-activity-empty flex flex-col items-center gap-1 p-4 text-center text-(--brand-text-3) border border-dashed border-(--brand-border-strong) rounded-lg"
        data-activity-empty
        data-activity-empty-kind="filter"
        :hidden="feed.emptyKind !== 'filter'"
      >
        <span class="font-medium text-(--brand-text-2)" data-i18n="activity.empty.filter.title">{{ $t("activity.empty.filter.title") }}</span>
        <span class="text-[12px]" data-i18n="activity.empty.filter.hint">{{ $t("activity.empty.filter.hint") }}</span>
        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-activity-empty-reset
          data-i18n="activity.empty.filter.reset"
          @click="onReset"
        >{{ $t("activity.empty.filter.reset") }}</button>
      </div>
    </div>

    <!-- B26.6 · Load older. It unfolds the next page of day groups and retires when
         there is nothing older; on an empty project it never appears. -->
    <div class="td-activity-foot" :hidden="!feed.hasMore">
      <button type="button" class="btn btn-ghost btn-sm" data-activity-more data-i18n="activity.more" @click="loadOlder">
        {{ $t("activity.more") }}
      </button>
    </div>
  </section>
</template>
