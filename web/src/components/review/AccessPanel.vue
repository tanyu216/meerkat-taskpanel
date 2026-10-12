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

import { resync } from "../../stores/board.js";
import { accessOpen, pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

// Stand-in ranges and a stand-in token; nothing leaves the page. The three
// ranges are the prototype's own seed values (`design/BLOCKS.md` B19) — the
// third one is a documentation range, which is why it says `203.0.113.0/24`
// rather than a real loopback address.
const ranges = ref(["192.168.0.0/16", "10.0.0.0/8", "203.0.113.0/24"]);

function makeToken() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let body = "";
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(24));
  for (let i = 0; i < 24; i++) body += alphabet[(bytes ? bytes[i] : i * 7) % alphabet.length];
  return `td_${body}`;
}

const token = ref(makeToken());
const revealed = ref(false);
// The mask is `td_` + twelve dots — the prototype's own mask, and deliberately
// **not** derived from the credential's length: the stand-in's length is an
// implementation detail, the masked face is design (`design/DESIGN.md` §12).
const masked = computed(() => `td_${"•".repeat(12)}`);

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
  <div class="fixed inset-0 z-[80] bg-neutral/40" data-access-overlay data-state="closed" :hidden="!accessOpen" @click="accessOpen = false"></div>

  <!-- The prototype's centred modal, not a right-hand drawer (ruling F1): the
       geometry is in `.td-access-panel` so the panel and the width it is capped
       at are stated together. Named by `aria-labelledby`, so the heading is the
       dialog's name rather than a string repeated on the section. -->
  <section
    class="td-access-panel z-[85]"
    data-access-panel
    :data-state="accessOpen ? 'open' : 'closed'"
    :hidden="!accessOpen"
    role="dialog"
    aria-modal="true"
    aria-labelledby="td-access-title"
  >
    <header class="td-access-head">
      <h2 class="m-0 text-[18px] font-semibold" id="td-access-title" data-i18n="access.title">{{ $t("access.title") }}</h2>
      <button type="button" class="ms-auto border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-access-close :aria-label="$t('access.close')" @click="accessOpen = false">✕</button>
    </header>

    <div class="td-access-body">
      <p class="text-[12px] text-(--brand-text-3)" data-i18n="access.model.bind">{{ $t("access.model.bind") }}</p>
      <p class="text-[12px] text-(--brand-text-3)" data-i18n="access.model.token">{{ $t("access.model.token") }}</p>

      <section class="mb-4" data-cidr-whitelist data-cidr-enabled="true">
        <label class="flex items-center gap-2">
          <input type="checkbox" class="toggle toggle-sm" data-cidr-switch checked disabled />
          <span data-i18n="access.cidr.enabled">{{ $t("access.cidr.enabled") }}</span>
        </label>
        <p class="text-[12px] text-(--brand-text-3)" data-i18n="access.cidr.note">{{ $t("access.cidr.note") }}</p>
        <ul class="td-cidr-list" data-cidr-list>
          <li v-for="range in ranges" :key="range" class="td-cidr-row" data-cidr-row>
            <input class="input input-sm td-input td-mono w-full" type="text" :value="range" readonly disabled data-cidr-value :aria-label="$t('access.cidr.value')" />
          </li>
        </ul>
      </section>

      <section class="mb-4" :data-token-revealed="revealed ? 'true' : 'false'" data-token-block>
        <h3 data-i18n="access.token.title">{{ $t("access.token.title") }}</h3>
        <div class="flex items-center gap-2">
          <code class="td-mono" data-token-value>{{ revealed ? token : masked }}</code>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-token-reveal
            :aria-pressed="revealed ? 'true' : 'false'"
            :aria-label="revealed ? $t('access.token.hide') : $t('access.token.reveal')"
            @click="revealed = !revealed"
          >
            <!-- Two glyphs, one visible: the swap is the same presence-based
                 `hidden` the sidebar's theme cell uses, so the state cannot be
                 mistaken for a stale icon (R6 ③; the emoji pair it replaces was
                 the implementation's own invention). -->
            <svg class="td-icon size-3.5" data-token-icon="hidden" v-bind="revealed ? { hidden: true } : {}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
            </svg>
            <svg class="td-icon size-3.5" data-token-icon="shown" v-bind="revealed ? {} : { hidden: true }" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 4l16 16M9.5 9.7A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2" />
              <path d="M6.2 6.4C3.9 8 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.7 0 3.1-.5 4.3-1.2M10 5.7A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2" />
            </svg>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-token-copy :data-i18n="'access.token.copy'" @click="copy">{{ $t("access.token.copy") }}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-token-reset :data-i18n="'access.token.reset'" @click="reset">{{ $t("access.token.reset") }}</button>
        </div>
        <p class="text-[12px] text-(--brand-text-3)" data-i18n="access.token.generated">{{ $t("access.token.generated") }}</p>
        <p class="text-[12px] text-(--brand-text-3)" data-i18n="access.token.private">{{ $t("access.token.private") }}</p>
      </section>

      <!-- The transport's manual resync (`?after=` replay). It is an M6b addition
           with no prototype counterpart, so it is a written deviation — and it
           lives here rather than as a standing control on the board, which is
           where a connection affordance belongs (surface-disposition.md #3). -->
      <section class="mb-4" data-connection-block>
        <h3 data-i18n="connection.title">{{ $t("connection.title") }}</h3>
        <p class="text-[12px] text-(--brand-text-3)" data-i18n="connection.hint">{{ $t("connection.hint") }}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-resync :title="$t('connection.resyncTitle')" @click="resync">
          {{ $t("connection.resync") }}
        </button>
      </section>
    </div>
  </section>
</template>
