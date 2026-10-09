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

import SidebarFooter from "./SidebarFooter.vue";

const nav = ["board", "list", "activity"];

const projects = computed(() =>
  board.projects.map((project, index) => ({
    id: project.id,
    name: project.name,
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
        :data-i18n="`nav.${item}`"
        @click="onNav(item)"
      >
        {{ $t(`nav.${item}`) }}
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
          <span class="td-side-name td-mono">{{ project.name }}</span>
          <span class="td-order-score td-mono" :title="scoreLabel(project)">{{ project.score }}</span>
          <span v-if="project.count !== null" class="badge badge-sm td-mono">{{ project.count }}</span>
        </button>
      </div>
    </section>

    <section>
      <h2 class="td-side-label" data-i18n="sidebar.agents">{{ $t("sidebar.agents") }}</h2>
      <div data-agents-presence>
        <div v-for="agent in agents" :key="agent.platform" class="td-agent-row">
          <span class="badge badge-xs td-mono" :data-agent-platform="agent.platform">{{ agent.platform }}</span>
          <span class="td-side-name td-mono">{{ agent.handles.join(", ") }}</span>
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

    <button type="button" class="td-side-item" data-states-open :data-i18n="'sidebar.states'" @click="statesOpen = true">
      {{ $t("sidebar.states") }}
    </button>

    <SidebarFooter />
  </aside>
</template>
