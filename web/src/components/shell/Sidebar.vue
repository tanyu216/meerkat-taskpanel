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

import {
  assigneeFilterValue,
  board,
  selectProject,
  waitingCount,
  writeAssigneeFilter,
  writeStatusFilter,
} from "../../stores/board.js";
import { unreadCount as activityUnreadCount } from "../../stores/activity.js";
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
    // The badge is the project's **total** task count, served by `/projects`
    // (`task_count`). It is deliberately not derived from `board.tasks` — that
    // array holds only the *current* project's tasks, so reading `.length` here
    // filled one row in three (Terry's fidelity finding, 2026-10-12).
    count: project.task_count ?? null,
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

// The nav items that are real *views*. All four route now: R12x closed the last
// two stand-ins — `activity` opens the project's ledger (B26) and `waiting` the
// 「等你回复」view — so the rule "every nav item routes" holds in one place
// instead of two (DESIGN.md §29.2), and there is no name left that answers with a
// toast.
const ROUTABLE = ["board", "list", "activity", "waiting"];
function onNav(item) {
  if (ROUTABLE.includes(item)) setView(item);
}

/**
 * R11 ② · R13 — a roster name is a route **and** a narrowing.
 *
 * Pressing a name does three things in this order: the view goes to `list`, the
 * status set becomes the two in-flight statuses, and the name is written into the
 * assignee control — the two conditions are ANDed, exactly as any two fields of
 * the bar are (`design/fidelity-r13.md` §2.2). R11 wrote the name into no filter
 * because the control's domain held no given name; R13 extends that domain, so
 * the press narrows as well as routes.
 *
 * A press on the name **already in force** is the capsule's own close, not a
 * re-route: it removes the assignee condition and nothing else — the view and the
 * status set stay, which is what the bar's `x` does too (§2.3).
 *
 * @param {string} name
 */
function onAssignee(name) {
  if (assigneeFilterValue() === name) {
    writeAssigneeFilter("all");
    return;
  }
  setView("list");
  writeStatusFilter(["in_progress", "in_review"]);
  writeAssigneeFilter(name);
}
</script>

<template>
  <aside class="td-sidebar" data-sidebar>
    <nav class="td-nav" data-nav :aria-label="$t('nav.label')">
      <button
        v-for="item in nav"
        :key="item"
        type="button"
        class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] border border-transparent bg-transparent px-2 text-left text-[13px] font-medium text-(--brand-text-2) hover:bg-(--brand-hover) hover:text-(--brand-text) aria-[current=page]:bg-(--brand-accent-soft) aria-[current=page]:text-(--brand-accent)"
        :data-nav-item="item"
        :aria-current="view === item ? 'page' : undefined"
        @click="onNav(item)"
      >
        <!-- R7 ① — the nav glyph wears the brand's stroked face (`td-icon`:
             `fill:none` / `stroke:currentColor` / 1.5px round), not daisyUI's
             box. It carries **no `data-side-icon`**: that hook is the project
             monogram's rail chip (below), and a nav glyph wearing it was hit by
             the rail chip rule — a 24px bordered grey tile where the prototype
             draws a bare 16px glyph. -->
        <svg class="td-icon size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path :d="navIcons[item]" />
        </svg>
        <span data-side-text :data-i18n="`nav.${item}`">{{ $t(`nav.${item}`) }}</span>
        <!-- M1 · the count. `aria-live="polite"` so the number announcing itself
             does not steal focus; at zero the pill is hidden but the nav item
             stays clickable — a hidden zero and a disabled item are different
             promises, and only the first is wanted (design §3.3).

             R12x · B26 — `activity` carries the same pill, over the ledger's own
             unread count, and follows the same zero rule. The two numbers come
             from two different questions (what is new to me vs. what is on my
             side), so the two items keep two pills. -->
        <span
          v-if="item === 'waiting'"
          class="badge badge-sm td-mono bg-primary text-primary-content"
          data-nav-count="waiting"
          data-side-count
          aria-live="polite"
          :hidden="waitingCount === 0"
          :title="$t('waiting.count', waitingCount)"
        >{{ waitingCount }}</span>
        <span
          v-else-if="item === 'activity'"
          class="badge badge-sm td-mono bg-primary text-primary-content"
          data-nav-count="activity"
          data-side-count
          aria-live="polite"
          :hidden="activityUnreadCount === 0"
          :title="$t('activity.navCount', activityUnreadCount)"
        >{{ activityUnreadCount }}</span>
      </button>
    </nav>

    <section>
      <h2 class="m-0 mb-2 text-[11px] uppercase tracking-[0.06em] text-(--brand-text-3)" data-side-label data-i18n="sidebar.projects">{{ $t("sidebar.projects") }}</h2>
      <div class="td-nav" data-project-list>
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] border border-transparent bg-transparent px-2 text-left text-[13px] font-medium text-(--brand-text-2) hover:bg-(--brand-hover) hover:text-(--brand-text) aria-[current=page]:bg-(--brand-accent-soft) aria-[current=page]:text-(--brand-accent)"
          :data-project="project.name"
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
          <!-- R7 ② — the count is the brand's `.td-count` pill and it *is* the
               `data-project-count` element (the prototype puts the hook on the
               number, not on the row). The row keeps `data-side-count`, the
               rail's hide hook, and no longer carries `data-project-count` at
               all — so the hook names the number and only the number. `0`
               renders, an unknown count (`null`) does not. -->
          <span
            v-if="project.count !== null"
            class="badge badge-sm td-count"
            :data-project-count="project.count"
            data-side-count
          >{{ project.count }}</span>
        </button>
      </div>
    </section>

    <section>
      <h2 class="m-0 mb-2 text-[11px] uppercase tracking-[0.06em] text-(--brand-text-3)" data-side-label data-i18n="sidebar.agents">{{ $t("sidebar.agents") }}</h2>
      <div data-agents-presence>
        <div v-for="agent in agents" :key="agent.platform" class="flex items-center gap-2 py-0.5" :data-agent-row="agent.platform">
          <span class="badge badge-xs td-mono normal-case" :data-agent-platform="agent.platform">{{ agent.platform }}</span>
          <!-- R11 ② · R13 — the row's text is the names themselves, each a real
               `<button>` inside its own `[data-assignee-item]` wrapper, with the
               commas left as static text between them: the row still reads as one
               sentence. The wrapper is the capsule's shell (never the button), so
               the name's face stays the text it replaces. The host drops the
               project row's `overflow-hidden`/`text-ellipsis` on purpose — the
               capsule is **width-neutral** (6px padding cancelled by −6px inline
               margin), so its left cap bleeds 6px past the row's edge, and a
               clipped host would shear it off (R13 §8 U-6, corrected here). -->
          <span class="td-mono flex-1 whitespace-nowrap" data-side-name data-agent-text>
            <template v-for="(handle, index) in agent.handles" :key="handle">
              <span v-if="index > 0">, </span>
              <span
                class="td-assignee-item"
                :data-assignee-item="handle"
                :data-assignee-active="assigneeFilterValue() === handle ? 'true' : 'false'"
              >
                <button
                  type="button"
                  class="td-agent-assignee td-mono"
                  :data-agent-assignee="handle"
                  :data-assignee="handle"
                  data-assignee-kind="agent"
                  :aria-pressed="assigneeFilterValue() === handle ? 'true' : 'false'"
                  @click="onAssignee(handle)"
                >{{ handle }}</button>
              </span>
            </template>
          </span>
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
