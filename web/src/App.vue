<script setup>
/**
 * B01 · App shell.
 *
 * The two-area grid (`.td-shell`: topbar across, sidebar beside main), plus the
 * one instance of each overlay the board owns: the detail drawer (B09), the two
 * create dialogs (B10/B11), the access panel (B19) and the toast region (B14).
 * It wires the board store up on mount and owns the two document-level rules:
 * the Escape that closes whichever overlay is on top, and R9's **light dismiss**
 * for floating controls.
 */
import { onMounted, onUnmounted } from "vue";

import { initBoard, reloadConflict, board, closeDetail } from "./stores/board.js";
import { accessOpen, closeMoveMenu, createProjectOpen, createTaskOpen, moveMenu, view } from "./stores/ui.js";

import FiltersBar from "./components/board/FiltersBar.vue";
import Board from "./components/board/Board.vue";
import ListView from "./components/board/ListView.vue";
import WaitingView from "./components/board/WaitingView.vue";
import Sidebar from "./components/shell/Sidebar.vue";
import TopBar from "./components/shell/TopBar.vue";
import ToastRegion from "./components/shell/ToastRegion.vue";
import DetailDrawer from "./components/detail/DetailDrawer.vue";
import CreateTaskModal from "./components/create/CreateTaskModal.vue";
import CreateProjectModal from "./components/create/CreateProjectModal.vue";
import AccessPanel from "./components/review/AccessPanel.vue";

/**
 * R9 ①/② — **one** light-dismiss rule for every floating control.
 *
 * Membership is the `data-dismiss-on-outside` **attribute** and nothing else: no
 * class name, no selector list, no per-control handler. The project switcher and
 * the label filter are today's two members (both `<details class="dropdown">`);
 * a third one joins the rule by carrying the attribute, with no code change here
 * (`design/fidelity-r9.md` §8 R1/R2).
 *
 * Two behaviours, both from the contract's §2.1:
 *
 *   * a click that lands **outside** every member closes all open members — the
 *     finding Terry filed: the switcher's floating panel used to stay up and
 *     swallow the next click;
 *   * a click on a **closed** member's own `<summary>` closes the *other*
 *     members first, so only one is ever open. The guard matters: at dispatch
 *     time the `<details>` has not toggled yet, so an already-open member is on
 *     its way *closed* and must be left alone (`.removeAttr("open")` on it would
 *     be a no-op, but treating it as the newcomer would take its siblings down
 *     for nothing).
 */
function closeMembers(keep) {
  for (const el of document.querySelectorAll("[data-dismiss-on-outside][open]")) {
    if (el !== keep) el.removeAttribute("open");
  }
}

function onDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const member = target?.closest("[data-dismiss-on-outside]") ?? null;
  if (!member) return closeMembers(null);
  const summary = target.closest("summary");
  if (summary && summary.parentElement === member && !member.hasAttribute("open")) closeMembers(member);
}

function onKeydown(event) {
  if (event.key !== "Escape") return;
  // The floating controls are the lightest layer, so Escape takes them down
  // alongside whichever overlay is on top — as the prototype's own Escape branch
  // does (`design/prototype/app.js`, the Escape arm: it clears every member and
  // then closes the detail/states/access surfaces).
  closeMembers(null);
  if (moveMenu.value) return closeMoveMenu();
  if (createTaskOpen.value) return (createTaskOpen.value = false);
  if (createProjectOpen.value) return (createProjectOpen.value = false);
  if (accessOpen.value) return (accessOpen.value = false);
  if (board.drawerState === "open") return closeDetail();
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onDocumentClick);
  initBoard();
});
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("click", onDocumentClick);
});
</script>

<template>
  <div class="td-shell" data-app-shell>
    <TopBar />
    <Sidebar />

    <main class="[grid-area:main] min-w-0 overflow-auto">
      <FiltersBar />

      <!-- B17 · the document's single error state — a load failure. The contract
           allows exactly one `[data-error-state]` in the document; it used to be
           demonstrated inside B18 (the states gallery), which was a design
           demonstration and is gone, so the invariant now rides on the real
           surface. Rendered `hidden` at rest, exactly as the prototype states
           the state, so the one element is always the one element. -->
      <div
        class="flex flex-col items-start gap-2 p-4 m-4 rounded-lg bg-error/12"
        data-error-state
        role="alert"
        :hidden="!board.error"
      >
        <span class="font-medium text-(--brand-text-2)" data-i18n="error.title">{{ $t("error.title") }}</span>
        <span class="text-[12px]" data-i18n="error.hint">{{ $t("error.hint") }}</span>
        <button type="button" class="btn btn-outline btn-sm" data-error-retry data-i18n="error.retry" @click="initBoard">{{ $t("error.retry") }}</button>
      </div>

      <!-- Visible conflict prompt (F4): the change was reverted, not applied.
           There is no prototype counterpart — the prototype has no concurrent
           writers — so it is a written deviation (surface-disposition.md #2),
           and `data-conflict` is the semantic hook that makes it machine-visible
           rather than a class name only. -->
      <div
        v-if="board.conflict"
        class="flex flex-col gap-2 px-4 py-3 m-3 border border-error rounded-lg bg-error/10"
        data-conflict
        role="alert"
        :data-conflict-identifier="board.conflict.identifier"
      >
        <strong>{{ $t("conflict.title") }}</strong>
        <span class="text-[12px]">{{ $t("conflict.hint") }}</span>
        <span class="td-mono text-(--brand-text-3)">{{ board.conflict.identifier }}</span>
        <div class="flex gap-2">
          <button type="button" class="btn btn-primary btn-sm" @click="reloadConflict">{{ $t("conflict.reload") }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="board.conflict = null">{{ $t("conflict.dismiss") }}</button>
        </div>
      </div>

      <Board v-show="view === 'board'" />
      <ListView v-show="view === 'list'" />
      <!-- M1 · the 「等你回复」view. A nav destination, not a third value of the
           top bar's `board | list` toggle (that domain is frozen). -->
      <WaitingView v-show="view === 'waiting'" />

      <!-- The manual `?after=` resync used to sit here as a lone button in a
           second `.td-filters` strip. The prototype has no such row, and the
           control belongs to the transport, not to the board: it now lives in
           the access panel (B19), beside the other connection settings. The
           function is unchanged — it is only off the main path. -->
    </main>

    <DetailDrawer />
    <CreateTaskModal />
    <CreateProjectModal />
    <AccessPanel />
    <ToastRegion />
  </div>
</template>
