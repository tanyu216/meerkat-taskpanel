#!/usr/bin/env node
/**
 * The create dialog's **box gutter and the two tracks it feeds**, measured on the
 * prototype and on the implementation in the same run and compared with each other.
 *
 * Why this file exists (the `rail-chip-overflow.mjs` / `combo-menu-geometry.mjs`
 * precedent): every gate in the tree measured only **one** side of this chain. The
 * implementation's track is pinned in `dom-smoke.mjs`'s R4 section against the
 * literal `405.391` — a number that is true of the prototype **only above 1152px**,
 * where `min(1120px, …)` stops binding. Below that the pin says nothing, and the two
 * trees did **not** agree: at 980 the routing column was `333.08` against the
 * prototype's `339.23` (D3, `workspace/T-20261016-121311`, re-measured by the card
 * `T-20261016-130046-2`). The prototype's own box rule is viewport-dependent
 * (`design/prototype/src/input.css` `.td-modal-box`: `min(1120px, calc(100vw - 32px))`,
 * and `calc(100vw - 16px)` at ≤760), so a constant can only ever be a coincidence —
 * the assertion has to be the two sides in one browser.
 *
 * **No magic numbers.** Every expected value here is read from a DOM in the same
 * process: nothing names 405.391, 339.23, 1120, 32 or 16. Two forms carry that:
 *
 *   · **the chain identity**, per side — `box − 2·border − 2·gutter − gap` equals the
 *     two tracks together, where `box` is the panel, `gutter` is the horizontal
 *     padding between the panel's border box and the grid's content box (the
 *     prototype puts it on `.td-modal-box`, the implementation on the grid — the sum
 *     is the quantity that has to agree), and `gap` is the grid's column gap. This is
 *     the arithmetic the prototype's own numbers satisfy, checked on each tree
 *     separately.
 *   · **the cross-tree equality** the card asks for — `|track_impl − track_proto| ≤ 0.5`
 *     at every viewport where the dialog is two-column (1512 / 1240 / 980). Above 760
 *     the "track" is a real column of the pair; at ≤760 both trees stack, so there is
 *     no pair to compare and the single column is *recorded* rather than asserted
 *     (see "the ≤760 band" below).
 *
 * **The ≤760 band.** The prototype's box has a second branch there (`calc(100vw - 16px)`
 * with `padding: 16px`) and the implementation's narrow dialog does not follow it: at
 * 760 the prototype's single column is `710px` against the implementation's `670px`.
 * That gap predates this leg and is **not** its subject — the card it was written for
 * is the two-column track at 980 — so the reading is printed and carried in the
 * artifact, and no assertion depends on it.
 *
 * Usage: node web/scripts/dialog-track-parity.mjs [options]
 *   --repo <dir>    tree to measure (default: this script's repository)
 *   --json <path>   write the full artifact
 *   --shots <dir>   also write the two 980px dialog captures (prototype / implementation)
 *
 * Exit: 0 every assertion holds; 1 at least one failed; 2 the leg could not run
 * (no Playwright, no `web/dist`, no `design/prototype/index.html`).
 *
 * Host-side on purpose: `docs/docker.md` §Host-allowed-checks keeps browser-rendered
 * frontend checks on the host because the image carries no Chromium — and the image
 * also drops `design/` (`.dockerignore`), so this leg **skips** there rather than
 * passing. The fixture board `dom-smoke.mjs` serves is the carrier; no database, no
 * daemon, no network.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ argv */

const argv = process.argv.slice(2);
const opt = { repo: resolve(HERE, "../.."), json: null, shots: null };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const take = (name) => (arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : argv[++i]);
  if (arg === "--repo" || arg.startsWith("--repo=")) opt.repo = resolve(take("--repo"));
  else if (arg === "--json" || arg.startsWith("--json=")) opt.json = resolve(take("--json"));
  else if (arg === "--shots" || arg.startsWith("--shots=")) opt.shots = resolve(take("--shots"));
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write("Usage: node web/scripts/dialog-track-parity.mjs [--repo <dir>] [--json <path>] [--shots <dir>]\n");
    process.exit(0);
  } else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

const REPO = opt.repo;
const DIST = join(REPO, "web/dist");
const PROTOTYPE = join(REPO, "design/prototype/index.html");

if (!existsSync(join(DIST, "index.html"))) {
  process.stderr.write(`no build at ${DIST} — run \`npm --prefix web run build\` first (the leg measures the shipped artifact, not the sources)\n`);
  process.exit(2);
}
if (!existsSync(PROTOTYPE)) {
  // The oracle is absent, so the comparison cannot be made. Skip (exit 2), never pass:
  // `design/` is dropped from the image by `.dockerignore`, and a green suite there
  // says nothing about this leg.
  process.stderr.write(`no prototype at ${PROTOTYPE} — the oracle is absent, the comparison cannot be made (skipped, not passed)\n`);
  process.exit(2);
}

const smoke = await import(pathToFileURL(join(REPO, "web/scripts/dom-smoke.mjs")).href);
const playwright = smoke.resolvePlaywright();
if (!playwright) {
  process.stderr.write("Playwright is not installed on this host — `resolvePlaywright()` found nothing\n");
  process.exit(2);
}

/**
 * The viewports, and which of them are two-column.
 *
 * 1512/1240 are above the 1152px where the prototype's `min(1120px, …)` binds (so they
 * are the control: two trees that already agreed); 980 is the card's; 760/430 are the
 * single-column band, read for the record.
 */
const VIEWPORTS = [
  { width: 1512, height: 950, pair: true },
  { width: 1240, height: 950, pair: true },
  { width: 980, height: 950, pair: true, card: true },
  { width: 760, height: 900, pair: false },
  { width: 430, height: 900, pair: false },
];

/* ------------------------------------------------------------- the readings */

/**
 * The implementation's chain. The panel is `[data-create-task-panel]`; the gutter is
 * the **grid's** own padding (`p-5`) because the implementation's viewport cap lives
 * on the overlay, not on a `.td-modal-box` (`design/fidelity-r10.md` §9.2).
 */
const READ_IMPL = () => {
  const r = (n) => Math.round(n * 100) / 100;
  const el = (sel) => document.querySelector(sel);
  const box = (sel) => {
    const node = el(sel);
    if (!node) return null;
    const b = node.getBoundingClientRect();
    return { x: r(b.x), width: r(b.width), right: r(b.right) };
  };
  const panel = el("[data-create-task-panel]");
  const grid = el("[data-create-two-col]");
  const overlay = el("[data-create-task]");
  const ps = panel ? getComputedStyle(panel) : null;
  const gs = grid ? getComputedStyle(grid) : null;
  const os = overlay ? getComputedStyle(overlay) : null;
  const de = document.documentElement;
  const columns = grid ? gs.gridTemplateColumns.split(" ").filter(Boolean) : [];
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlay: os ? { paddingLeft: r(parseFloat(os.paddingLeft)), paddingRight: r(parseFloat(os.paddingRight)), scrollWidth: overlay.scrollWidth, clientWidth: overlay.clientWidth } : null,
    panel: panel ? { ...box("[data-create-task-panel]"), paddingLeft: r(parseFloat(ps.paddingLeft)), paddingRight: r(parseFloat(ps.paddingRight)), borderLeft: r(parseFloat(ps.borderLeftWidth)), borderRight: r(parseFloat(ps.borderRightWidth)) } : null,
    grid: grid ? { ...box("[data-create-two-col]"), paddingLeft: r(parseFloat(gs.paddingLeft)), paddingRight: r(parseFloat(gs.paddingRight)), gap: r(parseFloat(gs.columnGap)), columns } : null,
    left: box("[data-create-left]"),
    right: box("[data-create-right]"),
    doc: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth },
  };
};

/**
 * The prototype's chain, read through the same shape. `.td-modal-box` carries the
 * gutter (its own 20px padding) and the viewport cap (its `width`), so the grid's
 * padding is 0 there — the *sum* is what both trees have to agree on.
 */
const READ_PROTO = () => {
  const r = (n) => Math.round(n * 100) / 100;
  const el = (sel) => document.querySelector(sel);
  const box = (sel) => {
    const node = el(sel);
    if (!node) return null;
    const b = node.getBoundingClientRect();
    return { x: r(b.x), width: r(b.width), right: r(b.right) };
  };
  const panel = el(".td-modal-box");
  const grid = el(".td-two-col");
  const overlay = el(".modal[open]") ?? el(".modal");
  const ps = panel ? getComputedStyle(panel) : null;
  const gs = grid ? getComputedStyle(grid) : null;
  const os = overlay ? getComputedStyle(overlay) : null;
  const de = document.documentElement;
  const columns = grid ? gs.gridTemplateColumns.split(" ").filter(Boolean) : [];
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlay: os ? { paddingLeft: r(parseFloat(os.paddingLeft)), paddingRight: r(parseFloat(os.paddingRight)), scrollWidth: overlay.scrollWidth, clientWidth: overlay.clientWidth } : null,
    panel: panel ? { ...box(".td-modal-box"), paddingLeft: r(parseFloat(ps.paddingLeft)), paddingRight: r(parseFloat(ps.paddingRight)), borderLeft: r(parseFloat(ps.borderLeftWidth)), borderRight: r(parseFloat(ps.borderRightWidth)) } : null,
    grid: grid ? { ...box(".td-two-col"), paddingLeft: r(parseFloat(gs.paddingLeft)), paddingRight: r(parseFloat(gs.paddingRight)), gap: r(parseFloat(gs.columnGap)), columns } : null,
    left: box(".td-col-left"),
    right: box(".td-col-right"),
    doc: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth },
  };
};

/* ------------------------------------------------------------------ output */

const results = [];
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) <= 0.5;

function suite(title) {
  process.stdout.write(`\n—— ${title}\n`);
}
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}\n`);
}

/**
 * The chain identity of one side: `box − 2·border − 2·gutter − gap` vs the track(s).
 *
 * `gutter` is the sum of the panel's and the grid's horizontal padding, because the
 * two trees put the box's 20px on different elements (the prototype's `.td-modal-box`
 * against the implementation's grid — `design/fidelity-r10.md` §9.2). A stacked
 * (single-column) grid has one track and no column gap, so the shared term drops out
 * rather than being counted twice.
 */
function chain(side) {
  const { panel, grid, left, right } = side;
  if (!panel || !grid || !left || !right) return null;
  const pair = grid.columns.length > 1;
  const border = panel.borderLeft + panel.borderRight;
  const gutter = panel.paddingLeft + grid.paddingLeft;
  const inner = panel.width - border - 2 * gutter - (pair ? grid.gap : 0);
  const tracks = pair ? left.width + right.width : right.width;
  return { pair, border, gutter, gap: grid.gap, panel: panel.width, inner: round2(inner), tracks: round2(tracks), delta: round2(inner - tracks) };
}

/* -------------------------------------------------------------------- run */

let server = null;
let browser = null;
const observed = [];
try {
  let port;
  ({ server, port } = await smoke.startServer());
  browser = await playwright.chromium.launch({ headless: true });
  const errors = [];

  for (const vp of VIEWPORTS) {
    // --- the implementation, over the fixture board -----------------------
    const implCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const implPage = await implCtx.newPage();
    implPage.on("pageerror", (err) => errors.push(`impl@${vp.width}: ${err}`));
    implPage.on("console", (msg) => { if (msg.type() === "error") errors.push(`impl@${vp.width} console: ${msg.text()}`); });
    await implPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await implPage.waitForSelector("[data-new-task]", { timeout: 20_000 });
    await implPage.waitForTimeout(400);
    // In-page click: the top bar's button is inside the shell's own responsive
    // layout, and an actionability wait on it costs the 30s the harness cannot spare.
    await implPage.evaluate(() => document.querySelector("[data-new-task]")?.click());
    await implPage.waitForSelector("[data-create-task] [data-create-task-panel]", { timeout: 10_000 });
    await implPage.waitForTimeout(400);
    const impl = await implPage.evaluate(READ_IMPL);
    if (opt.shots && vp.card) {
      mkdirSync(opt.shots, { recursive: true });
      await implPage.locator("[data-create-task-panel]").screenshot({ path: join(opt.shots, `dialog-impl-${vp.width}.png`) });
    }
    await implCtx.close();

    // --- the prototype, over file:// --------------------------------------
    const protoCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const protoPage = await protoCtx.newPage();
    protoPage.on("pageerror", (err) => errors.push(`proto@${vp.width}: ${err}`));
    protoPage.on("console", (msg) => { if (msg.type() === "error") errors.push(`proto@${vp.width} console: ${msg.text()}`); });
    await protoPage.goto(pathToFileURL(PROTOTYPE).href, { waitUntil: "load" });
    await protoPage.waitForSelector("[data-new-task]", { timeout: 20_000 });
    await protoPage.waitForTimeout(600);
    await protoPage.evaluate(() => document.querySelector("[data-new-task]")?.click());
    await protoPage.waitForSelector(".modal[open] .td-modal-box", { timeout: 10_000 });
    await protoPage.waitForTimeout(400);
    const proto = await protoPage.evaluate(READ_PROTO);
    if (opt.shots && vp.card) {
      mkdirSync(opt.shots, { recursive: true });
      await protoPage.locator(".td-modal-box").screenshot({ path: join(opt.shots, `dialog-proto-${vp.width}.png`) });
    }
    await protoCtx.close();

    const window_ = { width: vp.width, height: vp.height, pair: vp.pair, card: Boolean(vp.card) };
    const implChain = chain(impl);
    const protoChain = chain(proto);
    const row = {
      ...window_,
      impl,
      proto,
      chain: { impl: implChain, proto: protoChain },
      trackDelta: impl.right && proto.right ? round2(impl.right.width - proto.right.width) : null,
      panelDelta: impl.panel && proto.panel ? round2(impl.panel.width - proto.panel.width) : null,
      gutter: { impl: implChain?.gutter ?? null, proto: protoChain?.gutter ?? null },
      gap: { impl: implChain?.gap ?? null, proto: protoChain?.gap ?? null },
    };
    observed.push(row);

    suite(`${vp.width}×${vp.height} — ${vp.pair ? "two-column" : "single column"}${vp.card ? " (the card's viewport)" : ""}`);
    check(
      `读得到两侧的面板与轨道（impl ${impl.right?.width ?? "—"} / proto ${proto.right?.width ?? "—"}）`,
      Boolean(impl.panel && impl.grid && impl.right && proto.panel && proto.grid && proto.right),
      "",
    );

    // The chain identity, per side, from that side's own DOM.
    for (const [name, , c] of [["impl", impl, implChain], ["proto", proto, protoChain]]) {
      if (c === null) continue;
      check(
        `${name} 链恒等式 box(${c.panel}) − 2·border(${c.border}) − 2·gutter(${c.gutter}) − gap(${c.pair ? c.gap : 0}) = ${c.pair ? "轨道和" : "单列宽"}`,
        near(c.inner, c.tracks),
        `${c.inner} vs ${c.tracks}（Δ ${c.delta}）`,
      );
    }

    if (vp.pair) {
      // The gutter and the gap are the same quantity on the two sides — the container
      // difference the card is about is exactly one of them.
      check(
        `两侧 gutter 同一值（impl ${row.gutter.impl} · proto ${row.gutter.proto}）`,
        row.gutter.impl !== null && row.gutter.impl === row.gutter.proto,
        "",
      );
      check(
        `两侧列间距同一值（impl ${row.gap.impl} · proto ${row.gap.proto}）`,
        row.gap.impl !== null && row.gap.impl === row.gap.proto,
        "",
      );

      // The card's assertion — exported, no constant: the implementation's track
      // against the prototype's, both read in this run.
      check(
        `|track_impl − track_proto| ≤ 0.5（${row.trackDelta >= 0 ? "+" : ""}${row.trackDelta}）`,
        near(impl.right.width, proto.right.width),
        `面板 ${impl.panel.width} vs ${proto.panel.width}（Δ ${row.panelDelta}）· 左轨 ${impl.left.width} vs ${proto.left.width}`,
      );
      check(
        `|track_left_impl − track_left_proto| ≤ 0.5`,
        near(impl.left.width, proto.left.width),
        `${impl.left.width} vs ${proto.left.width}`,
      );
      check(
        `|panel_impl − panel_proto| ≤ 0.5`,
        near(impl.panel.width, proto.panel.width),
        `${impl.panel.width} vs ${proto.panel.width}`,
      );
      check(
        `轨道比两侧一致（${round2(impl.left.width / impl.right.width)} vs ${round2(proto.left.width / proto.right.width)}）`,
        near(impl.left.width / impl.right.width, proto.left.width / proto.right.width),
        "",
      );
    }

    // Viewport hygiene, both sides: the outer container must not scroll sideways.
    check(
      `无横向溢出（impl ${impl.doc.scrollWidth}/${impl.doc.clientWidth} · proto ${proto.doc.scrollWidth}/${proto.doc.clientWidth}）`,
      impl.doc.scrollWidth <= impl.doc.clientWidth + 1 && proto.doc.scrollWidth <= proto.doc.clientWidth + 1,
      "",
    );
    if (impl.overlay) {
      check(
        `弹窗覆盖层自身不横向滚动（${impl.overlay.scrollWidth} ≤ ${impl.overlay.clientWidth}）`,
        impl.overlay.scrollWidth <= impl.overlay.clientWidth + 1,
        "",
      );
    }
  }

  suite("硬门");
  check("console/page error = 0（两侧、五视口）", errors.length === 0, errors.slice(0, 4).join(" | "));

  if (opt.json) {
    writeFileSync(opt.json, `${JSON.stringify({ repo: REPO, prototype: PROTOTYPE, viewports: observed, results }, null, 2)}\n`);
    process.stdout.write(`\nwrote ${opt.json}\n`);
  }
} catch (err) {
  await browser?.close().catch(() => {});
  server?.close();
  // Only a leg that *means* "cannot run" exits 2 — `test/web/blocks.dom.test.mjs`
  // reads 2 as a skip and prints the reason. A runtime failure (a timeout because
  // the dialog never rendered, a protocol error) is a **red**: `dom-smoke.mjs`'s
  // own handler is the family's shape (`SKIP` ⇒ 2, anything else ⇒ 1), and a leg
  // whose failure modes quietly become "skipped" is the one thing this suite's
  // wrapper exists to prevent.
  if (err?.code === "SKIP") process.exit(2);
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
}

await browser.close().catch(() => {});
server.close();

const failed = results.filter((result) => !result.ok);
const card = observed.find((row) => row.card);
process.stdout.write(
  `\ncreate dialog track parity: ${results.length - failed.length}/${results.length} assertions hold` +
    (card ? `\n  @980 track_impl ${card.impl.right.width} vs track_proto ${card.proto.right.width} (Δ ${card.trackDelta})` : "") +
    `\n  ≤760 band (recorded, not asserted — registered residual): ` +
    observed
      .filter((row) => !row.pair)
      .map((row) => `${row.width}px single column impl ${row.impl.right.width} / proto ${row.proto.right.width} (Δ ${round2(row.impl.right.width - row.proto.right.width)}), gutter ${row.gutter.impl}/${row.gutter.proto}, gap ${row.gap.impl}/${row.gap.proto}`)
      .join(" · ") +
    "\n",
);
process.exit(failed.length === 0 ? 0 : 1);
