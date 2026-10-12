<script setup>
/**
 * B03 · Sidebar — nav, the server-ordered project list, agent presence and the
 * three-cell footer.
 *
 * The project list renders exactly the order `/projects` computed and does no
 * sorting of its own (§4.6). Each row carries the diagnostic `total` the server
 * returns under `?order_debug=1` as its `data-order-score` **attribute** and its
 * 1-based position as `data-order-rank`. The score is a review diagnostic, not
 * copy, so it is never painted — the prototype's row has the attribute and no
 * text either (E2b, 2026-10-12). A painted score also cost the row real width
 * and ellipsised the project name; as an attribute it costs no layout at all.
 *
 * The prototype's two review surfaces are deliberately absent here: B15 (the
 * legend) and the States entry point that opened B18 (the states gallery) were
 * product-design demonstrations, not requirements, so the shipped sidebar
 * carries neither (see `test/web/blocks.contract.mjs`, where both blocks are
 * `prototype-only`).
 */
import { computed, ref } from "vue";

import { board, selectProject, waitingCount } from "../../stores/board.js";
import { view, setView } from "../../stores/ui.js";
import { initialsOf } from "../../lib/monogram.js";

import SidebarFooter from "./SidebarFooter.vue";

// B03 · the nav items. M1 appends `waiting` after `board | list | activity` —
// the deliberately-approved extension of the frozen `3` (design §10-C6), which
// is why B03's `count [data-nav-item]` and `DOMAINS.NAV` move with it.
const nav = ["board", "list", "activity", "waiting"];

// The rail glyph of each view, matching the prototype's B03 nav icons: board =
// three bars, list = three rules, activity = a clock, waiting = a speech mark
// (the question this view answers).
const navIcons = {
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M4 6h16M4 12h16M4 18h16",
  activity: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  waiting: "M5 5h14v10H9l-4 4V5Z",
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

// The nav items that are real *views*. `activity` remains a destination this
// build does not render (unchanged); `waiting` is a real writer — pressing it
// switches the main area to the 「等你回复」view, which is what makes the item a
// view rather than a decoration.
const ROUTABLE = ["board", "list", "waiting"];
function onNav(item) {
  if (ROUTABLE.includes(item)) setView(item);
}
</script>

<template>
  <aside class="td-sidebar" data-sidebar>
    <nav data-nav :aria-label="$t('nav.label')">
      <button
        v-for="item in nav"
        :key="item"
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-inherit hover:bg-(--brand-hover) aria-[current=page]:bg-(--brand-active) aria-[current=page]:font-medium"
        :data-nav-item="item"
        :aria-current="view === item ? 'page' : undefined"
        @click="onNav(item)"
      >
        <svg class="size-4" data-side-icon viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path :d="navIcons[item]" />
        </svg>
        <span data-side-text :data-i18n="`nav.${item}`">{{ $t(`nav.${item}`) }}</span>
        <!-- M1 · the count. `aria-live="polite"` so the number announcing itself
             does not steal focus; at zero the pill is hidden but the nav item
             stays clickable — a hidden zero and a disabled item are different
             promises, and only the first is wanted (design §3.3). -->
        <span
          v-if="item === 'waiting'"
          class="badge badge-sm td-mono bg-primary text-primary-content"
          data-nav-count="waiting"
          data-side-count
          aria-live="polite"
          :hidden="waitingCount === 0"
          :title="$t('waiting.count', waitingCount)"
        >{{ waitingCount }}</span>
      </button>
    </nav>

    <section>
      <h2 class="m-0 mb-2 text-[11px] uppercase tracking-[0.06em] text-(--brand-text-3)" data-side-label data-i18n="sidebar.projects">{{ $t("sidebar.projects") }}</h2>
      <div data-project-list>
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-inherit hover:bg-(--brand-hover) aria-[current=page]:bg-(--brand-active) aria-[current=page]:font-medium"
          :data-project="project.name"
          :data-project-count="project.count ?? ''"
          :data-order-rank="project.rank"
          :data-order-score="project.score"
          :aria-current="project.id === board.currentProjectId ? 'page' : undefined"
          @click="selectProject(project.id)"
        >
          <!-- The prefix monogram is the rail's stand-in for the name, so it is
               desktop-hidden and rail-visible — one element, two faces
               (BLOCKS.md B03: "prefix monogram, rail only"). -->
          <span class="td-mono" data-side-icon aria-hidden="true">{{ project.initials }}</span>
          <span class="td-mono flex-1 overflow-hidden text-ellipsis whitespace-nowrap" data-side-name>{{ project.name }}</span>
          <span v-if="project.count !== null" class="badge badge-sm td-mono" data-side-count>{{ project.count }}</span>
        </button>
      </div>
    </section>

    <section>
      <h2 class="m-0 mb-2 text-[11px] uppercase tracking-[0.06em] text-(--brand-text-3)" data-side-label data-i18n="sidebar.agents">{{ $t("sidebar.agents") }}</h2>
      <div data-agents-presence>
        <div v-for="agent in agents" :key="agent.platform" class="flex items-center gap-2 py-0.5">
          <span class="badge badge-xs td-mono normal-case" :data-agent-platform="agent.platform">{{ agent.platform }}</span>
          <span class="td-mono flex-1 overflow-hidden text-ellipsis whitespace-nowrap" data-side-name>{{ agent.handles.join(", ") }}</span>
          <span
            class="size-2 rounded-[999px] bg-(--brand-text-4) ms-auto data-[presence=running]:bg-success data-[presence=idle]:bg-(--brand-text-4)"
            :data-presence="agent.presence"
            role="img"
            :aria-label="$t(`presence.${agent.presence}`)"
            :title="$t(`presence.${agent.presence}`)"
          ></span>
        </div>
      </div>
    </section>

    <SidebarFooter />
  </aside>
</template>
