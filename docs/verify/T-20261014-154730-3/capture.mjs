#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730-3 · the R14 detail drawer's **re-capture**, after the
   I-1/I-2 fix (card `T-20261014-154730`).

   This is `docs/verify/T-20261014-150729/capture.mjs` with **one** change of
   substance: the implementation carrier.

     * 150729 read the implementation off the **live board at :9527** — a
       workspace artefact that happened to serve whatever build was checked
       out at the time, which is exactly why that leg could not be re-run
       after the fix and why that card had to register "实现腿不是本 lane 自建
       的 dist" as an unreviewed item (§3-1 of its README).
     * here the carrier is a **throwaway loopback static server over this
       worktree's own `web/dist`** (`--dist`, default `web/dist`) — built by
       this lane from the fix commit. Nothing outside the worktree is touched,
       the team's live board on :9527 is left alone, and the identity recorded
       in `evidence.json` is the bytes this lane actually built.

   The prototype carrier, the five widths, the three states, the JS-off pair,
   the two interaction beats, the per-seat computed comparison and every
   reading function below are unchanged from 150729 — the point of this card
   is to re-read the *same* instrument against the *repaired* build, so an
   instrument that changed would defeat it.

   Usage (host; needs a reachable Playwright and a built `web/dist`):
     node docs/verify/T-20261014-154730-3/capture.mjs \
       [--only id|a|b|e|c|d] [--dist web/dist] [--out <dir>]

   Exit codes: 0 read · 1 harness failure (readings are still written) ·
   2 environment (no browser / no dist).
   ===================================================================== */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet } from "node:http";
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
const ONLY = argOf("--only", "");
const groups = (name) => ONLY === "" || ONLY.split(",").includes(name);

const WIDTHS = [1512, 1240, 980, 760, 430];
const HEIGHT = 900;
const SETTLE_OPEN = 450; // > the 200ms opening beat both sides use for focus

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

/* ---------------------------------------------------------- static server */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * The prototype's carrier. Unchanged from 150729: a throwaway loopback server
 * over `design/`, so the prototype leg is the repo's own static file.
 */
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

/**
 * The implementation's carrier — **new in this card**.
 *
 * The live board at :9527 served the pre-fix bundle, so a re-read of the fix
 * cannot come from there. This serves `--dist` (this worktree's own build)
 * with the SPA fallback the app needs, and nothing else: no API, because the
 * API half of every request is answered by `fixture.mjs` through route
 * interception, exactly as 150729 did it.
 */
function serveDistRoot(distDir) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let file = join(distDir, rel === "" ? "index.html" : rel);
      if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(distDir, "index.html");
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

/* ------------------------------------------------------------- readings */

/**
 * Everything the drawer says about itself, in one shape, for both sides.
 *
 * The block list is deliberately the card's own list — text / layout /
 * spacing / labels / attachments / relation rows — so "逐块可见" is a
 * measurement rather than an impression. `shot` names the block's own
 * bounding box in CSS px against the drawer's, which is what a reader
 * checking "is the attachment row visible at 430" is actually asking.
 */
const READ_DRAWER = () => {
  const drawer = document.querySelector("[data-detail-drawer]");
  if (!drawer) return { present: false };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      display: cs.display, visibility: cs.visibility,
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    };
  };
  const text = (sel) => (drawer.querySelector(sel)?.textContent ?? "").trim().replace(/\s+/g, " ");
  const rows = (sel) => [...drawer.querySelectorAll(sel)].map((el) => el.textContent.trim().replace(/\s+/g, " "));
  const body = drawer.querySelector(".td-drawer-body");
  const cs = getComputedStyle(drawer);
  const sections = [...drawer.querySelectorAll(".td-section")].map((s) => ({
    title: s.querySelector(".td-section-title")?.textContent.trim() ?? "",
    hidden: s.hidden,
    box: box(s),
  }));
  return {
    present: true,
    drawer: {
      ...box(drawer),
      transform: cs.transform,
      width: cs.width,
      overflowY: cs.overflowY,
      borderLeft: cs.borderLeftWidth + " " + cs.borderLeftColor,
      boxShadow: cs.boxShadow === "none" ? "none" : "set",
    },
    body: body ? { overflowY: getComputedStyle(body).overflowY, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollTop: Math.round(body.scrollTop) } : null,
    head: {
      identifier: text("[data-detail-identifier]"),
      title: text("[data-detail-title]"),
      box: box(drawer.querySelector(".td-drawer-head") ?? drawer.querySelector("header")),
      chip: {
        text: text("[data-detail-status-chip] [data-detail-status-chip-label]") || text("[data-detail-status-chip]"),
        status: drawer.querySelector("[data-detail-status-chip]")?.getAttribute("data-status") ?? null,
      },
      close: box(drawer.querySelector("[data-detail-close]")),
    },
    status: {
      chipAttr: drawer.querySelector("[data-detail-status-chip]")?.getAttribute("data-status") ?? null,
      propAttr: drawer.querySelector("[data-detail-status]")?.getAttribute("data-status") ?? null,
    },
    blocks: {
      props: {
        labels: rows("[data-detail-props] .td-prop-label"),
        values: rows("[data-detail-props] .td-prop-value"),
        box: box(drawer.querySelector("[data-detail-props]")),
      },
      description: { present: !!drawer.querySelector("[data-detail-description]"), box: box(drawer.querySelector("[data-detail-description]")), blocks: drawer.querySelectorAll("[data-detail-description] > *").length },
      relations: {
        present: !!drawer.querySelector("[data-detail-relations]"),
        box: box(drawer.querySelector("[data-detail-relations]")),
        groups: [...drawer.querySelectorAll("[data-detail-relations] .td-rel-item")].map((g) => ({
          label: g.querySelector("span")?.textContent.trim() ?? "",
          links: [...g.querySelectorAll(".td-copy")].map((b) => b.textContent.trim()),
        })),
        text: text("[data-detail-relations]"),
      },
      attachments: {
        present: !!drawer.querySelector("[data-detail-attachments]"),
        box: box(drawer.querySelector("[data-detail-attachments]")),
        rows: [...drawer.querySelectorAll("[data-detail-attachments] .td-file")].map((f) => ({
          name: f.querySelector(".td-file-name")?.textContent.trim() ?? "",
          size: f.querySelector(".td-file-size")?.textContent.trim() ?? "",
          icon: box(f.querySelector("svg")),
          box: box(f),
        })),
        text: text("[data-detail-attachments]"),
      },
      comments: { present: !!drawer.querySelector("[data-detail-comments]"), box: box(drawer.querySelector("[data-detail-comments]")), count: drawer.querySelectorAll("[data-detail-comments] .td-comment").length, decisions: drawer.querySelectorAll("[data-detail-comments] .td-comment-decision").length },
      activity: { present: !!drawer.querySelector("[data-detail-activity]"), box: box(drawer.querySelector("[data-detail-activity]")), count: drawer.querySelectorAll("[data-detail-activity] .td-activity").length },
      session: { present: !!drawer.querySelector("[data-detail-agent-session]"), hidden: drawer.querySelector("[data-detail-agent-session]")?.hidden ?? null, box: box(drawer.querySelector("[data-detail-agent-session]")), id: text("[data-agent-session-id]") },
      labels: rows("[data-detail-label-chips] .td-chip"),
    },
    overlay: (() => {
      const ov = document.querySelector("[data-detail-overlay]");
      if (!ov) return { present: false };
      const c = getComputedStyle(ov);
      return { present: true, hidden: ov.hidden, state: ov.getAttribute("data-state"), background: c.backgroundColor, opacity: c.opacity, box: box(ov) };
    })(),
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      lang: document.documentElement.getAttribute("lang"),
      title: document.title,
    },
    focus: (() => {
      const active = document.activeElement;
      const close = drawer.querySelector("[data-detail-close]");
      const c = active ? getComputedStyle(active) : null;
      return {
        isClose: !!active && active === close,
        tag: active?.tagName ?? null,
        hook: active?.getAttribute?.("data-detail-close") !== null && active?.hasAttribute?.("data-detail-close") ? "data-detail-close" : null,
        outline: c ? c.outlineWidth + " " + c.outlineStyle + " " + c.outlineColor : null,
        outlineOffset: c?.outlineOffset ?? null,
        boxShadow: c?.boxShadow === "none" ? "none" : "set",
        boxShadowValue: c?.boxShadow ?? null,
      };
    })(),
  };
};

/* --------------------------------------------------------------- capture */

const shots = [];
const readings = {};
let pageErrors = [];

async function shot(page, file, note) {
  const path = join(OUT, file);
  await page.screenshot({ path, animations: "disabled" });
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  shots.push({ file, note, sha256_16: sha });
  process.stdout.write(`  · ${file}\n`);
  return path;
}

/** An element shot, registered in the manifest the same way a page shot is. */
async function elShot(page, selector, file, note) {
  const el = await page.$(selector);
  if (!el) throw new Error(`no element ${selector} for ${file}`);
  const path = join(OUT, file);
  await el.screenshot({ path, animations: "disabled" });
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  shots.push({ file, note, sha256_16: sha });
  process.stdout.write(`  · ${file}\n`);
}

/** A labelled side-by-side sheet, so both sides are read at the same scale. */
async function sideBySide(browser, files, out, caption, width) {
  const cells = files
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
  </style></head><body><h1>${caption}</h1><div class="row">${cells}</div></body></html>`;
  const p = await browser.newPage({ viewport: { width: width * files.length + 14 * (files.length + 1), height: 200 } });
  await p.setContent(html, { waitUntil: "load" });
  await p.waitForTimeout(120);
  const el = await p.$("body");
  await el.screenshot({ path: join(OUT, out) });
  const sha = createHash("sha256").update(readFileSync(join(OUT, out))).digest("hex").slice(0, 16);
  shots.push({ file: out, note: caption, sha256_16: sha });
  process.stdout.write(`  · ${out}\n`);
  await p.close();
}

/* ------------------------------------------------------- prototype driver */

async function protoPage(browser, base, { width, zh = false, javaScript = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, javaScriptEnabled: javaScript });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/prototype/index.html`, { waitUntil: "load" });
  if (javaScript) {
    await page.waitForFunction(() => !!window.jQuery);
    if (zh) {
      await page.evaluate(() => document.querySelector("[data-lang-select]").click());
      await page.waitForTimeout(80);
      await page.evaluate(() => document.querySelector('[data-lang-option="zh"]').click());
      await page.waitForTimeout(120);
    }
  }
  return { page, ctx, errors };
}

async function protoOpenCard(page, identifier) {
  const ok = await page.evaluate((id) => {
    const card = [...document.querySelectorAll("[data-board] [data-card]")].find(
      (c) => c.querySelector("[data-card-identifier]")?.textContent.trim() === id
    );
    if (!card) return false;
    card.querySelector("[data-card-title]").click();
    return true;
  }, identifier);
  if (!ok) throw new Error(`prototype: no card ${identifier}`);
  await page.waitForTimeout(SETTLE_OPEN);
}

/* ------------------------------------------------------- impl driver */

async function implPage(browser, origin, data, { width, zh = false, javaScript = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, javaScriptEnabled: javaScript });
  if (zh) await ctx.addInitScript(() => window.localStorage.setItem("meerkat-taskpanel.lang", "zh"));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mountRoutes(page, { livePort: DIST_PORT, data, origin });
  return { page, ctx, errors };
}

async function implOpenCard(page, origin, identifier, { javaScript = true } = {}) {
  /* A click, not the `#/task/<id>` fragment: the app *preserves* that fragment
     but has no reader for it (`stores/route.js` §4.3 step 2 keeps the hash),
     so a deep link lands on the board with the drawer shut. The ActivityView's
     own `<a href="#/task/…">` is opened by its `@click`, i.e. also a click. */
  await page.goto(`http://${origin}/board`, { waitUntil: "domcontentloaded" });
  if (!javaScript) return;
  await page.waitForSelector("[data-card]", { timeout: 20000 });
  const opened = await page.evaluate((id) => {
    const card = [...document.querySelectorAll("[data-card]")].find(
      (c) => c.querySelector("[data-card-identifier]")?.textContent.trim() === id
    );
    if (!card) return false;
    (card.querySelector("[data-card-title]") ?? card).click();
    return true;
  }, identifier);
  if (!opened) throw new Error(`implementation: no card ${identifier}`);
  await page.waitForFunction(
    (id) => document.querySelector("[data-detail-identifier]")?.textContent.trim() === id,
    identifier,
    { timeout: 15000 }
  );
  /* the drawer body settles once its sections have arrived */
  await page.waitForFunction(
    () => {
      const r = document.querySelector("[data-detail-relations]");
      const a = document.querySelector("[data-detail-attachments]");
      return !!r && r.children.length > 0 && !!a && a.children.length > 0;
    },
    null,
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(SETTLE_OPEN);
}

/* ------------------------------------------------------------------ main */

const chromium = await loadPlaywright();
if (!chromium) {
  process.stdout.write("playwright unreachable on this host — the render leg cannot be evaluated\n");
  process.exit(2);
}
if (!existsSync(join(DIST, "index.html"))) {
  process.stdout.write(`no built app at ${DIST} — run \`npm --prefix web run build\`\n`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
/* `unref` so the throwaway static servers cannot hold the event loop open after
   the run is over — an un-closed listener makes the process hang with all its
   output still sitting in the pipe. */
const designServer = await serveDesignRoot();
designServer.unref();
const base = `http://127.0.0.1:${designServer.address().port}`;
const distServer = await serveDistRoot(DIST);
distServer.unref();
const DIST_PORT = distServer.address().port;
const data = fixtureApi();
const ORIGIN = "app.test";
const browser = await chromium.launch();

const side = (page, name) => readings[name] ?? (readings[name] = {});

try {
  /* ---- identity of the served build ---------------------------------- */
  if (groups("id")) {
    /* Not the unmediated live board of 150729 (that board is the *pre-fix*
       build, and this lane must not touch it). What is recorded here is the
       identity of the bytes the implementation carrier actually handed the
       browser: the shell plus every asset it names, fetched back over HTTP
       from the carrier and hashed from the response body. */
    const shell = await fetchFrom(DIST_PORT, "/");
    const assets = {};
    for (const name of [...shell.text.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0])) {
      const got = await fetchFrom(DIST_PORT, name);
      assets[got.path.split("/").pop()] = { status: got.status, bytes: got.bytes, sha256_16: got.sha256_16 };
    }
    readings.servedBuild = {
      carrier: `http://127.0.0.1:${DIST_PORT} (loopback static server over ${DIST})`,
      dist: DIST,
      index_html_sha256_16: shell.sha256_16,
      assets,
      /* the same files read straight off the disk the carrier is serving, so a
         carrier that mangled a byte cannot pass as the build */
      onDisk: Object.fromEntries(
        readdirSync(join(DIST, "assets")).sort().map((name) => [
          name,
          {
            bytes: statSync(join(DIST, "assets", name)).size,
            sha256_16: createHash("sha256").update(readFileSync(join(DIST, "assets", name))).digest("hex").slice(0, 16),
          },
        ])
      ),
    };
    process.stdout.write(`servedBuild · ${JSON.stringify(readings.servedBuild.assets)}\n`);
  }

  /* ---- A · five widths, the agent card, en --------------------------- */
  if (groups("a")) {
    process.stdout.write("A · five widths (agent card TD-128, en)\n");
    for (const width of WIDTHS) {
      const proto = await protoPage(browser, base, { width });
      await protoOpenCard(proto.page, CARDS.AGENT);
      await shot(proto.page, `a-w${width}-proto.png`, `prototype · ${width}px · drawer open on TD-128`);
      side(proto.page, "proto")[`w${width}`] = await proto.page.evaluate(READ_DRAWER);
      await proto.ctx.close();

      const impl = await implPage(browser, ORIGIN, data, { width });
      await implOpenCard(impl.page, ORIGIN, CARDS.AGENT);
      await shot(impl.page, `a-w${width}-impl.png`, `implementation · ${width}px · drawer open on TD-128`);
      side(impl.page, "impl")[`w${width}`] = await impl.page.evaluate(READ_DRAWER);
      await impl.ctx.close();

      await sideBySide(
        browser,
        [{ file: `a-w${width}-proto.png`, label: "prototype" }, { file: `a-w${width}-impl.png`, label: "implementation" }],
        `a-w${width}-side-by-side.png`,
        `R14 detail drawer · TD-128 (agent) · ${width}px · prototype ⟷ implementation (post-fix)`,
        width + 2
      );
    }
  }

  /* ---- B · the three states ------------------------------------------ */
  if (groups("b")) {
    process.stdout.write("B · states (human / zh / empty)\n");
    const states = [
      { key: "b-human", card: CARDS.HUMAN, zh: false, caption: "TD-126 · human card · the `related` catalogue, single relation row", label: "human" },
      { key: "b-zh", card: CARDS.AGENT, zh: true, caption: "TD-128 · zh · Parent + Blocks catalogues in the zh dictionary", label: "zh" },
      { key: "b-empty", card: CARDS.EMPTY, zh: false, caption: "PROJ-0007 · relations.none + attachments.none (both empty seats)", label: "empty" },
    ];
    for (const s of states) {
      const proto = await protoPage(browser, base, { width: 1512, zh: s.zh });
      await protoOpenCard(proto.page, s.card);
      await shot(proto.page, `${s.key}-proto.png`, `prototype · 1512px · ${s.label} · ${s.card}`);
      side(proto.page, "proto")[s.key] = await proto.page.evaluate(READ_DRAWER);
      await proto.ctx.close();

      const impl = await implPage(browser, ORIGIN, data, { width: 1512, zh: s.zh });
      await implOpenCard(impl.page, ORIGIN, s.card);
      await shot(impl.page, `${s.key}-impl.png`, `implementation · 1512px · ${s.label} · ${s.card}`);
      side(impl.page, "impl")[s.key] = await impl.page.evaluate(READ_DRAWER);
      await impl.ctx.close();

      await sideBySide(
        browser,
        [{ file: `${s.key}-proto.png`, label: "prototype" }, { file: `${s.key}-impl.png`, label: "implementation" }],
        `${s.key}-side-by-side.png`,
        `R14 detail drawer · 1512px · ${s.caption}`,
        1514
      );
    }
  }

  /* ---- E · seat-by-seat computed comparison (no shot, readings only) --- */
  if (groups("e")) {
    process.stdout.write("E · seat comparison at 1512 (TD-128)\n");
    /* The seats the card's own list names — text, layout, spacing, labels,
       attachments, relation rows — read as computed style on both sides, so a
       difference a reader can see in the sheet has a number behind it. */
    const SEATS = [
      "[data-detail-drawer]",
      ".td-drawer-head",
      "[data-detail-identifier]",
      "[data-detail-title]",
      "[data-detail-status-chip]",
      "[data-detail-close]",
      "[data-detail-props]",
      "[data-detail-assignee]",
      "[data-detail-assignee] .td-avatar",
      "[data-detail-reporter]",
      "[data-detail-label-input]",
      "[data-detail-agent-session] [data-agent-platform-value]",
      "[data-detail-version]",
      "[data-detail-status-chip] [data-detail-status-chip-label]",
      "[data-detail-description]",
      "[data-detail-description] > *",
      "[data-detail-relations]",
      "[data-detail-relations] .td-rel-item",
      "[data-detail-attachments]",
      "[data-detail-attachments] .td-file",
      "[data-detail-attachments] .td-file svg",
      "[data-detail-attachments] .td-file-name",
      "[data-detail-attachments] .td-file-size",
      "[data-detail-comments]",
      "[data-detail-comments] .td-comment",
      "[data-comment-input]",
      "[data-detail-activity]",
      "[data-detail-agent-session]",
      "[data-detail-save-error]",
    ];
    const readSeats = (seats) => {
      const out = {};
      for (const sel of seats) {
        const el = document.querySelector(sel);
        if (!el) { out[sel] = null; continue; }
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        out[sel] = {
          text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 90),
          rect: [+r.width.toFixed(1), +r.height.toFixed(1)],
          fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight,
          color: c.color, gap: c.gap, padding: c.padding, marginTop: c.marginTop,
          borderTopWidth: c.borderTopWidth, borderBottomWidth: c.borderBottomWidth,
          borderLeftWidth: c.borderLeftWidth, borderRadius: c.borderRadius,
          outlineWidth: c.outlineWidth, outlineStyle: c.outlineStyle, outlineColor: c.outlineColor,
          outlineOffset: c.outlineOffset,
          boxShadow: c.boxShadow === "none" ? "none" : "set",
          boxShadowValue: c.boxShadow,
          marginLeft: c.marginLeft, display: c.display,
        };
      }
      return out;
    };

    const proto = await protoPage(browser, base, { width: 1512 });
    await protoOpenCard(proto.page, CARDS.AGENT);
    readings.seatCompare = { proto: await proto.page.evaluate(readSeats, SEATS) };
    await proto.ctx.close();

    const impl = await implPage(browser, ORIGIN, data, { width: 1512 });
    await implOpenCard(impl.page, ORIGIN, CARDS.AGENT);
    readings.seatCompare.impl = await impl.page.evaluate(readSeats, SEATS);
    await impl.ctx.close();
  }

  /* ---- C · JS off ----------------------------------------------------- */
  if (groups("c")) {
    process.stdout.write("C · JS disabled\n");
    const crit = {
      note: "判据 = 在 JS 禁用下，抽屉结构钩子是否仍在 DOM 中、且布局盒可见（w/h>0 且 visibility≠hidden）。",
      probe: (sel) => [...document.querySelectorAll(sel)].length,
    };
    const readJsOff = () => {
      const hooks = ["[data-detail-drawer]", "[data-detail-close]", "[data-detail-identifier]", "[data-detail-title]", "[data-detail-props]", "[data-detail-relations]", "[data-detail-attachments]", "[data-detail-comments]", "[data-detail-activity]", "[data-detail-agent-session]", ".td-rel-item", ".td-file", ".td-comment", ".td-activity"];
      const out = { present: {}, visible: {}, app: null };
      for (const h of hooks) {
        const els = [...document.querySelectorAll(h)];
        out.present[h] = els.length;
        out.visible[h] = els.filter((e) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        }).length;
      }
      const root = document.querySelector("#app");
      if (root) out.app = { children: root.children.length, text: root.textContent.trim().length };
      const cards = document.querySelectorAll("[data-card]").length;
      out.boardCards = cards;
      return out;
    };

    const proto = await protoPage(browser, base, { width: 1512, javaScript: false });
    await shot(proto.page, "c-js-off-proto.png", "prototype · 1512px · JS disabled");
    readings.jsOff = readings.jsOff ?? {};
    readings.jsOff.proto = await proto.page.evaluate(readJsOff);
    readings.jsOff.criteria = crit;
    await proto.ctx.close();

    const impl = await implPage(browser, ORIGIN, data, { width: 1512, javaScript: false });
    await implOpenCard(impl.page, ORIGIN, CARDS.AGENT, { javaScript: false });
    await impl.page.waitForTimeout(600);
    await shot(impl.page, "c-js-off-impl.png", "implementation · 1512px · JS disabled");
    readings.jsOff.impl = await impl.page.evaluate(readJsOff);
    await impl.ctx.close();

    await sideBySide(
      browser,
      [{ file: "c-js-off-proto.png", label: "prototype · JS off" }, { file: "c-js-off-impl.png", label: "implementation · JS off" }],
      "c-js-off-side-by-side.png",
      "R14 detail drawer · 1512px · JS disabled · structural visibility pair",
      1514
    );
  }

  /* ---- D · interaction beats ------------------------------------------ */
  if (groups("d")) {
    process.stdout.write("D · interaction (focus / overlay / scroll surface)\n");
    const proto = await protoPage(browser, base, { width: 1512 });
    await protoOpenCard(proto.page, CARDS.AGENT);
    readings.focus = readings.focus ?? {};
    readings.focus.proto = (await proto.page.evaluate(READ_DRAWER)).focus;
    await shot(proto.page, "d-focus-proto.png", "prototype · 1512px · focus landed on [data-detail-close]");
    await elShot(proto.page, "[data-detail-drawer] .td-drawer-head", "d-focus-proto-closeup.png", "prototype · drawer head at focus, close button on its focused face");
    await proto.page.evaluate(() => {
      const b = document.querySelector("[data-detail-drawer] .td-drawer-body");
      b.scrollTop = b.scrollHeight;
    });
    await proto.page.waitForTimeout(250);
    readings.scroll = readings.scroll ?? {};
    readings.scroll.proto = await proto.page.evaluate(() => {
      const b = document.querySelector("[data-detail-drawer] .td-drawer-body");
      return { scrollTop: Math.round(b.scrollTop), scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, overflowY: getComputedStyle(b).overflowY };
    });
    await shot(proto.page, "d-scroll-proto.png", "prototype · 1512px · drawer body scrolled to its end (scroll surface)");
    readings.overlay = readings.overlay ?? {};
    readings.overlay.proto = (await proto.page.evaluate(READ_DRAWER)).overlay;
    await proto.ctx.close();

    const impl = await implPage(browser, ORIGIN, data, { width: 1512 });
    await implOpenCard(impl.page, ORIGIN, CARDS.AGENT);
    readings.focus.impl = (await impl.page.evaluate(READ_DRAWER)).focus;
    await shot(impl.page, "d-focus-impl.png", "implementation · 1512px · focus landed on [data-detail-close]");
    await elShot(impl.page, "[data-detail-drawer] .td-drawer-head", "d-focus-impl-closeup.png", "implementation · drawer head at focus, close button on its focused face");
    await impl.page.evaluate(() => {
      const b = document.querySelector("[data-detail-drawer] .td-drawer-body");
      b.scrollTop = b.scrollHeight;
    });
    await impl.page.waitForTimeout(250);
    readings.scroll.impl = await impl.page.evaluate(() => {
      const b = document.querySelector("[data-detail-drawer] .td-drawer-body");
      return { scrollTop: Math.round(b.scrollTop), scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, overflowY: getComputedStyle(b).overflowY };
    });
    await shot(impl.page, "d-scroll-impl.png", "implementation · 1512px · drawer body scrolled to its end (scroll surface)");
    readings.overlay.impl = (await impl.page.evaluate(READ_DRAWER)).overlay;
    await impl.ctx.close();

    await sideBySide(
      browser,
      [{ file: "d-focus-proto-closeup.png", label: "prototype · focus on close" }, { file: "d-focus-impl-closeup.png", label: "implementation · focus on close" }],
      "d-focus-side-by-side.png",
      "R14 drawer head · 1512px · the opening beat lands focus on [data-detail-close]",
      530
    );
    await sideBySide(
      browser,
      [{ file: "d-scroll-proto.png", label: "prototype · scrolled" }, { file: "d-scroll-impl.png", label: "implementation · scrolled" }],
      "d-scroll-side-by-side.png",
      "R14 drawer · 1512px · the body's own scroll surface, scrolled to its end",
      1514
    );
  }
} catch (err) {
  /* A late failure still writes what it read — and still exits non-zero, so a
     half-run cannot be mistaken for a whole one. */
  readings.failure = { message: String(err?.message ?? err), at: new Date().toISOString() };
  process.exitCode = 1;
  process.stderr.write(`\nFAILED: ${readings.failure.message}\n`);
} finally {
  /* Written from `finally` so a failure loses the run but never the readings
     it already took. */
  const writeEvidence = () =>
    writeFileSync(
      join(HERE, "evidence", "capture.json"),
      JSON.stringify(
        {
          card: "T-20261014-154730-3",
          generated_at: new Date().toISOString(),
          host: `${process.platform} ${process.arch} · node ${process.version}`,
          carrier: { prototype: `${base} (loopback over design/)`, implementation: `127.0.0.1:${DIST_PORT} (loopback over ${DIST})` },
          groups: ONLY === "" ? "id,a,b,e,c,d" : ONLY,
          widths: WIDTHS,
          height: HEIGHT,
          pageErrors,
          shots,
          readings,
        },
        null,
        1
      )
    );
  await browser.close();
  designServer.close();
  distServer.close();
  writeEvidence();
  process.stdout.write(`\n${shots.length} shots + evidence/capture.json → ${HERE}\n`);
  process.exit(process.exitCode ?? 0);
}

/* --------------------------------------------------------------- helpers */

/** GET `path` off the loopback dist carrier; the response body is the reading. */
function fetchFrom(port, path) {
  return new Promise((done) => {
    const req = httpGet({ host: "127.0.0.1", port, path, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        done({
          path,
          status: res.statusCode,
          bytes: body.length,
          text: body.toString("utf8"),
          sha256_16: createHash("sha256").update(body).digest("hex").slice(0, 16),
        });
      });
    });
    req.on("error", () => done({ path, status: 0, bytes: 0, text: "", sha256_16: null }));
    req.on("timeout", () => { req.destroy(); done({ path, status: 0, bytes: 0, text: "", sha256_16: null }); });
  });
}
