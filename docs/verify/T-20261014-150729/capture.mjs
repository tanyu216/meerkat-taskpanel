#!/usr/bin/env node
/* =====================================================================
   T-20261014-150729 · the R14 detail drawer's visual leg.

   Produces the prototype ↔ implementation comparison the epic's done
   condition asks Elon to look at: five widths, three states, the JS-off
   structural pair, and the two interaction beats — plus a machine reading
   of every block in the drawer, so a picture that looks right cannot stand
   in for a block that is missing.

   Usage (host; needs a reachable Playwright and the live build):
     node design/verify/T-20261014-150729/capture.mjs \
       [--only a|b|c|d|live] [--live-port 9527] [--out <dir>]

   Two carriers, both real browsers:
     * prototype — a throwaway loopback static server over `design/`
       (the same carrier `design/prototype/check-combo-display.mjs` uses).
     * implementation — route interception over the **bundle the live
       server serves**: the static half is proxied to `--live-port`, the
       `/api/v1` half is answered by `fixture.mjs`. Nothing is re-built
       (this host has no frontend `node_modules`; the committed npm cache
       is linux/arm64), so what is captured is the served build, and the
       asset hashes recorded in `evidence.json` are its identity.

   Requires `--out` to be empty or absent; it writes the PNGs and one
   `evidence.json` and never touches the tree outside `--out`.
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
const LIVE_PORT = Number(argOf("--live-port", "9527"));
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
        boxShadow: c?.boxShadow === "none" ? "none" : "set",
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
  await mountRoutes(page, { livePort: LIVE_PORT, data, origin });
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
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
/* `unref` so the throwaway static server cannot hold the event loop open after
   the run is over — an un-closed listener makes the process hang with all its
   output still sitting in the pipe. */
const designServer = await serveDesignRoot();
designServer.unref();
const base = `http://127.0.0.1:${designServer.address().port}`;
const data = fixtureApi();
const ORIGIN = "app.test";
const browser = await chromium.launch();

const side = (page, name) => readings[name] ?? (readings[name] = {});

try {
  /* ---- identity of the served build ---------------------------------- */
  if (groups("live") || ONLY === "") {
    const p = await browser.newPage({ viewport: { width: 1512, height: HEIGHT } });
    const assets = {};
    p.on("response", async (res) => {
      const u = res.url();
      if (/\/assets\/.*\.(js|css)$/.test(u)) {
        try {
          assets[u.split("/").pop()] = createHash("sha256").update(await res.body()).digest("hex").slice(0, 16);
        } catch { /* body unavailable */ }
      }
    });
    /* NOT `networkidle`: the board holds an open `EventSource`, so the network
       never goes idle and the wait would never settle. */
    await p.goto(`http://127.0.0.1:${LIVE_PORT}/`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("[data-card]", { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(500);
    readings.servedBuild = { origin: `http://127.0.0.1:${LIVE_PORT}`, assets, title: await p.title() };
    await p.close();
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
        `R14 detail drawer · TD-128 (agent) · ${width}px · prototype ⟷ implementation`,
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
          boxShadow: c.boxShadow === "none" ? "none" : "set",
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

  /* ---- the live board, unmediated ------------------------------------- */
  if (groups("live")) {
    process.stdout.write("LIVE · the board at the card's own address, unmediated\n");
    const p = await browser.newPage({ viewport: { width: 1512, height: HEIGHT } });
    await p.goto(`http://127.0.0.1:${LIVE_PORT}/`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("[data-card]", { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    await shot(p, "live-board-1512.png", `live board at :${LIVE_PORT} · unmediated`);
    const opened = await p.evaluate(() => {
      const card = document.querySelector("[data-card]");
      if (!card) return null;
      (card.querySelector("[data-card-title]") ?? card).click();
      return card.querySelector("[data-card-identifier]")?.textContent.trim() ?? null;
    });
    await p.waitForTimeout(900);
    await shot(p, "live-drawer-1512.png", `live board at :${LIVE_PORT} · drawer opened on ${opened}`);
    readings.live = {
      opened,
      address_after_open: await p.evaluate(() => `${location.pathname}${location.hash}`),
      /* The writer's fragment, then the reader's answer to it: the drawer's own
         deep link is written but never read back (`stores/route.js` preserves
         the hash on the board alias; nothing calls `openDetail` from it). */
      deep_link_opens: await (async () => {
        await p.goto(`http://127.0.0.1:${LIVE_PORT}/#/task/${encodeURIComponent(opened)}`, { waitUntil: "domcontentloaded" });
        await p.waitForTimeout(1200);
        return {
          drawerState: await p.evaluate(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") ?? null),
          address: await p.evaluate(() => `${location.pathname}${location.hash}`),
        };
      })(),
      drawer: await p.evaluate(READ_DRAWER),
    };
    await p.close();
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
      join(OUT, "..", "evidence.json"),
      JSON.stringify(
        {
          card: "T-20261014-150729",
          generated_at: new Date().toISOString(),
          host: `${process.platform} ${process.arch} · node ${process.version}`,
          live_port: LIVE_PORT,
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
  writeEvidence();
  process.stdout.write(`\n${shots.length} shots + evidence.json → ${resolve(OUT, "..")}\n`);
  process.exit(process.exitCode ?? 0);
}
