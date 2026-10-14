<script setup>
/**
 * B27 · the 「等你回复」queue (R12x; M1's own view, re-cut to the design's block).
 *
 * The sidebar's fourth destination: the reader's own queue, not a second Activity.
 * B26 is the project's ledger — everything, newest first; this is the items whose
 * ball is in *the reader's* court, and only by how long they have waited
 * (`design/DESIGN.md` §30.1 — two destinations, two questions).
 *
 * Four things it is careful about, each of them a design rule:
 *
 *   * **Oldest first** (§30.2). The top row has waited longest, so the list is an
 *     overdue-first inbox. Reverse it and the item that has waited five days hides
 *     behind the one that arrived a minute ago — the failure a queue exists to
 *     prevent. The order lives in `lib/waiting-queue.js`, not in this template.
 *   * **The stamp is the row's own instant.** `data-waiting-since` and the
 *     `datetime` its visible text is printed from are the *same* value, and the
 *     text uses B26's three `time.*` keys — one time vocabulary across the two
 *     views, so the two read the same way.
 *   * **The reason is an attribute, the colour a variable.** The chip carries
 *     `data-waiting-reason-kind="question"|"blocked"` and the stylesheet's
 *     attribute rule sets `--status-color`; no component names a colour (B27's
 *     "zero new hues").
 *   * **A row opens B09.** The row body is the pointer's affordance and
 *     `[data-waiting-open]` its keyboard twin and accessible name; both land on
 *     the board's own detail surface for the task the row names. There is no
 *     second drawer and no anchor back to the board.
 *
 * What M1 rendered here (the card component, and the triggering question as an
 * inline summary plus a `<details>`) is **replaced** by the design's row: the
 * queue is a way *into* a card, and the card — with the question on it — is one
 * press away. The triggering comment is still read, because its instant is what
 * `since` reports; it is no longer painted here. That replacement is registered in
 * the card's report (`T-20261013-014701-7`), hooks and all.
 */
import { computed, watch } from "vue";

import { waitingRows } from "../../lib/waiting-queue.js";
import { board, loadWaitingPayloads, openDetail, waitingTasks } from "../../stores/board.js";
import { view } from "../../stores/ui.js";

/** The queue: one row per awaiting card, oldest first (§30.2). */
const rows = computed(() => waitingRows(waitingTasks.value, board.waitingPayload));

/**
 * The payloads load as soon as an awaiting card *exists*, not when the view is
 * opened — its instant is the row's `since`, so the queue is ordered by the real
 * wait from the first paint.
 *
 * Two triggers alone are not enough and both were tried (M1): `onMounted` runs
 * before the board has fetched its tasks, so the awaiting set is still empty; and
 * watching `view` fires only on a *change*, so an SSE re-sync that adds an
 * awaiting card while another view is up loads nothing. Keying the watcher on the
 * set of awaiting ids covers both, and is cheap: the loader skips every id it
 * already knows.
 */
const awaitingIds = computed(() => waitingTasks.value.map((task) => task.id).join(","));
watch(awaitingIds, () => loadWaitingPayloads(), { immediate: true });

const isEmpty = computed(() => rows.value.length === 0);

/**
 * The row body is the pointer's affordance and `[data-waiting-open]` its keyboard
 * twin — the same pair B26's rows are. A press that lands on the row's own button
 * is the button's, not the row's (the button stops its own propagation anyway;
 * this is the belt to that braces).
 */
function onRow(event, row) {
  if (event.target.closest("button")) return;
  openDetail(row.identifier);
}
</script>

<template>
  <section class="td-waiting-view" data-waiting-view :hidden="view !== 'waiting'">
    <!-- B27.2 · the head: the destination's name, what the view *is* and the
         queue's tally. Both read one derivation (`rows`), so the heading and the
         count cannot disagree — and `waiting.title` is byte-identical to
         `nav.waiting`, which is the one name this surface has. An empty queue
         hides the tally: "0 waiting on you" beside "Nothing is waiting on you"
         is the same sentence twice (§30).

         R15 ④ — the header states what the view is, not only its name: a title
         plus a one-line description, the two-line text block B26's own header
         carries (`design/fidelity-r15.md` §2.5). The view spells it in its own
         family names (`.td-waiting-head-text` / `.td-waiting-sub`) so either
         header can move without dragging the other, and the description carries
         a `data-i18n` hook only — no `data-waiting-*` seat of its own, exactly
         as B26's does. -->
    <header class="td-waiting-head" data-waiting-head>
      <div class="td-waiting-head-text">
        <h1 class="td-waiting-title" data-waiting-title data-i18n="waiting.title">{{ $t("waiting.title") }}</h1>
        <p class="td-waiting-sub" data-i18n="waiting.subtitle">{{ $t("waiting.subtitle") }}</p>
      </div>
      <span
        class="td-waiting-count"
        data-waiting-count
        data-i18n="waiting.count"
        :data-i18n-arg="rows.length"
        aria-live="polite"
        :hidden="isEmpty"
      >{{ $t("waiting.count", rows.length) }}</span>
    </header>

    <ul class="td-waiting-list" data-waiting-list>
      <li
        v-for="row in rows"
        :key="row.id"
        class="td-waiting-item"
        data-waiting-item
        :data-task="row.identifier"
        :data-since="row.since"
        @click="onRow($event, row)"
      >
        <span class="td-waiting-actor td-mono" data-waiting-actor :data-assignee-kind="row.actorKind">{{ row.actor }}</span>
        <!-- The two kinds are catalogue sentences, so they are two static hooks
             rather than one computed key — the same reading B26's day headings use.
             The chip is `.td-waiting-reason`, **not** the status chip: it carries
             its own 18px box, its own 4px radius and its own `::before` dot, and
             wearing `.td-chip` would hand all three to another family. -->
        <span class="td-waiting-reason" data-waiting-reason :data-waiting-reason-kind="row.reasonKind">
          <span v-if="row.reasonKind === 'blocked'" data-i18n="waiting.reason.blocked">{{ $t("waiting.reason.blocked") }}</span>
          <span v-else data-i18n="waiting.reason.question">{{ $t("waiting.reason.question") }}</span>
        </span>
        <span class="td-waiting-task-cell">
          <span class="td-waiting-task td-mono" data-waiting-task :title="row.identifier">{{ row.display }}</span>
          <span class="td-waiting-task-title" data-waiting-task-title>{{ row.title }}</span>
        </span>
        <time
          v-if="row.stamp !== null"
          class="td-waiting-since td-mono"
          data-waiting-since
          :datetime="row.since"
          :title="row.stamp.absolute"
        >{{ $t(row.stamp.key, row.stamp.arg) }}</time>
        <button
          type="button"
          class="td-iconbtn td-waiting-open"
          data-waiting-open
          :aria-label="$t('waiting.open', row.identifier)"
          @click.stop="openDetail(row.identifier)"
        >
          <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 4h16v16H4zM15 4v16" /></svg>
        </button>
      </li>
    </ul>

    <!-- B27.3 · the empty state. It is *resident* and mutually exclusive with the
         list by the `hidden` attribute, never by a `v-if` — the resting document
         carries it, which is what makes it machine-checkable (B26's own reading).

         R17 — it now reads like the other two: the brand mark B12 opens an empty
         board with, the `-lg` box, the title **and** a hint. The queue used to
         stand on its one line alone, which left the reader knowing nothing was
         owed but not where owed work lands; `waiting.empty.hint` is the second
         line B12's own two-part state gave it. No button: this view has no filter
         to clear (§30.1), so there is nothing a control here could do. -->
    <div class="td-empty td-empty-lg td-waiting-empty" data-waiting-empty :hidden="!isEmpty">
      <!-- The brand mark stands in for a generic empty glyph. Its two lead
           meerkats drop to `--brand-text-3` (the design's `--color-td-ink-3`) so
           the on-duty sentinel and its watch signal stay the only lit elements on
           the surface. Its own face-mask id keeps the document's mask ids
           unique — the board's empty state, the top bar's mark and the activity
           view's pair are all resident at the same time. -->
      <svg class="td-logo td-logo-lg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <defs>
          <mask id="face-knockout-d-lg" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
            <rect x="0" y="0" width="32" height="32" fill="#FFFFFF" />
            <g fill="#000000">
              <circle cx="6.4" cy="20" r="0.42" />
              <circle cx="8" cy="20" r="0.42" />
              <rect x="6.84" y="21.05" width="0.72" height="0.2" rx="0.1" />
              <circle cx="15.2" cy="14.8" r="0.42" />
              <circle cx="16.8" cy="14.8" r="0.42" />
              <rect x="15.64" y="15.85" width="0.72" height="0.2" rx="0.1" />
              <circle cx="24" cy="12" r="0.42" />
              <circle cx="25.6" cy="12" r="0.42" />
              <rect x="24.44" y="13.05" width="0.72" height="0.2" rx="0.1" />
            </g>
          </mask>
        </defs>
        <g mask="url(#face-knockout-d-lg)">
          <g fill="var(--brand-text-3)">
            <rect x="4.6" y="17.6" width="5.2" height="9.4" rx="2.6" />
            <circle cx="7.2" cy="20.2" r="2.6" />
            <circle cx="4.8" cy="19.3" r="1.2" />
            <circle cx="9.6" cy="19.3" r="1.2" />
          </g>
          <g fill="var(--brand-text-3)">
            <rect x="13.4" y="12.4" width="5.2" height="14.6" rx="2.6" />
            <circle cx="16" cy="15" r="2.6" />
            <circle cx="13.6" cy="14.1" r="1.2" />
            <circle cx="18.4" cy="14.1" r="1.2" />
          </g>
          <g fill="var(--color-primary)">
            <rect x="22.2" y="9.6" width="5.2" height="17.4" rx="2.6" />
            <circle cx="24.8" cy="12.2" r="2.6" />
            <circle cx="22.4" cy="11.3" r="1.2" />
            <circle cx="27.2" cy="11.3" r="1.2" />
          </g>
        </g>
        <circle cx="24.8" cy="3.4" r="2.1" fill="var(--color-primary)" />
      </svg>
      <span class="td-empty-title" data-i18n="waiting.empty">{{ $t("waiting.empty") }}</span>
      <span class="td-empty-hint" data-i18n="waiting.empty.hint">{{ $t("waiting.empty.hint") }}</span>
    </div>
  </section>
</template>
