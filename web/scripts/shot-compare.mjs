/**
 * Prototype ↔ implementation screenshot comparison (M6b · F3).
 *
 * Captures the **prototype** (`design/prototype/index.html`, opened over `file://`) and
 * the **built implementation** (`web/dist`, served against the same fixture API
 * the DOM smoke uses) at identical viewport / theme / language, writes a
 * side-by-side sheet per combination, and re-runs the machine check in the same
 * pass.
 *
 * ── Comparison basis (Elon's O7 ruling) ──────────────────────────────────────
 * **Structural + geometric machine check, plus human review. NO pixel diff.**
 * The prototype is jQuery + static HTML and the implementation is a Vue SPA;
 * pixel equality is unattainable and a diff would only produce noise. What this
 * script asserts instead is machine-checkable and geometry-checkable:
 *
 *   * every browser-layer block-contract rule (the same rules the DOM smoke
 *     drives, reused from `./dom-smoke.mjs`, not re-implemented; the count is
 *     whatever the contract declares — the run prints it),
 *   * `console errors = 0` and `page errors = 0`,
 *   * `documentElement.scrollWidth <= clientWidth + 1` at every captured
 *     viewport, for both sides.
 *
 * On top of those it runs one **geometric divergence probe** that the unit
 * contract cannot express: it records, per side, every element whose own content
 * is wider than the box that clips it, and reports the **asymmetry** between the
 * two sides. Symmetric clipping is by definition shared intent (the board's
 * horizontal scroller, a visually-hidden label); a key present on one side only
 * is a layout divergence worth a human's eyes. Ignoring the `sr-only`/`td-sr`
 * names is deliberate: they differ between the two codebases, so the probe drops
 * any 1–2px box instead of matching on a class name.
 *
 * That probe is **non-gating by default** — the acceptance bar is the three
 * checks above — but it is printed under its own heading and recorded in
 * `report.json`. `--strict` promotes it to a failure, with one declared
 * exception list (`APPROVED_DIVERGENCES`) for asymmetries a design round has
 * already ruled on in writing; those are filed separately, still printed and
 * still recorded, never silently dropped.
 *
 * ── Prototype driving ────────────────────────────────────────────────────────
 * `design/prototype/app.js` persists nothing: it boots at light/en from its own markup
 * and switches by click. So the prototype is *driven* (a programmatic click on
 * `[data-theme-switch]` / `[data-lang-option]`, which is what its delegated
 * handlers listen for) — the implementation is *seeded* (its two `localStorage`
 * keys are written before the first paint, via `addInitScript`). Both end in the
 * same declared state, which is asserted and reported per shot.
 * The theme cycle is light → dark → auto, so `dark` is one press.
 *
 * ── Placement ────────────────────────────────────────────────────────────────
 * Under `web/scripts/`, not `test/`, so `node --test` never collects it. The
 * output goes to the review workspace OUTSIDE the repository — the shots are review
 * artefacts and are deliberately **not** committed — so the directory must be given:
 * `--out=<dir>` or `SHOT_OUT`. There is no default, because the workspace path is a
 * property of the machine the review runs on, not of this checkout. Playwright is a
 * host tool resolved from an already-installed location, exactly as `dom-smoke.mjs`
 * does; the image carries no browser, so inside the container this exits 2 ("skip") —
 * rendering is a host-allowed exception (plan §9.1 exception 4; `docs/docker.md`).
 *
 * Usage: node web/scripts/shot-compare.mjs --out=<dir> [--json] [--strict]
 * Exit:  0 = captured + every check green · 1 = a check or a capture failed, or the
 *        invocation was wrong (no `--out`) · 2 = skip (no browser, no `web/dist`, no
 *        prototype) — the same split `dom-smoke.mjs` uses
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DIST, EVALUATED_RULES, resolvePlaywright, run as runDomSmoke, startServer } from "./dom-smoke.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const PROTOTYPE = resolve(WEB, "../design/prototype/index.html");

/**
 * Review artefacts belong to the task workspace, never to the repository — and that
 * workspace lives outside this checkout, so there is no portable default path. The
 * output directory is therefore **required** (`--out <dir>` or `SHOT_OUT`); `main`
 * refuses a run without one rather than inventing a path that exists on one machine.
 */
const DEFAULT_OUT = process.env.SHOT_OUT ?? null;

/** Every shot is a viewport (non-full-page) capture: the board is a fixed shell. */
const HEIGHT = 950;
/** Matches the prototype's own screenshot convention (`design/prototype/screenshots/*`). */
const DEVICE_SCALE = 2;

/**
 * The five widths the acceptance names — `1512 / 1240 / 980 / 760 / 430`, the
 * same five widths the review matrix uses.
 *
 * The fifth was `500`, one tier the tool had invented: no other surface in the
 * repo names it, so the narrowest band the acceptance actually reviews (`430`,
 * and with it the ≤559 rules it is the boundary of) had never been captured by
 * this script at all.
 */
const VIEWPORTS = Object.freeze([1512, 1240, 980, 760, 430]);

/** The prototype's own cycle order — its `data-theme-mode` starts at `light`. */
const PROTOTYPE_THEME_CYCLE = Object.freeze(["light", "dark", "auto"]);

/**
 * The combination matrix. Every requirement of the acceptance is here: light-en
 * at all five viewports, dark-en at 1512, light-zh at 1512.
 */
const COMBINATIONS = Object.freeze([
  Object.freeze({ id: "light-en", theme: "light", lang: "en", viewports: VIEWPORTS }),
  Object.freeze({ id: "dark-en", theme: "dark", lang: "en", viewports: Object.freeze([1512]) }),
  Object.freeze({ id: "light-zh", theme: "light", lang: "zh", viewports: Object.freeze([1512]) }),
  // R12x · B26 / B27 — the two new destinations have states of their own: each is
  // reached by a press, on both sides, so the pair captures that view rather than
  // the board behind it.
  Object.freeze({ id: "light-en-activity", theme: "light", lang: "en", view: "activity", viewports: VIEWPORTS }),
  Object.freeze({ id: "light-en-waiting", theme: "light", lang: "en", view: "waiting", viewports: VIEWPORTS }),
]);

/**
 * Asymmetries the design has **already ruled on, in writing**.
 *
 * The divergence probe below reports any clipping key one side owns and the other
 * does not, on the reasoning that whatever *both* sides clip is shared intent —
 * which is why the board's own horizontal scroller never appears here (the
 * prototype has one too). `--strict` fails the run on the rest.
 *
 * R12 is the one case where the two sides are *required* to differ: the contract
 * rules the filters bar to be one line at every tier with its own overflow policy
 * (`design/fidelity-r12-supplement.md` §2.1, ruling R-2 / Elon's ②, card
 * `T-20261013-023722`), against a prototype that wraps that row at 430. The bar
 * therefore clips its own row on the implementation side only, at 430 only — and
 * the contract's A4 asserts precisely that (`[data-filters].scrollWidth >
 * clientWidth`, with the document still free of horizontal overflow).
 *
 * This is a **declared exception, not a mute**. It names one selector and one
 * width; it cites the ruling; a match is still recorded in `report.json` under
 * `approvedDivergences` and printed by `printSummary`; and everything it does not
 * name — including the same selector at any other width — still fails `--strict`.
 */
const APPROVED_DIVERGENCES = Object.freeze([
  Object.freeze({
    width: 430,
    selector: "section[data-filters]",
    ruling: "design/fidelity-r12-supplement.md §2.1 (d) / R-2 — the bar is one line with its own scroller (card T-20261013-023722)",
  }),
]);

/** Is this implementation-only clipping key one the design has ruled on? */
function isApprovedDivergence(width, key) {
  return APPROVED_DIVERGENCES.some((entry) => entry.width === width && entry.selector === key);
}

/* ------------------------------------------------------------------ helpers */

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, json: argv.includes("--json"), strict: argv.includes("--strict") };
  argv.forEach((arg, index) => {
    if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--out" && argv[index + 1]) opts.out = argv[index + 1];
  });
  return opts;
}

const skip = (message) => Object.assign(new Error(message), { code: "SKIP" });

/**
 * A bad invocation is neither a skip nor a check failure. Same exit code as any other
 * failure (1 — `2` means "skip" in this family, see `dom-smoke.mjs`), but the message is
 * printed on its own: a missing `--out` is a thing to read and fix, not a stack to scroll.
 */
const usage = (message) => Object.assign(new Error(message), { code: "USAGE" });

/** `documentElement` horizontal-overflow — the geometric assertion. */
const measureOverflow = () => {
  const de = document.documentElement;
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, ok: de.scrollWidth <= de.clientWidth + 1 };
};

/** The document-level state a reviewer would check by eye, read back as data. */
const readDocState = () => ({
  themeMode: document.documentElement.getAttribute("data-theme-mode"),
  themeAttr: document.documentElement.getAttribute("data-theme"),
  lang: document.documentElement.getAttribute("lang"),
  columns: document.querySelectorAll("[data-column]").length,
  cards: document.querySelectorAll("[data-card]").length,
});

/**
 * A stable name for one element: `tag[data-hook]` where it has a `data-*`
 * attribute, else `tag.firstClass.secondClass`.
 *
 * The probe prefers the element's own hook because the board's conventions require
 * checks to key on `data-*` rather than on a class, and M3 moved its surfaces onto
 * hooks. Naming by class made this list
 * churn on a refactor that changed no layout at all: the same board box printed
 * as `div.td-board` before and `div.flex.h-full` after.
 *
 * Both collectors below inline this as `nameOf` rather than calling a helper,
 * because Playwright ships a `page.evaluate`d function on its own: anything it
 * closes over outside its own body does not exist in the page.
 */
/**
 * Every element whose own content is wider than the box that clips it, named by
 * `nameOf` and deduplicated.
 *
 * Boxes 2px or smaller are dropped: that is the visually-hidden-text idiom
 * (`sr-only` here, `td-sr` in the prototype), which is intentional and whose
 * class names deliberately differ between the two codebases — so it is filtered
 * by geometry, not by name.
 */
function collectClipped() {
  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const hook = Array.from(el.attributes)
      .map((attr) => attr.name)
      .find((name) => name.startsWith("data-"));
    if (hook) return `${tag}[${hook}]`;
    const classes = Array.from(el.classList).slice(0, 2).join(".");
    return `${tag}${classes ? `.${classes}` : ""}`;
  };
  const found = new Set();
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    if (el.clientWidth <= 2 || el.clientHeight <= 2) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    found.add(nameOf(el));
  }
  return [...found].sort();
}

/**
 * `collectClipped` scoped to one subtree, the root included. Used for the
 * sidebar rail parity check: the prototype's rail clips nothing, so any clipped
 * key the implementation's rail owns and the prototype's does not is a rail that
 * is hiding text instead of dropping it.
 */
function collectClippedWithin(selector) {
  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const hook = Array.from(el.attributes)
      .map((attr) => attr.name)
      .find((name) => name.startsWith("data-"));
    if (hook) return `${tag}[${hook}]`;
    const classes = Array.from(el.classList).slice(0, 2).join(".");
    return `${tag}${classes ? `.${classes}` : ""}`;
  };
  const root = document.querySelector(selector);
  if (!root) return [];
  const found = new Set();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    if (el.clientWidth <= 2 || el.clientHeight <= 2) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    found.add(nameOf(el));
  }
  return [...found].sort();
}

/**
 * The two boxes O1/O3 are about: the top bar's height (a bar that has folded to
 * more rows than the prototype) and the sidebar's width (the rail must be the
 * same width as the prototype's). Runs in the page.
 */
function measureGeometry() {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  return { topbar: box("[data-topbar]"), sidebar: box("[data-sidebar]") };
}

/** Attach the zero-error collectors every capture shares. */
function watchErrors(page, sink) {
  page.on("console", (msg) => {
    if (msg.type() === "error") sink.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message ?? String(err)}`));
}

/* ------------------------------------------------- implementation · seeded */

async function shootImplementation(browser, url, combo, width, outDir) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: DEVICE_SCALE });
  // Seed the two browser-local keys before the first paint: `web/src/main.js`
  // reads them synchronously on boot, so the shell never flashes the wrong
  // scheme or the wrong copy.
  await context.addInitScript(
    ([theme, lang]) => {
      globalThis.localStorage?.setItem("meerkat-taskpanel.theme", theme);
      globalThis.localStorage?.setItem("meerkat-taskpanel.lang", lang);
    },
    [combo.theme, combo.lang],
  );

  const errors = [];
  const page = await context.newPage();
  watchErrors(page, errors);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-column]", { timeout: 20_000 });
    await page.waitForTimeout(700); // settle the SSE-connected revision + fonts
    // Both new destinations are entered by the same press on the same nav item,
    // and the row that appears is what says the view landed (the feed is read
    // when its view is entered; the queue's rows come with the board's tasks).
    if (combo.view === "activity" || combo.view === "waiting") {
      await page.click(`[data-nav-item="${combo.view}"]`);
      await page.waitForSelector(combo.view === "activity" ? "[data-activity-row]" : "[data-waiting-item]", { timeout: 20_000 });
      await page.waitForTimeout(400);
    }

    const overflow = await page.evaluate(measureOverflow);
    const state = await page.evaluate(readDocState);
    const clipped = await page.evaluate(collectClipped);
    const geometry = await page.evaluate(measureGeometry);
    const sidebarClipped = await page.evaluate(collectClippedWithin, "[data-sidebar]");
    const file = join(outDir, `impl-${combo.id}-${width}.png`);
    await page.screenshot({ path: file });
    return { file, overflow, state, clipped, geometry, sidebarClipped, errors };
  } finally {
    await context.close();
  }
}

/* --------------------------------------------------- prototype · driven -- */

async function shootPrototype(browser, combo, width, outDir) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: DEVICE_SCALE });
  const errors = [];
  const page = await context.newPage();
  watchErrors(page, errors);
  try {
    await page.goto(pathToFileURL(PROTOTYPE).href, { waitUntil: "load" });
    await page.waitForSelector("[data-column]", { timeout: 20_000 });
    await page.waitForTimeout(700);

    // Drive the theme cycle with programmatic clicks: the delegated handler runs
    // regardless of whether the sidebar footer control is laid out at this width.
    const presses = PROTOTYPE_THEME_CYCLE.indexOf(combo.theme);
    for (let i = 0; i < presses; i++) {
      await page.evaluate(() => document.querySelector("[data-theme-switch]")?.click());
      await page.waitForTimeout(100);
    }
    if (combo.lang !== "en") {
      await page.evaluate((lang) => document.querySelector(`[data-lang-option="${lang}"]`)?.click(), combo.lang);
    }

    // Both switches raise a toast (prototype `toast()` removes it at 2500ms +
    // 200ms). Wait it out so the shot shows the settled board, not the notice —
    // the implementation, seeded before paint, shows no toast at all.
    await page.waitForTimeout(3300);

    // R12x · B26 / B27 — the same press the implementation side makes, so the
    // pair is one state: `setView(view)` is what puts the view on screen. The
    // press is programmatic because the nav item is inside the sidebar's own
    // scroll container, which is not always laid out at these widths.
    if (combo.view === "activity" || combo.view === "waiting") {
      await page.evaluate((view) => document.querySelector(`[data-nav-item="${view}"]`)?.click(), combo.view);
      await page.waitForTimeout(400);
    }

    const overflow = await page.evaluate(measureOverflow);
    const state = await page.evaluate(readDocState);
    const clipped = await page.evaluate(collectClipped);
    const geometry = await page.evaluate(measureGeometry);
    const sidebarClipped = await page.evaluate(collectClippedWithin, "[data-sidebar]");
    const file = join(outDir, `proto-${combo.id}-${width}.png`);
    await page.screenshot({ path: file });
    return { file, overflow, state, clipped, geometry, sidebarClipped, errors };
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------- side-by-side sheet */

function sheetHtml({ combo, width, prototypeName, implementationName, prototypeShot, implementationShot }) {
  const cell = (o) =>
    o.ok
      ? "no overflow"
      : `<span class="bad">OVERFLOW — scrollWidth ${o.scrollWidth} &gt; clientWidth ${o.clientWidth}</span>`;
  // The two cards sit side by side with a gap, wrap padding and a border each.
  const sheetWidth = width * 2 + 110;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${combo.id} · ${width} — prototype vs implementation</title>
<style>
  body { margin:0; background:#0f1115; color:#e7e9ee;
         font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { display:inline-block; padding:20px 24px 24px; }
  h1 { margin:0 0 4px; font-size:16px; font-weight:650; letter-spacing:.2px; }
  .sub { margin:0 0 16px; color:#9aa3b2; font-size:12px; }
  .cols { display:flex; gap:18px; align-items:flex-start; }
  figure { margin:0; }
  figcaption { padding:0 0 8px; font-size:12px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
  figcaption .src { color:#9aa3b2; font-weight:400; letter-spacing:0; text-transform:none; }
  img { display:block; border:1px solid #2b303b; border-radius:6px; background:#fff; }
  .geo { margin:16px 0 0; color:#9aa3b2; font-size:12px; }
  code { color:#cfd6e4; background:#1a1e26; padding:1px 6px; border-radius:4px; }
  .bad { color:#ff8f8f; }
</style></head>
<body><div class="wrap">
  <h1>${combo.id} · ${width}px — prototype vs implementation</h1>
  <p class="sub">Same viewport, theme and language. Structural / geometric comparison + human review —
     <strong>no pixel diff</strong> (O7). Captured at ${width}×${HEIGHT} CSS px, deviceScaleFactor ${DEVICE_SCALE}, shown here at 1×.</p>
  <div class="cols">
    <figure>
      <figcaption>Prototype <span class="src">design/prototype/index.html · file://</span></figcaption>
      <img src="${prototypeName}" width="${width}" alt="prototype ${combo.id} ${width}">
    </figure>
    <figure>
      <figcaption>Implementation <span class="src">web/dist · served</span></figcaption>
      <img src="${implementationName}" width="${width}" alt="implementation ${combo.id} ${width}">
    </figure>
  </div>
  <p class="geo">overflow — prototype: <code>${cell(prototypeShot.overflow)}</code>
     · implementation: <code>${cell(implementationShot.overflow)}</code></p>
</div></body></html>`;
}

async function makeSheet(browser, outDir, combo, width, prototypeShot, implementationShot) {
  const prototypeName = `proto-${combo.id}-${width}.png`;
  const implementationName = `impl-${combo.id}-${width}.png`;
  // Written beside the two halves so the relative <img src> resolves over file://,
  // screenshotted, then removed — the directory keeps the PNGs and nothing else.
  const temp = join(outDir, `.sheet-${combo.id}-${width}.html`);
  const file = join(outDir, `side-by-side-${combo.id}-${width}.png`);
  writeFileSync(temp, sheetHtml({ combo, width, prototypeName, implementationName, prototypeShot, implementationShot }), "utf8");

  const context = await browser.newContext({ viewport: { width: width * 2 + 110, height: 400 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(temp).href, { waitUntil: "load" });
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } finally {
    await context.close();
    rmSync(temp, { force: true });
  }
}

/* -------------------------------------------------------------------- main */

async function main(opts) {
  if (typeof opts.out !== "string" || opts.out.trim() === "") {
    throw usage(
      "no output directory: pass --out <dir>, or set SHOT_OUT.\n" +
        "Review artefacts belong to the task workspace, which is outside this repository,\n" +
        "so there is no in-repo default to fall back to.\n" +
        "Usage: node web/scripts/shot-compare.mjs --out=<dir> [--json] [--strict]",
    );
  }
  if (!existsSync(join(DIST, "index.html"))) throw skip(`web/dist is not built — run \`npm -w web run build\` (looked in ${DIST})`);
  if (!existsSync(PROTOTYPE)) throw skip(`the prototype baseline is missing: ${PROTOTYPE}`);
  const playwright = resolvePlaywright();
  if (!playwright) throw skip("Playwright is not installed on this host");
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    throw skip(`could not launch Chromium: ${err.message}`);
  }

  mkdirSync(opts.out, { recursive: true });
  const matrix = [];
  const captureErrors = { implementation: [], prototype: [] };
  const problems = [];
  const layoutDivergences = [];
  const approvedDivergences = [];
  const geometryParity = [];

  const { server, port } = await startServer();
  try {
    const url = `http://127.0.0.1:${port}/`;
    for (const combo of COMBINATIONS) {
      for (const width of combo.viewports) {
        try {
          // Prototype first: both halves are independent pages on the same browser.
          const prototypeShot = await shootPrototype(browser, combo, width, opts.out);
          const implementationShot = await shootImplementation(browser, url, combo, width, opts.out);
          const sheet = await makeSheet(browser, opts.out, combo, width, prototypeShot, implementationShot);

          captureErrors.prototype.push(...prototypeShot.errors);
          captureErrors.implementation.push(...implementationShot.errors);

          const stateMatches =
            implementationShot.state.themeMode === combo.theme &&
            implementationShot.state.lang === combo.lang &&
            implementationShot.state.columns === 7;
          if (!stateMatches) problems.push(`${combo.id}@${width}: implementation state ${JSON.stringify(implementationShot.state)} != ${combo.theme}/${combo.lang}`);
          if (!implementationShot.overflow.ok) problems.push(`${combo.id}@${width}: implementation overflows horizontally`);
          if (!prototypeShot.overflow.ok) problems.push(`${combo.id}@${width}: the prototype baseline overflows horizontally — the two sides are not being compared on a fair viewport`);

          // Asymmetry, not clipping: whatever both sides clip is shared intent.
          const prototypeClipped = new Set(prototypeShot.clipped);
          const implementationClipped = new Set(implementationShot.clipped);
          const implementationOnly = implementationShot.clipped.filter((s) => !prototypeClipped.has(s));
          const prototypeOnly = prototypeShot.clipped.filter((s) => !implementationClipped.has(s));
          // …and the asymmetry the design has already ruled on is filed apart
          // (see APPROVED_DIVERGENCES): it is still recorded and printed, it
          // just does not fail `--strict`. Everything unnamed does.
          const approved = implementationOnly.filter((key) => isApprovedDivergence(width, key));
          const unapprovedImplementationOnly = implementationOnly.filter((key) => !isApprovedDivergence(width, key));
          if (approved.length) approvedDivergences.push({ combination: combo.id, width, implementationOnly: approved });
          if (unapprovedImplementationOnly.length || prototypeOnly.length) {
            layoutDivergences.push({ combination: combo.id, width, implementationOnly: unapprovedImplementationOnly, prototypeOnly });
          }

          // --- geometric parity (O1/O3) — gating, unlike the probe above ----
          // The probe above reports *asymmetry* non-gating; these three compare
          // the boxes the two observations are about and fail the run on a miss:
          //   * the top bar may not have folded to more rows than the prototype
          //     (O3) — a row costs ~30px, so an 8px ceiling catches a fold;
          //   * the sidebar rail must be the prototype's width (O1);
          //   * the sidebar must clip nothing the prototype does not — a rail
          //     that hides text by clipping it rather than dropping it (O1).
          const protoTopbar = prototypeShot.geometry.topbar?.height ?? null;
          const implTopbar = implementationShot.geometry.topbar?.height ?? null;
          const protoRail = prototypeShot.geometry.sidebar?.width ?? null;
          const implRail = implementationShot.geometry.sidebar?.width ?? null;
          const sidebarImplementationOnly = implementationShot.sidebarClipped.filter((s) => !prototypeShot.sidebarClipped.includes(s));

          if (implTopbar !== null && protoTopbar !== null && implTopbar > protoTopbar + 8) {
            problems.push(`${combo.id}@${width}: topbar folded — impl ${implTopbar}px > proto ${protoTopbar}px + 8px`);
          }
          if (implRail !== null && protoRail !== null && Math.abs(implRail - protoRail) > 2) {
            problems.push(`${combo.id}@${width}: sidebar width ${implRail}px != proto ${protoRail}px (±2)`);
          }
          if (sidebarImplementationOnly.length) {
            problems.push(`${combo.id}@${width}: sidebar clips content the prototype does not — ${sidebarImplementationOnly.join(", ")}`);
          }

          geometryParity.push({
            combination: combo.id,
            width,
            topbarHeight: { implementation: implTopbar, prototype: protoTopbar },
            sidebarWidth: { implementation: implRail, prototype: protoRail },
            sidebarClipped: { implementation: implementationShot.sidebarClipped, prototype: prototypeShot.sidebarClipped },
            sidebarImplementationOnly,
          });

          matrix.push({
            combination: combo.id,
            theme: combo.theme,
            lang: combo.lang,
            width,
            prototype: { file: prototypeShot.file, overflow: prototypeShot.overflow, state: prototypeShot.state, clipped: prototypeShot.clipped },
            implementation: { file: implementationShot.file, overflow: implementationShot.overflow, state: implementationShot.state, clipped: implementationShot.clipped },
            sheet,
          });
        } catch (err) {
          problems.push(`${combo.id}@${width}: capture failed — ${err.message}`);
        }
      }
    }
  } finally {
    server.close();
    await browser.close();
  }

  // --- the machine check, re-run in this same pass ---------------------------
  // `run()` is `dom-smoke.mjs`'s own entry point: the fixture server, every
  // browser-layer rule, the error counters and the five-viewport overflow
  // assertion, exactly what the acceptance names. Reused, never re-implemented.
  let machine = null;
  try {
    machine = await runDomSmoke();
  } catch (err) {
    if (err.code !== "SKIP") throw err;
    problems.push(`machine check unavailable: ${err.message}`);
  }

  const implementationOverflow = matrix.map((m) => ({ width: m.width, ...m.implementation.overflow }));

  const report = {
    generator: "web/scripts/shot-compare.mjs",
    basis: "structural + geometric machine check + human review; no pixel diff (O7)",
    prototype: PROTOTYPE,
    implementation: `web/dist served against the dom-smoke fixture API`,
    viewports: VIEWPORTS,
    deviceScaleFactor: DEVICE_SCALE,
    height: HEIGHT,
    combinations: COMBINATIONS.map((c) => ({ id: c.id, theme: c.theme, lang: c.lang, viewports: c.viewports })),
    shots: matrix,
    captureErrors,
    layoutDivergences,
    approvedDivergences,
    geometryParity,
    problems,
    machineCheck: machine && {
      rules: { total: machine.counts.rules, failed: machine.counts.failed, expected: EVALUATED_RULES.length },
      consoleErrors: machine.consoleErrors,
      pageErrors: machine.pageErrors,
      ruleFailures: machine.failures,
      viewports: machine.viewports,
      interactions: machine.interactions,
      geometry: machine.geometry,
    },
    implementationOverflow,
  };

  writeFileSync(join(opts.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

/* ------------------------------------------------------------------ output */

function printSummary(report) {
  const m = report.machineCheck;
  console.log(`combinations: ${report.combinations.map((c) => `${c.id}[${c.viewports.join(",")}]`).join(" ")}`);
  console.log(`shots: ${report.shots.length} pairs + ${report.shots.length} side-by-side sheets -> ${report.shots[0]?.sheet ? dirname(report.shots[0].sheet) : ""}`);
  console.log("");
  console.log("── machine check ─────────────────────────────────────────");
  if (m) {
    const declared = m.rules.total === m.rules.expected ? "" : ` (the contract declares ${m.rules.expected} — mismatch!)`;
    console.log(`contract rules (browser layer): ${m.rules.total - m.rules.failed}/${m.rules.total} passed${declared}`);
    console.log(`console errors: ${m.consoleErrors.length}`);
    console.log(`page errors:    ${m.pageErrors.length}`);
    for (const e of [...m.consoleErrors, ...m.pageErrors]) console.log(`  ! ${e}`);
    for (const f of m.ruleFailures) console.log(`  ✗ ${f.block} ${f.kind} ${f.selector ?? ""} — ${f.detail}`);
    console.log(`interactions:   ${JSON.stringify(m.interactions)}`);
  } else {
    console.log("machine check: unavailable");
  }
  console.log("");
  console.log("── per-viewport horizontal overflow (captured shots) ──────");
  for (const shot of report.shots) {
    const flag = (o) => (o.ok ? "ok" : `OVERFLOW ${o.scrollWidth}>${o.clientWidth}`);
    console.log(
      `  ${shot.combination}@${shot.width}  proto ${flag(shot.prototype.overflow)}  impl ${flag(shot.implementation.overflow)}` +
        `  (${shot.implementation.state.columns} cols, ${shot.implementation.state.cards} cards, data-theme-mode=${shot.implementation.state.themeMode}, lang=${shot.implementation.state.lang})`,
    );
  }
  console.log("");
  console.log("── geometric parity (gating: topbar rows · rail width · rail clipping) ──");
  for (const g of report.geometryParity) {
    const t = `topbar ${g.topbarHeight.implementation}/${g.topbarHeight.prototype}`;
    const r = `rail ${g.sidebarWidth.implementation}/${g.sidebarWidth.prototype}`;
    const clip = g.sidebarImplementationOnly.length ? `  ✗ impl-only clipped: ${g.sidebarImplementationOnly.join(", ")}` : "";
    console.log(`  ${g.combination}@${g.width}  ${t}  ${r} (impl/proto)${clip}`);
  }
  console.log("");
  console.log("── prototype ↔ implementation layout divergences ──────────");
  if (!report.layoutDivergences.length) {
    console.log("  none — both sides clip the same elements (structure matches geometrically)");
  } else {
    for (const d of report.layoutDivergences) {
      for (const key of d.implementationOnly) console.log(`  ✗ ${d.combination}@${d.width}  implementation only: ${key}`);
      for (const key of d.prototypeOnly) console.log(`  ✗ ${d.combination}@${d.width}  prototype only:       ${key}`);
    }
    console.log("  (non-gating: the acceptance bar is the three checks above. `--strict` fails on these.)");
  }
  if (report.approvedDivergences.length) {
    console.log("");
    console.log("── declared deviations (recorded, not gated) ──────────────");
    for (const d of report.approvedDivergences) {
      for (const key of d.implementationOnly) {
        const entry = APPROVED_DIVERGENCES.find((a) => a.width === d.width && a.selector === key);
        console.log(`  · ${d.combination}@${d.width}  implementation only: ${key} — ${entry?.ruling ?? "declared"}`);
      }
    }
  }
  console.log("");
  console.log("── capture-time errors ───────────────────────────────────");
  console.log(`implementation: ${report.captureErrors.implementation.length}`);
  for (const e of report.captureErrors.implementation) console.log(`  ! ${e}`);
  console.log(`prototype:      ${report.captureErrors.prototype.length}`);
  for (const e of report.captureErrors.prototype) console.log(`  ! ${e}`);
  if (report.problems.length) {
    console.log("");
    console.log("── problems ──────────────────────────────────────────────");
    for (const p of report.problems) console.log(`  ✗ ${p}`);
  }
}

const OPTS = parseArgs(process.argv.slice(2));

main(OPTS).then(
  (report) => {
    if (OPTS.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printSummary(report);
      console.log("");
      console.log(`report: ${join(OPTS.out, "report.json")}`);
    }
    const clean = report.problems.length === 0 &&
      report.captureErrors.implementation.length === 0 &&
      report.machineCheck !== null &&
      report.machineCheck.consoleErrors.length === 0 &&
      report.machineCheck.pageErrors.length === 0 &&
      report.machineCheck.ruleFailures.length === 0 &&
      report.machineCheck.viewports.every((v) => v.ok) &&
      report.implementationOverflow.every((v) => v.ok) &&
      (!OPTS.strict || report.layoutDivergences.length === 0);
    process.exit(clean ? 0 : 1);
  },
  (err) => {
    if (err.code === "SKIP") {
      console.log(`SKIP: ${err.message}`);
      process.exit(2);
    }
    if (err.code === "USAGE") {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  },
);
