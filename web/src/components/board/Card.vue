<script setup>
/**
 * B07 · Card.
 *
 * The card's scalars are its own attributes — the store, in the prototype's
 * sense — and the drawer, list, filters and board all derive from them. Every
 * card root carries the **identical** hook set (C01), so no filter, drag or
 * drawer path ever special-cases one: the conditional hooks (the agent badge and
 * role) live on descendants, never on the root.
 *
 * A human card keeps the agent badge element but hides it and gives it no
 * platform (matching the prototype); an agent card shows the badge with the
 * platform and the role handle.
 */
import { computed } from "vue";

import { platformOf, priorityOf, projectNameOf } from "../../stores/board.js";
import { openMoveMenu } from "../../stores/ui.js";

const props = defineProps({ task: { type: Object, required: true }, dragging: { type: Boolean, default: false } });
const emit = defineEmits(["open", "dragstart", "dragend"]);

const assigneeName = computed(() => props.task.assignee?.display_name ?? "");
const assigneeKind = computed(() => props.task.assignee?.kind ?? "human");
const isAgent = computed(() => assigneeKind.value === "agent");
const platform = computed(() => platformOf(assigneeName.value));
const labels = computed(() => props.task.labels ?? []);
const labelsCsv = computed(() => labels.value.join(","));
const monogram = computed(() => (assigneeName.value ? assigneeName.value.trim().charAt(0).toUpperCase() : "?"));
const commentCount = computed(() => Number(props.task.meta?.comment_count ?? 0));
const attachmentCount = computed(() => Number(props.task.meta?.attachment_count ?? 0));
const relationsParent = computed(() => Number(props.task.meta?.relations_parent ?? 0));
const relationsBlocks = computed(() => Number(props.task.meta?.relations_blocks ?? 0));
const relationsRelated = computed(() => Number(props.task.meta?.relations_related ?? 0));
const hasRelations = computed(() => relationsParent.value + relationsBlocks.value + relationsRelated.value > 0);

function onMenu(event) {
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  openMoveMenu(props.task, rect);
}
</script>

<template>
  <article
    class="td-card"
    data-card
    draggable="true"
    :data-identifier="task.identifier"
    :data-id="task.id"
    :data-status="task.status"
    :data-priority="priorityOf(task)"
    :data-project="projectNameOf(task.project_id)"
    :data-assignee="assigneeName"
    :data-assignee-kind="assigneeKind"
    :data-reporter="task.reporter?.display_name ?? ''"
    :data-labels="labelsCsv"
    :data-version="task.version"
    :data-comments="commentCount"
    :data-attachments="attachmentCount"
    :data-relations-parent="relationsParent"
    :data-relations-blocks="relationsBlocks"
    :data-relations-related="relationsRelated"
    :data-done="task.status === 'done' ? 'true' : 'false'"
    :data-canceled="task.status === 'canceled' ? 'true' : 'false'"
    :data-dragging="dragging ? 'true' : 'false'"
    :aria-selected="false"
    @click="emit('open', task)"
    @dragstart="emit('dragstart', task, $event)"
    @dragend="emit('dragend')"
  >
    <span class="td-card-stripe" data-card-stripe aria-hidden="true"></span>

    <div class="td-card-head">
      <span class="td-card-id td-mono" data-card-identifier>{{ task.identifier }}</span>
      <button type="button" class="td-card-menu" data-card-menu aria-haspopup="menu" :aria-expanded="false" :aria-label="$t('card.move', task.identifier)" @click="onMenu">
        ⋯
      </button>
    </div>

    <button type="button" class="td-card-title" data-card-title>{{ task.title }}</button>

    <div class="td-card-labels" data-card-labels>
      <span v-for="label in labels" :key="label" class="td-chip" data-label>{{ label }}</span>
    </div>

    <div class="td-card-foot">
      <span class="td-pri" data-card-priority role="img" :aria-label="$t('prop.priorityValue', $t(`priority.${priorityOf(task)}`))" :title="$t(`priority.${priorityOf(task)}`)">
        <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1" /></svg>
      </span>

      <span class="td-avatar" data-card-assignee :title="assigneeName">{{ monogram }}</span>
      <span class="badge badge-xs td-agent-badge" data-card-agent-badge :data-agent-platform="isAgent ? platform : undefined" :hidden="!isAgent">{{ isAgent ? platform : "" }}</span>
      <span v-if="isAgent" class="td-agent-role td-mono" data-card-agent-role>{{ assigneeName }}</span>

      <div class="td-card-foot-right">
        <span class="td-meta" data-card-relations :hidden="!hasRelations">
          <span data-relation-parent>{{ relationsParent }}</span>
          <span data-relation-blocks>{{ relationsBlocks }}</span>
          <span data-relation-related>{{ relationsRelated }}</span>
        </span>
        <span class="td-meta" data-card-comment-count :hidden="commentCount === 0">{{ commentCount }}</span>
        <span class="td-meta" data-card-attachment-count :hidden="attachmentCount === 0">{{ attachmentCount }}</span>
      </div>
    </div>
  </article>
</template>
