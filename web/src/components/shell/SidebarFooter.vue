<script setup>
/**
 * B03 · Sidebar footer — three equal cells: theme cycle, language menu, access.
 *
 * The theme cell is a **three-state cycle**, not a toggle, so it carries no
 * `aria-pressed`; the mode in force rides on `data-theme-mode` (mirrored onto
 * `<html>` by the one writer, `applyTheme`) and on the cell's own
 * `data-theme-mode`. The language menu is a `<details>` so it degrades without
 * script; its two options are `[data-lang-option]`.
 */
import { computed, ref } from "vue";

import { applyLang, lang, nextLang, t } from "../../i18n/index.js";
import { applyTheme, nextTheme, readTheme } from "../../stores/prefs.js";
import { accessOpen, pushToast } from "../../stores/ui.js";

const themeMode = ref(readTheme());
const icons = { light: "☀", dark: "☾", auto: "◐" };
const modes = ["light", "dark", "auto"];
const langs = ["en", "zh"];

/** "Theme: <current>. Activate for <next>." — `access.theme.aria` with two args. */
const themeAria = computed(() => t("access.theme.aria", t(`access.theme.${themeMode.value}`), t(`access.theme.${nextTheme(themeMode.value)}`)));

const themeToast = { light: "toast.themeLight", dark: "toast.themeDark", auto: "toast.themeAuto" };

function cycleTheme() {
  themeMode.value = applyTheme(nextTheme(themeMode.value));
  pushToast(t(themeToast[themeMode.value]), "info");
}

function chooseLang(value) {
  if (value === lang.value) return;
  applyLang(value);
  pushToast(t(value === "zh" ? "toast.langZh" : "toast.langEn"), "info");
}
</script>

<template>
  <div class="td-access-status" data-access-status>
    <button
      type="button"
      class="td-access-cell"
      data-theme-switch
      :data-theme-mode="themeMode"
      :aria-label="themeAria"
      :title="themeAria"
      @click="cycleTheme"
    >
      <span v-for="mode in modes" :key="mode" :data-theme-icon="mode" :hidden="themeMode !== mode" aria-hidden="true">
        {{ icons[mode] }}
      </span>
      <span class="td-side-text" data-theme-label>{{ $t(`access.theme.${themeMode}`) }}</span>
    </button>

    <details class="td-details" data-lang-menu>
      <summary class="td-access-cell" data-lang-select aria-haspopup="menu" :aria-label="$t('access.lang.open')">
        <span aria-hidden="true">⌘</span>
        <span class="td-side-text" data-lang-label>{{ $t(`access.lang.short.${lang}`) }}</span>
      </summary>
      <ul class="td-details-menu menu">
        <li v-for="option in langs" :key="option">
          <button type="button" :data-lang-option="option" :aria-current="lang === option ? 'true' : 'false'" @click="chooseLang(option)">
            {{ $t(`access.lang.${option}`) }}
          </button>
        </li>
      </ul>
    </details>

    <button
      type="button"
      class="td-access-cell"
      data-access-open
      aria-haspopup="dialog"
      :aria-label="$t('access.open')"
      :title="$t('access.open')"
      @click="accessOpen = true"
    >
      <span aria-hidden="true">⚙</span>
      <span class="td-side-text">{{ $t("access.title") }}</span>
    </button>
  </div>
</template>
