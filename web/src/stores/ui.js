/**
 * View + ephemeral UI state (B02 view toggle, B14 toasts, B19 panel).
 *
 * Kept apart from the board data store: none of this is persisted or fetched,
 * and every piece is a plain `ref` the shell reads. Toasts auto-dismiss after
 * 2.5 s (the prototype's timing).
 */
import { computed, ref } from "vue";

/**
 * board ↔ list ↔ waiting (mutually exclusive; `hidden` on the inactive ones).
 *
 * `waiting` is M1's 「等你回复」view: a *nav* view, not a third value of the top
 * bar's `board | list` toggle — that control's domain is frozen at two
 * (`DOMAINS.VIEW`), and design §10-C6 puts the new surface on the sidebar nav
 * precisely so it does not become one.
 */
const VIEWS = ["board", "list", "waiting"];
export const view = ref("board");
export function setView(next) {
  if (VIEWS.includes(next)) view.value = next;
}

/**
 * B08/B13 · the list view's two states — `loading` (the skeleton alone) and
 * `data` (the rows alone).
 *
 * They are stated on `[data-list]` and made mutually exclusive by a **rule** on
 * that attribute (`app.css`), never by swapping elements one at a time: a state
 * rule also holds for the document at rest, which a `v-if` on each half cannot
 * promise (R9 ③, contract R6). The resting value is `data` — a document that has
 * not run a read yet shows the rows' group, exactly as the prototype's own
 * resting document does.
 *
 * `data` is the only value the writer sets after a read; a view switch sets
 * `loading` first (see `ListView.vue`).
 */
export const listState = ref("data");
export function setListState(next) {
  if (next === "loading" || next === "data") listState.value = next;
}

/** The filters bar starts open (`aria-pressed="true"`), matching B02. */
export const filtersOpen = ref(true);
export function toggleFilters() {
  filtersOpen.value = !filtersOpen.value;
  return filtersOpen.value;
}


/** B19 access panel. */
export const accessOpen = ref(false);

/** B10 create-task and B11 create-project modals. */
export const createTaskOpen = ref(false);
export const createProjectOpen = ref(false);
/** The status a `[data-column-add]` press wants the new task to start in. */
export const createTaskStatus = ref(null);

/** Open the create dialog, optionally aimed at a column. */
export function openCreateTask(status = null) {
  createTaskStatus.value = status;
  createTaskOpen.value = true;
}

/** The single shared "Move to" menu (auxiliary hook `[data-move-menu]`). */
export const moveMenu = ref(null); // { task, top, left } | null
export function openMoveMenu(task, rect) {
  moveMenu.value = { task, top: rect.bottom + 4, left: Math.max(8, rect.left - 120) };
}
export function closeMoveMenu() {
  moveMenu.value = null;
}

/* ------------------------------------------------------------------ toasts */

let nextToastId = 1;
export const toasts = ref([]);

/**
 * Push a toast. `kind` ∈ info | success | danger (B14's domain).
 *
 * @param {string} text
 * @param {"info"|"success"|"danger"} [kind]
 * @param {{timeout?: number}} [options]
 */
export function pushToast(text, kind = "info", options = {}) {
  const id = nextToastId++;
  toasts.value = [...toasts.value, { id, text, kind, state: "entering" }];
  const timeout = options.timeout ?? 2500;
  if (timeout > 0) {
    setTimeout(() => {
      toasts.value = toasts.value.map((toast) => (toast.id === id ? { ...toast, state: "leaving" } : toast));
      setTimeout(() => {
        toasts.value = toasts.value.filter((toast) => toast.id !== id);
      }, 200);
    }, timeout);
  }
  return id;
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** A danger toast that stays until dismissed — used for a version conflict. */
export function pushStickyToast(text, kind = "danger") {
  return pushToast(text, kind, { timeout: 0 });
}

export const hasToasts = computed(() => toasts.value.length > 0);
