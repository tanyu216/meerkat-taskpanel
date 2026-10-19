<script setup>
/**
 * B19 · Access & token settings.
 *
 * The panel's **layout and styling are the prototype's own** (`index.html`
 * B19 + `src/input.css` `.td-access-*` / `.td-cidr-*` / `.td-token-*` /
 * `.td-switch`): the body order is bind lead → allow-list → token lead →
 * token box, and every face below is transcribed rather than approximated
 * with utilities.
 *
 * Unlike the prototype's DOM-only demo, this panel **persists**:
 *
 *   * the token is the installed credential (`GET /api/v1/access`), so a
 *     refresh shows the same one; Copy copies it, and Reset clears the field
 *     and leaves a placeholder saying the credential is minted on save;
 *   * the allow-list switch and rows are a draft, and the one **Save** button
 *     writes the switch, every range and a pending token rotation together
 *     (`PUT /api/v1/access` → `<dataDir>/taskd.env` + the token file), then
 *     closes the dialog;
 *   * add/remove are real controls over that draft.
 *
 * Both access verbs are loopback-only, so a remote browser never sees the
 * token. When the process environment owns the policy (`TASKD_ALLOW_CIDRS`),
 * the response says `source: "env"`; the panel then states that and disables
 * editing, because a save would be undone by the next process start.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { errorTextKey } from "../../i18n/messages.mjs";
import { accessOpen, pushToast } from "../../stores/ui.js";
import { api } from "../../services/api.js";
import { t } from "../../i18n/index.js";

/* --------------------------------------------------------------- the draft */

const loading = ref(false);
const loaded = ref(false);
const loadError = ref(null);
const saving = ref(false);

const token = ref("");
const source = ref("default");
const savedEnabled = ref(false);
const savedCidrs = ref([]);
const draftEnabled = ref(false);
const draftCidrs = ref([]);
const pendingRotate = ref(false);
const revealed = ref(false);

// The mask is `td_` + twelve dots — the prototype's own mask, and deliberately
// **not** derived from the credential's length (`design/DESIGN.md` §12).
const masked = `td_${"•".repeat(12)}`;

const canEdit = computed(() => loaded.value && source.value !== "env" && !saving.value);
const dirty = computed(() => {
  if (pendingRotate.value) return true;
  if (draftEnabled.value !== savedEnabled.value) return true;
  if (draftCidrs.value.length !== savedCidrs.value.length) return true;
  return draftCidrs.value.some((entry, index) => entry.trim() !== savedCidrs.value[index]);
});
const blankRow = computed(() => draftCidrs.value.some((entry) => entry.trim() === ""));
const canSave = computed(() => canEdit.value && dirty.value && !blankRow.value);

const note = computed(() => {
  if (loadError.value !== null) return t(loadError.value);
  if (loading.value) return t("access.loading");
  if (source.value === "env") return t("access.envManaged");
  if (blankRow.value) return t("access.cidr.empty");
  if (draftEnabled.value && draftCidrs.value.length === 0) return t("access.cidr.none");
  return "";
});

async function load() {
  loading.value = true;
  loaded.value = false;
  loadError.value = null;
  try {
    const data = await api.access();
    token.value = data.token;
    source.value = data.source;
    savedEnabled.value = data.allow_list.enabled;
    savedCidrs.value = [...data.allow_list.cidrs];
    draftEnabled.value = data.allow_list.enabled;
    draftCidrs.value = [...data.allow_list.cidrs];
    pendingRotate.value = false;
    revealed.value = false;
    loaded.value = true;
  } catch (err) {
    loadError.value = errorTextKey(err);
    loaded.value = false;
  } finally {
    loading.value = false;
  }
}

function addRange() {
  if (!canEdit.value) return;
  draftCidrs.value = [...draftCidrs.value, ""];
  nextTick(() => {
    const inputs = document.querySelectorAll("[data-access-panel] [data-cidr-value]");
    inputs[inputs.length - 1]?.focus();
  });
}

function removeRange(index) {
  if (!canEdit.value) return;
  draftCidrs.value = draftCidrs.value.filter((_, at) => at !== index);
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const data = await api.saveAccess({
      allow_list: {
        enabled: draftEnabled.value,
        cidrs: draftCidrs.value.map((entry) => entry.trim()),
      },
      rotate_token: pendingRotate.value,
    });
    token.value = data.token;
    source.value = data.source;
    savedEnabled.value = data.allow_list.enabled;
    savedCidrs.value = [...data.allow_list.cidrs];
    draftEnabled.value = data.allow_list.enabled;
    draftCidrs.value = [...data.allow_list.cidrs];
    if (data.rotated) revealed.value = true;
    pendingRotate.value = false;
    pushToast(t("access.saved"), "success");
    // A successful save is the end of the task: close the dialog at once (the
    // opener regains focus in the `accessOpen` watcher).
    accessOpen.value = false;
  } catch (err) {
    pushToast(t(errorTextKey(err)), "danger");
  } finally {
    saving.value = false;
  }
}

async function copy() {
  if (token.value === "") return;
  try {
    await navigator.clipboard.writeText(token.value);
    pushToast(t("toast.tokenCopied"), "success");
  } catch {
    pushToast(t("error.generic"), "danger");
  }
}

function reset() {
  if (!canEdit.value) return;
  // Staged, not performed: the one Save submits the rotation with the policy.
  pendingRotate.value = true;
  revealed.value = false;
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
    void load();
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
    :data-access-loaded="loaded ? 'true' : 'false'"
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

      <section class="td-cidr" data-cidr-whitelist :data-cidr-enabled="draftEnabled ? 'true' : 'false'">
        <!-- daisyUI `toggle` — the allow-list is a switch, so the panel says
             whether the list is in force before it lists anything. -->
        <label class="td-switch">
          <input
            type="checkbox"
            class="toggle toggle-sm td-toggle"
            data-cidr-switch
            :checked="draftEnabled"
            :disabled="!canEdit"
            @change="draftEnabled = $event.target.checked"
          />
          <span class="td-switch-text" data-i18n="access.cidr.enabled">{{ $t("access.cidr.enabled") }}</span>
        </label>
        <div class="td-cidr-head">
          <p class="td-cidr-note" data-i18n="access.cidr.note">{{ $t("access.cidr.note") }}</p>
          <button
            type="button"
            class="td-iconbtn"
            data-cidr-add
            :disabled="!canEdit"
            :aria-label="$t('access.cidr.add')"
            :title="$t('access.cidr.add')"
            @click="addRange"
          >
            <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>

        <ul class="td-cidr-list" data-cidr-list>
          <li v-for="(range, index) in draftCidrs" :key="index" class="td-cidr-row" data-cidr-row>
            <input
              v-model="draftCidrs[index]"
              class="td-input td-mono td-cidr-value"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :readonly="!canEdit"
              :disabled="!canEdit"
              data-cidr-value
              :aria-label="$t('access.cidr.value')"
            />
            <button
              type="button"
              class="td-iconbtn"
              data-cidr-remove
              :disabled="!canEdit"
              :aria-label="$t('access.cidr.remove')"
              :title="$t('access.cidr.remove')"
              @click="removeRange(index)"
            >
              <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </li>
        </ul>
      </section>

      <p class="td-access-lead td-access-rule" data-i18n="access.model.token">{{ $t("access.model.token") }}</p>

      <section class="td-token" :data-token-revealed="revealed ? 'true' : 'false'" data-token-block>
        <h3 class="td-token-title" data-i18n="access.token.title">{{ $t("access.token.title") }}</h3>

        <div class="td-token-row">
          <code class="td-token-value td-mono" data-token-value>
            <span v-if="pendingRotate" class="td-token-placeholder" data-token-placeholder>{{ $t("access.token.placeholder") }}</span>
            <template v-else>{{ revealed && token !== "" ? token : masked }}</template>
          </code>

          <button
            type="button"
            class="td-iconbtn"
            data-token-reveal
            :disabled="pendingRotate"
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
            :disabled="token === '' || pendingRotate"
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
            :disabled="!canEdit"
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

    </div>

    <!-- One Save for every pending edit: the allow-list draft and a staged
         token rotation. The token itself is the persisted credential, so a
         refresh never mints a new one. -->
    <footer class="td-access-foot">
      <p v-if="note !== ''" class="td-access-foot-note" data-access-note>{{ note }}</p>
      <button type="button" class="btn btn-primary btn-sm" data-access-save :disabled="!canSave" @click="save">
        {{ saving ? $t("access.saving") : $t("access.save") }}
      </button>
    </footer>
  </section>
</template>
