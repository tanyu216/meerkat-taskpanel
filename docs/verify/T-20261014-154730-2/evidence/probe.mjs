#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730-2 · independent computed-level re-read of the drawer
   close button (I-1) and its focus ring (I-2).

   Carrier note: this lane's macOS sandbox denies BOTH a Chromium Mach
   rendezvous (bare chromium.launch → EPERM bootstrap_check_in) and any
   loopback `listen()`. So neither the SUT probe's `createServer` prototype leg
   nor a bare launch works here. Both sides are therefore driven **entirely by
   Playwright route interception** — no socket binds — and Chromium is launched
   with `--single-process --no-zygote` (injected by pw-wrapper.mjs, which is what
   PLAYWRIGHT_ENTRY points at).

   The reading (`READ_CLOSE`) is copied verbatim from the SUT probe
   `docs/verify/T-20261014-154730/probe-close-focus.mjs` so a value here is
   comparable, value-for-value, with the SUT's own before/after evidence.

   Usage: node probe.mjs --dist <web/dist> [--out f.json] [--label name] [--width N]
   Exit:  0 read · 2 environment · 3 harness error.
   ===================================================================== */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-154730-2-seg1";
const DESIGN = join(REPO, "design");
const PROTO_ROOT = join(DESIGN, "prototype");
const FIXTURE = join(REPO, "docs/verify/T-20261014-125122/fixture.mjs");
const { DRAWER_ID, fixtureApi, mountRoutes } = await import(pathToFileURL(FIXTURE).href);

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
const SETTLE_OPEN = 450;

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

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_ENTRY, "playwright"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium && typeof chromium.launch === "function") return chromium;
    } catch {
      /* next */
    }
  }
  return null;
}

/* ------------------------------------------------------------ the reading */
/* Verbatim from docs/verify/T-20261014-154730/probe-close-focus.mjs. */
const READ_CLOSE = () => {
  const round = (n) => Math.round(n * 100) / 100;
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
      rectWidth: round(r.width),
      rectHeight: round(r.height),
      rectTop: round(r.top),
      rectRight: round(r.right),
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

async function readFocused(page) {
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
  await page.evaluate(() => document.querySelector("[data-detail-close]").focus());
  await page.waitForTimeout(80);
  return page.evaluate(READ_CLOSE);
}

/* prototype carrier: route interception over design/prototype, no listener */
async function mountPrototype(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "proto.test") return route.fulfill({ status: 404, body: "off-origin" });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/prototype/index.html";
    const file = join(DESIGN, rel);
    if (!existsSync(file) || statSync(file).isDirectory()) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({
      status: 200,
      contentType: MIME[extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });
}

/* ------------------------------------------------------------------- main */
const browserType = await loadPlaywright();
if (!browserType) {
  console.error("SKIP: no Playwright reachable (set PLAYWRIGHT_ENTRY)");
  process.exit(2);
}
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`SKIP: no built app at ${DIST}`);
  process.exit(2);
}

const readings = { label: LABEL, dist: DIST, width: WIDTH };
const pageErrors = [];

try {
  /* ---- prototype ------------------------------------------------------ */
  /* One launch per side: under `--single-process` a second page in a second
     context aborts the browser (verified), so each side gets a fresh browser.
     This also makes the two readings fully independent of one another. */
  const protoBrowser = await browserType.launch();
  const protoCtx = await protoBrowser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const proto = await protoCtx.newPage();
  await mountPrototype(proto);
  await proto.goto("http://proto.test/prototype/index.html", { waitUntil: "load" });
  await proto.waitForSelector("[data-card]", { timeout: 20000 });
  await proto.evaluate(() => {
    const card = document.querySelector("[data-board] [data-card]");
    (card.querySelector("[data-card-title]") ?? card).click();
  });
  await proto.waitForTimeout(SETTLE_OPEN);
  readings.proto = await readFocused(proto);
  await protoBrowser.close().catch(() => {});

  /* ---- implementation ------------------------------------------------- */
  const implBrowser = await browserType.launch();
  const data = fixtureApi();
  const implCtx = await implBrowser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
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
  await implBrowser.close().catch(() => {});
} catch (err) {
  console.error("HARNESS ERROR:", err);
  process.exit(3);
}

readings.distAssets = (() => {
  const dir = join(DIST, "assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, sha256_16: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex").slice(0, 16) }));
})();
readings.pageErrors = pageErrors;

const payload = JSON.stringify(readings, null, 2);
if (OUT) writeFileSync(OUT, payload + "\n");
console.log(payload);
process.exit(0);
