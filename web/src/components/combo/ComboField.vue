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
import { identifierText } from "../../lib/identifier.js";
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
  /**
   * The clear affordance's own hook (T-20261016-113131 ③.1) — **opt-in**, and
   * the only class in this component that is not shared by all nine instances.
   * The prototype draws `.td-combo-clear` **once** in its whole document (the
   * create dialog's Parent), so the box-plus-✕ row is not a generic part of the
   * control: a control that does not pass this renders exactly the bare box it
   * has always rendered. That keeps the other eight (assignee / reporter /
   * labels / depends-on here, and the drawer's four) out of a change that has
   * no ruling behind it.
   */
  hookClear: { type: String, default: "" },
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
  /**
   * R10 ② — the input **carries** the field's value instead of holding an empty
   * query. The drawer's two single-valued rows are the prototype's
   * `value="linus"` inputs: the text in the box *is* the field, which is what
   * makes "leaves the field with a different value" a question the input can
   * answer on its own. The create dialog's fields are unseeded — they start
   * empty because there is nothing to edit yet.
   */
  seed: { type: Boolean, default: false },
  /**
   * E-2 (T-20261014-212017-3 §4.5) — a terminal card's drawer is read-only, and
   * the relation control's box and its chips' ✕ are on the disabled list. The
   * box still *shows* its values (a read-only control that hid them would say
   * the card has no dependencies); it just cannot be typed into or opened.
   */
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "blur"]);

const query = ref(props.seed ? (props.multi ? "" : String(props.modelValue ?? "")) : "");
const open = ref(false);
const active = ref(0);
const inputEl = ref(null);

const roster = computed(() => createRoster(props.options));

/**
 * The values this control holds, as a list — the roster control's single name
 * or the multi control's set. It is also the chip list, and the two are the
 * same thing on purpose: a chip is the value, not a decoration beside it.
 */
const values = computed(() => {
  if (props.multi) return Array.isArray(props.modelValue) ? props.modelValue : [];
  const value = String(props.modelValue ?? "");
  return value === "" ? [] : [value];
});

/**
 * What the menu must leave out: the values already taken. Only a control that
 * *shows* its values as chips can dedupe by them — for a free-text single
 * control (assignee, reporter) the box itself holds the value and the roster
 * still offers it, which is the behaviour those two fields have always had.
 */
const chosen = computed(() => (props.multi || props.hookChips ? values.value : []));

const results = computed(() => comboOptions({ roster: roster.value, query: query.value, freeText: props.freeText, chosen: chosen.value }));

/**
 * The title a chip shows beside the identifier (T-20261014-001418 ②). A
 * relation chip names its task the way an option row does — identifier, then
 * title — and resolves both against the same roster the row came from. The
 * whole title also rides the chip's `title`, so nothing is lost to the ellipsis.
 */
function chipTitle(value) {
  return String(roster.value.get(value)?.title ?? "");
}

const inputHooks = computed(() => ({ [props.hookInput]: "", ...(props.hookLabel ? { [props.hookLabel]: "" } : {}) }));

/**
 * The box's whole attribute set, so the two rows in the template (the field row
 * that carries the ✕, and the bare box every other control renders) can share
 * one definition: they differ in their **wrapper**, not in the box. `t()` reads
 * the language ref, so each value here tracks the language exactly as the `$t`
 * calls it replaces did.
 */
const inputAttrs = computed(() => ({
  type: "text",
  class: "w-full border border-(--brand-border-strong) rounded-[6px] bg-(--brand-surface) px-2 py-1 text-(--brand-text)",
  autocomplete: "off",
  spellcheck: "false",
  ...inputHooks.value,
  "aria-label": props.ariaKey ? t(props.ariaKey) : undefined,
  "aria-expanded": open.value ? "true" : "false",
  placeholder: t(props.placeholderKey),
  disabled: props.disabled || undefined,
  "aria-disabled": props.disabled ? "true" : undefined,
}));

/**
 * The clear affordance's click (T-20261016-113131 ③.2): it empties the **value**
 * as well as the box. While the ✕ was the dialog's sibling button the two halves
 * lived in two places — the dialog cleared the model and called into here for
 * the query — and inside the control there is nothing to reach back for, so it
 * emits. It never re-opens the menu: the box it just emptied must not
 * immediately offer to fill itself (T-20261014-001418 ②).
 */
function clearValue() {
  emit("update:modelValue", props.multi ? [] : "");
  clear();
}

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
  if (props.disabled) return;
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

/**
 * Removing a chip drops that value: one of many for a multi control, the
 * control's **only** value for a single-valued relation field — the parent's
 * chip carries the whole of what the field holds, so its ✕ empties the field.
 */
function removeChip(name) {
  if (props.multi) {
    emit(
      "update:modelValue",
      values.value.filter((item) => item !== name),
    );
    return;
  }
  if (props.hookChipRemove) emit("update:modelValue", "");
}

/**
 * The blur half of R10 ②'s commit: the drawer's single-valued fields save when
 * the reader leaves one whose value moved. `mousedown.prevent` on the menu rows
 * keeps the focus where it is while a row is being accepted, so this fires on a
 * real departure and not on a choice.
 */
function onBlur() {
  open.value = false;
  emit("blur", query.value.trim());
}

function focus() {
  open.value = true;
  nextTick(() => inputEl.value?.focus());
}

/**
 * The box's own way out: no half-typed query outlives the choice it was looking
 * for (T-20261014-001418 ②, design §3.5). It never re-opens the menu. The clear
 * affordance is `clearValue` above — it drops the value too, and is what the ✕
 * in the field row calls.
 */
function clear() {
  query.value = "";
  open.value = false;
}

/**
 * A seeded field follows its value: accepting a roster row rewrites the model,
 * and the box shows what was accepted rather than the query that found it. A
 * multi-value control keeps an empty box — its values are the chips.
 */
watch(
  () => props.modelValue,
  (next) => {
    if (!props.seed || open.value) return;
    query.value = props.multi ? "" : String(next ?? "");
  },
);

watch(
  () => props.options,
  () => {
    /* the roster grows by use; no reset needed */
  },
);

defineExpose({ focus, clear });
</script>

<template>
  <!-- The root. `.td-combo` is opt-in with the clear row, because it is what
       names the control in the design layer: it is the popup's positioning
       ancestor (`.td-combo-menu` is `width: max(100%, …)`, so the popup is as
       wide as the box it belongs to) and the anchor the prototype's two `:has()`
       rules hang off. T-20261016-113131 ③.2. -->
  <div class="relative" :class="{ 'td-combo': hookClear }" :data-drop="dropUp ? 'up' : 'down'">
    <!-- The accepted values read as chips *above* the field, which is where the
         prototype puts `.td-chips` for all four controls that carry them (the
         parent, depends-on, the create dialog's labels and the drawer's).

         R14 D50/B14/B15 — a chip is the prototype's own `.badge.td-chip`: the
         18px accent-soft pill whose 2px/4px/2px/8px padding and 12px face the
         stylesheet already states for the status chip. Its two children are the
         name and the remove control, and the remove control is the prototype's
         `button.td-chip-remove` — a 16×16 box holding `svg.td-icon-sm`, never a
         text glyph. A relation chip names its task the way an option row does —
         the identifier (mono, width held) then the title (the half that gives) —
         and keeps the whole title on `title` (T-20261014-001418 ①/②). -->
    <div v-if="hookChips" v-bind="{ [hookChips]: '' }" class="td-chips">
      <span
        v-for="name in values"
        :key="name"
        class="badge td-chip"
        v-bind="hookChip ? { [hookChip]: '', ...(hookChipValue ? { [hookChipValue]: name } : {}) } : {}"
        :title="chipTitle(name) || name"
      >
        <span v-if="taskMode" class="td-mono">{{ identifierText(name) }}</span>
        <span v-else>{{ name }}</span>
        <span v-if="taskMode && chipTitle(name)" class="td-combo-title">{{ chipTitle(name) }}</span>
        <button
          v-if="hookChipRemove"
          type="button"
          class="td-chip-remove"
          v-bind="{ [hookChipRemove]: '' }"
          :aria-label="`Clear ${name}`"
          :title="$t('combo.clear')"
          :disabled="disabled"
          :aria-disabled="disabled ? 'true' : undefined"
          @click="removeChip(name)"
        >
          <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </span>
    </div>

    <!-- The field row — the box and its ✕ on one line, the prototype's
         `.td-combo-field` (T-20261016-113131 ③.1). It is what makes the track
         an arithmetic identity rather than a width someone has to remember:
         `box + gap + ✕ == track`. Before it, the box sat in a `flex items-end`
         row shell as a `flex: 0 1 auto` item with `width: auto`, so it took its
         *content's* max-content width — 172px for the default `size=20` box,
         218.734 with a chip, against a 405.391px track and against every other
         control in the same column (T-20261015-233122 §①).

         The ✕ is the prototype's `.td-combo-clear`: the same 20×20 SVG box as
         the chips' own remove control, `display: none` until the field carries
         something to clear — which the two stylesheet rules decide, from the
         input's own state (`.td-combo-field:has(> input:not(:placeholder-shown))`)
         and from the chip row above it (`.td-combo:has([data-parent-chip])`).

         Only a control that asks for the affordance gets the row; the box is
         written from `inputAttrs` in both branches so the two cannot drift. -->
    <div v-if="hookClear" class="td-combo-field">
      <input
        ref="inputEl"
        v-model="query"
        v-bind="inputAttrs"
        @input="onInput"
        @focus="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
      />
      <button
        type="button"
        class="td-combo-clear"
        v-bind="{ [hookClear]: '' }"
        :aria-label="$t('combo.clear')"
        :title="$t('combo.clear')"
        :disabled="disabled"
        :aria-disabled="disabled ? 'true' : undefined"
        @click="clearValue"
      >
        <svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>

    <input
      v-else
      ref="inputEl"
      v-model="query"
      v-bind="inputAttrs"
      @input="onInput"
      @focus="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    />

    <ul v-show="open" v-bind="{ [hookMenu]: '' }" class="td-combo-menu" role="listbox">
      <li v-if="results.isNew">
        <button type="button" v-bind="optionHooks({ name: query.trim() }, true)" :aria-selected="active === 0 ? 'true' : 'false'" @mousedown.prevent="accept({ __new: true })">
          <span class="flex-1 overflow-hidden text-ellipsis">{{ query.trim() }}</span>
          <span class="ms-auto text-[11px] text-primary">{{ $t("combo.new") }}</span>
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
          <!-- A task row: identifier first under the one cap the board's
               identifiers share (`lib/identifier.js`), then the title, which is
               the half that gives — single line, `…` when it does not fit. The
               two classes are the prototype's own (`td-combo-id` /
               `td-combo-title`), and the whole title stays on the row's
               `title` (T-20261014-001418 ①). -->
          <span v-if="taskMode" class="td-mono td-combo-id">{{ identifierText(entry.identifier ?? entry.name) }}</span>
          <span v-if="taskMode" class="td-combo-title">{{ entry.title }}</span>
          <span v-else class="flex-1 overflow-hidden text-ellipsis">{{ entry.name }}</span>
        </button>
      </li>
      <li v-if="!results.isNew && results.entries.length === 0" class="p-2 text-[12px] text-(--brand-text-3)">{{ $t(emptyKey) }}</li>
    </ul>

  </div>
</template>
