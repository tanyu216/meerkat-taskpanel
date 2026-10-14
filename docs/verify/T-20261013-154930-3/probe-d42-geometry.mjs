/**
 * R14 · targeted re-probe for the single D42 FAIL (attachment row geometry).
 *
 * Why this file exists: `verify-r14-impl.mjs` D42 judged "size sits at the row's
 * end" false, with the note `size.marginLeft=0px (used), row.right=1492,
 * size.right=1571.59`. That reading is only interpretable if something *inside
 * the row* is wider than the row. This probe dumps the row's child boxes so the
 * finding can be attributed to a mechanism (not just a number).
 *
 *   node probe-d42-geometry.mjs --dist <web/dist>
 *
 * Read-only: it mounts the built `dist` behind Playwright routes (the sandbox
 * denies `listen(2)`) and reads geometry. It never writes to the SUT.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { fixtureApi, mountRoutes, RICH_ID } from "./fixture.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const DIST = resolve(argOf("dist", "web/dist"));

function resolvePlaywright() {
  const roots = [process.env.PLAYWRIGHT_ROOT, join(process.cwd(), "node_modules")].filter(Boolean);
  for (const base of ["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"]) roots.push(base);
  try {
    const nvm = join(homedir(), ".nvm/versions/node");
    if (existsSync(nvm)) for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib/node_modules"));
  } catch {
    /* best effort */
  }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      return createRequire(join(root, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  return null;
}

const READ = () => {
  const row = document.querySelector("[data-attachment-row]");
  if (!row) return { error: "no [data-attachment-row]" };
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  };
  const box = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      class: el.getAttribute("class"),
      rect: rect(el),
      width: cs.width,
      height: cs.height,
      flex: `${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis}`,
      marginLeft: cs.marginLeft,
      display: cs.display,
    };
  };
  const rowCs = getComputedStyle(row);
  return {
    row: { ...box(row), paddingLeft: rowCs.paddingLeft, paddingRight: rowCs.paddingRight, overflowX: rowCs.overflowX },
    children: Array.from(row.children).map(box),
    size: box(document.querySelector("[data-attachment-size]")),
    rowScroll: { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
    docOverflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
  };
};

async function main() {
  const playwright = resolvePlaywright();
  if (!playwright) {
    console.error("no playwright available");
    process.exit(2);
  }
  const data = fixtureApi();
  const browser = await playwright.chromium.launch({ headless: true, args: ["--single-process"], timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 1512, height: 950 } });
  const page = await context.newPage();
  await mountRoutes(page, { distDir: DIST, data });
  await page.goto("http://app.test/board", { waitUntil: "load" });
  await page.waitForSelector("[data-card]", { timeout: 20000 });
  await page.click(`[data-card][data-identifier="${RICH_ID}"]`);
  await page.waitForFunction(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") === "open", null, {
    timeout: 10000,
  });
  await page.waitForTimeout(260);
  const reading = await page.evaluate(READ);
  console.log(JSON.stringify(reading, null, 2));
  await browser.close();
}

await main();
