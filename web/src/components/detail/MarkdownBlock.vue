<script setup>
/**
 * The drawer's escaped Markdown → HTML sink.
 *
 * `renderMarkdown` escapes its input before any inline transform and falls
 * back to escaped plain text when the renderer global is absent, so no call
 * site may hand-roll its own `v-html`. `.td-gfm` is the stylesheet contract in
 * app.css; callers pass only the raw source plus their own class/data hooks
 * (Vue merges fallthrough attrs onto the single root div).
 */
import { computed } from "vue";

import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({ source: { type: String, default: "" } });
const html = computed(() => renderMarkdown(props.source ?? ""));
</script>

<template>
  <div class="td-gfm" v-html="html"></div>
</template>
