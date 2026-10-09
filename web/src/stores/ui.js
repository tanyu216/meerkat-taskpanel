/**
 * View + ephemeral UI state (B02 view toggle, B14 toasts, B18/B19 panels).
 *
 * Kept apart from the board data store: none of this is persisted or fetched,
 * and every piece is a plain `ref` the shell reads. Toasts auto-dismiss after
 * 2.5 s (the prototype's timing); the B18 showcase's three sample toasts are
 * authored markup with `data-state="static"` and are never dismissed here.
 */
import { computed, ref } from "vue";

/** board ↔ list (mutually exclusive; `hidden` on the inactive one). */
export const view = ref("board");
export function setView(next) {
  if (next === "board" || next === "list") view.value = next;
}

/** The filters bar starts open (`aria-pressed="true"`), matching B02. */
export const filtersOpen = ref(true);
export function toggleFilters() {
  filtersOpen.value = !filtersOpen.value;
  return filtersOpen.value;
}

/** B18 states gallery and B19 access panel. */
export const statesOpen = ref(false);
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
