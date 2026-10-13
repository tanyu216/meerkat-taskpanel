#!/usr/bin/env node
/* =====================================================================
   check-combo-display.mjs — the machine check for the create dialog's
   Parent / Depends-on display spec (task T-20261014-001418).
   ---------------------------------------------------------------------
   Usage
     node design/prototype/check-combo-display.mjs                # static + render
     node design/prototype/check-combo-display.mjs --static-only   # no browser
     node design/prototype/check-combo-display.mjs --shots         # write screenshots/

   Zero dependencies beyond Node's standard library; the render half drives the
   host's Playwright if one is reachable and FAILS (it does not skip) when one
   is not, because an assertion nobody can evaluate is not a passing assertion.

   Two suites, one exit code:
     static — parses index.html / app.js / src/input.css / tw.css as text.
              Every assertion is a claim about the shipped artefact.
     render — loads the page over a throwaway loopback server and drives the
              control the way a reader does: open the dialog, open a menu,
              accept a row, clear it. No network beyond 127.0.0.1.

   The spec's A-table is the contract (A1–A8); the S-checks are the structural
   claims the A-table rests on, kept separate so the mapping stays readable.
   ===================================================================== */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, "..");

const INDEX_PATH = join(HERE, "index.html");
const APP_PATH = join(HERE, "app.js");
const INPUT_CSS_PATH = join(HERE, "src", "input.css");
const TW_CSS_PATH = join(HERE, "tw.css");
const SHOTS_DIR = join(HERE, "screenshots");

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes("--static-only");
const SHOTS = argv.includes("--shots");

/* ------------------------------------------------------------- harness */

const results = [];
let current = null;

function suite(name) {
  current = name;
}

function check(id, ok, detail) {
  results.push({ suite: current, id, ok: !!ok, detail: detail || "" });
  process.stdout.write(`[${ok ? "  ok  " : " FAIL "}] ${id}${detail ? " — " + detail : ""}\n`);
}

/* ------------------------------------------------------------- sources */

const html = readFileSync(INDEX_PATH, "utf8");
const js = readFileSync(APP_PATH, "utf8");
const inputCss = readFileSync(INPUT_CSS_PATH, "utf8");
const twCss = readFileSync(TW_CSS_PATH, "utf8");

/* --------------------------------------------------- the one truncation */

/* The rule, restated here from `app.js:identifierText` — length ≤ 8 verbatim,
   longer → its first eight characters plus an ellipsis. The check states it
   independently so it is a claim about the artefact, not a copy of it. */
const cap = (value) => {
  const id = String(value || "");
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
};

/* ------------------------------------------------------ tiny tag parser */

function startTags(source) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(source))) {
    out.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2]), raw: m[0], index: m.index });
  }
  return out;
}

function parseAttrs(chunk) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(chunk))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[m[1]] = value === undefined ? "" : value;
  }
  return attrs;
}

/** One function's source, from its declaration to the next top-level one. */
function functionSource(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) return null;
  const rest = source.slice(at + 10);
  const next = rest.search(/\n  function [A-Za-z_$]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** A single rule's declaration block, as text — `null` when the rule is gone. */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  return css.slice(at, css.indexOf("}", at) + 1);
}

/** The declared value of one property inside a rule body. */
function decl(rule, property) {
  if (!rule) return null;
  const m = rule.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`, "i"));
  return m ? m[1].trim() : null;
}

/** Every option row's identifier cell and value, read off the document. */
function seedRows(marker) {
  const rows = [];
  for (const tag of startTags(html)) {
    if (tag.attrs[`data-${marker}-option`] === undefined) continue;
    const end = html.indexOf("</button>", tag.index);
    const body = html.slice(tag.index + tag.raw.length, end);
    const id = body.match(/<span class="td-mono td-combo-id">([^<]*)<\/span>/);
    const title = body.match(/<span class="td-combo-title">([^<]*)<\/span>/);
    rows.push({
      value: tag.attrs[`data-${marker}-value`],
      title: tag.attrs.title,
      idText: id ? id[1] : null,
      titleText: title ? title[1] : null,
    });
  }
  return rows;
}

/* =====================================================================
   STATIC SUITE
   ===================================================================== */

suite("static");

/* --- S · the structure the A-table rests on ---------------------------- */

const parentRoot = startTags(html).find((t) => t.attrs["data-create-task-parent"] !== undefined);
check("S1.1 [data-create-task-parent] present exactly once", (html.match(/data-create-task-parent(?=[\s>])/g) || []).length === 1);

{
  /* The chip container has to be inside the parent control and ahead of the
     field, so the chip stands where the value stands. */
  const chips = startTags(html).filter((t) => t.attrs["data-parent-chips"] !== undefined);
  check("S1.2 [data-parent-chips] present exactly once", chips.length === 1, `${chips.length} occurrence(s)`);
  const field = html.indexOf('<div class="td-combo-field">', parentRoot ? parentRoot.index : 0);
  check(
    "S1.3 [data-parent-chips] sits inside [data-create-task-parent], before its .td-combo-field",
    chips.length === 1 && parentRoot && chips[0].index > parentRoot.index && field !== -1 && chips[0].index < field,
  );
}

for (const marker of ["parent", "depends"]) {
  const rows = seedRows(marker);
  const wrong = rows.filter((r) => r.idText !== cap(r.value));
  check(
    `S2.${marker} every static seed row's identifier is identifierText(its value)`,
    rows.length > 0 && wrong.length === 0,
    `${rows.length} row(s)${wrong.length ? " · wrong: " + wrong.slice(0, 3).map((r) => `${r.value}→${r.idText}`).join(", ") : ""}`,
  );
  const overCap = rows.filter((r) => String(r.value).length > 8);
  check(
    `S3.${marker}a the seed carries an over-cap identifier (the truncation is exercised)`,
    overCap.length >= 1,
    overCap.map((r) => `${r.value}→${r.idText}`).join(", ") || "none",
  );
  /* 48 characters is a floor, not a measurement: at the 980px viewport a 45
     character title is already clipped, so anything at or past 48 cannot fit.
     The render half is what proves a real clip on a real box. */
  const longTitle = rows.filter((r) => (r.titleText || "").length >= 48);
  check(
    `S3.${marker}b the seed carries a title long enough to need the ellipsis`,
    longTitle.length >= 1,
    longTitle.map((r) => `${(r.titleText || "").length} chars`).join(", ") || "none",
  );
  const truncTitle = rows.filter((r) => r.titleText !== r.title);
  check(
    `S2.${marker}b every seed row keeps the whole title on its tooltip (${marker})`,
    truncTitle.length === 0,
    truncTitle.length ? truncTitle.map((r) => r.value).join(", ") : `${rows.length} row(s)`,
  );
}

{
  /* A row's tooltip is the whole title — the ellipsis is paint, never data. */
  const rows = seedRows("parent");
  const withTitle = rows.filter((r) => r.titleText && r.title === r.titleText);
  check("S2.parentc every seeded row's title attribute carries the whole title", withTitle.length === rows.filter((r) => r.titleText).length);
}

/* --- S4/S5 · the stylesheet the design ships --------------------------- */

{
  /* The row rule is the only one in this family with a two-line selector, so
     it is read by its first line rather than by a joined string. */
  const rowRule = (twCss.match(/\.td-combo-menu \[data-parent-option\][\s\S]{0,90}?\{[^}]*\}/) || [])[0] || null;
  check(
    "S4.1 built tw.css: the option row is a flex row that may shrink (min-width:0)",
    !!rowRule && decl(rowRule, "min-width") === "0" && /display:\s*flex/.test(rowRule),
    rowRule ? rowRule.replace(/\s+/g, " ").trim().slice(0, 130) : "rule not found",
  );
  const titleRule = ruleBody(twCss, ".td-combo-title");
  check(
    "S4.2 built tw.css: .td-combo-title takes the remaining space and clips",
    !!titleRule &&
      decl(titleRule, "flex") === "1 1 auto" &&
      decl(titleRule, "min-width") === "0" &&
      decl(titleRule, "overflow") === "hidden" &&
      decl(titleRule, "text-overflow") === "ellipsis" &&
      decl(titleRule, "white-space") === "nowrap",
    titleRule ? titleRule.replace(/\s+/g, " ").trim().slice(0, 170) : "rule not found",
  );
  const chipTitle = ruleBody(twCss, ".td-chip .td-combo-title");
  const chipMono = ruleBody(twCss, ".td-chip .td-mono");
  check(
    "S4.3 built tw.css: the chip's title is single-line and clipping, its identifier fixed",
    !!chipTitle &&
      decl(chipTitle, "min-width") === "0" &&
      decl(chipTitle, "overflow") === "hidden" &&
      decl(chipTitle, "text-overflow") === "ellipsis" &&
      decl(chipTitle, "white-space") === "nowrap" &&
      !!chipMono && decl(chipMono, "flex") === "0 0 auto",
    `title ${!!chipTitle} · mono ${!!chipMono}`,
  );
  check(
    "S4.4 built tw.css: a parent chip keeps the field's clear affordance",
    /\.td-combo:has\(\[data-parent-chip\]\)\s*\.td-combo-clear\s*\{[^}]*display:\s*inline-flex/.test(twCss),
  );

  /* §7 — the rules this card touched introduce no token and no literal; every
     token they read already lives in tw.css. Read off the authored source,
     which is what the build copies. */
  const touched = [
    (inputCss.match(/\.td-combo-menu \[data-parent-option\][\s\S]{0,90}?\{[^}]*\}/) || [])[0],
    ruleBody(inputCss, ".td-combo-id"),
    ruleBody(inputCss, ".td-combo-title"),
    ruleBody(inputCss, ".td-combo:has([data-parent-chip]) .td-combo-clear"),
    ruleBody(inputCss, ".td-chip .td-mono"),
    ruleBody(inputCss, ".td-chip .td-combo-title"),
  ].filter(Boolean);
  check(
    "S5.0 all six rules this card touched are present in the authored source",
    touched.length === 6,
    `${touched.length}/6 found`,
  );
  const literals = touched.flatMap((r) => [...r.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g)].map((m) => m[0]));
  const declared = touched.flatMap((r) => [...r.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  check(
    "S5.1 the touched rules declare no custom property (the token set is untouched)",
    declared.length === 0,
    declared.join(", ") || "no declaration",
  );
  check("S5.2 the touched rules introduce no colour literal", literals.length === 0, [...new Set(literals)].join(", ") || "none");
  const used = [...new Set(touched.flatMap((r) => [...r.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1])))];
  const missing = used.filter((name) => !new RegExp(`${name}\\s*:`).test(twCss));
  check("S5.3 every token the touched rules read already exists in tw.css", missing.length === 0, missing.join(", ") || `${used.length} token(s)`);
}

{
  /* §7 purity — the prototype is a document, not a client. */
  const impure = ["fetch(", "apiFetch(", "XMLHttpRequest", "localStorage", "sessionStorage"].filter((n) => js.includes(n) && !/combo/i.test(n));
  const net = [...`${js}\n${html}`.matchAll(/https?:\/\//g)];
  check("S6.1 the prototype makes no API call and reads no storage", impure.length === 0, impure.join(", ") || "none");
  check("S6.2 the prototype names no remote origin", net.length === 0, net.length ? `${net.length} URL(s)` : "none");
}

/* --- A1 · the option row routes through the one truncation ------------- */

{
  const fn = functionSource(js, "comboOptionMarkup");
  check(
    "A1 comboOptionMarkup renders .td-combo-id through identifierText()",
    !!fn && fn.includes("td-combo-id") && fn.includes("identifierText(") && !/\.text\(\s*entry\.identifier\s*\)/.test(fn),
    fn ? "identifierText( present, raw .text(entry.identifier) absent" : "comboOptionMarkup not found",
  );
}

/* --- A8 · one truncation in the document, and the chip uses it --------- */

{
  const sites = [...js.matchAll(/slice\(\s*0\s*,\s*8\s*\)/g)].length;
  const inIdentifierText = !!functionSource(js, "identifierText") && /slice\(\s*0\s*,\s*8\s*\)/.test(functionSource(js, "identifierText"));
  check(
    "A8.1 app.js carries exactly one `slice(0, 8)` and it is identifierText's",
    sites === 1 && inIdentifierText,
    `${sites} site(s), inside identifierText: ${inIdentifierText}`,
  );
  const optionFn = functionSource(js, "comboOptionMarkup");
  const chipFn = functionSource(js, "addComboChip");
  check(
    "A8.2 both the option row and the chip route their identifier through identifierText()",
    !!optionFn && optionFn.includes("identifierText(") && !!chipFn && chipFn.includes("identifierText("),
    `option row: ${!!optionFn && optionFn.includes("identifierText(")} · chip: ${!!chipFn && chipFn.includes("identifierText(")}`,
  );
  check(
    "A8.3 neither the option row nor the chip slices an identifier itself",
    !!optionFn && !!chipFn && !/slice\(/.test(optionFn) && !/slice\(/.test(chipFn),
  );

  /* The same rule is mirrored outside this document — the board's own
     `identifierText` (web/src/lib/identifier.js, via IDENTIFIER_LIMIT) and one
     test's expectation string. Neither is this card's to change (its write面
     is design/prototype/**), so they are reported as a diagnostic rather than
     asserted; what this suite owns is that the document carries one
     truncation and points both readers at it. */
  process.stdout.write(
    "        · note: identifierText is mirrored in web/src/lib/identifier.js (IDENTIFIER_LIMIT)\n" +
      "          and restated as an expectation in test/web/identifier.test.mjs — both outside\n" +
      "          this card's write面, and the same-value check that keeps the mirror honest is\n" +
      "          test/web/identifier.test.mjs.\n",
  );
}

/* =====================================================================
   RENDER SUITE
   ===================================================================== */

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
    } catch (err) {
      /* try the next candidate */
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function serveDesignRoot() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const target = resolve(DESIGN, "." + decodeURIComponent(url.pathname));
      if (!target.startsWith(DESIGN) || !existsSync(target)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream" });
      res.end(readFileSync(target));
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

const VIEWPORTS = [
  { label: "1512", width: 1512, height: 900 },
  { label: "1240", width: 1240, height: 900 },
  { label: "980", width: 980, height: 900 },
  { label: "760", width: 760, height: 900 },
  { label: "430", width: 430, height: 900 },
];

/* The page, driven the way a reader drives it. */
const OPEN_DIALOG = () => document.querySelector("[data-new-task]").click();
const EXPAND = (sel) => {
  const input = document.querySelector(sel);
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/* One row's reading, as the assertion needs it. */
const READ_ROWS = (marker) =>
  [...document.querySelectorAll(`[data-${marker}-option]`)].map((button) => {
    const id = button.querySelector(".td-combo-id");
    const title = button.querySelector(".td-combo-title");
    const cs = title ? getComputedStyle(title) : null;
    return {
      value: button.getAttribute(`data-${marker}-value`),
      id: id ? id.textContent : null,
      titleText: title ? title.textContent : null,
      titleAttr: button.getAttribute("title"),
      textOverflow: cs ? cs.textOverflow : null,
      whiteSpace: cs ? cs.whiteSpace : null,
      overflow: cs ? cs.overflow : null,
      clipped: title ? title.scrollWidth > title.clientWidth : false,
      scrollWidth: title ? title.scrollWidth : 0,
      clientWidth: title ? title.clientWidth : 0,
    };
  });

async function renderSuite() {
  suite("render");

  const chromium = await loadPlaywright();
  if (!chromium) {
    check("R0.0 Playwright reachable", false, "no playwright module on this host — the render suite cannot be evaluated");
    return;
  }
  check("R0.0 Playwright reachable", true);

  const server = await serveDesignRoot();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/prototype/index.html`;
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1512, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.jQuery);
    await page.evaluate(OPEN_DIALOG);
    await page.waitForTimeout(150);
    const open = await page.evaluate(() => {
      const d = document.querySelector("[data-create-task]");
      return !!d && d.open === true;
    });
    check("R0.1 the create dialog opens", open, `dialog.open = ${open}`);
    check("R0.2 no console or page errors on the way in", consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors].slice(0, 2).join(" | "));

    /* -- A2 · the option rows ------------------------------------------- */
    await page.evaluate(EXPAND, "[data-parent-input]");
    await page.waitForTimeout(150);
    const rows = await page.evaluate(READ_ROWS, "parent");
    check("A2.0 the Parent menu renders rows", rows.length > 0, `${rows.length} row(s)`);

    const malformed = rows.filter((r) => !/^.{0,8}(…)?$/u.test(r.id || ""));
    check(
      "A2.1 every Parent option's identifier is at most 8 characters plus an ellipsis",
      malformed.length === 0,
      malformed.length ? malformed.map((r) => `${r.value}→${r.id}`).join(", ") : `${rows.length} row(s) checked`,
    );
    const overCap = rows.filter((r) => String(r.value).length > 8);
    const shortFromCap = overCap.filter((r) => r.id !== cap(r.value));
    check(
      "A2.2 every over-cap identifier is exactly its first eight characters plus an ellipsis",
      overCap.length > 0 && shortFromCap.length === 0,
      overCap.length
        ? `${overCap.length} over-cap row(s): ${overCap.map((r) => `${r.value}→${r.id}`).join(", ")}`
        : "no over-cap identifier in the roster — the cap is not exercised",
    );
    const short = rows.filter((r) => String(r.value).length <= 8 && r.id !== r.value);
    check("A2.3 a short identifier renders verbatim", short.length === 0, short.map((r) => `${r.value}→${r.id}`).join(", ") || "none altered");
    const titleLost = rows.filter((r) => r.titleText && r.titleAttr !== r.titleText);
    check("A2.4 each row's tooltip still carries the whole title", titleLost.length === 0, titleLost.length ? titleLost.map((r) => r.value).join(", ") : `${rows.length} row(s)`);

    /* -- A3 · the ellipsis is declared and real -------------------------- */
    const badStyle = rows.filter((r) => r.textOverflow !== "ellipsis" || r.whiteSpace !== "nowrap" || r.overflow !== "hidden");
    check(
      "A3.1 every Parent option title computes nowrap + hidden + ellipsis",
      badStyle.length === 0,
      badStyle.length ? badStyle.slice(0, 2).map((r) => `${r.value}: ${r.overflow}/${r.whiteSpace}/${r.textOverflow}`).join(" | ") : `${rows.length} row(s)`,
    );

    /* A menu is only as wide as its control, so whether a title is *actually*
       cut is a property of the viewport, not of the rule. The declaration is
       asserted everywhere above; the clip has to be observed somewhere, or the
       rule would only be claiming it could. */
    const clipEvidence = [];
    let clipExample = null;
    for (const vp of VIEWPORTS) {
      const p = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await p.goto(base, { waitUntil: "load" });
      await p.waitForFunction(() => !!window.jQuery);
      await p.evaluate(OPEN_DIALOG);
      await p.waitForTimeout(120);
      await p.evaluate(EXPAND, "[data-parent-input]");
      await p.waitForTimeout(120);
      const read = await p.evaluate(READ_ROWS, "parent");
      const cut = read.filter((r) => r.clipped);
      clipEvidence.push(`${vp.label}:${cut.length}`);
      if (cut.length) clipExample = `${cut[0].value} ${cut[0].scrollWidth}>${cut[0].clientWidth} at ${vp.label}px`;
      await p.close();
    }
    check(
      "A3.2 the ellipsis is real, not merely declared (a title is genuinely cut)",
      clipEvidence.some((e) => !e.endsWith(":0")),
      `clipped rows per viewport — ${clipEvidence.join(" ")}${clipExample ? " · " + clipExample : ""}`,
    );

    /* -- A4 · the field shows what was chosen ---------------------------- */
    const pick = overCap.length ? overCap[0] : rows[0];
    const chosen = await page.evaluate((value) => {
      const button = [...document.querySelectorAll("[data-parent-option]")].find((b) => b.getAttribute("data-parent-value") === value);
      button.click();
      const chips = [...document.querySelectorAll("[data-parent-chip]")];
      const chip = chips[0];
      const mono = chip ? chip.querySelector(".td-mono") : null;
      const title = chip ? chip.querySelector(".td-combo-title") : null;
      return {
        chipCount: chips.length,
        value: chip ? chip.getAttribute("data-parent-value") : null,
        mono: mono ? mono.textContent : null,
        hasTitle: !!title,
        titleText: title ? title.textContent : null,
        titleAttr: chip ? chip.getAttribute("title") : null,
        hasRemove: !!(chip && chip.querySelector("[data-parent-remove]")),
        input: document.querySelector("[data-parent-input]").value,
        menuHidden: document.querySelector("[data-parent-menu]").hidden,
        clearDisplay: getComputedStyle(document.querySelector("[data-parent-clear]")).display,
      };
    }, pick.value);

    check("A4.1 accepting a Parent row leaves exactly one chip", chosen.chipCount === 1, `${chosen.chipCount} chip(s)`);
    check(
      "A4.2 the chip's identifier is the capped one (≤ 9 characters, ellipsis when over-cap)",
      chosen.mono !== null && chosen.mono.length <= 9 && (String(pick.value).length <= 8 ? chosen.mono === pick.value : chosen.mono.endsWith("…") && chosen.mono === cap(pick.value)),
      `${pick.value} → ${JSON.stringify(chosen.mono)}`,
    );
    check(
      "A4.3 the chip carries the whole title in its title span and on its tooltip",
      chosen.hasTitle && chosen.titleText === pick.titleText && chosen.titleAttr === pick.titleText,
      `span=${JSON.stringify(chosen.titleText)} tooltip=${JSON.stringify(chosen.titleAttr)}`,
    );
    check("A4.4 the chip keeps its own way out", chosen.hasRemove);
    check("A4.5 the input hands the display to the chip", chosen.input === "");
    check("A4.6 accepting closes the menu", chosen.menuHidden === true);
    check(
      "A4.7 the field's clear affordance is still reachable while the chip is up",
      chosen.clearDisplay !== "none",
      `display: ${chosen.clearDisplay}`,
    );

    /* -- A5 · clear ------------------------------------------------ */
    const cleared = await page.evaluate(() => {
      document.querySelector("[data-parent-clear]").click();
      return {
        chips: document.querySelectorAll("[data-parent-chip]").length,
        input: document.querySelector("[data-parent-input]").value,
        menuHidden: document.querySelector("[data-parent-menu]").hidden,
      };
    });
    check("A5.1 the field's clear ✕ empties the chip", cleared.chips === 0, `${cleared.chips} chip(s) left`);
    check("A5.2 the field's clear ✕ empties the input", cleared.input === "");
    check("A5.3 clearing stays a dismissal — the menu does not reopen", cleared.menuHidden === true);

    /* the chip's own ✕ is the same act from the other side */
    await page.evaluate(EXPAND, "[data-parent-input]");
    await page.waitForTimeout(120);
    const fromChip = await page.evaluate((value) => {
      const button = [...document.querySelectorAll("[data-parent-option]")].find((b) => b.getAttribute("data-parent-value") === value);
      button.click();
      const before = document.querySelectorAll("[data-parent-chip]").length;
      document.querySelector("[data-parent-remove]").click();
      return { before, after: document.querySelectorAll("[data-parent-chip]").length };
    }, pick.value);
    check(
      "A4.8 the chip's own ✕ removes it",
      fromChip.before === 1 && fromChip.after === 0,
      `${fromChip.before} → ${fromChip.after}`,
    );

    /* -- A6 · depends-on, same rule ------------------------------------- */
    await page.evaluate(EXPAND, "[data-depends-input]");
    await page.waitForTimeout(120);
    const depends = await page.evaluate(() => {
      const opts = [...document.querySelectorAll("[data-depends-option]")];
      const first = opts[0].getAttribute("data-depends-value");
      const second = opts[1].getAttribute("data-depends-value");
      opts[0].click();
      [...document.querySelectorAll("[data-depends-option]")].find((o) => o.getAttribute("data-depends-value") === second).click();
      const read = () =>
        [...document.querySelectorAll("[data-depends-chip]")].map((chip) => {
          const mono = chip.querySelector(".td-mono");
          const title = chip.querySelector(".td-combo-title");
          return {
            value: chip.getAttribute("data-depends-value"),
            mono: mono ? mono.textContent : null,
            hasTitle: !!title,
            titleText: title ? title.textContent : null,
            titleAttr: chip.getAttribute("title"),
          };
        });
      const two = read();
      document.querySelector("[data-depends-remove]").click();
      return { two, one: read(), second, first };
    });

    check("A6.1 two accepted prerequisites make two chips", depends.two.length === 2, `${depends.two.length} chip(s)`);
    const badMono = depends.two.filter((c) => !/^.{0,8}(…)?$/u.test(c.mono || "") || c.mono !== cap(c.value));
    check(
      "A6.2 every depends chip's identifier wears the same cap as an option row",
      badMono.length === 0,
      depends.two.map((c) => `${c.value}→${c.mono}`).join(", "),
    );
    const noTitle = depends.two.filter((c) => !c.hasTitle || c.titleText !== c.titleAttr);
    check(
      "A6.3 every depends chip carries the whole title (span = tooltip)",
      noTitle.length === 0,
      noTitle.length ? noTitle.map((c) => c.value).join(", ") : `${depends.two.length} chip(s)`,
    );
    check("A6.4 a chip's ✕ drops that chip and only that one", depends.one.length === 1, `${depends.two.length} → ${depends.one.length}`);

    /* -- A7 · the breakpoints ------------------------------------------- */
    for (const vp of VIEWPORTS) {
      const vpage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const errors = [];
      vpage.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      vpage.on("pageerror", (e) => errors.push(String(e)));
      await vpage.goto(base, { waitUntil: "load" });
      await vpage.waitForFunction(() => !!window.jQuery);
      await vpage.evaluate(OPEN_DIALOG);
      await vpage.waitForTimeout(120);
      /* the heaviest reading: a parent chip up, two depends chips up, and a
         menu open over them */
      const metrics = await vpage.evaluate(() => {
        document.querySelector("[data-parent-input]").focus();
        document.querySelector("[data-parent-input]").dispatchEvent(new Event("input", { bubbles: true }));
        const option = document.querySelector("[data-parent-option]");
        if (option) option.click();
        const dependsInput = document.querySelector("[data-depends-input]");
        dependsInput.focus();
        dependsInput.dispatchEvent(new Event("input", { bubbles: true }));
        const opts = [...document.querySelectorAll("[data-depends-option]")];
        if (opts[0]) opts[0].click();
        const again = [...document.querySelectorAll("[data-depends-option]")];
        if (again[0]) again[0].click();
        const de = document.documentElement;
        const overflowing = [...document.querySelectorAll("[data-create-task] *")]
          .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
          .slice(0, 3)
          .map((el) => el.className || el.tagName);
        return {
          scrollWidth: de.scrollWidth,
          clientWidth: de.clientWidth,
          overflowing,
          parentChips: document.querySelectorAll("[data-parent-chip]").length,
          dependsChips: document.querySelectorAll("[data-depends-chip]").length,
        };
      });
      check(
        `A7.${vp.label} no horizontal overflow at ${vp.label}px`,
        metrics.scrollWidth <= metrics.clientWidth && metrics.overflowing.length === 0,
        `scrollWidth ${metrics.scrollWidth} vs ${metrics.clientWidth} · ${metrics.parentChips} parent chip(s), ${metrics.dependsChips} depends chip(s)${metrics.overflowing.length ? " · over: " + metrics.overflowing.join(", ") : ""}`,
      );
      check(`A7.${vp.label}b no console errors at ${vp.label}px`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await vpage.close();
    }

    /* -- the reset -------------------------------------------------------
       The dialog is reset every time it opens, so a selection must not survive
       into the next one. */
    const afterReset = await page.evaluate(() => {
      document.querySelector("[data-create-task] [data-modal-close]").click();
      document.querySelector("[data-new-task]").click();
      return {
        chips: document.querySelectorAll("[data-parent-chip], [data-depends-chip]").length,
        input: document.querySelector("[data-parent-input]").value,
      };
    });
    check("R9.1 reopening the dialog starts from an empty selection", afterReset.chips === 0 && afterReset.input === "", `${afterReset.chips} chip(s), input ${JSON.stringify(afterReset.input)}`);

    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
}

/* ---------------------------------------------------------- screenshots */

async function shots() {
  const chromium = await loadPlaywright();
  if (!chromium) {
    process.stdout.write("shots: no playwright available\n");
    process.exitCode = 1;
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  const server = await serveDesignRoot();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/prototype/index.html`;
  const browser = await chromium.launch();
  const freeze = "*, *::before, *::after { transition: none !important; animation: none !important; }";

  const shoot = async (file, opts) => {
    const context = await browser.newContext({
      viewport: opts.viewport,
      colorScheme: opts.colorScheme || "light",
    });
    const p = await context.newPage();
    await p.goto(opts.url || base, { waitUntil: "load" });
    await p.waitForFunction(() => !!window.jQuery);
    await p.addStyleTag({ content: freeze });
    await p.evaluate(OPEN_DIALOG);
    await p.waitForTimeout(150);
    if (opts.act) await opts.act(p);
    await p.waitForTimeout(150);
    await p.screenshot({ path: join(SHOTS_DIR, file) });
    process.stdout.write(`shot ${file}\n`);
    await context.close();
  };

  /* The two the spec names — the default dialog and the long-title case —
     share one viewport, one theme and one language. 980px is the width at
     which the board's own longest title genuinely runs out of room (measured
     in A3.2), so it is the viewport where the long-title case actually is one. */
  await shoot("combo-01-default-980.png", { viewport: { width: 980, height: 900 } });
  await shoot("combo-02-long-title-980.png", {
    viewport: { width: 980, height: 900 },
    act: (p) => p.evaluate(EXPAND, "[data-parent-input]"),
  });
  /* the selection states the card is about */
  await shoot("combo-03-parent-selected-980.png", {
    viewport: { width: 980, height: 900 },
    act: (p) => p.evaluate(() => {
      document.querySelector("[data-parent-input]").focus();
      document.querySelector("[data-parent-input]").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-parent-option]").click();
    }),
  });
  await shoot("combo-04-depends-chips-980.png", {
    viewport: { width: 980, height: 900 },
    act: (p) => p.evaluate(() => {
      const input = document.querySelector("[data-depends-input]");
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-depends-option]").click();
      document.querySelector("[data-depends-option]").click();
      document.querySelector("[data-depends-menu]").hidden = true;
    }),
  });
  await shoot("combo-05-parent-selected-430.png", {
    viewport: { width: 430, height: 900 },
    act: (p) => p.evaluate(() => {
      document.querySelector("[data-parent-input]").focus();
      document.querySelector("[data-parent-input]").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-parent-option]").click();
    }),
  });

  await browser.close();
  server.close();
}

/* =====================================================================
   main
   ===================================================================== */

if (SHOTS) {
  await shots();
}

if (!STATIC_ONLY) {
  await renderSuite();
} else {
  suite("render");
  check("R0.0 render suite", true, "skipped by --static-only");
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n== SUMMARY == ${results.length - failed.length}/${results.length} passed${
    failed.length ? `, ${failed.length} failed:\n  - ${failed.map((f) => f.id).join("\n  - ")}` : ""
  }\n`,
);
process.exitCode = failed.length ? 1 : 0;
