/**
 * Viewport anchoring for the `<details class="dropdown">` menus.
 *
 * The board's filter bar is `overflow-x: auto` by contract
 * (`[data-filters]` → `overflowX: auto`), and CSS computes the other axis to
 * `auto` too. That made every absolutely-positioned `.td-details-menu` panel
 * **clip inside the 32px bar**: the menu opened, but only its trigger's line was
 * painted, so a press looked inert (`elementFromPoint` at the menu's centre hit
 * the board below). Removing the overflow is not an option — the one-line bar is
 * the contract's own rule — and a `<details>` panel cannot be teleported without
 * breaking the selectors that require it to stay inside its control.
 *
 * The way out is the one `Board.vue` already uses for its move menu: a
 * **fixed**-position box. An open menu is anchored to its `<summary>`'s
 * viewport rect and is no longer clipped by an ancestor's plain `overflow` (no
 * ancestor in this tree creates a fixed containing block via `transform`,
 * `filter` or `contain`). It stays in the details subtree, so `closest()`, the
 * light-dismiss click rule and `dismissMemberFrom()` all keep working unchanged.
 *
 * This module owns two things:
 *
 *   * `placeMenu()` — the pure placement arithmetic (the tests pin it without a
 *     browser);
 *   * `installAnchoredMenus()` — the document-level installer, driven by the
 *     `toggle` event that `<details>` dispatches (capture, because it does not
 *     bubble) and re-run on scroll/resize while a menu is open.
 */

import { MEMBER_SELECTOR, OPEN_MEMBER_SELECTOR } from "./light-dismiss.js";

/** The menu shell this module positions. */
export const MENU_SELECTOR = ".td-details-menu";

const GAP = 4;
const EDGE = 8;

/**
 * Where an open menu should sit, in viewport coordinates.
 *
 * Below the anchor by default; flipped above when the menu would overflow the
 * bottom and there is room above; clamped to the bottom edge when neither side
 * fits. Horizontally clamped so an anchored panel never leaves the viewport.
 *
 * @param {{top: number, bottom: number, left: number, width: number}} anchor
 * @param {{width: number, height: number}} size the menu's measured box
 * @param {{width: number, height: number}} viewport
 * @param {number} [gap]
 * @param {number} [edge]
 * @returns {{top: number, left: number, upward: boolean}}
 */
export function placeMenu(anchor, size, viewport, gap = GAP, edge = EDGE) {
  const width = Math.min(size.width, Math.max(0, viewport.width - edge * 2));
  const left = Math.min(Math.max(anchor.left, edge), Math.max(edge, viewport.width - edge - width));
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  if (below + size.height <= viewport.height - edge) return { top: below, left, upward: false };
  if (above >= edge) return { top: above, left, upward: true };
  // Neither side fits: pin to the bottom edge rather than paint off-screen.
  return { top: Math.max(edge, viewport.height - edge - size.height), left, upward: false };
}

/**
 * Install the anchoring rule. Returns the disposer.
 *
 * @param {Document} doc
 * @param {Window} [win]
 */
export function installAnchoredMenus(doc, win = doc.defaultView) {
  const raf = typeof win?.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : (cb) => win.setTimeout(cb, 0);
  const caf = typeof win?.cancelAnimationFrame === "function" ? win.cancelAnimationFrame.bind(win) : (id) => win.clearTimeout(id);
  /** @type {number|null} */
  let frame = null;

  /** Put one open member's menu on the viewport, next to its summary. */
  const anchor = (member) => {
    const summary = member.querySelector("summary");
    const menu = member.querySelector(MENU_SELECTOR);
    if (!summary || !menu) return;
    menu.setAttribute("data-anchored", "true");
    // Measure unpositioned, then write the coordinates — two reads and one
    // write, so the flip test sees the menu's real height.
    menu.style.visibility = "hidden";
    menu.style.top = "";
    menu.style.left = "";
    menu.style.minWidth = "";
    menu.style.maxWidth = "";
    const box = summary.getBoundingClientRect();
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    menu.style.minWidth = `${Math.max(180, Math.round(box.width))}px`;
    menu.style.maxWidth = `${Math.max(0, viewport.width - EDGE * 2)}px`;
    const size = menu.getBoundingClientRect();
    const placed = placeMenu(box, size, viewport);
    menu.style.top = `${Math.round(placed.top)}px`;
    menu.style.left = `${Math.round(placed.left)}px`;
    menu.style.visibility = "";
  };

  /** Return a closed menu to its stylesheet-defined box. */
  const release = (menu) => {
    if (!menu) return;
    menu.removeAttribute("data-anchored");
    menu.style.top = "";
    menu.style.left = "";
    menu.style.minWidth = "";
    menu.style.maxWidth = "";
    menu.style.visibility = "";
  };

  const reposition = () => {
    for (const member of doc.querySelectorAll(OPEN_MEMBER_SELECTOR)) anchor(member);
  };

  const schedule = () => {
    if (frame !== null) return;
    frame = raf(() => {
      frame = null;
      reposition();
    });
  };

  const onToggle = (event) => {
    const target = event.target;
    if (!target?.matches?.(MEMBER_SELECTOR)) return;
    const menu = target.querySelector(MENU_SELECTOR);
    if (!menu) return;
    if (target.hasAttribute("open")) anchor(target);
    else release(menu);
  };

  doc.addEventListener("toggle", onToggle, true);
  // Capture: scroll does not bubble, and the menu must follow the board's own
  // scroller as well as the window.
  win?.addEventListener("scroll", schedule, true);
  win?.addEventListener("resize", schedule);

  return () => {
    doc.removeEventListener("toggle", onToggle, true);
    win?.removeEventListener("scroll", schedule, true);
    win?.removeEventListener("resize", schedule);
    if (frame !== null) caf(frame);
    frame = null;
    for (const menu of doc.querySelectorAll(`${MENU_SELECTOR}[data-anchored]`)) release(menu);
  };
}
