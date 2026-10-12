<script setup>
/**
 * B03 · Sidebar footer — three equal cells: theme cycle, language menu, access.
 *
 * The theme cell is a **three-state cycle**, not a toggle, so it carries no
 * `aria-pressed`; the mode in force rides on `data-theme-mode` (mirrored onto
 * `<html>` by the one writer, `applyTheme`) and on the cell's own
 * `data-theme-mode`. Its three glyphs are inline SVGs (`data-theme-icon`), not
 * text characters, so the sun/moon/display family reads as one stroke set.
 *
 * The language cell is a **trigger plus a floating menu**, not a `<details>`:
 * the trigger states the language in force (globe + label + `.td-caret`) and the
 * menu holds one option per language. The menu is teleported to the end of the
 * document rather than left inside the sidebar, because the sidebar is a scroll
 * container and would clip it — the same reason the card's "Move to" menu
 * floats. Options stay in the DOM while the menu is closed (`hidden`, not
 * `v-if`), so a programmatic click reaches them exactly as it did inside the
 * `<details>` that used to wrap them.
 *
 * The settings cell is **icon only**: its accessible name says what it opens and
 * no visible text sits beside the gear (BLOCKS.md B03, verbatim).
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { applyLang, lang, nextLang, t } from "../../i18n/index.js";
import { applyTheme, nextTheme, readTheme } from "../../stores/prefs.js";
import { accessOpen, pushToast } from "../../stores/ui.js";

const themeMode = ref(readTheme());
const modes = ["light", "dark", "auto"];
const langs = ["en", "zh"];

/** "Theme: <current>. Activate for <next>." — `access.theme.aria` with two args. */
const themeAria = computed(() => t("access.theme.aria", t(`access.theme.${themeMode.value}`), t(`access.theme.${nextTheme(themeMode.value)}`)));

const themeToast = { light: "toast.themeLight", dark: "toast.themeDark", auto: "toast.themeAuto" };

function cycleTheme() {
  themeMode.value = applyTheme(nextTheme(themeMode.value));
  pushToast(t(themeToast[themeMode.value]), "info");
}

/* --------------------------------------------------------- language menu -- */

const langOpen = ref(false);
const langTrigger = ref(null);
const langMenu = ref(null);
const menuStyle = ref({});

/**
 * Anchor the floating menu to the trigger, **above** it: the cell is the bottom
 * row of the sidebar, so opening downwards would leave the viewport. Reading the
 * distance from the viewport's bottom edge avoids measuring the menu's own
 * height, which is only known after it renders.
 */
function positionMenu() {
  const rect = langTrigger.value?.getBoundingClientRect();
  if (!rect) return;
  const width = langMenu.value?.offsetWidth || 148;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  menuStyle.value = { position: "fixed", left: `${left}px`, bottom: `${Math.max(8, window.innerHeight - rect.top + 6)}px` };
}

function toggleLang() {
  langOpen.value = !langOpen.value;
  if (langOpen.value) positionMenu();
}
function closeLang() {
  langOpen.value = false;
}

function chooseLang(value) {
  closeLang();
  if (value === lang.value) return;
  applyLang(value);
  pushToast(t(value === "zh" ? "toast.langZh" : "toast.langEn"), "info");
}

/** Close on a click outside — `pointerdown`, so the click that opens it cannot close it. */
function onPointerDown(event) {
  if (!langOpen.value) return;
  const target = event.target;
  if (langMenu.value?.contains(target) || langTrigger.value?.contains(target)) return;
  closeLang();
}
/** Escape closes the menu before it reaches the shell's overlay handler. */
function onKeydown(event) {
  if (event.key === "Escape" && langOpen.value) closeLang();
}
/** The menu is anchored to a box that has moved, so it closes rather than follows. */
function onViewportChange() {
  if (langOpen.value) closeLang();
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onViewportChange);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onViewportChange);
});
</script>

<template>
  <div class="grid grid-cols-3 mt-auto border-t border-t-(--brand-border)" data-access-status>
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 px-1 py-2 border-0 bg-transparent text-inherit cursor-pointer text-[11px] focus-visible:outline-2 focus-visible:outline-(--brand-focus-ring) focus-visible:-outline-offset-2"
      data-theme-switch
      :data-theme-mode="themeMode"
      :aria-label="themeAria"
      :title="themeAria"
      @click="cycleTheme"
    >
      <svg
        v-for="mode in modes"
        :key="mode"
        class="td-icon size-3.5"
        :data-theme-icon="mode"
        :hidden="themeMode !== mode"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path v-if="mode === 'light'" d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        <path v-else-if="mode === 'dark'" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        <!-- Auto reads as "the system decides": a display, the same stroke family as the sun and the moon. -->
        <template v-else>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </template>
      </svg>
      <span data-side-text data-theme-label>{{ $t(`access.theme.${themeMode}`) }}</span>
    </button>

    <button
      type="button"
      class="flex flex-col items-center gap-0.5 px-1 py-2 border-0 border-s border-s-(--brand-border) bg-transparent text-inherit cursor-pointer text-[11px] focus-visible:outline-2 focus-visible:outline-(--brand-focus-ring) focus-visible:-outline-offset-2"
      data-lang-select
      ref="langTrigger"
      aria-haspopup="menu"
      :aria-expanded="langOpen ? 'true' : 'false'"
      :aria-label="$t('access.lang.open')"
      :title="$t('access.lang.open')"
      @click="toggleLang"
    >
      <svg class="td-icon size-3.5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
      </svg>
      <span data-side-text data-lang-label>{{ $t(`access.lang.short.${lang}`) }}</span>
      <svg class="td-icon size-3.5 shrink-0 text-(--brand-text-3)" data-caret viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 9.5 12 15.5 18 9.5" />
      </svg>
    </button>

    <button
      type="button"
      class="flex flex-col items-center gap-0.5 px-1 py-2 border-0 border-s border-s-(--brand-border) bg-transparent text-inherit cursor-pointer text-[11px] focus-visible:outline-2 focus-visible:outline-(--brand-focus-ring) focus-visible:-outline-offset-2"
      data-access-open
      aria-haspopup="dialog"
      :aria-label="$t('access.open')"
      :title="$t('access.open')"
      @click="accessOpen = true"
    >
      <svg class="td-icon size-3.5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
      </svg>
    </button>
  </div>

  <!-- The floating language menu: at the end of the document, outside the
       sidebar's scroll container, and never wrapping its own trigger. It is a
       **menu**, so it carries a daisyUI `ul.menu` list with one `li` per option
       — the same shell the other three floating menus use, and the one the
       prototype spells out (`index.html:3305-3321`, DESIGN.md §"The language
       menu is a menu"). The `li` hosts the button the list rows are struck
       from; without it the options hang directly off the container. -->
  <Teleport to="body">
    <div
      ref="langMenu"
      class="dropdown absolute z-[60] border border-(--brand-border) rounded-lg bg-(--brand-surface) [box-shadow:var(--shadow-pop)]"
      data-lang-menu
      :style="menuStyle"
      :hidden="!langOpen"
    >
      <ul class="menu min-w-[148px] p-1" :aria-label="$t('access.lang.group')">
        <li v-for="option in langs" :key="option">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 border-0 rounded-[6px] bg-transparent px-2 py-1 text-left hover:bg-(--brand-hover)"
            :class="lang === option ? 'text-primary font-medium' : 'text-(--brand-text)'"
            :data-lang-option="option"
            :lang="option === 'zh' ? 'zh-CN' : 'en'"
            :aria-pressed="lang === option ? 'true' : 'false'"
            @click="chooseLang(option)"
          >
            <span class="flex-1 text-[13px]">{{ $t(`access.lang.${option}`) }}</span>
            <svg
              class="td-icon size-3.5"
              :class="lang === option ? 'visible' : 'invisible'"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5 13l4.5 4.5L19 7" />
            </svg>
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
