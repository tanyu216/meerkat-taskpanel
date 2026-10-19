<script setup>
/**
 * B19 · Access & token settings.
 *
 * The panel's **layout and styling are the prototype's own** (`index.html`
 * B19 + `src/input.css` `.td-access-*` / `.td-cidr-*` / `.td-token-*` /
 * `.td-switch`): the body order is bind lead → allow-list → token lead →
 * token box, and every face below is transcribed rather than approximated
 * with utilities. The measured oracle is 16px/600 title, 13px `--brand-text-2`
 * leads, a sunken token box, a bordered allow-list and icon-only
 * `.td-iconbtn` controls.
 *
 * Two written deviations remain, both already ruled:
 *
 *   * The CIDR allow-list is rendered **read-only** (ruling O6): §5.1 defines
 *     no CIDR read/write route and `/meta` exposes only
 *     `capabilities.allow_list` as a boolean, so the add/remove controls are
 *     deliberately absent rather than faked as dead buttons. The switch stays
 *     display-only in the prototype's own sense — it moves, dims the list and
 *     announces the state, and writes nothing.
 *   * The token is a stand-in produced in memory (`td_` + 12 characters): no
 *     storage, no transport, no credential. Reveal toggles the mask; Copy
 *     reports a toast without touching the clipboard; Reset mints a new value
 *     and reveals it, as the prototype does.
 *
 * The transport's manual resync (`?after=` replay) is an M6b addition with no
 * prototype counterpart; it stays a written deviation (`surface-disposition.md`
 * #3) and lives here rather than as a standing board control.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

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
  const length = 12; // the prototype's TOKEN_LENGTH
  let body = "";
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(length));
  for (let i = 0; i < length; i++) body += alphabet[(bytes ? bytes[i] : i * 7) % alphabet.length];
  return `td_${body}`;
}

const token = ref(makeToken());
const revealed = ref(false);
// The mask is `td_` + twelve dots — the prototype's own mask, and deliberately
// **not** derived from the credential's length: the stand-in's length is an
// implementation detail, the masked face is design (`design/DESIGN.md` §12).
const masked = computed(() => `td_${"•".repeat(12)}`);

// Display-only, as in the prototype: the switch moves, the list dims and the
// toast says so. Nothing is written, sent or enforced.
const cidrEnabled = ref(true);

function onCidrChange(event) {
  cidrEnabled.value = event.target.checked;
  pushToast(
    t(cidrEnabled.value ? "access.cidr.enabled" : "access.cidr.disabled"),
    cidrEnabled.value ? "success" : "info",
  );
}

function copy() {
  // Announced, not performed — the prototype never touches the clipboard.
  pushToast(t("toast.tokenCopied"), "success");
}
function reset() {
  token.value = makeToken();
  // The prototype reveals the newly minted value rather than re-masking it.
  revealed.value = true;
  pushToast(t("toast.tokenReset"), "success");
}

/* ------------------------------------------------------------- open/close -- */

// The prototype removes `hidden` a frame before `data-state` flips, so the
// 180ms transition has a start point, and keeps the element mounted until the
// closing transition ends. `rendered` is the `hidden` half of that pair;
// `state` is the `data-state` half.
const rendered = ref(false);
const state = ref("closed");
const closeButton = ref(null);
let closeTimer = null;

function openerElement() {
  return document.querySelector("[data-access-open]");
}

watch(accessOpen, async (open) => {
  clearTimeout(closeTimer);
  if (open) {
    rendered.value = true;
    await nextTick();
    // One frame with the closed face painted, then open — same forced-start
    // the prototype gets from its `.width()` read.
    requestAnimationFrame(() => {
      state.value = "open";
      // Focus only once `visibility` has flipped: the transition starts at
      // this frame's paint, so a second frame is the first one on which the
      // panel is actually focusable.
      requestAnimationFrame(() => closeButton.value?.focus());
    });
  } else {
    state.value = "closed";
    // The prototype lands the caret back on the footer cell that opened it.
    openerElement()?.focus();
    closeTimer = setTimeout(() => {
      rendered.value = false;
    }, 180);
  }
});

onBeforeUnmount(() => clearTimeout(closeTimer));
</script>

<template>
  <div
    class="td-scrim fixed inset-0 z-[80]"
    data-access-overlay
    :data-state="state"
    :hidden="!rendered"
    @click="accessOpen = false"
  ></div>

  <!-- The prototype's centred modal, not a right-hand drawer (ruling F1): the
       geometry is in `.td-access-panel` so the panel and the width it is capped
       at are stated together. Named by `aria-labelledby`, so the heading is the
       dialog's name rather than a string repeated on the section. -->
  <section
    class="td-access-panel z-[85]"
    data-access-panel
    :data-state="state"
    :aria-hidden="state === 'open' ? 'false' : 'true'"
    :hidden="!rendered"
    role="dialog"
    aria-modal="true"
    aria-labelledby="td-access-title"
  >
    <header class="td-access-head">
      <h2 class="m-0 text-[16px] leading-[21.6px] font-semibold" id="td-access-title" data-i18n="access.title">{{ $t("access.title") }}</h2>
      <button
        ref="closeButton"
        type="button"
        class="td-iconbtn ms-auto"
        data-access-close
        :aria-label="$t('access.close')"
        @click="accessOpen = false"
      >
        <svg class="td-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </header>

    <div class="td-access-body">
      <p class="td-access-lead" data-i18n="access.model.bind">{{ $t("access.model.bind") }}</p>

      <section class="td-cidr" data-cidr-whitelist :data-cidr-enabled="cidrEnabled ? 'true' : 'false'">
        <!-- daisyUI `toggle` — the allow-list is a switch, so the panel says
             whether the list is in force before it lists anything. Display
             only: the switch moves and the list dims, nothing else happens. -->
        <label class="td-switch">
          <input
            type="checkbox"
            class="toggle toggle-sm td-toggle"
            data-cidr-switch
            :checked="cidrEnabled"
            @change="onCidrChange"
          />
          <span class="td-switch-text" data-i18n="access.cidr.enabled">{{ $t("access.cidr.enabled") }}</span>
        </label>
        <div class="td-cidr-head">
          <p class="td-cidr-note" data-i18n="access.cidr.note">{{ $t("access.cidr.note") }}</p>
        </div>

        <ul class="td-cidr-list" data-cidr-list>
          <li v-for="range in ranges" :key="range" class="td-cidr-row" data-cidr-row>
            <input
              class="td-input td-mono td-cidr-value"
              type="text"
              :value="range"
              readonly
              disabled
              data-cidr-value
              :aria-label="$t('access.cidr.value')"
            />
          </li>
        </ul>
      </section>

      <p class="td-access-lead td-access-rule" data-i18n="access.model.token">{{ $t("access.model.token") }}</p>

      <section class="td-token" :data-token-revealed="revealed ? 'true' : 'false'" data-token-block>
        <h3 class="td-token-title" data-i18n="access.token.title">{{ $t("access.token.title") }}</h3>

        <div class="td-token-row">
          <code class="td-token-value td-mono" data-token-value>{{ revealed ? token : masked }}</code>

          <button
            type="button"
            class="td-iconbtn"
            data-token-reveal
            :aria-pressed="revealed ? 'true' : 'false'"
            :aria-label="revealed ? $t('access.token.hide') : $t('access.token.reveal')"
            :title="revealed ? $t('access.token.hide') : $t('access.token.reveal')"
            @click="revealed = !revealed"
          >
            <!-- Two glyphs, one visible: the swap is the same presence-based
                 `hidden` the sidebar's theme cell uses, so the state cannot be
                 mistaken for a stale icon (R6 ③; the emoji pair it replaces was
                 the implementation's own invention). -->
            <svg class="td-icon td-icon-sm" data-token-icon="hidden" v-bind="revealed ? { hidden: true } : {}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
            </svg>
            <svg class="td-icon td-icon-sm" data-token-icon="shown" v-bind="revealed ? {} : { hidden: true }" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 4l16 16M9.5 9.7A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2" />
              <path d="M6.2 6.4C3.9 8 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.7 0 3.1-.5 4.3-1.2M10 5.7A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2" />
            </svg>
          </button>

          <button
            type="button"
            class="td-iconbtn"
            data-token-copy
            :aria-label="$t('access.token.copy')"
            :title="$t('access.token.copy')"
            @click="copy"
          >
            <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 9h10v10H9zM5 15V5h10" /></svg>
          </button>

          <button
            type="button"
            class="td-iconbtn"
            data-token-reset
            :aria-label="$t('access.token.reset')"
            :title="$t('access.token.reset')"
            @click="reset"
          >
            <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" /></svg>
          </button>
        </div>

        <p class="td-token-notes">
          <span data-i18n="access.token.generated">{{ $t("access.token.generated") }}</span>
          <span data-i18n="access.token.private">{{ $t("access.token.private") }}</span>
        </p>
      </section>

      <!-- The transport's manual resync (`?after=` replay). It is an M6b addition
           with no prototype counterpart, so it is a written deviation — and it
           lives here rather than as a standing control on the board, which is
           where a connection affordance belongs (surface-disposition.md #3). -->
      <section class="mt-4 mb-4" data-connection-block>
        <h3 data-i18n="connection.title">{{ $t("connection.title") }}</h3>
        <p class="text-[12px] text-(--brand-text-3)" data-i18n="connection.hint">{{ $t("connection.hint") }}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-resync :title="$t('connection.resyncTitle')" @click="resync">
          {{ $t("connection.resync") }}
        </button>
      </section>
    </div>
  </section>
</template>
