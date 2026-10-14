#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730 · I-1 / I-2 — the drawer close button's **computed box**
   and its **focus ring**, read on both sides of the comparison.

   Why a second probe (the visual leg next door already reads the drawer):
     * `docs/verify/T-20261014-150729/evidence.json` records the close button's
       *bounding box* (`head.close.w/h`) and the focused element's *outline
       shorthand* — enough to see the two divergences, but its `boxShadow` is
       flattened to `"set"`/`"none"`, it never reads the box's own computed
       `width`/`height`/`border`/`border-radius`/`color`, and it never reads the
       header's own height. Those are exactly the four values the card's ①②
       name, and ③ has to assert them, so they are measured here by their own
       long-hand properties rather than inferred from a rect.
     * the two sides are read through **one** function, so a difference in the
       reading is a difference in the browser and never in the probe.

   Carriers — both real Chromium, neither needs the app's own server:
     * prototype: a throwaway loopback static server over `design/`, the same
       carrier `docs/verify/T-20261014-150729/capture.mjs` uses.
     * implementation: route interception over a **local** `web/dist`
       (`fixture.mjs` in the 125122 evidence directory), so the probe reads the
       build in *this* worktree and not whatever a live `:9527` happens to
       serve.

   Usage (host; needs a reachable Playwright and a built `web/dist`):
     node docs/verify/T-20261014-154730/probe-close-focus.mjs \
       [--dist web/dist] [--out <file.json>] [--label name]

   Exit codes: 0 read · 2 environment (no browser / no dist) · 3 harness error.
   ===================================================================== */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DRAWER_ID, fixtureApi, mountRoutes } from "../T-20261014-125122/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const DESIGN = join(REPO, "design");

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at === -1 ? fallback : argv[at + 1];
};
const DIST = resolve(argOf("--dist", join(REPO, "web/dist")));
const OUT = argOf("--out", null);
const LABEL = argOf("--label", "impl");
const WIDTH = Number(argOf("--width", "1512"));
const HEIGHT = 900;
/** > the 200 ms opening beat both sides use to hand focus to the close button. */
const SETTLE_OPEN = 450;

/* ------------------------------------------------------------- playwright */

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

/* --------------------------------------------------------- prototype host */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function serveDesignRoot() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/prototype/index.html";
      const file = join(DESIGN, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

/* ------------------------------------------------------------- the reading */

/**
 * The four faces the card's ①② name, in one shape for both sides.
 *
 * The box is read as **computed long-hand** (`width`/`height`/`border-*`/
 * `border-radius`/`color`), not as a rect alone: a rect cannot tell a 32×32
 * `content-box` from a 30×30 box with 1px borders, and `border-radius` and the
 * ink colour have no rect at all. The rect is kept beside it so the two can be
 * read against each other — a `getBoundingClientRect()` that disagrees with the
 * computed pair is itself a finding.
 *
 * The focus face is read after the **keyboard modality is established** (a real
 * `Tab` press) and the button is focused again, so what is measured is the
 * `:focus-visible` face and not whatever the opening beat happened to leave.
 * `matches(":focus-visible")` is reported rather than assumed — a probe that
 * read `outline` off a button that never matched the pseudo-class would
 * otherwise report the UA's own ring as if it were the design's.
 */
const READ_CLOSE = () => {
  const round = (n) => Math.round(n * 100) / 100;
  const drawer = document.querySelector("[data-detail-drawer]");
  const close = document.querySelector("[data-detail-close]");
  const head = document.querySelector("[data-detail-drawer] .td-drawer-head") ?? document.querySelector(".td-drawer-head");
  if (!close) return { present: false };
  const cs = getComputedStyle(close);
  const r = close.getBoundingClientRect();
  const headRect = head?.getBoundingClientRect() ?? null;
  const headCs = head ? getComputedStyle(head) : null;
  const glyph = close.querySelector("svg");
  const glyphRect = glyph?.getBoundingClientRect() ?? null;
  const active = document.activeElement;
  const acs = active ? getComputedStyle(active) : null;
  return {
    present: true,
    box: {
      // the rect
      rectWidth: round(r.width),
      rectHeight: round(r.height),
      rectTop: round(r.top),
      rectRight: round(r.right),
      // the computed long-hand
      width: cs.width,
      height: cs.height,
      display: cs.display,
      boxSizing: cs.boxSizing,
      borderTopWidth: cs.borderTopWidth,
      borderRightWidth: cs.borderRightWidth,
      borderBottomWidth: cs.borderBottomWidth,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopStyle: cs.borderTopStyle,
      borderTopColor: cs.borderTopColor,
      borderRadius: cs.borderRadius,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      cursor: cs.cursor,
      flex: `${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`,
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      marginLeft: cs.marginLeft,
    },
    glyph: glyphRect ? { width: round(glyphRect.width), height: round(glyphRect.height) } : null,
    head: headRect
      ? {
          height: round(headRect.height),
          paddingTop: headCs.paddingTop,
          paddingBottom: headCs.paddingBottom,
          borderBottomWidth: headCs.borderBottomWidth,
          /* The head's own row, broken down — a head height that disagrees with
             the prototype is only actionable once it is clear *which* child
             carried the difference, so each child reports the size it rendered
             at (`height`) beside the face it rendered with
             (`fontSize`/`lineHeight`/`fontWeight`). */
          children: head
            ? [...head.children].map((child) => {
                const ccs = getComputedStyle(child);
                const cr = child.getBoundingClientRect();
                return {
                  tag: child.tagName.toLowerCase(),
                  hook: child.getAttribute("data-detail-title") !== null ? "data-detail-title" : child.className.split(/\s+/)[0] || null,
                  height: round(cr.height),
                  width: round(cr.width),
                  fontSize: ccs.fontSize,
                  lineHeight: ccs.lineHeight,
                  fontWeight: ccs.fontWeight,
                  marginTop: ccs.marginTop,
                  marginBottom: ccs.marginBottom,
                  selfHeight: ccs.height,
                  /* the identifier/chip/close row's own box, so its height can be
                     read without re-deriving it from the children's rects */
                  rowHeight:
                    child.className.includes("flex") && child.children.length > 0
                      ? round(child.getBoundingClientRect().height)
                      : undefined,
                };
              })
            : [],
        }
      : null,
    focus: {
      matchesFocusVisible: close.matches(":focus-visible"),
      isActive: active === close,
      activeTag: active?.tagName ?? null,
      outlineWidth: close.matches(":focus-visible") ? cs.outlineWidth : null,
      outlineStyle: close.matches(":focus-visible") ? cs.outlineStyle : null,
      outlineColor: close.matches(":focus-visible") ? cs.outlineColor : null,
      outlineOffset: close.matches(":focus-visible") ? cs.outlineOffset : null,
      boxShadow: close.matches(":focus-visible") ? cs.boxShadow : null,
      activeOutline: acs ? `${acs.outlineWidth} ${acs.outlineStyle} ${acs.outlineColor}` : null,
    },
  };
};

/** Tab (keyboard modality) → focus the close button → read. */
async function readFocused(page) {
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
  await page.evaluate(() => document.querySelector("[data-detail-close]").focus());
  await page.waitForTimeout(80);
  return page.evaluate(READ_CLOSE);
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

/* The same bare launch the visual leg uses (`docs/verify/T-20261014-150729/
   capture.mjs`): `--single-process` kills the browser when the first context
   closes, and this probe needs two. */
const browser = await browserType.launch();
const readings = { label: LABEL, dist: DIST, width: WIDTH };
const pageErrors = [];

try {
  /* ---- prototype ------------------------------------------------------ */
  const server = await serveDesignRoot();
  const protoPort = server.address().port;
  const protoCtx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const proto = await protoCtx.newPage();
  await proto.goto(`http://127.0.0.1:${protoPort}/prototype/index.html`, { waitUntil: "load" });
  await proto.waitForSelector("[data-card]", { timeout: 20000 });
  await proto.evaluate(() => {
    const card = document.querySelector("[data-board] [data-card]");
    (card.querySelector("[data-card-title]") ?? card).click();
  });
  await proto.waitForTimeout(SETTLE_OPEN);
  readings.proto = await readFocused(proto);
  await protoCtx.close();
  server.close();

  /* ---- implementation ------------------------------------------------- */
  const data = fixtureApi();
  const implCtx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await implCtx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await mountRoutes(page, { distDir: DIST, data });
  await page.goto("http://app.test/board", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-card]", { timeout: 20000 });
  await page.evaluate((id) => {
    const card = [...document.querySelectorAll("[data-card]")].find(
      (c) => c.querySelector("[data-card-identifier]")?.textContent.trim() === id,
    );
    (card.querySelector("[data-card-title]") ?? card).click();
  }, DRAWER_ID);
  await page.waitForFunction(
    (id) => document.querySelector("[data-detail-identifier]")?.textContent.trim() === id,
    DRAWER_ID,
    { timeout: 15000 },
  );
  await page.waitForTimeout(SETTLE_OPEN);
  readings.impl = await readFocused(page);
  await implCtx.close();
} catch (err) {
  console.error("HARNESS ERROR:", err);
  await browser.close();
  process.exit(3);
}

await browser.close();

/* The identity of the built artefact this reading describes, so a reader can
   tell a re-run of the same build from a reading of a new one. */
readings.distAssets = (() => {
  const dir = join(DIST, "assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({
      name,
      sha256_16: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex").slice(0, 16),
    }));
})();
readings.pageErrors = pageErrors;

const payload = JSON.stringify(readings, null, 2);
if (OUT) writeFileSync(OUT, payload + "\n");
console.log(payload);
process.exit(0);
