<script setup>
/**
 * B02 · Top bar — brand, project switcher, search, the filter and view toggles,
 * the live revision readout and the primary action.
 *
 * The right cluster (revision + New task) is one flex item pushed right with
 * `margin-left: auto`, so it hugs the header's right padding edge and never
 * splits across the rows the bar folds into. There is no user/account control
 * and no theme or language control here — those live in the sidebar footer
 * (B03); the contract asserts their absence from the bar.
 */
import { computed } from "vue";

import { dismissMemberFrom } from "../../lib/light-dismiss.js";
import { board, selectProject } from "../../stores/board.js";
import { navigate } from "../../stores/route.js";
import { createProjectOpen, createTaskOpen, filtersOpen, toggleFilters, view } from "../../stores/ui.js";

const projects = computed(() => board.projects);
const currentName = computed(() => board.projects.find((p) => p.id === board.currentProjectId)?.name ?? "—");

// The view-toggle glyphs, matching the prototype's B02 tabs (board = bars,
// list = rules). At ≤759px only these show — the label text is dropped.
const viewIcons = {
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M4 6h16M4 12h16M4 18h16",
};

/** Choosing a project is what the panel was open for, so it closes with the choice
 *  — the prototype's own handler clears `open` before it switches. */
function switchProject(id, event) {
  dismissMemberFrom(event);
  if (id !== board.currentProjectId) selectProject(id).catch(() => {});
}
</script>

<template>
  <header class="[grid-area:topbar] flex flex-nowrap items-center min-w-0 gap-2 px-3 py-0 border-b border-b-(--brand-border) bg-(--brand-surface)" data-topbar>
    <!-- F2 — the bar's inner spacing is the prototype's `.td-topbar` box:
         `padding: 0 12px`, no block padding. The bar is 56px through the shell
         grid's own topbar track (`--shell-topbar`, stated on `.td-shell`), not
         through its padding, so the vertical pair was pure divergence — the
         content was already centred by `items-center`, and `py-2` only narrowed
         the room the search may shrink into (where the 980/430 fold is decided).
         The inline 12px is one step in from the 16px (`px-4`) it carried. -->
    <a class="inline-flex items-baseline gap-2 no-underline text-inherit" href="#" data-brand @click.prevent>
      <!-- Sentinel Watch — the brand mark, geometry fixed by BRAND.md §5 and
           transcribed from `design/prototype/index.html`'s `[data-brand]` mark.
           The two lead meerkats read `--brand-text` (the design's
           `--color-td-ink`), the on-duty sentinel and its watch signal read
           `--color-primary` (the design's `--color-td-accent`), so the mark
           follows the active theme with no second file. The eyes and mouth are
           cut as negative space by the mask below; the watch signal stays
           outside it, so the sentinel on duty is always solid.

           R17 — the 18px size comes from the design's own `td-logo` rather than
           the `size-[18px] shrink-0 self-center` utility trio, which stated the
           same three numbers. One mark vocabulary across the app: the top bar's
           mark and the four empty states' all read a `.td-logo*` class. See the
           ported pair in `web/src/styles/app.css`. -->
      <svg class="td-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <defs>
          <mask id="face-knockout-a-top" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
            <rect x="0" y="0" width="32" height="32" fill="#FFFFFF" />
            <g fill="#000000">
              <!-- sentinel 1 · face -->
              <circle cx="6.4" cy="20" r="0.42" />
              <circle cx="8" cy="20" r="0.42" />
              <rect x="6.84" y="21.05" width="0.72" height="0.2" rx="0.1" />
              <!-- sentinel 2 · face -->
              <circle cx="15.2" cy="14.8" r="0.42" />
              <circle cx="16.8" cy="14.8" r="0.42" />
              <rect x="15.64" y="15.85" width="0.72" height="0.2" rx="0.1" />
              <!-- sentinel 3 · face -->
              <circle cx="24" cy="12" r="0.42" />
              <circle cx="25.6" cy="12" r="0.42" />
              <rect x="24.44" y="13.05" width="0.72" height="0.2" rx="0.1" />
            </g>
          </mask>
        </defs>
        <g mask="url(#face-knockout-a-top)">
          <!-- sentinel 1 · cx 7.2 · top 17.6 -->
          <g fill="var(--brand-text)">
            <rect x="4.6" y="17.6" width="5.2" height="9.4" rx="2.6" />
            <circle cx="7.2" cy="20.2" r="2.6" />
            <circle cx="4.8" cy="19.3" r="1.2" />
            <circle cx="9.6" cy="19.3" r="1.2" />
          </g>
          <!-- sentinel 2 · cx 16 · top 12.4 -->
          <g fill="var(--brand-text)">
            <rect x="13.4" y="12.4" width="5.2" height="14.6" rx="2.6" />
            <circle cx="16" cy="15" r="2.6" />
            <circle cx="13.6" cy="14.1" r="1.2" />
            <circle cx="18.4" cy="14.1" r="1.2" />
          </g>
          <!-- sentinel 3 (on duty, tallest) · cx 24.8 · top 9.6 -->
          <g fill="var(--color-primary)">
            <rect x="22.2" y="9.6" width="5.2" height="17.4" rx="2.6" />
            <circle cx="24.8" cy="12.2" r="2.6" />
            <circle cx="22.4" cy="11.3" r="1.2" />
            <circle cx="27.2" cy="11.3" r="1.2" />
          </g>
        </g>
        <!-- watch signal — clear of the sentinel's crown by 4.1, outside the mask -->
        <circle cx="24.8" cy="3.4" r="2.1" fill="var(--color-primary)" />
      </svg>
      <span class="font-semibold" data-brand-name data-i18n="app.brand">{{ $t("app.brand") }}</span>
      <span class="text-[12px] text-(--brand-text-3)" data-brand-sub data-i18n="app.tagline">{{ $t("app.tagline") }}</span>
    </a>

    <!-- R9 ① — the switcher takes the light-dismiss rule by carrying the
         attribute, not by being named in a handler: it closes on a click outside
         and on Escape, and opening it closes the other member (the label
         filter). Its floating panel used to stay up and intercept the very next
         click, which is what Terry saw as "must click the list itself to close". -->
    <details class="dropdown" data-project-switcher data-dismiss-on-outside>
      <summary class="btn btn-ghost btn-sm gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <!-- The switcher glyph is the prototype's stacked-plane SVG, not a text
             character: at 14px the glyph `▦` and the icon stop reading alike. -->
        <svg class="td-icon size-3.5" data-project-switcher-icon viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3 3 8l9 5 9-5-9-5ZM3 14l9 5 9-5" />
        </svg>
        <span class="td-mono" data-project-current>{{ currentName }}</span>
        <svg class="td-icon size-3.5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <ul class="td-details-menu menu">
        <li v-for="project in projects" :key="project.id">
          <button
            type="button"
            :data-project-option="project.name"
            :aria-current="project.id === board.currentProjectId ? 'true' : 'false'"
            @click="switchProject(project.id, $event)"
          >
            <span class="td-mono">{{ project.name }}</span>
          </button>
        </li>
        <li>
          <button type="button" data-project-new :data-i18n="'project.new'" @click="createProjectOpen = true">
            {{ $t("project.new") }}
          </button>
        </li>
      </ul>
    </details>

    <div class="grow shrink basis-[200px] min-w-0 max-w-[340px]" data-search>
      <input
        v-model="board.filters.search"
        class="input input-sm td-input w-full"
        type="text"
        autocomplete="off"
        spellcheck="false"
        data-search-input
        :data-i18n-placeholder="'topbar.search.placeholder'"
        :aria-label="$t('topbar.search.label')"
        :placeholder="$t('topbar.search.placeholder')"
      />
    </div>

    <!-- F10 — the prototype's filters toggle is a `td-iconbtn` holding the
         funnel-lines glyph (`.td-icon`), at every width; this was a text button
         reading "Filters". The word cost 31px of the bar's first row, which is
         what pushed that row past a phone-width line — the bar then folded to
         three rows where the prototype folds to two (`shot-compare`'s 430 tier).
         The `aria-label` carries the same name the word did. -->
    <button
      type="button"
      class="td-iconbtn"
      data-filter-toggle
      :aria-pressed="filtersOpen ? 'true' : 'false'"
      aria-controls="td-filters"
      :aria-label="$t('topbar.filters')"
      :data-i18n-aria-label="'topbar.filters'"
      @click="toggleFilters"
    >
      <svg class="td-icon size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 6h16M7 12h10M10 18h4" />
      </svg>
    </button>

    <!-- daisyUI's `tabs tabs-box` carries the shell; `td-tabs`/`td-tab` state the
         brand well and the pressed tab. The buttons stay `aria-pressed` toggles,
         which daisyUI's activation vocabulary (`.tab-active`, `[aria-selected]`,
         `[aria-current]`) does not read — so the selected state is the rule in
         app.css, not a daisyUI class (R6 ①, B02). -->
    <div class="tabs tabs-box td-tabs" data-view-toggle role="group" :aria-label="$t('topbar.view')">
      <button
        v-for="mode in ['board', 'list']"
        :key="mode"
        type="button"
        class="tab td-tab"
        :data-view="mode"
        :aria-pressed="view === mode ? 'true' : 'false'"
        @click="navigate(mode)"
      >
        <svg class="td-icon size-3.5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path :d="viewIcons[mode]" />
        </svg>
        <span data-label-text>{{ $t(`topbar.view.${mode}`) }}</span>
      </button>
    </div>

    <!-- M2c ② — `flex-none` is the prototype's own declaration for this cluster
         (`design/prototype/src/input.css`: `.td-topbar-actions { … flex: none;
         min-width: 0; margin-left: auto }`). Without it the cluster is the only
         *shrinkable* item besides the search, so at 980px the two split the
         shortfall: the cluster kept its box but its content (revision + New task)
         spilled 12px past the shell, which `overflow: hidden` then clipped — the
         one implementation-only entry `shot-compare --strict` reported. The
         search is the item the bar is designed to give slack to
         (`flex: 1 1 160px; min-width: 0` in the prototype), so the cluster now
         holds its natural width and the search absorbs the whole shortfall. -->
    <div class="inline-flex flex-none items-center gap-2 ms-auto">
      <span class="inline-flex items-center gap-1 text-[12px] text-(--brand-text-2)" data-revision>
        <span class="size-2 rounded-[999px] bg-success data-[connection=closed]:bg-warning data-[connection=connecting]:bg-warning" :data-connection="board.connection" aria-hidden="true"></span>
        <span data-label-text data-i18n="topbar.live">{{ $t("topbar.live") }}</span>
        <span class="td-mono" data-revision-label :title="$t('topbar.revision.title')">
          <span data-label-text>rev</span> <span data-revision-value>{{ board.revision }}</span>
        </span>
      </span>
      <button type="button" class="btn btn-primary btn-sm gap-2" data-new-task :data-i18n="'topbar.newTask'" @click="createTaskOpen = true">
        <svg class="td-icon size-3.5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span data-label-text>{{ $t("topbar.newTask") }}</span>
      </button>
    </div>
  </header>
</template>
