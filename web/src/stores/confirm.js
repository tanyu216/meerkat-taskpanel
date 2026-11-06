/**
 * The shared confirmation dialog (TP-0125).
 *
 * One dialog instance lives in `App.vue`; the board's move menu, a drop and the
 * drawer's status combo all open it through `askConfirm`. The state is one
 * request at a time: opening a second request replaces the first, which is what
 * a person pressing another destructive control means.
 *
 * The three text keys are i18n keys, never prose, so the dialog speaks the
 * reader's language; `run` is the write the confirm gates. `acceptConfirm`
 * deliberately **rethrows** the write's failure after closing: the caller's own
 * path (`runCommit` in the drawer, `moveTask` on the board) is what surfaces
 * it, and swallowing it here would turn a refused write into a silent no-op.
 */
import { reactive } from "vue";

export const confirm = reactive({
  open: false,
  titleKey: null,
  bodyKey: null,
  actionKey: null,
  run: null,
  busy: false,
});

/**
 * Open the dialog for one write.
 *
 * @param {{titleKey: string, bodyKey: string, actionKey: string, run: () => Promise<unknown>|unknown}} request
 */
export function askConfirm({ titleKey, bodyKey, actionKey, run }) {
  if (typeof run !== "function") return false;
  confirm.open = true;
  confirm.titleKey = titleKey;
  confirm.bodyKey = bodyKey;
  confirm.actionKey = actionKey;
  confirm.run = run;
  confirm.busy = false;
  return true;
}

/**
 * Run the gated write and close. A busy dialog ignores a second press, so a
 * double click cannot issue two moves.
 *
 * @returns {Promise<boolean>} whether a write ran
 */
export async function acceptConfirm() {
  if (!confirm.open || confirm.busy) return false;
  confirm.busy = true;
  const run = confirm.run;
  try {
    await run?.();
    return true;
  } finally {
    confirm.busy = false;
    resetConfirm();
  }
}

/** Close without running. A busy dialog ignores the dismissal. */
export function dismissConfirm() {
  if (confirm.busy) return false;
  resetConfirm();
  return true;
}

function resetConfirm() {
  confirm.open = false;
  confirm.titleKey = null;
  confirm.bodyKey = null;
  confirm.actionKey = null;
  confirm.run = null;
}
