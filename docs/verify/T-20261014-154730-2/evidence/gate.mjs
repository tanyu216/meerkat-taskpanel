#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730-2 · the drawer gate's R14 I-1/I-2 assertion block, run
   against this worktree's build WITHOUT a listener.

   Why an extraction rather than `node web/scripts/dom-smoke.mjs` itself: this
   lane's sandbox denies every `listen()` (EPERM, TCP *and* unix), and the stock
   harness both (a) boots a real fixture server and (b) registers its own
   `page.route(..., route.continue())` for `/api/v1/tasks` (which needs that
   real server). So the stock process cannot complete here.

   What IS reproduced faithfully:
     * the fixture data and the API handler come from the harness's own
       `startServer` — `node:http`'s `createServer` is shimmed (see http-shim/)
       to capture the handler instead of binding a port, so the handler that
       answers each request is the gate file's own, unmodified;
     * the assertion block is sliced **verbatim** out of `web/scripts/dom-smoke.mjs`
       (lines 752–922) — the same `r14Check(...)` calls, the same strings, the
       same `R14_RELATION_ROWS`; the slice's sha256 is printed so it can be
       checked against the file;
     * `r14Check` semantics are mirrored: collect failures, non-empty ⇒ exit 1.

   What is NOT reproduced: the other R14/R7/R9 rules in the same file (out of
   this card's scope), and the transport (route interception, not a socket).

   Usage: node --import http-shim/register.mjs gate.mjs [--dist D] [--out f.json]
   Exit:  0 all checks pass · 1 assertions failed · 2 environment · 3 harness error
   ===================================================================== */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-154730-2-seg1";
const SMOKE = join(REPO, "web/scripts/dom-smoke.mjs");
const BLOCK_FROM = 752;
const BLOCK_TO = 922;

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at === -1 ? fallback : argv[at + 1];
};
const DIST = resolve(argOf("--dist", join(REPO, "web/dist")));
/* the build under test: static files are served from here, the fixture API from
   the harness's own handler. Defaults to the lane's web/dist, but a mutated
   build in a scratch tree can be pointed at without touching the lane tree. */
const STATIC_ROOT = resolve(argOf("--static-root", DIST));
const OUT = argOf("--out", null);
const LABEL = argOf("--label", "gate");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/* ---- the harness's own fixtures + handler (node:http shimmed) ------------- */
const smoke = await import(pathToFileURL(SMOKE).href);
const { server: fakeServer, port, data } = await smoke.startServer();
const handler = globalThis.__capturedServerHandler;
if (typeof handler !== "function") {
  console.error("environment: the http shim did not capture the fixture handler");
  process.exit(2);
}

/* ---- the assertion block, sliced verbatim --------------------------------- */
const allLines = readFileSync(SMOKE, "utf8").split("\n");
const blockLines = allLines.slice(BLOCK_FROM - 1, BLOCK_TO);
const blockSrc = blockLines.join("\n");
const blockSha = createHash("sha256").update(blockSrc).digest("hex");

/* ---- playwright ----------------------------------------------------------- */
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

/* ---- a req/res shim so the real fixture handler can be driven from a route -- */
function fulfill(page, route, handlerFn) {
  return new Promise((resolveFulfill) => {
    const req = route.request();
    const u = new URL(req.url());
    let done = false;
    const chunks = [];
    const headers = {};
    let status = 200;
    const finish = () => {
      if (done) return;
      done = true;
      const body = Buffer.concat(chunks);
      clearTimeout(timer);
      resolveFulfill(
        route.fulfill({ status, headers, body }).catch(() => {}),
      );
    };
    const timer = setTimeout(finish, 200);
    const resShim = {
      writeHead(s, h) {
        status = s;
        if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
        return resShim;
      },
      setHeader(k, v) {
        headers[k.toLowerCase()] = v;
        return resShim;
      },
      getHeader(k) {
        return headers[k.toLowerCase()];
      },
      write(c) {
        if (c !== undefined) chunks.push(Buffer.from(String(c)));
        return true;
      },
      end(c) {
        if (c !== undefined) chunks.push(Buffer.from(String(c)));
        finish();
        return resShim;
      },
      on() {},
      once() {},
      emit() {},
      removeListener() {},
      get statusCode() {
        return status;
      },
      set statusCode(v) {
        status = v;
      },
    };
    const reqShim = {
      url: u.pathname + u.search,
      method: req.method(),
      headers: req.headers(),
      httpVersion: "1.1",
      socket: { remoteAddress: "127.0.0.1" },
      on() {},
      once() {},
      removeListener() {},
      setEncoding() {},
    };
    try {
      handlerFn(reqShim, resShim);
    } catch (err) {
      console.error("handler threw:", err);
      clearTimeout(timer);
      route.fulfill({ status: 500, body: "handler threw" }).catch(() => {});
      resolveFulfill();
    }
  });
}

/* ---- run ------------------------------------------------------------------ */
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`environment: no built app at ${DIST}`);
  process.exit(2);
}
const browserType = await loadPlaywright();
if (!browserType) {
  console.error("environment: no Playwright (set PLAYWRIGHT_ENTRY)");
  process.exit(2);
}

const browser = await browserType.launch();
const consoleErrors = [];
const pageErrors = [];
let failures = [];
let status = "ok";

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "127.0.0.1") return route.fulfill({ status: 404, body: "off-origin" });
    const isApi = u.pathname.startsWith("/api/") || u.pathname === "/health";
    if (isApi) return fulfill(page, route, handler);
    // static (the build under test), with the SPA fallback Vite's build implies
    const rel = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(STATIC_ROOT, rel === "/" ? "index.html" : rel);
    if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(STATIC_ROOT, "index.html");
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({
      status: 200,
      contentType: MIME[extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-column]", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.click('[data-view="board"]');
  await page.waitForTimeout(120);
  await page.click("[data-card]");
  await page.waitForTimeout(250);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("page", `${blockSrc}\nreturn r14Failures;`);
  failures = await run(page);
  status = failures.length === 0 ? "green" : "red";
} catch (err) {
  console.error("HARNESS ERROR:", err);
  await browser.close().catch(() => {});
  process.exit(3);
}
await browser.close().catch(() => {});

const report = {
  label: LABEL,
  dist: DIST,
  staticRoot: STATIC_ROOT,
  block: { from: BLOCK_FROM, to: BLOCK_TO, sha256: blockSha, lines: BLOCK_TO - BLOCK_FROM + 1 },
  status,
  exitCode: failures.length === 0 ? 0 : 1,
  failureCount: failures.length,
  failures,
  consoleErrors,
  pageErrors,
  fixtureProjects: data.projects?.length ?? null,
  fixtureTasks: data.tasks?.length ?? null,
};
const payload = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, payload + "\n");
console.log(payload);
process.exit(report.exitCode);
