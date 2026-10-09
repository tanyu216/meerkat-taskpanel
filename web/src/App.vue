<script setup>
/**
 * B01 · App shell — the mount root.
 *
 * Only the shell chrome this stage owns: the top bar (B02) and the sidebar
 * (B03). The board body lands in S3; `<main>` is an explicit placeholder here
 * so nothing pretends to be implemented that is not.
 */
import Sidebar from "./components/shell/Sidebar.vue";
import TopBar from "./components/shell/TopBar.vue";
</script>

<template>
  <div class="td-shell" data-app-shell>
    <TopBar />
    <Sidebar />
    <main class="td-main" data-main>
      <p class="td-placeholder">Board not wired up yet (M6b stage S1 — shell only).</p>
    </main>
  </div>
</template>
