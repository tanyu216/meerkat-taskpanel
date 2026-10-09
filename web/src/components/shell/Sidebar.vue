<script setup>
/**
 * B03 · Sidebar — nav, the server-ordered project list, agent presence, the
 * legend (B15) and the three-cell footer.
 *
 * The project list renders exactly the order `/projects` computed and does no
 * sorting of its own (§4.6). Each row prints the diagnostic `total` the server
 * returns under `?order_debug=1` as `data-order-score` and its 1-based position
 * as `data-order-rank`; if the diagnostic field were ever missing the score
 * falls back to 0 for display only — the order is still the server's.
 */
import { computed, ref } from "vue";

import { board, selectProject, STATUSES, PRIORITIES } from "../../stores/board.js";
import { accessOpen, statesOpen, view, setView } from "../../stores/ui.js";
import { initialsOf } from "../../lib/monogram.js";

import SidebarFooter from "./SidebarFooter.vue";

const nav = ["board", "list", "activity"];

// The rail glyph of each view, matching the prototype's B03 nav icons: board =
// three bars, list = three rules, activity = a clock.
const navIcons = {
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M4 6h16M4 12h16M4 18h16",
  activity: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
};

const projects = computed(() =>
  board.projects.map((project, index) => ({
    id: project.id,
    name: project.name,
    initials: initialsOf(project.name),
    count: board.currentProjectId === project.id ? board.tasks.length : null,
    rank: index + 1,
    score: board.orderDebug[project.id]?.total ?? 0,
  })),
);

function scoreLabel(project) {
  return board.orderDebug[project.id] ? String(project.score) : "";
}

// Presence is derived from the board's own data: an agent is "running" while it
// holds a task in progress or review, "idle" otherwise.
const agents = computed(() => {
  const busy = new Set(
    board.tasks
      .filter((task) => task.status === "in_progress" || task.status === "in_review")
      .map((task) => task.assignee?.display_name)
      .filter(Boolean),
  );
  const byPlatform = new Map();
  for (const entry of board.assignees) {
    if (entry.kind !== "agent") continue;
    const platform = entry.platform ?? "claude";
    if (!byPlatform.has(platform)) byPlatform.set(platform, { platform, handles: [], presence: "idle" });
    const row = byPlatform.get(platform);
    row.handles.push(entry.display_name);
    if (busy.has(entry.display_name)) row.presence = "running";
  }
  return [...byPlatform.values()];
});

function onNav(item) {
  if (item === "board" || item === "list") setView(item);
}
</script>

<template>
  <aside class="td-sidebar" data-sidebar>
    <nav data-nav :aria-label="$t('nav.label')">
      <button
        v-for="item in nav"
        :key="item"
        type="button"
        class="td-side-item"
        :data-nav-item="item"
        :aria-current="view === item ? 'page' : undefined"
        @click="onNav(item)"
      >
        <svg class="td-side-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path :d="navIcons[item]" />
        </svg>
        <span class="td-side-text" :data-i18n="`nav.${item}`">{{ $t(`nav.${item}`) }}</span>
      </button>
    </nav>

    <section>
      <h2 class="td-side-label" data-i18n="sidebar.projects">{{ $t("sidebar.projects") }}</h2>
      <div data-project-list>
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="td-side-item"
          :data-project="project.name"
          :data-project-count="project.count ?? ''"
          :data-order-rank="project.rank"
          :data-order-score="project.score"
          :aria-current="project.id === board.currentProjectId ? 'page' : undefined"
          @click="selectProject(project.id)"
        >
          <span class="td-side-icon td-mono" aria-hidden="true">{{ project.initials }}</span>
          <span class="td-side-name td-mono">{{ project.name }}</span>
          <span class="td-order-score td-mono" :title="scoreLabel(project)">{{ project.score }}</span>
          <span v-if="project.count !== null" class="badge badge-sm td-mono td-count">{{ project.count }}</span>
        </button>
      </div>
    </section>

    <section>
      <h2 class="td-side-label" data-i18n="sidebar.agents">{{ $t("sidebar.agents") }}</h2>
      <div data-agents-presence>
        <div v-for="agent in agents" :key="agent.platform" class="td-agent-row">
          <span class="badge badge-xs td-mono td-agent-badge" :data-agent-platform="agent.platform">{{ agent.platform }}</span>
          <span class="td-side-name td-agent-text td-mono">{{ agent.handles.join(", ") }}</span>
          <span
            class="td-presence"
            :data-presence="agent.presence"
            role="img"
            :aria-label="$t(`presence.${agent.presence}`)"
            :title="$t(`presence.${agent.presence}`)"
          ></span>
        </div>
      </div>
    </section>

    <!-- B15 · Legend: one chip per status (7) and per priority (5). -->
    <section>
      <h2 class="td-side-label" data-i18n="sidebar.legend">{{ $t("sidebar.legend") }}</h2>
      <div class="td-legend" data-legend>
        <div class="td-legend-status" data-legend-status>
          <span v-for="status in STATUSES" :key="status" class="td-legend-chip" :data-status="status">{{ $t(`status.${status}`) }}</span>
        </div>
        <div class="td-legend-priority" data-legend-priority>
          <span v-for="priority in PRIORITIES" :key="priority" class="td-legend-chip" :data-priority="priority">{{ $t(`priority.${priority}`) }}</span>
        </div>
      </div>
    </section>

    <button type="button" class="td-side-item" data-states-open @click="statesOpen = true">
      <svg class="td-side-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5h6v6H4zM14 5h6v3h-6zM4 15h6v4H4zM14 12h6v7h-6z" />
      </svg>
      <span class="td-side-text" :data-i18n="'sidebar.states'">{{ $t("sidebar.states") }}</span>
    </button>

    <SidebarFooter />
  </aside>
</template>
