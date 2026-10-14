#!/usr/bin/env node
/* Five-width drawer regression, route-interception carrier (no listener).
   For each width: open the drawer on the fixture board and read
   • the drawer's own rendered width (`min(520px, 100vw)`),
   • whether the *document* overflows horizontally (scrollWidth > clientWidth+1),
   • whether the drawer's own content overflows horizontally.
   Usage: node --import http-shim/register.mjs widths.mjs [--static-root D] [--out f.json]
   Exit: 0 read · 2 environment · 3 harness error. Never exits 1 (it is a read). */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-154730-2-seg1";
const DIST = resolve(join(REPO, "web/dist"));
const argv = process.argv.slice(2);
const argOf = (f, d) => (argv.indexOf(f) === -1 ? d : argv[argv.indexOf(f) + 1]);
const STATIC_ROOT = resolve(argOf("--static-root", DIST));
const OUT = argOf("--out", null);
const WIDTHS = [1512, 1240, 980, 760, 430];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const smoke = await import(pathToFileURL(join(REPO, "web/scripts/dom-smoke.mjs")).href);
const { port } = await smoke.startServer();
const handler = globalThis.__capturedServerHandler;

const mod = await import(process.env.PLAYWRIGHT_ENTRY ? pathToFileURL(process.env.PLAYWRIGHT_ENTRY).href : "playwright");
const chromium = mod.chromium || mod.default.chromium;

function fulfill(route) {
  return new Promise((res) => {
    const u = new URL(route.request().url());
    const chunks = [];
    const headers = {};
    let status = 200;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res(route.fulfill({ status, headers, body: Buffer.concat(chunks) }).catch(() => {}));
    };
    const timer = setTimeout(finish, 200);
    const resShim = {
      writeHead(s, h) { status = s; if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]; return resShim; },
      setHeader(k, v) { headers[k.toLowerCase()] = v; return resShim; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      write(c) { if (c !== undefined) chunks.push(Buffer.from(String(c))); return true; },
      end(c) { if (c !== undefined) chunks.push(Buffer.from(String(c))); finish(); return resShim; },
      on() {}, once() {}, emit() {}, removeListener() {},
      get statusCode() { return status; }, set statusCode(v) { status = v; },
    };
    const reqShim = { url: u.pathname + u.search, method: route.request().method(), headers: route.request().headers(), httpVersion: "1.1", socket: {}, on() {}, once() {}, removeListener() {}, setEncoding() {} };
    handler(reqShim, resShim);
  });
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (u.hostname !== "127.0.0.1") return route.fulfill({ status: 404, body: "off-origin" });
  const isApi = u.pathname.startsWith("/api/") || u.pathname === "/health";
  if (isApi) return fulfill(route);
  const rel = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(STATIC_ROOT, rel === "/" ? "index.html" : rel);
  if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(STATIC_ROOT, "index.html");
  if (!existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
  return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
});

const rows = [];
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-column]", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.click("[data-view=\"board\"]");
  await page.waitForTimeout(120);
  await page.click("[data-card]");
  await page.waitForFunction(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") === "open", null, { timeout: 8000 });
  await page.waitForTimeout(450);
  const read = await page.evaluate(() => {
    const de = document.documentElement;
    const drawer = document.querySelector("[data-detail-drawer]");
    const r = drawer.getBoundingClientRect();
    return {
      drawerWidth: Math.round(r.width * 100) / 100,
      drawerLeft: Math.round(r.left * 100) / 100,
      drawerRight: Math.round(r.right * 100) / 100,
      docScrollWidth: de.scrollWidth,
      docClientWidth: de.clientWidth,
      docOverflow: de.scrollWidth > de.clientWidth + 1,
      bodyScrollWidth: document.body.scrollWidth,
      drawerScrollWidth: drawer.scrollWidth,
      drawerClientWidth: drawer.clientWidth,
      drawerContentOverflow: drawer.scrollWidth > drawer.clientWidth + 1,
      innerWidth: window.innerWidth,
    };
  });
  rows.push({ width, ...read });
  // close so the next width starts clean
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}
await browser.close().catch(() => {});

const report = { staticRoot: STATIC_ROOT, widths: WIDTHS, rows };
const payload = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, payload + "\n");
console.log(payload);
