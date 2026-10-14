#!/usr/bin/env node
/**
 * C-COMBO-1 · the combo popup's box and row metrics — the browser leg no other
 * gate carries.
 *
 * Why this file exists (the rail-chip precedent, `web/scripts/rail-chip-overflow.mjs`):
 * `.td-combo-menu` was measured wrong in **two** places at once and every gate was
 * silent about both. `T-20261014-212017-7` (D3/D4) found the drawer's menu box at
 * **110.188px** where the prototype drew **383px**, its rows at 27.5px where the
 * prototype drew 28, and the create dialog's menu as `display: block` where the
 * prototype lays out a flex column — while `ui-align`'s baseline never opened
 * either menu, `blocks.contract.mjs` pins only counts and `docOverflow` reads
 * `{0,0}` on both sides of the breakage (the menu is narrow when it is wrong, and
 * `overflow: visible` when it is right). A green suite therefore said nothing
 * about this box; this script is what does.
 *
 * The defect's own signature is the reproduction test here (D4). daisyUI's `.menu`
 * — which both trees' markup carries, the prototype's included
 * (`design/prototype/index.html:3482` → `ul.menu.td-combo-menu`) — declares
 * `width: fit-content`. An absolutely positioned box with `left: 0` and a
 * competing `width` settles on the width, so the popup shrank to its content:
 * **removing the class in the page flipped 110.19 → 383**. After the fix the class
 * is inert, and D4 asserts exactly that: strip it and the box must not move. A
 * future regression that re-loses the width declaration reds D1 and D4 together.
 *
 * **Expected values, and where each one comes from.** They are the prototype's own
 * declarations, confirmed as the design token expectations by the design ruling on
 * the card (`T-20261015-065331`, comment 2026-10-14T22:55:22Z) — never read back
 * off this implementation:
 *   · box   `design/prototype/src/input.css:2950` (→ `tw.css:5633`) — `width:
 *           max(100%, 220px)`, `max-height: 232px`, `padding: 4px`,
 *           `border-radius: var(--r-md)` = 6px (`tw.css:3587`), `flex-wrap: nowrap`;
 *           the column direction is daisyUI's `.menu` (`tw.css:883`).
 *   · box type  `--text-13` 13px / `--leading-body` 1.5 = 19.5px
 *           (`web/src/styles/tokens.css:146/152`; the prototype states 13px twice,
 *           `input.css:2979/2981`).
 *   · row   `design/prototype/src/input.css:1639` (`.menu li > button`) —
 *           `min-height: 28px`, `padding: 0 8px`, `border-radius: var(--r-sm)` =
 *           4px (`tw.css:3586`), `font-size: 13px`, `gap: 8px`,
 *           `color: var(--color-td-ink-2)` = `#4a555e` = `--brand-text-2`
 *           (`tokens.css:99`).
 * The colour leg compares against the *token* the rule names, so it holds in the
 * dark theme too rather than pinning a light-theme hex.
 *
 * **Two surfaces, one value set.** The card's ② is "create dialog and drawer land
 * the same group of values" — so the leg reads both and D7 asserts the two sets are
 * equal, not merely that each matches the table.
 *
 * Usage: node web/scripts/combo-menu-geometry.mjs [options]
 *   --json <path>   write the full artifact (default: stdout summary only)
 *   --lang <code>   en | zh                          (default en)
 *
 * Exit: 0 every assertion holds; 1 at least one failed; 2 the leg could not run
 * (no Playwright, no `web/dist`).
 *
 * Host-side on purpose: `docs/docker.md` §Host-allowed-checks keeps
 * browser-rendered frontend checks on the host because the image carries no
 * Chromium. No `npm install` is performed — Playwright is resolved if present.
 * The fixture board `dom-smoke.mjs` serves is the carrier, so this leg needs no
 * database and no daemon.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const DIST = join(WEB, "dist");

/* ------------------------------------------------------------------ argv */

const argv = process.argv.slice(2);
const opt = { lang: "en", json: null };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const take = (name) => (arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : argv[++i]);
  if (arg === "--json" || arg.startsWith("--json=")) opt.json = resolve(take("--json"));
  else if (arg === "--lang" || arg.startsWith("--lang=")) opt.lang = take("--lang");
  else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}
if (!["en", "zh"].includes(opt.lang)) {
  process.stderr.write(`--lang must be en|zh, got ${JSON.stringify(opt.lang)}\n`);
  process.exit(2);
}
if (!existsSync(join(DIST, "index.html"))) {
  process.stderr.write(`no build at ${DIST} — run \`npm --prefix web run build\` first (the leg asserts the shipped artifact, not the sources)\n`);
  process.exit(2);
}

const { startServer, resolvePlaywright } = await import("./dom-smoke.mjs");
const playwright = resolvePlaywright();
if (!playwright) {
  process.stderr.write("Playwright is not installed on this host — `resolvePlaywright()` found nothing\n");
  process.exit(2);
}

/* ------------------------------------------------------------- the readings */

/** The drawer's menu and its option rows, plus the create dialog's, in one shape. */
function readMenus() {
  const round = (n) => +n.toFixed(2);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { w: round(r.width), h: round(r.height) };
  };
  /**
   * The absolutely positioned box's containing block, as the padding box of the
   * nearest positioned ancestor — which is what `100%` in `max(100%, 220px)`
   * resolves against (CSS 2.1 §10.1). Read rather than assumed: the drawer's
   * wrapper and the dialog's are different elements in the two trees, and D1
   * compares against this number, not against a hard-coded one.
   */
  const containingBox = (el) => {
    let node = el.parentElement;
    while (node !== null && getComputedStyle(node).position === "static") node = node.parentElement;
    if (node === null) return null;
    const cs = getComputedStyle(node);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const edge = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    return { classes: node.getAttribute("class") ?? "", w: round(node.getBoundingClientRect().width - pad - edge) };
  };
  /** The unselected row — the selected one paints a state background (see D-notes). */
  const rowOf = (menu) => [...menu.querySelectorAll("button")].find((b) => b.getAttribute("aria-selected") !== "true") ?? null;

  const read = (menu, row) => {
    const cs = getComputedStyle(menu);
    const rs = row === null ? null : getComputedStyle(row);
    const token = cs.getPropertyValue("--brand-text-2").trim();
    return {
      menu: {
        w: box(menu).w,
        h: box(menu).h,
        containing: containingBox(menu),
        border_radius: cs.borderTopLeftRadius,
        font_size: cs.fontSize,
        line_height: cs.lineHeight,
        max_height: cs.maxHeight,
        padding: cs.padding,
        display: cs.display,
        flex_direction: cs.flexDirection,
        flex_wrap: cs.flexWrap,
        has_menu_class: menu.classList.contains("menu"),
        /** D4 的取样：把 daisyUI 的 `menu` 类摘掉，盒宽必须不动。 */
        width_without_menu_class: (() => {
          const before = box(menu).w;
          const had = menu.classList.contains("menu");
          if (!had) return { had_menu_class: false, with: before, without: before };
          menu.classList.remove("menu");
          const after = box(menu).w;
          menu.classList.add("menu");
          return { had_menu_class: true, with: before, without: after };
        })(),
      },
      row: row === null ? null : {
        h: box(row).h,
        w: box(row).w,
        min_height: rs.minHeight,
        padding: rs.padding,
        border_radius: rs.borderTopLeftRadius,
        font_size: rs.fontSize,
        gap: rs.gap,
        color: rs.color,
        token,
        width_fills_box: round(box(row).w - (box(menu).w - (parseFloat(cs.paddingLeft) || 0) * 2 - (parseFloat(cs.borderLeftWidth) || 0) * 2)),
      },
    };
  };

  const drawerMenu = document.querySelector("[data-detail-status-menu]");
  const out = {
    drawer: drawerMenu === null ? null : read(drawerMenu, rowOf(drawerMenu)),
    create: null,
  };
  const createMenu = document.querySelector("[data-create-task] [data-parent-menu]");
  if (createMenu !== null) out.create = read(createMenu, rowOf(createMenu));
  return out;
}

/** Open a card's drawer and its status menu. */
function openDrawerStatusMenu() {
  const card = document.querySelector("[data-card]");
  (card?.querySelector("[data-card-title]") ?? card)?.click();
  return true;
}

/** Open the create dialog from the board's own trigger. */
function openCreateDialog() {
  document.querySelector("[data-new-task]")?.click();
  return true;
}

/**
 * Open the Parent combo. The control opens on **focus** with the query still
 * empty (`ComboField.vue` `@focus="onInput"`), which is deliberate: it offers the
 * whole candidate list, so the row leg has rows to read without depending on how
 * a search string happens to match the fixture's titles.
 */
function focusParentCombo() {
  const input = document.querySelector("[data-create-task] [data-parent-input]");
  if (input === null) return false;
  input.focus();
  input.click?.();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/* ------------------------------------------------------------- assertions */

const results = [];
let current = null;
const suite = (name) => {
  current = name;
};
const check = (id, ok, detail) => {
  results.push({ suite: current, id, ok: !!ok, detail: detail ?? "" });
  process.stdout.write(`[${ok ? "  ok  " : " FAIL "}] ${id}${detail ? ` — ${detail}` : ""}\n`);
};
const near = (a, b, tol = 0.51) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

/** The box declarations, in the order the ruling lists them. */
const BOX_EXPECTED = {
  border_radius: "6px",
  font_size: "13px",
  line_height: "19.5px",
  max_height: "232px",
  padding: "4px",
  display: "flex",
  flex_direction: "column",
  flex_wrap: "nowrap",
};
/** The row declarations. */
const ROW_EXPECTED = {
  min_height: "28px",
  padding: "0px 8px",
  border_radius: "4px",
  font_size: "13px",
  gap: "8px",
};
const BOX_FLOOR = 220;

/** A surface is readable only when its box *and* a row are actually painted. */
const readable = (side) => side !== null && side.menu !== null && side.row !== null && side.menu.w > 0 && side.row.w > 0;
/** The value set a surface carries — what D7 compares across the two. */
const valueSet = (side) => Object.fromEntries([...Object.keys(BOX_EXPECTED).map((k) => [`box.${k}`, side.menu[k]]), ...Object.keys(ROW_EXPECTED).map((k) => [`row.${k}`, side.row[k]])]);

let browser = null;
let server = null;
try {
  const started = await startServer();
  server = started.server;
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${started.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-card]", { timeout: 20_000 });
  await page.waitForTimeout(400);

  /* ---- the drawer (the -7 D3/D4 surface) ---- */
  await page.evaluate(`(${openDrawerStatusMenu})()`);
  await page.waitForFunction(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") === "open", null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("[data-detail-status]")?.click());
  await page.waitForTimeout(250);
  const drawer = await page.evaluate(readMenus);
  if (!readable(drawer.drawer)) {
    process.stderr.write("the drawer's status menu did not render — the leg cannot read it\n");
    throw Object.assign(new Error("drawer menu missing"), { code: "SKIP" });
  }

  /* ---- the create dialog (the same rule family's other surface) ---- */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.evaluate(`(${openCreateDialog})()`);
  await page.waitForTimeout(400);
  await page.evaluate(`(${focusParentCombo})()`);
  await page.waitForTimeout(350);
  const create = await page.evaluate(readMenus);
  if (!readable(create.create)) {
    process.stderr.write("the create dialog's parent menu did not render — the leg cannot read it\n");
    throw Object.assign(new Error("create menu missing"), { code: "SKIP" });
  }

  /* ------------------------------------------------------------ the table */

  for (const [surface, side] of [["drawer", drawer.drawer], ["create", create.create]]) {
    suite(`${surface} · 菜单盒 .td-combo-menu`);
    const want = Math.max(BOX_FLOOR, side.menu.containing.w);
    check(`D1 width = max(containing block, ${BOX_FLOOR}) — 不塌到内容宽`, near(side.menu.w, want), `w=${side.menu.w} want=${round2(want)} containing=${side.menu.containing.classes} ${side.menu.containing.w}px`);
    for (const [key, expected] of Object.entries(BOX_EXPECTED)) {
      check(`D2 ${key} = ${expected}`, side.menu[key] === expected, `got ${side.menu[key]}`);
    }
    suite(`${surface} · 选项行`);
    check("D3 row height = 28px", near(side.row.h, 28), `got ${side.row.h}`);
    for (const [key, expected] of Object.entries(ROW_EXPECTED)) {
      check(`D3 ${key} = ${expected}`, side.row[key] === expected, `got ${side.row[key]}`);
    }
    check("D3 color = var(--brand-text-2)", side.row.color === rgb(side.row.token), `color=${side.row.color} token ${side.row.token} = ${rgb(side.row.token)}`);
    check("D3 row width fills the box", near(side.row.width_fills_box, 0), `row ${side.row.w} / box ${side.menu.w} Δ=${side.row.width_fills_box}`);
    suite(`${surface} · 归因`);
    check(
      "D4 daisyUI `menu` 类不再承重：摘掉它盒宽不变（缺陷签名 110.19→383）",
      near(side.menu.width_without_menu_class.with, side.menu.width_without_menu_class.without),
      `${side.menu.has_menu_class ? "has" : "no"} menu class；with=${side.menu.width_without_menu_class.with} without=${side.menu.width_without_menu_class.without}`,
    );
  }

  suite("两处同时落同一组值（卡 ②）");
  const a = valueSet(drawer.drawer);
  const b = valueSet(create.create);
  const drifted = Object.keys(a).filter((k) => a[k] !== b[k]);
  check("D7 create 对话框与详情抽屉的值集全等", drifted.length === 0, drifted.length === 0 ? `${Object.keys(a).length} 条逐字相同` : drifted.map((k) => `${k}: ${a[k]} vs ${b[k]}`).join("; "));

  suite("硬门");
  check("D8 console/page error = 0", consoleErrors.length === 0 && pageErrors.length === 0, `${consoleErrors.length} console / ${pageErrors.length} page${consoleErrors.length || pageErrors.length ? `: ${[...consoleErrors, ...pageErrors].slice(0, 3).join(" | ")}` : ""}`);

  if (opt.json) {
    writeFileSync(opt.json, `${JSON.stringify({ viewport: "1512x950", lang: opt.lang, drawer, create, results }, null, 2)}\n`);
    process.stdout.write(`\nwrote ${opt.json}\n`);
  }
} catch (err) {
  await browser?.close().catch(() => {});
  server?.close();
  if (err?.code === "SKIP") process.exit(2);
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(2);
}
await browser.close().catch(() => {});
server.close();

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\nC-COMBO-1: ${results.length - failed.length}/${results.length} assertions hold\n`);
process.exit(failed.length === 0 ? 0 : 1);

/* ------------------------------------------------------------------ helpers */

function round2(n) {
  return +n.toFixed(2);
}
/** The token's hex, as the browser would paint it — `#4a555e` → `rgb(74, 85, 94)`. */
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return hex;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
