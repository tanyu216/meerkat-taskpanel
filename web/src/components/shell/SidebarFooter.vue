<script setup>
/**
 * B03 · Sidebar footer — three equal cells: theme (cycle), language (menu),
 * settings (opens B19). The theme cell is a three-state *cycle*, not a toggle,
 * so it carries no `aria-pressed`; the mode in force rides on `data-theme-mode`
 * and is mirrored onto `<html>` by `applyTheme` — the one writer.
 *
 * Language switching and the access panel land in later stages; the language
 * menu ships its two options now so B03's `[data-lang-option]` count (2) holds.
 */
import { ref } from "vue";

import { applyTheme, nextTheme, readTheme } from "../../stores/prefs.js";

const themeMode = ref(readTheme());
const lang = ref("en");

function cycleTheme() {
  themeMode.value = applyTheme(nextTheme(themeMode.value));
}
</script>

<template>
  <div class="td-access-status grid grid-cols-3" data-access-status>
    <button
      type="button"
      class="td-access-cell"
      data-theme-switch
      :data-theme-mode="themeMode"
      :aria-label="`Theme: ${themeMode}. Activate for ${nextTheme(themeMode)}.`"
      :title="`Theme: ${themeMode}. Activate for ${nextTheme(themeMode)}.`"
      @click="cycleTheme"
    >
      <span data-theme-icon="light" :hidden="themeMode !== 'light'" aria-hidden="true">☀</span>
      <span data-theme-icon="dark" :hidden="themeMode !== 'dark'" aria-hidden="true">☾</span>
      <span data-theme-icon="auto" :hidden="themeMode !== 'auto'" aria-hidden="true">▭</span>
      <span class="td-side-text" data-theme-label>{{ themeMode }}</span>
    </button>

    <details class="dropdown" data-lang-menu>
      <summary class="td-access-cell" data-lang-select aria-haspopup="menu">
        <span class="td-side-text" data-lang-label>{{ lang.toUpperCase() }}</span>
      </summary>
      <ul class="dropdown-content menu">
        <li><button type="button" data-lang-option="en" :aria-current="lang === 'en'" @click="lang = 'en'">English</button></li>
        <li><button type="button" data-lang-option="zh" :aria-current="lang === 'zh'" @click="lang = 'zh'">中文</button></li>
      </ul>
    </details>

    <button
      type="button"
      class="td-access-cell"
      data-access-open
      aria-haspopup="dialog"
      aria-label="Access and token settings"
      title="Access and token settings"
    >
      Settings
    </button>
  </div>
</template>
