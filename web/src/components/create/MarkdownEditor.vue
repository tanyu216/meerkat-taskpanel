<script setup>
/**
 * B23 · Markdown editor.
 *
 * Three modes (Write / Preview / Split) selected by `[data-md-toggle]`; the mode
 * in force is written as `data-md-mode` on the panes container. `[data-md-highlight]`
 * is an aria-hidden `<pre>` painted behind the textarea with the same `.td-md-text`
 * metrics, so the two break lines identically; the scroll binding is direct (a
 * `scroll` event does not bubble). The renderers are the prototype's vendored
 * first-party files — no markdown-it, no DOMPurify, no network.
 */
import { computed, onMounted, ref, watch } from "vue";

import { highlightMarkdown, renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  /** Extra hooks on the textarea (B10 marks it `[data-create-task-description]`). */
  sourceHooks: { type: Array, default: () => ["data-create-task-description"] },
});
const emit = defineEmits(["update:modelValue"]);

const modes = ["write", "preview", "split"];
const mode = ref("write");
const source = ref(null);
const highlightEl = ref(null);

const text = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

const previewHtml = computed(() => renderMarkdown(text.value));
const highlightHtml = computed(() => highlightMarkdown(text.value));
const sourceHookAttrs = computed(() => Object.fromEntries(props.sourceHooks.map((hook) => [hook, ""])));

function syncScroll() {
  if (!source.value || !highlightEl.value) return;
  highlightEl.value.scrollTop = source.value.scrollTop;
  highlightEl.value.scrollLeft = source.value.scrollLeft;
}

onMounted(syncScroll);
watch(mode, () => {
  // Re-align the layer when the panes re-appear (a hidden element has no metrics).
  requestAnimationFrame(syncScroll);
});
</script>

<template>
  <div class="td-md-editor" data-md-editor>
    <div class="td-md-bar" role="group" :aria-label="$t('md.label')">
      <button
        v-for="value in modes"
        :key="value"
        type="button"
        class="td-md-toggle"
        :data-md-toggle="value"
        :aria-pressed="mode === value ? 'true' : 'false'"
        @click="mode = value"
      >
        {{ $t(`md.${value}`) }}
      </button>
      <span class="td-md-hint" data-i18n="md.hint">{{ $t("md.hint") }}</span>
    </div>

    <div class="td-md-panes" :data-md-mode="mode">
      <div class="td-md-pane-write">
        <pre ref="highlightEl" class="td-md-text td-md-highlight" data-md-highlight aria-hidden="true" v-html="highlightHtml"></pre>
        <textarea
          ref="source"
          v-model="text"
          class="td-md-text td-md-source"
          spellcheck="false"
          data-md-source
          v-bind="sourceHookAttrs"
          @scroll="syncScroll"
        ></textarea>
      </div>
      <div class="td-md-pane-preview">
        <div class="td-gfm" data-md-preview v-html="previewHtml"></div>
      </div>
    </div>
  </div>
</template>
