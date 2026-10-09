<script setup>
/**
 * B03 · Sidebar.
 *
 * Nav, the (server-ordered) project list, agent presence, the legend and the
 * three-cell footer. The project order is server-computed and only *consumed*
 * here — the static rows below carry a descending `data-order-score` and a
 * contiguous `data-order-rank` so the contract's order rules hold on the shell
 * while the live wiring lands in S3.
 */
import SidebarFooter from "./SidebarFooter.vue";

const nav = ["board", "list", "activity"];
const projects = [
  { name: "Orchestrator", score: 0.867, count: 4 },
  { name: "TaskPanel", score: 0.667, count: 12 },
  { name: "Site Refresh", score: 0.467, count: 2 },
];
const agents = [
  { platform: "claude", handles: "jobs, linus, simons", presence: "running" },
  { platform: "openclaw", handles: "elon", presence: "running" },
  { platform: "codex", handles: "turing", presence: "idle" },
  { platform: "pi", handles: "assistant", presence: "running" },
];
const statuses = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
const priorities = ["urgent", "high", "medium", "low", "none"];
</script>

<template>
  <aside class="td-sidebar" data-sidebar>
    <nav class="td-nav" data-nav aria-label="Views">
      <button
        v-for="(item, i) in nav"
        :key="item"
        type="button"
        class="td-nav-item btn btn-ghost btn-sm justify-start"
        :data-nav-item="item"
        :aria-current="i === 0 ? 'page' : undefined"
      >
        {{ item }}
      </button>
    </nav>

    <section>
      <h2 class="td-side-label">Projects</h2>
      <div class="td-nav mt-2" data-project-list>
        <button
          v-for="(project, i) in projects"
          :key="project.name"
          type="button"
          class="td-side-item btn btn-ghost btn-sm justify-start gap-2"
          :data-project="project.name"
          :data-order-score="project.score"
          :data-order-rank="i + 1"
          :aria-current="project.name === 'TaskPanel' ? 'page' : undefined"
          :title="project.name"
        >
          <span class="td-side-name td-mono">{{ project.name }}</span>
          <span class="badge badge-sm" data-project-count>{{ project.count }}</span>
        </button>
      </div>
    </section>

    <section>
      <h2 class="td-side-label">Active agents</h2>
      <div class="mt-2" data-agents-presence>
        <div v-for="agent in agents" :key="agent.platform" class="td-agent-row">
          <span class="badge badge-xs" :data-agent-platform="agent.platform">{{ agent.platform }}</span>
          <span class="td-side-name td-mono">{{ agent.handles }}</span>
          <span class="td-presence" :data-presence="agent.presence" role="img" :aria-label="agent.presence"></span>
        </div>
      </div>
    </section>

    <section>
      <h2 class="td-side-label">Legend</h2>
      <div class="td-legend mt-2" data-legend>
        <div class="td-legend-status" data-legend-status>
          <span v-for="status in statuses" :key="status" class="td-legend-chip" :data-status="status">
            {{ status }}
          </span>
        </div>
        <div class="td-legend-priority" data-legend-priority>
          <span v-for="priority in priorities" :key="priority" class="td-legend-chip" :data-priority="priority">
            {{ priority }}
          </span>
        </div>
      </div>
    </section>

    <button type="button" class="td-side-item td-state-btn btn btn-ghost btn-sm justify-start" data-states-open title="UI states preview">
      States
    </button>

    <SidebarFooter />
  </aside>
</template>
