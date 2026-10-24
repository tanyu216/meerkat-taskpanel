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

import { identifierText } from "../../lib/identifier.js";
import {
  board,
  isAgentKind,
  isAwaiting,
  kindLabel,
  platformOf,
  platformOfKind,
  priorityOf,
  projectNameOf,
  stageOf,
} from "../../stores/board.js";
import { openMoveMenu } from "../../stores/ui.js";

const props = defineProps({ task: { type: Object, required: true }, dragging: { type: Boolean, default: false } });
const emit = defineEmits(["open", "dragstart", "dragend"]);

/** The card the board has selected, so `aria-selected` reports the truth. */
const selected = computed(() => board.selectedRef === props.task.identifier);

/**
 * M1 — the card's `data-status` is its **stage**, not its state: an `awaiting`
 * card stays in its column and keeps the stage stripe (design §3.1/§8-08), so
 * the one-to-one "progress scan down a column" reading is unchanged. The
 * attention rides the badge below, which is an *overlay* — never a move.
 */
const stage = computed(() => stageOf(props.task));
const awaiting = computed(() => isAwaiting(props.task));

const assigneeName = computed(() => props.task.assignee?.display_name ?? "");
// `data-assignee-kind` is a closed design domain (`agent | human`), so it is
// derived from the kind rather than carrying it: since 0023 a kind is a platform.
const assigneeKind = computed(() => kindLabel(props.task.assignee?.kind));
const isAgent = computed(() => isAgentKind(props.task.assignee?.kind));
// The badge prefers the **card's own** reference — that is the act's platform —
// and falls back to the registry's aggregate for a card whose reference recorded
// none (every card written before 0023, and any the backfill could not place).
const platform = computed(() => platformOfKind(props.task.assignee?.kind) ?? platformOf(assigneeName.value));
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
    :data-status="stage"
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
    :aria-selected="selected ? 'true' : 'false'"
    @click="emit('open', task)"
    @dragstart="emit('dragstart', task, $event)"
    @dragend="emit('dragend')"
  >
    <span class="td-card-stripe" data-card-stripe aria-hidden="true"></span>

    <div class="td-card-top">
      <!-- R8 ③ — the same cap, the same function and the same pair of values as
           the list's row and the drawer's head: the text is the display value,
           `title` the full identifier, and the card root's `data-identifier`
           (above) the full value lookups use. -->
      <span
        class="td-mono td-id text-[11px] text-(--brand-text-3)"
        data-card-identifier
        :title="task.identifier"
      >{{ identifierText(task.identifier) }}</span>
      <!-- M1 · the attention badge. An overlay on the card, not a column
           transfer: it rides the reason code as an *attribute* and the unified
           label as its only text node, so the copy swaps with the language and
           the badge never grows a vocabulary of its own (design §3.1). -->
      <span
        v-if="awaiting"
        class="td-card-waiting"
        data-card-waiting
        :data-waiting-reason="task.awaiting_reason ?? ''"
        role="status"
        :aria-label="$t('waiting.aria.badge')"
        :title="$t(`waiting.reason.${task.awaiting_reason}`)"
      >
        <span data-card-waiting-label>{{ $t("status.awaiting") }}</span>
      </span>
      <!-- 0031/0037 — the card's acceptance mode. A descendant hook (the root's
           hook set is invariant across every card), and no new stage: a review
           is a gate on `done`, not a column. The chip is the `agent` mode's
           (an independent review card will be dispatched); a `human` card is
           surfaced by the waiting queue instead. -->
      <span
        v-if="task.acceptance_mode === 'agent'"
        class="inline-flex items-center px-1.5 py-px rounded-[4px] border border-(--brand-border) bg-(--brand-sunken) text-[10px] text-(--brand-text-3)"
        data-card-review-required
      >{{ $t("review.chip") }}</span>
      <button type="button" class="ms-auto border-0 bg-transparent text-(--brand-text-3) cursor-pointer" data-card-menu aria-haspopup="menu" :aria-expanded="false" :aria-label="$t('card.move', task.identifier)" @click="onMenu">
        ⋯
      </button>
    </div>

    <!-- Two lines, then an ellipsis (R6 ④). The clamp lives in `.td-card-title`
         with the rest of the title's metrics, so the button and the box it is
         clipped by are stated together. -->
    <button type="button" class="td-card-title" data-card-title>{{ task.title }}</button>

    <div class="td-card-labels" data-card-labels>
      <span v-for="label in labels" :key="label" class="inline-flex items-center gap-1 px-1.5 py-px rounded-[4px] border border-(--brand-border) bg-(--brand-sunken) text-[11px] text-(--brand-text-2)" data-label>{{ label }}</span>
    </div>

    <div class="td-card-foot">
      <span class="td-pri" data-card-priority role="img" :aria-label="$t('prop.priorityValue', $t(`priority.${priorityOf(task)}`))" :title="$t(`priority.${priorityOf(task)}`)">
        <svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1" /></svg>
      </span>

      <!-- Identity: an agent card hides the avatar but keeps the monogram in the
           DOM (the platform badge and the role name already say who it is); a
           human card keeps it visible. `hidden` on the wrapper, never on the
           `[data-card-assignee]` element itself, so the hook is always present. -->
      <span class="avatar" :hidden="isAgent">
        <span class="inline-flex items-center justify-center size-5 rounded-[999px] bg-(--brand-active) text-(--brand-text-2) text-[11px] font-medium" data-card-assignee :title="assigneeName">{{ monogram }}</span>
      </span>
      <span class="badge badge-xs normal-case" data-card-agent-badge :data-agent-platform="isAgent ? platform : undefined" :hidden="!isAgent">{{ isAgent ? platform : "" }}</span>
      <span v-if="isAgent" class="td-mono text-[11px] text-(--brand-text-3)" data-card-agent-role>{{ assigneeName }}</span>

      <div class="inline-flex items-center gap-2 ms-auto">
        <span class="inline-flex items-center gap-1 text-[11px] text-(--brand-text-3)" data-card-relations :hidden="!hasRelations">
          <span data-relation-parent>{{ relationsParent }}</span>
          <span data-relation-blocks>{{ relationsBlocks }}</span>
          <span data-relation-related>{{ relationsRelated }}</span>
        </span>
        <span class="inline-flex items-center gap-1 text-[11px] text-(--brand-text-3)" data-card-comment-count :hidden="commentCount === 0">{{ commentCount }}</span>
        <span class="inline-flex items-center gap-1 text-[11px] text-(--brand-text-3)" data-card-attachment-count :hidden="attachmentCount === 0">{{ attachmentCount }}</span>
      </div>
    </div>
  </article>
</template>
