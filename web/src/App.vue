<script setup>
/**
 * B01 · App shell.
 *
 * The two-area grid (`.td-shell`: topbar across, sidebar beside main), plus the
 * one instance of each overlay the board owns: the detail drawer (B09), the two
 * create dialogs (B10/B11), the access panel (B19) and the toast region (B14).
 * It wires the board store up on mount and owns the document-level Escape, which
 * closes whichever overlay is on top.
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

function onKeydown(event) {
  if (event.key !== "Escape") return;
  if (moveMenu.value) return closeMoveMenu();
  if (createTaskOpen.value) return (createTaskOpen.value = false);
  if (createProjectOpen.value) return (createProjectOpen.value = false);
  if (accessOpen.value) return (accessOpen.value = false);
  if (board.drawerState === "open") return closeDetail();
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  initBoard();
});
onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="td-shell" data-app-shell>
    <TopBar />
    <Sidebar />

    <main class="td-main">
      <FiltersBar />

      <!-- B17 · the document's single error state — a load failure. The contract
           allows exactly one `[data-error-state]` in the document; it used to be
           demonstrated inside B18 (the states gallery), which was a design
           demonstration and is gone, so the invariant now rides on the real
           surface. Rendered `hidden` at rest, exactly as the prototype states
           the state, so the one element is always the one element. -->
      <div class="td-error" data-error-state role="alert" :hidden="!board.error">
        <span class="td-empty-title" data-i18n="error.title">{{ $t("error.title") }}</span>
        <span class="td-empty-hint" data-i18n="error.hint">{{ $t("error.hint") }}</span>
        <button type="button" class="btn btn-outline btn-sm" data-error-retry data-i18n="error.retry" @click="initBoard">{{ $t("error.retry") }}</button>
      </div>

      <!-- Visible conflict prompt (F4): the change was reverted, not applied.
           There is no prototype counterpart — the prototype has no concurrent
           writers — so it is a written deviation (surface-disposition.md #2),
           and `data-conflict` is the semantic hook that makes it machine-visible
           rather than a class name only. -->
      <div v-if="board.conflict" class="td-conflict" data-conflict role="alert" :data-conflict-identifier="board.conflict.identifier">
        <strong>{{ $t("conflict.title") }}</strong>
        <span class="td-empty-hint">{{ $t("conflict.hint") }}</span>
        <span class="td-mono td-weak">{{ board.conflict.identifier }}</span>
        <div class="td-conflict-actions">
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
