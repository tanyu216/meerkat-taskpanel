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

import { board, selectProject } from "../../stores/board.js";
import { createProjectOpen, createTaskOpen, filtersOpen, setView, toggleFilters, view } from "../../stores/ui.js";

const projects = computed(() => board.projects);
const currentName = computed(() => board.projects.find((p) => p.id === board.currentProjectId)?.name ?? "—");

// The view-toggle glyphs, matching the prototype's B02 tabs (board = bars,
// list = rules). At ≤759px only these show — the label text is dropped.
const viewIcons = {
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M4 6h16M4 12h16M4 18h16",
};

function switchProject(id) {
  if (id !== board.currentProjectId) selectProject(id);
}
</script>

<template>
  <header class="td-topbar" data-topbar>
    <a class="td-brand" href="#" data-brand @click.prevent>
      <!-- Sentinel Watch — the brand mark, geometry fixed by BRAND.md §5 and
           transcribed from `design/prototype/index.html`'s `[data-brand]` mark.
           The two lead meerkats read `--brand-text` (the design's
           `--color-td-ink`), the on-duty sentinel and its watch signal read
           `--color-primary` (the design's `--color-td-accent`), so the mark
           follows the active theme with no second file. The eyes and mouth are
           cut as negative space by the mask below; the watch signal stays
           outside it, so the sentinel on duty is always solid. -->
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
      <span class="td-brand-name" data-i18n="app.brand">{{ $t("app.brand") }}</span>
      <span class="td-brand-sub" data-i18n="app.tagline">{{ $t("app.tagline") }}</span>
    </a>

    <details class="td-details dropdown" data-project-switcher>
      <summary class="btn btn-ghost btn-sm gap-2">
        <!-- The switcher glyph is the prototype's stacked-plane SVG, not a text
             character: at 14px the glyph `▦` and the icon stop reading alike. -->
        <svg class="td-icon td-icon-sm" data-project-switcher-icon viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3 3 8l9 5 9-5-9-5ZM3 14l9 5 9-5" />
        </svg>
        <span class="td-mono" data-project-current>{{ currentName }}</span>
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </summary>
      <ul class="td-details-menu menu">
        <li v-for="project in projects" :key="project.id">
          <button
            type="button"
            :data-project-option="project.name"
            :aria-current="project.id === board.currentProjectId ? 'true' : 'false'"
            @click="switchProject(project.id)"
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

    <div class="td-search" data-search>
      <input
        v-model="board.filters.search"
        class="td-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        data-search-input
        :data-i18n-placeholder="'topbar.search.placeholder'"
        :aria-label="$t('topbar.search.label')"
        :placeholder="$t('topbar.search.placeholder')"
      />
    </div>

    <button
      type="button"
      class="btn btn-ghost btn-sm"
      data-filter-toggle
      :aria-pressed="filtersOpen ? 'true' : 'false'"
      aria-controls="td-filters"
      :aria-label="$t('topbar.filters')"
      :data-i18n-aria-label="'topbar.filters'"
      @click="toggleFilters"
    >
      {{ $t("filters.label") }}
    </button>

    <div class="tabs tabs-box td-tabs" data-view-toggle role="group" :aria-label="$t('topbar.view')">
      <button
        v-for="mode in ['board', 'list']"
        :key="mode"
        type="button"
        class="tab td-tab"
        :data-view="mode"
        :aria-pressed="view === mode ? 'true' : 'false'"
        @click="setView(mode)"
      >
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path :d="viewIcons[mode]" />
        </svg>
        <span class="td-view-toggle-label">{{ $t(`topbar.view.${mode}`) }}</span>
      </button>
    </div>

    <div class="td-topbar-actions">
      <span class="td-revision" data-revision>
        <span class="td-live-dot" :data-connection="board.connection" aria-hidden="true"></span>
        <span class="td-revision-text" data-i18n="topbar.live">{{ $t("topbar.live") }}</span>
        <span class="td-mono" data-revision-label :title="$t('topbar.revision.title')">
          <span class="td-revision-text">rev</span> <span data-revision-value>{{ board.revision }}</span>
        </span>
      </span>
      <button type="button" class="btn btn-primary btn-sm gap-2" data-new-task :data-i18n="'topbar.newTask'" @click="createTaskOpen = true">
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span class="td-new-task-label">{{ $t("topbar.newTask") }}</span>
      </button>
    </div>
  </header>
</template>
