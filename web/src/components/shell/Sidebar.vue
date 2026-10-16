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
  isAgentKind,
  platformOf,
  selectProject,
  waitingCount,
  writeAssigneeFilter,
} from "../../stores/board.js";
import { unreadCount as activityUnreadCount } from "../../stores/activity.js";
import { navigate } from "../../stores/route.js";
import { view } from "../../stores/ui.js";

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
    // C-RAIL-1 · the rail chip is the project's **effective prefix**, read off
    // the wire (`projectToWire` → `prefix`), rendered verbatim. It is *not*
    // derived here: the client has no copy of `identifierPrefix` and cannot
    // reproduce the legacy fallback (`identifierPrefix(id)`) that numbers every
    // project created before the prefix slot existed, so a client-side
    // derivation would blank the chip for exactly those projects. One
    // derivation, server-side — the same value the cards are numbered with, so
    // `TD-0001` on the board and `TD` in the rail are one property, not two
    // (C-RAIL-1 §3.1 M1/M2). Consequently nothing in `web/src/**` uppercases or
    // folds this string.
    prefix: project.prefix,
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
    // An **agent** is anyone the board has not recorded as the human, and since
    // 0023 the kind a roster entry shows is aggregated from the references that
    // named them — so the platform is a real one rather than the generic `agent`
    // this used to skip. An entry nothing has ever named has no kind, and cannot
    // be placed on a platform row at all.
    if (!isAgentKind(entry.kind)) continue;
    const platform = platformOf(entry.display_name) ?? "claude";
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
//
// R16 §4.5 — the press goes through `navigate()` rather than writing the view
// directly: the address is what decides the view now, and a press that changed
// the view without moving the address would be exactly the stale address bar the
// round exists to remove.
const ROUTABLE = ["board", "list", "activity", "waiting"];
function onNav(item) {
  if (ROUTABLE.includes(item)) navigate(item);
}

/**
 * R13 修订（seg3 · 决定甲）— a roster name is a **narrowing**, nothing else.
 *
 * Pressing a name does one thing: the name is written into the assignee control,
 * exactly as choosing it in the bar's own menu would (`design/fidelity-r13.md`
 * §10.1 row 1). The view is **not** switched, no status / priority / label /
 * search / project condition is touched, and the press is **idempotent** — the
 * name already in force is written again, so there is no toggle-off (R13 §10.2
 * retires the old four-step route and the toggle branch; §10.3 C1.2/C1.3/C2).
 * The removal path is the control's own `Assignee: All` row
 * (`filters.assignee.all`), which is why this round gives back the
 * `assignee.clear` key rather than adding one.
 *
 * @param {string} name
 */
function onAssignee(name) {
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
        <!-- A11y (T-20261015-055434) · the row's own `title` = the project name.
             The prototype has always carried it (`design/prototype/index.html`,
             `button.td-side-item[data-project]` → `title="Orchestrator"`); M6b
             stage 3 dropped it when the row was re-cut, and with it the only name
             the row has at ≤1023px. The rail hides *every* visible text node of
             the row (`[data-side-name]` and `[data-side-count]` are
             `display:none`), so name-from-contents yields nothing and the
             button's accessible name comes out empty: Playwright's
             `ariaSnapshot()` answers `- button` for all five rows at 980px, and
             `- button "Zulu Legacy Importer 0"` at 1512px. The chip cannot carry
             the name instead — it is `aria-hidden` by the rail's own rule, and
             the `title` it does have is the *prefix* (C-RAIL-2 P5), which
             reaches a pointer and no assistive technology. `title` is the name
             computation's last resort, so it fires exactly where nothing else
             does: at ≥1024px the visible name still wins, and the computed name
             is the same string it was before (`MeerkatTaskPanel 12` either way)
             — the row gains a name in the rail and the desktop board does not
             move. The prototype's own markup, restored; not a supplement. -->
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] border border-transparent bg-transparent px-2 text-left text-[13px] font-medium text-(--brand-text-2) hover:bg-(--brand-hover) hover:text-(--brand-text) aria-[current=page]:bg-(--brand-accent-soft) aria-[current=page]:text-(--brand-accent)"
          :data-project="project.name"
          :data-order-rank="project.rank"
          :data-order-score="project.score"
          :aria-current="project.id === board.currentProjectId ? 'page' : undefined"
          :title="project.name"
          @click="selectProject(project.id)"
        >
          <!-- The prefix monogram is the rail's stand-in for the name, so it is
               desktop-hidden and rail-visible — one element, two faces
               (BLOCKS.md B03: "prefix monogram, rail only"). -->
          <!-- C-RAIL-1 U1a · change note (declarative supplement, prototype
               untouched). The prototype's `[data-create-project-form]` handler
               appends its row with `.td-side-name` + `[data-project-count]` and
               **no** `.td-side-icon` (C-RAIL-1 §2 R6) — a gap in the prototype
               itself, not a second reading of the chip. This template renders
               *every* row of `[data-project-list]`, and `CreateProjectModal`
               re-reads `/projects` before selecting the new id, so a project
               created in the UI wears its chip from its first paint and no
               hand-appended row exists to fall behind. Elon chose (a) — the
               supplement lives in the implementation and `design/prototype/**`
               keeps its static three rows (C-RAIL-1 §7 U1). -->
          <!-- C-RAIL-2 P5 · U2 (approved) — the whole prefix, on the same
               channel `DESIGN.md` §24.3 (R8) already uses for an over-long
               identifier: the visible text may be a fragment, the `title`
               carries the value. Here it is the *only* channel that can: the
               chip is `aria-hidden`, so `title` reaches a pointer, not assistive
               technology, and at ≤1023px the chip is the rail's only drawn
               identity cue. The value itself is untouched — no slice, no `…`
               (P3), which the 24px box makes pointless anyway: it fits three
               characters, so any truncation would render `ORCHESTRA-1`,
               `ORCHESTRA-2` and `ORC` as the same string (C-RAIL-2 §2.6). -->
          <span class="td-mono" data-side-icon aria-hidden="true" :title="project.prefix">{{ project.prefix }}</span>
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
