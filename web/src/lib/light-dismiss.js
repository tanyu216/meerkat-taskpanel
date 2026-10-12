/**
 * R9 ①/② — the one light-dismiss rule for floating controls.
 *
 * Membership is the `data-dismiss-on-outside` **attribute** and nothing else: no
 * class name, no selector list, no per-control handler. Today's members are the
 * top bar's project switcher and the filters bar's label control — both
 * `<details class="dropdown">` — and a third one joins by carrying the attribute,
 * with no code change here (`design/fidelity-r9.md` §2.1 and §8 R1/R2).
 *
 * Three entry points, one rule:
 *
 *   * `installLightDismiss(doc)` — the **document-level** click rule. A click
 *     that lands outside every member closes every open member (Terry's finding:
 *     the switcher's panel used to stay up and swallow the next click); a click
 *     on a *closed* member's own `<summary>` closes the *other* members first, so
 *     only one is ever open. Returns a disposer, so the shell can uninstall it on
 *     unmount.
 *   * `closeFloatingControls(doc)` — what the shell's existing Escape chain calls
 *     (the floating controls are the lightest layer, so Escape clears them
 *     alongside whichever overlay is on top). Deliberately a function rather than
 *     a second `keydown` binding.
 *   * `dismissMemberFrom(event)` — what a control *inside* a member calls when
 *     the choice is made: choosing is what the panel was open for, so it closes
 *     with the choice. The prototype's own option handlers do exactly this
 *     (`design/prototype/app.js`), and it cannot be derived from the attribute —
 *     that click is inside the member by definition.
 *
 * The module touches the DOM, so it is exercised by the browser layer
 * (`web/scripts/dom-smoke.mjs`, the R9 section); the one decision that is worth
 * pinning without a browser — the "opening a member must not take its *own*
 * siblings down with it" guard — is a pure function (`isOpeningClick`) with its
 * own unit test (`test/web/light-dismiss.test.mjs`).
 */

/** A floating control that takes the light-dismiss rule. */
export const MEMBER_SELECTOR = "[data-dismiss-on-outside]";

/** A member that is currently open. */
export const OPEN_MEMBER_SELECTOR = "[data-dismiss-on-outside][open]";

/**
 * Is this click the one that *opens* `member`?
 *
 * True only for a click on the member's own `<summary>` while it is still
 * closed. The `open` half is the guard the contract calls out as not-optional:
 * at dispatch time the `<details>` has not toggled yet, so an already-open member
 * is on its way *closed* and must be left alone — treating it as the newcomer
 * would take its siblings down for nothing.
 *
 * `closest("summary")` rather than `target === summary` on purpose: a click on
 * the caret svg inside the summary, or anywhere in its padding, is still a click
 * on the summary.
 *
 * @param {Element} target the click's target
 * @param {Element|null} member the nearest member ancestor (or null)
 * @returns {boolean}
 */
export function isOpeningClick(target, member) {
  if (!target || !member || member.hasAttribute("open")) return false;
  const summary = target.closest("summary");
  return summary !== null && summary.parentElement === member;
}

/** Close every open member, optionally sparing one. */
function closeMembers(doc, keep = null) {
  for (const el of doc.querySelectorAll(OPEN_MEMBER_SELECTOR)) {
    if (el !== keep) el.removeAttribute("open");
  }
}

/** Escape / programmatic close: every member goes down. */
export function closeFloatingControls(doc) {
  closeMembers(doc);
}

/** The panel a just-activated option lives in closes with the choice. */
export function dismissMemberFrom(event) {
  const node = event?.currentTarget ?? event?.target;
  node?.closest?.(MEMBER_SELECTOR)?.removeAttribute("open");
}

/**
 * Install the document-level click rule.
 *
 * @param {Document} doc
 * @returns {() => void} uninstall
 */
export function installLightDismiss(doc) {
  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const member = target?.closest(MEMBER_SELECTOR) ?? null;
    if (!member) return closeMembers(doc);
    if (isOpeningClick(target, member)) closeMembers(doc, member);
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
