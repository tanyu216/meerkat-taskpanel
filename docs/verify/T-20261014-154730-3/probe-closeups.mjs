#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730-3 · group B — the close/focus **closeups**.

   The card's ① asks for the close button and its focus ring to be re-shot
   after the I-1/I-2 fix, as a pair a reader can put side by side. The
   readings that decide it are taken by `docs/verify/T-20261014-154730/
   probe-close-focus.mjs` (computed box + `:focus-visible` ring, one function
   for both sides); this script only produces the **pictures** for the same
   two faces, and produces them the one way that makes a byte-level eye
   comparison legitimate:

     * every shot is a `page.screenshot({ clip })` with an **identical clip
       rectangle in viewport coordinates on both sides** — same size, same
       offset, no element-relative box that would silently normalise away a
       difference in position or size;
     * `b-close-*` is the clip with focus *off* the button, `b-focus-*` is the
       same clip after a real `Tab` press establishes keyboard modality and
       `[data-detail-close]` is focused again (so what is photographed is the
       `:focus-visible` face, not the UA's `:focus` one);
     * `animations: "disabled"` on both sides, as in `capture.mjs`.

   The clip is anchored to the **drawer head's right end**, which is where
   both faces live, and is stated in the evidence file beside the geometry it
   was derived from so a reader can re-derive it.

   Carriers — both real Chromium, neither is a live server:
     * prototype: a throwaway loopback static server over `design/`.
     * implementation: a throwaway loopback static server over `--dist` (this
       worktree's own build), with `fixture.mjs` answering the API half.

   Usage (host; needs a reachable Playwright and a built `web/dist`):
     node docs/verify/T-20261014-154730-3/probe-closeups.mjs \
       [--dist web/dist] [--out docs/verify/T-20261014-154730-3/shots]

   Exit codes: 0 read · 2 environment (no browser / no dist) · 3 harness error.
   ===================================================================== */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CARDS, fixtureApi, mountRoutes } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const DESIGN = join(REPO, "design");

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at === -1 ? fallback : argv[at + 1];
};
const DIST = resolve(argOf("--dist", join(REPO, "web/dist")));
const OUT = resolve(argOf("--out", join(HERE, "shots")));
const WIDTH = Number(argOf("--width", "1512"));
const HEIGHT = 900;
const SETTLE_OPEN = 450;

/**
 * The clip, in viewport coordinates, **identical on both sides**.
 *
 * 460×120 at the top-right corner: wide enough to hold the identifier chip,
 * the status chip and the 32px close button with its 2px/2px focus ring and
 * its 4px halo (≈ 40px of ink at the right edge), and tall enough to hold the
 * whole 78.59px head plus the head's border. It is expressed against the
 * **viewport**, never against the drawer or the button, so the two sides are
 * cropped at the same page position — an element-relative shot would move
 * with whatever it was cropping and could hide a misplacement.
 */
const CLIP = { x: WIDTH - 460, y: 0, width: 460, height: 120 };

/**
 * The seats read for the collateral question, chosen so that a **global**
 * `:focus-visible` rule would have to show up somewhere: a text field inside
 * the drawer, a control the drawer's own unlayered rules already target
 * (`.td-copy`), and a plain board control outside the drawer entirely.
 */
const COLLATERAL = ["[data-comment-input]", "[data-detail-close]", "[data-detail-id-copy]"];

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_ENTRY,
    "playwright",
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "playwright", "index.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium && typeof chromium.launch === "function") return chromium;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".woff2": "font/woff2",
};

function staticRoot(root, { spa = false, fallback = "/prototype/index.html" } = {}) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = fallback;
      let file = join(root, rel);
      if (!existsSync(file) || statSync(file).isDirectory() || (spa && !extname(file))) file = join(root, fallback);
      if (!existsSync(file)) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

/* ------------------------------------------------------------------- main */

const browserType = await loadPlaywright();
if (!browserType) {
  console.error("SKIP: no Playwright reachable (set PLAYWRIGHT_ENTRY or install it globally)");
  process.exit(2);
}
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`SKIP: no built app at ${DIST} — run \`npm --prefix web run build\``);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const browser = await browserType.launch();
const readings = { card: "T-20261014-154730-3", width: WIDTH, height: HEIGHT, dist: DIST, clip: CLIP, shots: [] };
const pageErrors = [];

/** Register a shot the same way `capture.mjs` does: name + note + body hash. */
function note(file, text) {
  const sha = createHash("sha256").update(readFileSync(join(OUT, file))).digest("hex").slice(0, 16);
  readings.shots.push({ file, note: text, sha256_16: sha });
  process.stdout.write(`  · ${file}  ${sha}\n`);
}

/** Everything the clip needs to be re-derivable, read while the drawer is open. */
const READ_HEAD = () => {
  const round = (n) => Math.round(n * 100) / 100;
  const drawer = document.querySelector("[data-detail-drawer]");
  const head = document.querySelector("[data-detail-drawer] .td-drawer-head");
  const close = document.querySelector("[data-detail-close]");
  const r = head.getBoundingClientRect();
  const c = close.getBoundingClientRect();
  return {
    drawer: drawer ? { x: round(drawer.getBoundingClientRect().x), w: round(drawer.getBoundingClientRect().width) } : null,
    head: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
    close: { x: round(c.x), y: round(c.y), w: round(c.width), h: round(c.height), right: round(c.right) },
    closeClass: close.className,
    closeComputed: (() => {
      const s = getComputedStyle(close);
      return {
        width: s.width, height: s.height, display: s.display, borderRadius: s.borderRadius,
        borderTopWidth: s.borderTopWidth, borderTopStyle: s.borderTopStyle, borderTopColor: s.borderTopColor,
        color: s.color, alignItems: s.alignItems, justifyContent: s.justifyContent,
      };
    })(),
    glyph: (() => {
      const g = close.querySelector("svg");
      if (!g) return null;
      const gr = g.getBoundingClientRect();
      return { w: round(gr.width), h: round(gr.height) };
    })(),
    active: document.activeElement?.tagName ?? null,
    focusVisible: close.matches(":focus-visible"),
  };
};

/**
 * The ring on **any** seat, read on the focused face.
 *
 * I-2 landed as a global base-layer `:focus-visible` rule, so the card's ②
 * ("no new deviation at five widths") is also a question about seats the fix
 * did not name: a ring that reached every control would be a wider change than
 * the one I-1/I-2 asked for. Keyboard modality is established by a real `Tab`
 * press before this runs, so `focus()` produces the `:focus-visible` face.
 */
const READ_FOCUS_FACE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.focus();
  const s = getComputedStyle(el);
  return {
    matchesFocusVisible: el.matches(":focus-visible"),
    isActive: document.activeElement === el,
    outlineWidth: s.outlineWidth,
    outlineStyle: s.outlineStyle,
    outlineColor: s.outlineColor,
    outlineOffset: s.outlineOffset,
    boxShadow: s.boxShadow,
  };
};

/** The ring, read on the focused face (after a real Tab establishes modality). */
const READ_RING = () => {
  const close = document.querySelector("[data-detail-close]");
  if (!close) return null;
  const s = getComputedStyle(close);
  return {
    matchesFocusVisible: close.matches(":focus-visible"),
    isActive: document.activeElement === close,
    outlineWidth: s.outlineWidth,
    outlineStyle: s.outlineStyle,
    outlineColor: s.outlineColor,
    outlineOffset: s.outlineOffset,
    boxShadow: s.boxShadow,
    borderRadius: s.borderRadius,
  };
};

try {
  const designServer = await staticRoot(DESIGN);
  const protoBase = `http://127.0.0.1:${designServer.address().port}`;

  /* ---- prototype --------------------------------------------------- */
  const protoCtx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const proto = await protoCtx.newPage();
  proto.on("pageerror", (e) => pageErrors.push(`proto: ${String(e)}`));
  await proto.goto(`${protoBase}/prototype/index.html`, { waitUntil: "load" });
  await proto.waitForSelector("[data-board] [data-card]", { timeout: 20000 });
  await proto.evaluate((id) => {
    const card = [...document.querySelectorAll("[data-board] [data-card]")].find(
      (c) => c.querySelector("[data-card-identifier]")?.textContent.trim() === id
    );
    (card.querySelector("[data-card-title]") ?? card).click();
  }, CARDS.AGENT);
  await proto.waitForTimeout(SETTLE_OPEN);
  /* focus OFF the button for the close face — the drawer opens focused (C2), so
     the unfocused face is taken by blurring, not by opening differently. */
  await proto.evaluate(() => document.activeElement?.blur());
  await proto.waitForTimeout(120);
  readings.proto = { closeFace: await proto.evaluate(READ_HEAD) };
  await proto.screenshot({ path: join(OUT, "b-close-proto-closeup.png"), clip: CLIP, animations: "disabled" });
  note("b-close-proto-closeup.png", "prototype · 1512px · drawer-head right end, close button unfocused");
  /* the focused face: real Tab first (keyboard modality), then focus the button */
  await proto.keyboard.press("Tab");
  await proto.waitForTimeout(60);
  await proto.evaluate(() => document.querySelector("[data-detail-close]").focus());
  await proto.waitForTimeout(120);
  readings.proto.ring = await proto.evaluate(READ_RING);
  await proto.screenshot({ path: join(OUT, "b-focus-proto-closeup.png"), clip: CLIP, animations: "disabled" });
  note("b-focus-proto-closeup.png", "prototype · 1512px · same clip, focus landed on [data-detail-close]");
  /* the collateral faces — seats I-1/I-2 did not name, read so a global ring
     cannot pass unnoticed */
  readings.proto.focusFaces = {};
  for (const sel of COLLATERAL) {
    readings.proto.focusFaces[sel] = await proto.evaluate(READ_FOCUS_FACE, sel);
  }
  await protoCtx.close();
  designServer.close();

  /* ---- implementation ---------------------------------------------- */
  const distServer = await staticRoot(DIST, { spa: true, fallback: "/index.html" });
  const distPort = distServer.address().port;
  const implCtx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await implCtx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`impl: ${String(e)}`));
  await mountRoutes(page, { livePort: distPort, data: fixtureApi(), origin: "app.test" });
  await page.goto("http://app.test/board", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-card]", { timeout: 20000 });
  await page.evaluate((id) => {
    const card = [...document.querySelectorAll("[data-card]")].find(
      (c) => c.querySelector("[data-card-identifier]")?.textContent.trim() === id
    );
    (card.querySelector("[data-card-title]") ?? card).click();
  }, CARDS.AGENT);
  await page.waitForFunction(
    (id) => document.querySelector("[data-detail-identifier]")?.textContent.trim() === id,
    CARDS.AGENT,
    { timeout: 15000 }
  );
  await page.waitForTimeout(SETTLE_OPEN);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(120);
  readings.impl = { closeFace: await page.evaluate(READ_HEAD) };
  await page.screenshot({ path: join(OUT, "b-close-impl-closeup.png"), clip: CLIP, animations: "disabled" });
  note("b-close-impl-closeup.png", "implementation (post-fix) · 1512px · drawer-head right end, close button unfocused");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
  await page.evaluate(() => document.querySelector("[data-detail-close]").focus());
  await page.waitForTimeout(120);
  readings.impl.ring = await page.evaluate(READ_RING);
  await page.screenshot({ path: join(OUT, "b-focus-impl-closeup.png"), clip: CLIP, animations: "disabled" });
  note("b-focus-impl-closeup.png", "implementation (post-fix) · 1512px · same clip, focus landed on [data-detail-close]");
  readings.impl.focusFaces = {};
  for (const sel of COLLATERAL) {
    readings.impl.focusFaces[sel] = await page.evaluate(READ_FOCUS_FACE, sel);
  }
  await implCtx.close();
  distServer.close();

  /* ---- the whole head, side by side -------------------------------- */
  const cells = [
    { file: "b-focus-proto-closeup.png", label: "prototype" },
    { file: "b-focus-impl-closeup.png", label: "implementation (post-fix)" },
  ]
    .map(({ file, label }) => {
      const b64 = readFileSync(join(OUT, file)).toString("base64");
      return `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${b64}"></figure>`;
    })
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{background:#0b0f11;color:#e6e8eb;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;padding:14px 14px 18px}
    h1{font-size:13px;font-weight:600;margin-bottom:10px;letter-spacing:.02em}
    .row{display:flex;gap:14px;align-items:flex-start}
    figure{flex:0 0 auto;border:1px solid #2a3238;border-radius:6px;overflow:hidden;background:#111}
    figcaption{padding:5px 8px;font-size:11px;background:#161c20;border-bottom:1px solid #2a3238;color:#9fb0ba}
    img{display:block}
  </style></head><body><h1>R14 drawer head · 1512px · [data-detail-close] focused · prototype ⟷ implementation (post-fix) · identical ${CLIP.width}×${CLIP.height} clip at x=${CLIP.x}</h1><div class="row">${cells}</div></body></html>`;
  const sheet = await browser.newPage({ viewport: { width: (CLIP.width + 14) * 2 + 28, height: 240 } });
  await sheet.setContent(html, { waitUntil: "load" });
  await sheet.waitForTimeout(150);
  await (await sheet.$("body")).screenshot({ path: join(OUT, "b-head-side-by-side.png") });
  note("b-head-side-by-side.png", "the two focused closeups on one sheet, same clip both sides");
  await sheet.close();

  /* ---- the ring, read on the focused face, side by side ------------- */
  const ringCells = [
    { file: "b-focus-proto-closeup.png", label: `prototype · ${JSON.stringify(readings.proto.ring)}` },
    { file: "b-focus-impl-closeup.png", label: `implementation (post-fix) · ${JSON.stringify(readings.impl.ring)}` },
  ]
    .map(({ file, label }) => {
      const b64 = readFileSync(join(OUT, file)).toString("base64");
      return `<figure><figcaption style="max-width:${CLIP.width}px">${label}</figcaption><img src="data:image/png;base64,${b64}"></figure>`;
    })
    .join("");
  const ringHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{background:#0b0f11;color:#e6e8eb;font:11px/1.45 ui-sans-serif,system-ui,sans-serif;padding:14px 14px 18px}
    h1{font-size:13px;font-weight:600;margin-bottom:10px}
    .row{display:flex;gap:14px;align-items:flex-start}
    figure{flex:0 0 auto;border:1px solid #2a3238;border-radius:6px;overflow:hidden;background:#111}
    figcaption{padding:5px 8px;background:#161c20;border-bottom:1px solid #2a3238;color:#9fb0ba;word-break:break-all}
    img{display:block}
  </style></head><body><h1>The focus ring, as read on the focused face (computed, both sides)</h1><div class="row">${ringCells}</div></body></html>`;
  const ringSheet = await browser.newPage({ viewport: { width: (CLIP.width + 14) * 2 + 28, height: 300 } });
  await ringSheet.setContent(ringHtml, { waitUntil: "load" });
  await ringSheet.waitForTimeout(150);
  await (await ringSheet.$("body")).screenshot({ path: join(OUT, "b-ring-side-by-side.png") });
  note("b-ring-side-by-side.png", "the two focused closeups with each side's computed ring printed under it");
  await ringSheet.close();
} catch (err) {
  console.error("HARNESS ERROR:", err);
  await browser.close();
  process.exit(3);
}

await browser.close();

/* The identity of the built artefact this reading describes, so a reader can
   tell a re-run of the same build from a reading of a new one. */
readings.pageErrors = pageErrors;
writeFileSync(join(HERE, "evidence", "closeups.json"), JSON.stringify(readings, null, 2) + "\n");
console.log(JSON.stringify({ shots: readings.shots.length, ring: { proto: readings.proto?.ring, impl: readings.impl?.ring } }, null, 2));
process.exit(0);
