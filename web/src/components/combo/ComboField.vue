<script setup>
/**
 * B22 / B24 / B25 · the one combobox control.
 *
 * One implementation, driven by props: the create dialog's assignee (B22),
 * reporter (B22), parent (B24), depends-on (B24) and labels (B25), plus the
 * drawer's assignee/reporter and `data-detail-label-*` families. The matching
 * algorithm is the pure `lib/combo.js` (prefix → contains → subsequence); this
 * component only renders what it returns and owns the keyboard.
 *
 * There is **no management entry** anywhere: a name the roster does not hold is
 * offered as a `· new` row and joins the roster the moment it is used (C10).
 * Free-text controls (people, labels) offer that row; relation controls
 * (`freeText:false`) never do — a relation can only point at an existing task.
 */
import { computed, nextTick, ref, watch } from "vue";

import { comboOptions, createRoster } from "../../lib/combo.js";
import { t } from "../../i18n/index.js";

const props = defineProps({
  modelValue: { type: [String, Array], default: "" },
  options: { type: Array, default: () => [] },
  hookInput: { type: String, required: true },
  hookMenu: { type: String, required: true },
  hookOption: { type: String, required: true },
  hookValue: { type: String, required: true },
  hookLabel: { type: String, default: "" },
  hookChips: { type: String, default: "" },
  hookChip: { type: String, default: "" },
  hookChipValue: { type: String, default: "" },
  hookChipRemove: { type: String, default: "" },
  kindAttr: { type: String, default: "" },
  platformAttr: { type: String, default: "" },
  taskMode: { type: Boolean, default: false },
  multi: { type: Boolean, default: false },
  freeText: { type: Boolean, default: true },
  /** Inside a modal the last field in a column opens upward (`.td-combo[data-drop="up"]`). */
  dropUp: { type: Boolean, default: false },
  placeholderKey: { type: String, default: "combo.assigneePlaceholder" },
  emptyKey: { type: String, default: "combo.empty" },
  ariaKey: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const query = ref("");
const open = ref(false);
const active = ref(0);
const inputEl = ref(null);

const roster = computed(() => createRoster(props.options));

const chosen = computed(() => (props.multi ? (Array.isArray(props.modelValue) ? props.modelValue : []) : []));

const results = computed(() => comboOptions({ roster: roster.value, query: query.value, freeText: props.freeText, chosen: chosen.value }));

const inputHooks = computed(() => ({ [props.hookInput]: "", ...(props.hookLabel ? { [props.hookLabel]: "" } : {}) }));

function optionHooks(entry, isNew) {
  const hooks = { [props.hookOption]: "", [props.hookValue]: entry.name };
  if (props.kindAttr) hooks[props.kindAttr] = entry.kind ?? "human";
  if (props.platformAttr && entry.platform) hooks[props.platformAttr] = entry.platform;
  if (isNew) hooks["data-combo-new"] = "true";
  return hooks;
}

function accept(entry) {
  if (!entry) return;
  const isNewRow = entry.__new === true;
  const name = isNewRow ? String(query.value).trim() : entry.name;
  if (name === "") return;
  if (props.multi) {
    const current = chosen.value;
    if (!current.some((item) => item.toLowerCase() === name.toLowerCase())) emit("update:modelValue", [...current, name]);
    query.value = "";
  } else {
    emit("update:modelValue", name);
    query.value = "";
    open.value = false;
  }
  active.value = 0;
}

function onInput() {
  open.value = true;
  active.value = 0;
}

function move(delta) {
  const total = results.value.entries.length + (results.value.isNew ? 1 : 0);
  if (total === 0) return;
  active.value = (active.value + delta + total) % total;
}

function onKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!open.value) open.value = true;
    else move(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) open.value = true;
    else move(-1);
    return;
  }
  if (event.key === "Enter") {
    const rows = rowsForEnter.value;
    if (!open.value && props.freeText && !props.multi) return; // let the form submit
    if (open.value) {
      event.preventDefault();
      accept(rows[active.value]);
    } else if (props.multi || !props.freeText) {
      event.preventDefault();
      open.value = true;
    }
    return;
  }
  if (event.key === "Escape") {
    if (open.value) {
      event.stopPropagation(); // the drawer also listens for Escape
      open.value = false;
    }
    return;
  }
  if (event.key === "Tab") open.value = false;
}

/** The rows Enter can accept: the `· new` row (when offered) then the matches. */
const rowsForEnter = computed(() => {
  const rows = [];
  if (results.value.isNew) rows.push({ name: query.value.trim(), __new: true });
  return rows.concat(results.value.entries);
});

function removeChip(name) {
  if (!props.multi) return;
  emit(
    "update:modelValue",
    chosen.value.filter((item) => item !== name),
  );
}

function focus() {
  open.value = true;
  nextTick(() => inputEl.value?.focus());
}

watch(
  () => props.options,
  () => {
    /* the roster grows by use; no reset needed */
  },
);

defineExpose({ focus });
</script>

<template>
  <div class="td-combo" :data-drop="dropUp ? 'up' : 'down'">
    <input
      ref="inputEl"
      v-model="query"
      type="text"
      class="td-combo-input"
      autocomplete="off"
      spellcheck="false"
      v-bind="inputHooks"
      :aria-label="ariaKey ? $t(ariaKey) : undefined"
      :aria-expanded="open ? 'true' : 'false'"
      :placeholder="$t(placeholderKey)"
      @input="onInput"
      @focus="onInput"
      @keydown="onKeydown"
      @blur="open = false"
    />

    <ul v-show="open" v-bind="{ [hookMenu]: '' }" class="td-combo-menu" role="listbox">
      <li v-if="results.isNew">
        <button type="button" v-bind="optionHooks({ name: query.trim() }, true)" :aria-selected="active === 0 ? 'true' : 'false'" @mousedown.prevent="accept({ __new: true })">
          <span class="td-combo-title">{{ query.trim() }}</span>
          <span class="td-combo-new">{{ $t("combo.new") }}</span>
        </button>
      </li>
      <li v-for="(entry, index) in results.entries" :key="entry.name">
        <button
          type="button"
          v-bind="optionHooks(entry, false)"
          :aria-selected="active === (results.isNew ? index + 1 : index) ? 'true' : 'false'"
          :title="entry.title ?? entry.name"
          @mousedown.prevent="accept(entry)"
        >
          <span v-if="taskMode" class="td-mono">{{ entry.identifier ?? entry.name }}</span>
          <span class="td-combo-title">{{ taskMode ? entry.title : entry.name }}</span>
        </button>
      </li>
      <li v-if="!results.isNew && results.entries.length === 0" class="td-combo-empty">{{ $t(emptyKey) }}</li>
    </ul>

    <div v-if="multi && hookChips" v-bind="{ [hookChips]: '' }" class="td-combo-chips">
      <span v-for="name in chosen" :key="name" class="td-chip" v-bind="hookChip ? { [hookChip]: '', ...(hookChipValue ? { [hookChipValue]: name } : {}) } : {}">
        {{ name }}
        <button
          v-if="hookChipRemove"
          type="button"
          class="td-chip-remove"
          v-bind="{ [hookChipRemove]: '' }"
          :aria-label="`Clear ${name}`"
          :title="$t('combo.clear')"
          @click="removeChip(name)"
        >
          ✕
        </button>
      </span>
    </div>
  </div>
</template>
