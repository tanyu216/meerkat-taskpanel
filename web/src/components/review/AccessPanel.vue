<script setup>
/**
 * B19 · Access & token settings.
 *
 * The CIDR allow-list is rendered **read-only** (ruling O6): §5.1 defines no
 * CIDR read/write route and `/meta` exposes only `capabilities.allow_list` as a
 * boolean, so the block states the ranges in force and explains that they are
 * configured elsewhere — the add/remove controls are deliberately absent rather
 * than faked as dead buttons. The switch is display-only, as in the prototype.
 *
 * The token is a stand-in produced in memory (`td_` + a mask): no storage, no
 * transport, no credential. Reveal toggles the mask; Copy reports a toast
 * without touching the clipboard.
 */
import { computed, ref } from "vue";

import { accessOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

// Stand-in ranges and a stand-in token; nothing leaves the page.
const ranges = ref(["192.168.0.0/16", "10.0.0.0/8", "127.0.0.1/32"]);

function makeToken() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let body = "";
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(24));
  for (let i = 0; i < 24; i++) body += alphabet[(bytes ? bytes[i] : i * 7) % alphabet.length];
  return `td_${body}`;
}

const token = ref(makeToken());
const revealed = ref(false);
const masked = computed(() => `${token.value.slice(0, 6)}${"•".repeat(18)}`);

function copy() {
  pushToast(t("toast.tokenCopied"), "info");
}
function reset() {
  token.value = makeToken();
  revealed.value = false;
  pushToast(t("toast.tokenReset"), "info");
}
</script>

<template>
  <div class="td-panel-overlay" data-access-overlay data-state="closed" :hidden="!accessOpen" @click="accessOpen = false"></div>

  <section
    class="td-panel"
    data-access-panel
    :data-state="accessOpen ? 'open' : 'closed'"
    :hidden="!accessOpen"
    role="dialog"
    aria-modal="true"
    :aria-label="$t('access.title')"
  >
    <header class="td-panel-head">
      <h2 data-i18n="access.title">{{ $t("access.title") }}</h2>
      <button type="button" class="td-card-menu" data-access-close :aria-label="$t('access.close')" @click="accessOpen = false">✕</button>
    </header>

    <p class="td-state-note" data-i18n="access.model.bind">{{ $t("access.model.bind") }}</p>
    <p class="td-state-note" data-i18n="access.model.token">{{ $t("access.model.token") }}</p>

    <section class="td-state-block" data-cidr-whitelist data-cidr-enabled="true">
      <label class="td-switch" style="display: flex; align-items: center; gap: 8px">
        <input type="checkbox" class="toggle toggle-sm" data-cidr-switch checked disabled />
        <span data-i18n="access.cidr.enabled">{{ $t("access.cidr.enabled") }}</span>
      </label>
      <p class="td-cidr-note td-state-note" data-i18n="access.cidr.note">{{ $t("access.cidr.note") }}</p>
      <ul class="td-cidr-list" data-cidr-list>
        <li v-for="range in ranges" :key="range" class="td-cidr-row" data-cidr-row>
          <input class="td-input td-mono" type="text" :value="range" readonly disabled data-cidr-value :aria-label="$t('access.cidr.value')" />
        </li>
      </ul>
    </section>

    <section class="td-state-block" :data-token-revealed="revealed ? 'true' : 'false'" data-token-block>
      <h3 data-i18n="access.token.title">{{ $t("access.token.title") }}</h3>
      <div style="display: flex; align-items: center; gap: 8px">
        <code class="td-mono" data-token-value>{{ revealed ? token : masked }}</code>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-token-reveal
          :aria-label="revealed ? $t('access.token.hide') : $t('access.token.reveal')"
          @click="revealed = !revealed"
        >
          <span :data-token-icon="revealed ? 'shown' : 'hidden'">{{ revealed ? "🙈" : "👁" }}</span>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-token-copy :data-i18n="'access.token.copy'" @click="copy">{{ $t("access.token.copy") }}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-token-reset :data-i18n="'access.token.reset'" @click="reset">{{ $t("access.token.reset") }}</button>
      </div>
      <p class="td-state-note" data-i18n="access.token.generated">{{ $t("access.token.generated") }}</p>
      <p class="td-state-note" data-i18n="access.token.private">{{ $t("access.token.private") }}</p>
    </section>
  </section>
</template>
