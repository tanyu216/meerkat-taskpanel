<script setup>
/**
 * B02 · Top bar.
 *
 * The real data bindings (projects, revision from the event stream, search,
 * the view/filter toggles) arrive in S3/S4. This stage ships the hook surface
 * the block contract declares, with inert shell state, so the selectors survive
 * the Vue compile and the shell is real rather than a mock.
 */
const projects = ["TaskPanel", "Orchestrator", "Site Refresh"];
const currentProject = "TaskPanel";
const revision = 0;
</script>

<template>
  <header class="td-topbar navbar gap-2" data-topbar>
    <a class="td-brand btn btn-ghost gap-2" href="#" data-brand>
      <span class="td-brand-name">TaskPanel</span>
      <span class="td-brand-sub">Agent Task Collaboration</span>
    </a>

    <details class="dropdown" data-project-switcher>
      <summary class="btn btn-ghost gap-2">
        <span class="td-project-switcher-icon" data-project-switcher-icon aria-hidden="true">▦</span>
        <span class="td-mono" data-project-current>{{ currentProject }}</span>
      </summary>
      <ul class="dropdown-content menu w-56">
        <li v-for="name in projects" :key="name">
          <button type="button" :data-project-option="name" :aria-current="name === currentProject">
            <span class="td-mono">{{ name }}</span>
          </button>
        </li>
        <li>
          <button type="button" data-project-new>New project…</button>
        </li>
      </ul>
    </details>

    <div class="td-search" data-search>
      <input
        class="td-input input input-sm"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Search tasks, #ID, labels…"
        data-search-input
      />
    </div>

    <button type="button" class="td-iconbtn btn btn-ghost btn-sm" data-filter-toggle aria-pressed="true" aria-controls="td-filters" aria-label="Toggle filters">
      Filters
    </button>

    <div class="tabs tabs-box" data-view-toggle role="group" aria-label="View">
      <button type="button" class="tab" data-view="board" aria-pressed="true">Board</button>
      <button type="button" class="tab" data-view="list" aria-pressed="false">List</button>
    </div>

    <div class="td-topbar-actions ml-auto">
      <span class="td-revision" data-revision>
        <span class="td-revision-text">Live</span>
        <span class="td-mono" data-revision-label title="Global revision">
          rev <span data-revision-value>{{ revision }}</span>
        </span>
      </span>

      <button type="button" class="btn btn-primary btn-sm" data-new-task>New task</button>
    </div>
  </header>
</template>
