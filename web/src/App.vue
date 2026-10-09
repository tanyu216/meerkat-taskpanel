<script setup>
/**
 * B01 · App shell.
 *
 * The two-area grid (`.td-shell`: topbar across, sidebar beside main), plus the
 * one instance of each overlay the board owns: the detail drawer (B09), the two
 * create dialogs (B10/B11), the states gallery (B18), the access panel (B19) and
 * the toast region (B14). It wires the board store up on mount and owns the
 * document-level Escape, which closes whichever overlay is on top.
 */
import { onMounted, onUnmounted } from "vue";

import { initBoard, reloadConflict, board, closeDetail, resync } from "./stores/board.js";
import { accessOpen, closeMoveMenu, createProjectOpen, createTaskOpen, moveMenu, statesOpen, view } from "./stores/ui.js";

import FiltersBar from "./components/board/FiltersBar.vue";
import Board from "./components/board/Board.vue";
import ListView from "./components/board/ListView.vue";
import Sidebar from "./components/shell/Sidebar.vue";
import TopBar from "./components/shell/TopBar.vue";
import ToastRegion from "./components/shell/ToastRegion.vue";
import DetailDrawer from "./components/detail/DetailDrawer.vue";
import CreateTaskModal from "./components/create/CreateTaskModal.vue";
import CreateProjectModal from "./components/create/CreateProjectModal.vue";
import StatesShowcase from "./components/review/StatesShowcase.vue";
import AccessPanel from "./components/review/AccessPanel.vue";

function onKeydown(event) {
  if (event.key !== "Escape") return;
  if (moveMenu.value) return closeMoveMenu();
  if (createTaskOpen.value) return (createTaskOpen.value = false);
  if (createProjectOpen.value) return (createProjectOpen.value = false);
  if (statesOpen.value) return (statesOpen.value = false);
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

      <!-- A load failure. Deliberately *not* `[data-error-state]`: the contract
           allows exactly one of those in the document and it lives in B18. -->
      <div v-if="board.error" class="td-error" role="alert">
        <span class="td-empty-title">{{ $t("error.title") }}</span>
        <span class="td-empty-hint">{{ $t("error.hint") }}</span>
        <button type="button" class="btn btn-outline btn-sm" @click="initBoard">{{ $t("error.retry") }}</button>
      </div>

      <!-- Visible conflict prompt (F4): the change was reverted, not applied. -->
      <div v-if="board.conflict" class="td-conflict" role="alert">
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

      <div class="td-filters" style="border-bottom: 0">
        <button type="button" class="btn btn-ghost btn-xs" :title="$t('connection.resyncTitle')" @click="resync">
          {{ $t("connection.resync") }}
        </button>
      </div>
    </main>

    <DetailDrawer />
    <CreateTaskModal />
    <CreateProjectModal />
    <StatesShowcase />
    <AccessPanel />
    <ToastRegion />
  </div>
</template>
