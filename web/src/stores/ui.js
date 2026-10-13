/**
 * View + ephemeral UI state (B02 view toggle, B14 toasts, B19 panel).
 *
 * Kept apart from the board data store: none of this is persisted or fetched,
 * and every piece is a plain `ref` the shell reads. Toasts auto-dismiss after
 * 2.5 s (the prototype's timing).
 */
import { computed, ref } from "vue";

import { VIEWS } from "../lib/route.js";

/**
 * board ↔ list ↔ activity ↔ waiting (mutually exclusive; `hidden` on the inactive
 * ones).
 *
 * `activity` (R12x · B26) and `waiting` (M1) are both *nav* views, not further
 * values of the top bar's `board | list` toggle — that control's domain is
 * frozen at two (`DOMAINS.VIEW`), and `design/DESIGN.md` §29.2 puts the new
 * surfaces on the sidebar's four-way destination list precisely so they do not
 * become values of it.
 *
 * R16 (DESIGN.md §32.3) — this ref is now a **mirror of the address**, not the
 * thing the interface sets: the view a reader is on is decided by
 * `location.pathname` and by nothing else. It is written in exactly one place,
 * `mirrorView` below, and only by the router (`stores/route.js`) — the address
 * reader `applyLocation()` on boot and on `popstate`. A component that wants to
 * change the view calls `navigate(view)` from that module instead, which writes
 * the address first and lets the reader move the mirror.
 */
export const view = ref("board");

/**
 * The mirror writer — **the router's own**, never a component's.
 *
 * It sets the ref without touching the address (that is the reader's rule: it
 * never writes history), so calling it from anywhere but `stores/route.js` would
 * put the view and the address bar out of step, which is the defect the round
 * exists to remove.
 */
export function mirrorView(next) {
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

/**
 * R12x · §29.2 — does the **board area** show its filter bar?
 *
 * The bar narrows *cards*, and the two destinations that are not the board area
 * (the activity ledger, the waiting queue) are narrowed by their own controls —
 * a second row of card filters above them would change nothing, which is the
 * defect the round exists to remove. The prototype states this as
 * `boardAreaShowsBar()` (`design/prototype/app.js`), and it is what the bar's own
 * visibility is bound to here.
 */
export const boardArea = computed(() => view.value === "board" || view.value === "list");

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
