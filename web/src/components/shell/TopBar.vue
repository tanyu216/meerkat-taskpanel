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
      <span class="td-brand-name" data-i18n="app.brand">{{ $t("app.brand") }}</span>
      <span class="td-brand-sub" data-i18n="app.tagline">{{ $t("app.tagline") }}</span>
    </a>

    <details class="td-details dropdown" data-project-switcher>
      <summary class="btn btn-ghost btn-sm gap-2">
        <span data-project-switcher-icon aria-hidden="true">▦</span>
        <span class="td-mono" data-project-current>{{ currentName }}</span>
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
