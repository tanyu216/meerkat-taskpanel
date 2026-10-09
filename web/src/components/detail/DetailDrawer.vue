<script setup>
/**
 * B09 · Task detail drawer, with B16's agent-session provenance and the drawer
 * families of the assignee/reporter (B22) and label (B25) controls.
 *
 * One drawer component renders for any card (the prototype's per-card
 * `<template>` clones are a jQuery mechanism; the *hooks* are the contract, the
 * template multiplicity is not). The drawer is toggled by `data-state` and
 * `hidden`, never by a stylesheet rule (C06), and Escape returns focus to the
 * opener (handled in `App.vue`).
 *
 * The body is **always in the document** — the contract counts hooks like
 * `[data-detail-labels]` with no `when` precondition, so they must exist while
 * the drawer is closed; only their values are empty at rest.
 */
import { computed, ref, watch } from "vue";

import { board, addComment, closeDetail, labelRoster, platformOf, priorityOf, reporterRoster } from "../../stores/board.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { pushToast } from "../../stores/ui.js";
import { t } from "../../i18n/index.js";

import ComboField from "../combo/ComboField.vue";

const commentDraft = ref("");
const assigneeDraft = ref("");
const reporterDraft = ref("");
const labelDraft = ref([]);

const detail = computed(() => board.detail);
const task = computed(() => detail.value?.task ?? null);
const open = computed(() => board.drawerState !== "closed" && task.value !== null);

const identifier = computed(() => task.value?.identifier ?? "");
const title = computed(() => task.value?.title ?? "");
const status = computed(() => task.value?.status ?? "backlog");
const priority = computed(() => priorityOf(task.value));
const versionText = computed(() => task.value?.version ?? "");
const idText = computed(() => task.value?.id ?? "");
const assigneeName = computed(() => task.value?.assignee?.display_name ?? "");
const reporterName = computed(() => task.value?.reporter?.display_name ?? "");
const isAgent = computed(() => (task.value?.assignee?.kind ?? "human") === "agent");
const platform = computed(() => platformOf(assigneeName.value));
const projectLabel = computed(() => board.projects.find((p) => p.id === task.value?.project_id)?.name ?? "");
const initial = (name) => (name ? name.charAt(0).toUpperCase() : "?");

const comments = computed(() => detail.value?.comments ?? []);
const activities = computed(() => detail.value?.activities ?? []);
const labelNames = computed(() => task.value?.labels ?? []);

const session = computed(() => {
  const sessions = detail.value?.sessions ?? [];
  return sessions.find((row) => row.status === "running") ?? sessions[0] ?? null;
});

const peopleOptions = computed(() => board.assignees.map((entry) => ({ name: entry.display_name, kind: entry.kind, platform: entry.platform })));
const reporterOptions = computed(() => reporterRoster.value.map((name) => ({ name })));
const labelOptions = computed(() => labelRoster.value.map((name) => ({ name })));

const descriptionHtml = computed(() => (task.value?.description ? renderMarkdown(task.value.description) : ""));

/** Identifier of a related task when the board knows it, else the raw id. */
function identifierOf(id) {
  return board.tasks.find((item) => item.id === id)?.identifier ?? id;
}

const relationLinks = computed(() => {
  const rel = detail.value?.relations ?? {};
  return (rel.relations ?? []).map((row) => {
    const other = row.source === task.value?.id ? row.target : row.source;
    return { key: row.id, type: row.type, label: identifierOf(other) };
  });
});

/** `data-status` on the status chip/prop falls back to a valid domain value at rest. */
const statusValue = computed(() => status.value);

// Keep the drafts in step with whichever task is open.
watch(
  () => task.value?.id,
  () => {
    assigneeDraft.value = assigneeName.value;
    reporterDraft.value = reporterName.value;
    labelDraft.value = [...labelNames.value];
    commentDraft.value = "";
  },
  { immediate: true },
);

async function submitComment() {
  const body = commentDraft.value.trim();
  if (!body || !task.value) return;
  await addComment(task.value.identifier, body);
  commentDraft.value = "";
}

/** The prototype reports a toast without touching the clipboard; so do we. */
function copyId() {
  pushToast(t("toast.copied"), "info");
}
</script>

<template>
  <div class="td-drawer-overlay" data-detail-overlay :data-state="board.drawerState" :hidden="!open" @click="closeDetail"></div>

  <aside
    class="td-drawer"
    data-detail-drawer
    :data-state="board.drawerState"
    :hidden="!open"
    :aria-hidden="open ? 'false' : 'true'"
    role="dialog"
    aria-modal="true"
  >
    <header class="td-drawer-head">
      <div style="display: flex; align-items: center; gap: 8px">
        <span class="td-mono" data-detail-identifier>{{ identifier }}</span>
        <span class="badge" data-detail-status-chip :data-status="statusValue">
          <span data-detail-status-chip-label>{{ $t(`status.${statusValue}`) }}</span>
        </span>
      </div>
      <h2 data-detail-title>{{ title }}</h2>
      <button type="button" class="td-drawer-close" data-detail-close :aria-label="$t('drawer.close')" @click="closeDetail">✕</button>
    </header>

    <div class="td-drawer-body">
      <dl class="td-props" data-detail-props>
        <dt>{{ $t("prop.status") }}</dt>
        <dd data-detail-status :data-status="statusValue"><span data-detail-status-label>{{ $t(`status.${statusValue}`) }}</span></dd>

        <dt>{{ $t("prop.priority") }}</dt>
        <dd data-detail-priority :data-priority="priority"><span data-detail-priority-label>{{ $t(`priority.${priority}`) }}</span></dd>

        <dt>{{ $t("prop.assignee") }}</dt>
        <dd data-detail-assignee>
          <span class="td-avatar" data-detail-assignee-avatar>{{ initial(assigneeName) }}</span>
          <span v-if="isAgent" data-detail-assignee-platform>{{ platform }}</span>
          <ComboField
            v-model="assigneeDraft"
            :options="peopleOptions"
            hook-input="data-assignee-input"
            hook-label="data-detail-assignee-label"
            hook-menu="data-assignee-menu"
            hook-option="data-assignee-option"
            hook-value="data-assignee-value"
            kind-attr="data-assignee-kind"
            platform-attr="data-agent-platform"
            placeholder-key="combo.assigneePlaceholder"
            aria-key="prop.assignee"
          />
        </dd>

        <dt>{{ $t("prop.reporter") }}</dt>
        <dd data-detail-reporter>
          <span class="td-avatar" data-detail-reporter-avatar>{{ initial(reporterName) }}</span>
          <ComboField
            v-model="reporterDraft"
            :options="reporterOptions"
            hook-input="data-reporter-input"
            hook-label="data-detail-reporter-label"
            hook-menu="data-reporter-menu"
            hook-option="data-reporter-option"
            hook-value="data-reporter-value"
            placeholder-key="combo.reporterPlaceholder"
            aria-key="prop.reporter"
          />
        </dd>

        <dt>{{ $t("prop.project") }}</dt>
        <dd data-detail-project><span data-detail-project-label>{{ projectLabel }}</span></dd>

        <dt>{{ $t("prop.id") }}</dt>
        <dd>
          <span class="td-mono" data-detail-id>{{ idText }}</span>
          <button type="button" class="td-card-menu" data-detail-id-copy :data-copy-value="idText" :aria-label="$t('toast.copied')" @click="copyId">⧉</button>
        </dd>

        <dt>{{ $t("prop.version") }}</dt>
        <dd class="td-mono" data-detail-version>{{ versionText }}</dd>

        <dt>{{ $t("prop.labels") }}</dt>
        <dd>
          <div data-detail-labels>
            <ComboField
              v-model="labelDraft"
              :options="labelOptions"
              multi
              hook-input="data-detail-label-input"
              hook-menu="data-detail-label-menu"
              hook-option="data-detail-label-option"
              hook-value="data-detail-label-value"
              hook-chips="data-detail-label-chips"
              hook-chip="data-detail-label-chip"
              hook-chip-value="data-detail-label-value"
              hook-chip-remove="data-detail-label-remove"
              placeholder-key="combo.labelsPlaceholder"
              empty-key="combo.noLabels"
              aria-key="prop.labels"
            />
          </div>
        </dd>
      </dl>

      <section class="td-slot" data-detail-description>
        <h3 class="td-slot-title">{{ $t("drawer.description") }}</h3>
        <div v-if="descriptionHtml" class="td-gfm" v-html="descriptionHtml"></div>
        <p v-else class="td-state-note" data-i18n="description.none">{{ $t("description.none") }}</p>
      </section>

      <section class="td-slot" data-detail-relations>
        <h3 class="td-slot-title">{{ $t("drawer.relations") }}</h3>
        <ul v-if="relationLinks.length" style="margin: 0; padding-left: 16px">
          <li v-for="link in relationLinks" :key="link.key">
            <a href="#" class="td-mono" data-relation-link @click.prevent>{{ link.type }} · {{ link.label }}</a>
          </li>
        </ul>
        <p v-else class="td-state-note" data-i18n="relations.none">{{ $t("relations.none") }}</p>
      </section>

      <section class="td-slot" data-detail-agent-session :hidden="!isAgent">
        <h3 class="td-slot-title">{{ $t("drawer.session") }}</h3>
        <div data-detail-agent-session-body>
          <div data-agent-session>
            <p>{{ $t("session.id") }}: <span class="td-mono" data-agent-session-id>{{ session?.session_id ?? "—" }}</span></p>
            <p><span :data-agent-platform="isAgent ? platform : undefined">{{ platform }}</span> · <span data-agent-platform-value>{{ platform }}</span></p>
            <button type="button" class="btn btn-ghost btn-xs" data-agent-resume>{{ $t("drawer.resume") }}</button>
          </div>
        </div>
      </section>

      <section class="td-slot" data-detail-attachments>
        <h3 class="td-slot-title">{{ $t("drawer.attachments") }}</h3>
        <p class="td-state-note" data-i18n="attachments.none">{{ $t("attachments.none") }}</p>
      </section>

      <section class="td-slot" data-detail-comments>
        <h3 class="td-slot-title">{{ $t("drawer.comments") }}</h3>
        <article v-for="comment in comments" :key="comment.id" class="td-comment">
          <div class="td-comment-meta">
            <span>{{ comment.author_id ?? comment.author?.display_name ?? "—" }}</span>
            <span>{{ $t(`comment.${comment.author_kind ?? 'human'}`) }}</span>
          </div>
          <p>{{ comment.body }}</p>
        </article>
        <form data-comment-form @submit.prevent="submitComment">
          <textarea v-model="commentDraft" class="td-comment-input" data-comment-input :placeholder="$t('drawer.commentPlaceholder')"></textarea>
          <button type="submit" class="btn btn-primary btn-sm" data-comment-submit>{{ $t("drawer.submit") }}</button>
        </form>
      </section>

      <section class="td-slot" data-detail-activity>
        <h3 class="td-slot-title">{{ $t("drawer.activity") }}</h3>
        <ul style="margin: 0; padding-left: 16px">
          <li v-for="activity in activities" :key="activity.id">
            <span class="td-mono">{{ activity.actor_id ?? "—" }}</span> · {{ activity.event }}
          </li>
        </ul>
      </section>
    </div>

    <!-- The contract's inert slot templates: the hooks survive the framework,
         the multiplicity does not. One template holds one slot per SLOT value. -->
    <div data-detail-templates hidden>
      <div data-detail-for="*">
        <div data-detail-slot-source hidden></div>
        <div data-slot="description"></div>
        <div data-slot="relations"></div>
        <div data-slot="agent-session"></div>
        <div data-slot="attachments"></div>
        <div data-slot="comments"></div>
        <div data-slot="activity"></div>
      </div>
    </div>
  </aside>
</template>
