#!/usr/bin/env node
/* =====================================================================
   check-drawer-tabs.mjs — the machine check for the two drawer-tab variants
   of task T-20261015-171422 ("conclusion 归位 + comments/activity 独立成 tab").

   Usage
     node design/prototype/check-drawer-tabs.mjs                 # static + render
     node design/prototype/check-drawer-tabs.mjs --static-only    # no browser
     node design/prototype/check-drawer-tabs.mjs --shots          # write screenshots/

   Zero dependencies beyond Node's standard library. 口径随 check-detail-views.mjs:
   the render half drives the host's Playwright if one is reachable and FAILS (it
   does not skip) when one is not, because an assertion nobody can evaluate is not
   a passing assertion. One exit code.

   The two variants, and the one variable they differ by:

     index-detail-tabs-v2.html  甲 — Comments AND the Activity log leave Details
                                     for a fifth tab named `activity`.
     index-detail-tabs-v3.html  丙 — only the Activity log leaves; the Comments
                                     section, write form and all, stays in Details.

   Both are the 方案二 page (index-detail-tabs.html, T-20261015-025759) plus the
   tab button, plus the panel, plus a one-line ORDER rewrite, plus the move. All
   three files are parsed as text; the claims are about the shipped bytes.

   On "the shared surface is unchanged" the proof is structural, not a git call:
   each variant must carry every line of index.html, in order, with only
   insertions around them (A1). That walk is deliberately the same one
   check-detail-views.mjs uses — and it is why this round had to repair one line
   of the base: index.html's PROJECTS comment was rewritten by b141211 (03:16Z,
   before the 方案二 merge 275556d at 04:49Z), so the base still spells
   `ARCHITECTURE §4.6` where the母本 now reads `DESIGN.md §20`. The base therefore
   fails its own A1 walk today (239/5602); the variants carry the current母本 line
   and pass it (A1.4 records both).
   ===================================================================== */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, "..");

const INDEX_PATH = join(HERE, "index.html");
const BASE_PATH = join(HERE, "index-detail-tabs.html");
const V2_PATH = join(HERE, "index-detail-tabs-v2.html");
const V3_PATH = join(HERE, "index-detail-tabs-v3.html");
const SHOTS_DIR = join(HERE, "screenshots");

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes("--static-only");
const SHOTS = argv.includes("--shots");

const VIEWPORT = { width: 1512, height: 950 };
const NARROW = { width: 430, height: 932 };

/* The tab set the two variants share, in the order the panel script walks it. */
const ORDER = ["details", "activity", "reports", "acceptance", "leftovers"];
const BASE_ORDER = ["details", "reports", "acceptance", "leftovers"];

/* The drawer's seven regions, by the i18n key their heading wears. Each occurs
   exactly once in index.html and must still occur exactly once per variant: the
   move relocates a region, it does not clone or drop one. */
const SECTIONS = [
  "drawer.properties",
  "drawer.description",
  "drawer.relations",
  "drawer.session",
  "drawer.attachments",
  "drawer.comments",
  "drawer.activity",
];

/* The new tab button's label is a literal, like the four it joins — none of the
   five carries a data-i18n hook (§3 of the design note: zero new catalogue keys).
   That is asserted, not assumed (A6.2). */
const TAB_LABEL = "Activity";

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
const base = readFileSync(BASE_PATH, "utf8");
const sources = {
  "index-detail-tabs-v2.html": readFileSync(V2_PATH, "utf8"),
  "index-detail-tabs-v3.html": readFileSync(V3_PATH, "utf8"),
};

/* One element's opening tag, as text — null when it is not there. */
function openTag(source, predicate) {
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^>"])*?)\/?>/g;
  let m;
  while ((m = re.exec(source))) {
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      const value = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4];
      attrs[a[1]] = value === undefined ? "" : value;
    }
    const tag = { name: m[1].toLowerCase(), attrs, raw: m[0], index: m.index };
    if (predicate(tag)) return tag;
  }
  return null;
}

/** How many times an attribute occurs as an attribute (not as a bare word). */
const countAttr = (source, attr) => (source.match(new RegExp(`${attr}(?=[\\s=>])`, "g")) || []).length;

/** The value of one attribute of the first tag carrying `hook`. */
function attrOf(source, hook, attr) {
  const tag = openTag(source, (t) => t.attrs[hook] !== undefined);
  return tag ? tag.attrs[attr] : null;
}

/** Every i18n key the source asks the catalogue for. */
function i18nKeys(source) {
  return new Set(
    [...source.matchAll(/data-i18n(?:-aria-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]),
  );
}

/** A panel's own text, from its opening tag through its closing marker.
    Both markers are asserted to exist by the caller, so an empty segment can
    never be read as a satisfied "does not contain" claim. */
function panelSegment(source, name, closer) {
  const open = source.indexOf(`data-detail-panel="${name}"`);
  if (open === -1) return null;
  const from = source.lastIndexOf("\n", open) + 1;
  const end = source.indexOf(closer, open);
  if (end === -1) return null;
  return source.slice(from, end + closer.length);
}

/** The body of one i18n-keyed region, from the `<section` that leads to it
    through the `</section>` that closes it. Used for the base's two blocks. */
function sectionAt(source, key) {
  const head = source.indexOf(`data-i18n="${key}"`);
  if (head === -1) return null;
  const open = source.lastIndexOf("<section", head);
  const close = source.indexOf("</section>", head);
  return { from: open, to: close === -1 ? -1 : close + "</section>".length };
}

/** Walk the母本's lines through `variant`: every base line must be met, in
    order, with only insertions around it. A rewritten or dropped base line
    stalls the walk — which is the whole point of the check. */
function insertionWalk(baseText, variantText) {
  const b = baseText.split("\n");
  const v = variantText.split("\n");
  let i = 0;
  let inserted = 0;
  for (const line of v) {
    if (i < b.length && line === b[i]) i += 1;
    else inserted += 1;
  }
  return { matched: i, total: b.length, inserted, ok: i === b.length };
}

/* =====================================================================
   STATIC SUITE
   ===================================================================== */

suite("static");

/* --- A1 · the shared surface ------------------------------------------- */

for (const [name, source] of Object.entries(sources)) {
  const walk = insertionWalk(html, source);
  check(
    `A1.1 ${name} carries every line of index.html in order (insertions only, nothing rewritten)`,
    walk.ok && walk.inserted > 0,
    `${walk.matched}/${walk.total}母本 lines matched · ${walk.inserted} inserted`,
  );
}

for (const [name, source] of Object.entries(sources)) {
  const linksTw = (source.match(/href="tw\.css"/g) || []).length;
  const loadsApp = (source.match(/src="app\.js"/g) || []).length;
  const inlinesCss = /<style[^>]*>[\s\S]{0,400}tailwindcss/i.test(source);
  const inlinesApp = source.includes("function identifierText(");
  check(
    `A1.2 ${name} references the shared tw.css and app.js, and inlines neither`,
    linksTw === 1 && loadsApp === 1 && !inlinesCss && !inlinesApp,
    `tw.css link=${linksTw} · app.js src=${loadsApp} · inlined css=${inlinesCss} · inlined app=${inlinesApp}`,
  );
}

{
  /* The base file is read-only here, but its state is part of this round's
     evidence: it no longer satisfies the invariant it was built under. */
  const baseWalk = insertionWalk(html, base);
  const v2Walk = insertionWalk(html, sources["index-detail-tabs-v2.html"]);
  const staleLine = "ARCHITECTURE §4.6";
  const currentLine = "DESIGN.md §20";
  const carriesStale = Object.values(sources).some((s) => sectionAt(s, "sidebar.projects") && s.includes(staleLine));
  check(
    "A1.4 the母本 drift is repaired, not inherited",
    !carriesStale && v2Walk.ok,
    `base (read-only) ${baseWalk.matched}/${baseWalk.total} — it still spells "${staleLine}" where the母本 now spells ` +
      `"${currentLine}" (index.html rewritten by b141211, before the 方案二 merge); both variants carry the current line`,
  );
}

/* --- A2 · the tab set --------------------------------------------------- */

for (const [name, source] of Object.entries(sources)) {
  const tabs = countAttr(source, "data-detail-tab");
  const panels = countAttr(source, "data-detail-panel");
  const order = (source.match(/var ORDER = (\[[^\]]*\]);/) || [])[1];
  const parsed = order ? JSON.parse(order) : null;
  check(
    `A2.1 ${name} has five tabs and five panels`,
    tabs === 5 && panels === 5,
    `${tabs} tab(s), ${panels} panel(s)`,
  );
  check(
    `A2.2 ${name} has an "activity" tab, and ORDER carries it at index 1 (right after Details)`,
    !!parsed && parsed.length === ORDER.length && parsed.join(",") === ORDER.join(","),
    `ORDER = ${order}`,
  );
  const listed = [...source.matchAll(/data-detail-tab="([^"]+)"/g)].map((m) => m[1]);
  check(
    `A2.3 ${name} lists the tabs in ORDER's own order`,
    listed.join(",") === ORDER.join(","),
    listed.join(" / "),
  );
}

/* --- A3/A4 · where the two blocks live ---------------------------------- */

const PLACEMENT = {
  "index-detail-tabs-v2.html": {
    id: "A3",
    label: "甲 · Comments + Activity both leave Details",
    detailsHas: { comments: false, activity: false },
    activityHas: { comments: true, activity: true, form: true },
  },
  "index-detail-tabs-v3.html": {
    id: "A4",
    label: "丙 · only the Activity log leaves",
    detailsHas: { comments: true, activity: false },
    activityHas: { comments: false, activity: true, form: false },
  },
};

const segments = {};
for (const [name, source] of Object.entries(sources)) {
  const d = panelSegment(source, "details", "<!-- /Details panel -->");
  const a = panelSegment(source, "activity", "<!-- /Activity panel -->");
  segments[name] = { details: d, activity: a };
  const spec = PLACEMENT[name];
  /* Both segments must exist AND be the panel they claim to be, before any
     "does not contain" claim below can mean anything. */
  const wellFormed = !!d && !!a &&
    d.includes('data-detail-panel="details"') && a.includes('data-detail-panel="activity"') &&
    d.includes('data-i18n="drawer.properties"') && a.includes('data-i18n="drawer.');
  check(
    `${spec.id}.1 ${name} — the two panels are locatable and non-empty, so the placement claims below are not vacuous`,
    wellFormed,
    `details ${d ? d.length : 0} chars · activity ${a ? a.length : 0} chars`,
  );
  const seen = (seg, hook) => seg.includes(hook);
  check(
    `${spec.id}.2 ${name} — ${spec.label}: Details ${spec.detailsHas.comments ? "keeps" : "drops"} Comments, ` +
      `${spec.detailsHas.activity ? "keeps" : "drops"} the Activity log`,
    d !== null && seen(d, "data-detail-comments") === spec.detailsHas.comments &&
      seen(d, "data-detail-activity") === spec.detailsHas.activity,
    `[data-detail-comments]=${d ? seen(d, "data-detail-comments") : "?"} · [data-detail-activity]=${d ? seen(d, "data-detail-activity") : "?"}`,
  );
  check(
    `${spec.id}.3 ${name} — the activity panel holds the Activity log` +
      `${spec.activityHas.comments ? ", the Comments section and the write form" : " and nothing else"}`,
    a !== null && seen(a, "data-detail-activity") === spec.activityHas.activity &&
      seen(a, "data-detail-comments") === spec.activityHas.comments &&
      seen(a, "data-comment-form") === spec.activityHas.form,
    `comments=${a ? seen(a, "data-detail-comments") : "?"} · activity=${a ? seen(a, "data-detail-activity") : "?"} · form=${a ? seen(a, "data-comment-form") : "?"}`,
  );
}

/* The move relocates; it must not clone. Each heading key survives exactly once. */
for (const [name, source] of Object.entries(sources)) {
  const counts = SECTIONS.map((k) => [k, (source.match(new RegExp(`data-i18n="${k}"`, "g")) || []).length]);
  const bad = counts.filter(([, n]) => n !== 1);
  check(
    `A3.4 ${name} — each of the母本's seven region headings survives exactly once (moved, not cloned)`,
    bad.length === 0,
    counts.map(([k, n]) => `${k.split(".")[1]}=${n}`).join(" "),
  );
}

/* The comment hook families ride along with their region. */
for (const [name, source] of Object.entries(sources)) {
  const a = segments[name].activity;
  const d = segments[name].details;
  const spec = PLACEMENT[name];
  const form = spec.activityHas.form ? a : d;
  const ok = !!form && form.includes("data-comment-input") && form.includes("data-comment-submit");
  check(
    `A3.5 ${name} — the comment form's own hooks stay with the form, wherever it landed`,
    ok,
    `[data-comment-input] and [data-comment-submit] both under ${spec.activityHas.form ? "the activity panel" : "Details"}`,
  );
}

/* --- A5 · the panel faces ----------------------------------------------- */

for (const [name, source] of Object.entries(sources)) {
  const openTags = [...source.matchAll(/<div[^>]*data-detail-panel="([^"]+)"[^>]*>/g)];
  const hidden = Object.fromEntries(
    openTags.map((m) => [m[1], /(?:^|\s)hidden(?=[\s>])/.test(m[0]) ? "hidden" : "shown"]),
  );
  const others = ORDER.filter((n) => n !== "details");
  check(
    `A5.1 ${name} — Details is the panel not hidden at rest, and the other four are hidden`,
    openTags.length === 5 && hidden.details === "shown" && others.every((n) => hidden[n] === "hidden"),
    Object.entries(hidden).map(([k, v]) => `${k}:${v}`).join(" "),
  );
  check(
    `A5.2 ${name} — Details is the tab selected at rest and the only one in the tab order`,
    attrOf(source, "data-detail-tab", "aria-selected") === "true" &&
      (source.match(/data-detail-tab="details"[^>]*aria-selected="true"/) || []).length === 1 &&
      (source.match(/tabindex="0"[^>]*>Details</) || []).length === 1,
    "the Details button is the one aria-selected=\"true\" with tabindex=\"0\"",
  );
}

/* --- A6 · the catalogue -------------------------------------------------- */

{
  const baseKeys = i18nKeys(base);
  for (const [name, source] of Object.entries(sources)) {
    const extra = [...i18nKeys(source)].filter((k) => !baseKeys.has(k));
    check(
      `A6.1 ${name} adds no i18n key the母本 does not already carry`,
      extra.length === 0,
      extra.length ? extra.slice(0, 5).join(", ") : `0 new key(s) over the base's ${baseKeys.size}`,
    );
  }
  for (const [name, source] of Object.entries(sources)) {
    const tag = openTag(source, (t) => t.attrs["data-detail-tab"] === "activity");
    const labelAt = tag ? tag.index + tag.raw.length : -1; /* the text node right after the open tag */
    const labelled = labelAt > 0 && source.startsWith(`${TAB_LABEL}</button>`, labelAt);
    check(
      `A6.2 ${name}'s new tab is a literal, like the four it joins — no data-i18n hook`,
      !!tag && tag.attrs["data-i18n"] === undefined && labelled,
      tag ? `label "${TAB_LABEL}" · data-i18n: ${tag.attrs["data-i18n"] === undefined ? "absent" : "present"}` : "no activity tab",
    );
  }
}

/* --- A7 · the DOM the markup declares ----------------------------------- */

for (const [name, source] of Object.entries(sources)) {
  const ids = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const tabs = [...source.matchAll(/<button[^>]*data-detail-tab="([^"]+)"[^>]*>/g)];
  const panels = [...source.matchAll(/<div[^>]*data-detail-panel="([^"]+)"[^>]*>/g)];
  const controls = tabs.map((m) => (m[0].match(/aria-controls="([^"]+)"/) || [])[1]);
  const labelled = panels.map((m) => (m[0].match(/aria-labelledby="([^"]+)"/) || [])[1]);
  const tabIds = tabs.map((m) => (m[0].match(/\bid="([^"]+)"/) || [])[1]);
  const ok = tabs.length === 5 && panels.length === 5 &&
    new Set(tabs.map((m) => m[1])).size === 5 &&
    new Set(panels.map((m) => m[1])).size === 5 &&
    controls.every((c) => ids.has(c) && new RegExp(`data-detail-panel="${panelNameOf(c)}"`).test(source)) &&
    labelled.every((l) => ids.has(l) && tabIds.includes(l));
  check(
    `A7.1 ${name} — with the script off the markup still stands: 5 tabs, 5 panels, and every ` +
      "aria-controls / aria-labelledby resolves to an element that exists",
    ok,
    `tabs=${tabs.length} panels=${panels.length} controls→${controls.join(",")}`,
  );
}

function panelNameOf(panelId) {
  return panelId.replace(/^td-dv-panel-/, "");
}

/* =====================================================================
   RENDER SUITE
   ===================================================================== */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

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

/* Open a card the way a reader opens one — but the first card on the board is a
   project row whose `[data-slot="comments"]` is empty, so its Comments region
   would render as a bare heading and the evidence would say nothing about
   whether the region travelled. Open the first card whose template actually
   carries comments; the choice is data-driven, so it is the same one every run. */
const OPEN_CARD = () => {
  const cards = [...document.querySelectorAll("[data-card]")];
  const withComments = cards.find((card) => {
    const id = (card.querySelector("[data-card-identifier]") || {}).textContent || "";
    const tpl = document.querySelector(`template[data-detail-for="${id.trim()}"]`);
    return !!tpl && /\btd-comment\b/.test(tpl.innerHTML);
  });
  (withComments || cards[0]).click();
};
const PICK_TAB = (name) => document.querySelector(`[data-detail-tab="${name}"]`).click();

const READ_TABS = () => {
  const tabs = [...document.querySelectorAll("[data-detail-tab]")];
  const bar = document.querySelector("[data-detail-tabs]");
  const boxes = tabs.map((t) => t.getBoundingClientRect());
  const first = getComputedStyle(tabs[0]);
  const activity = document.querySelector('[data-detail-tab="activity"]');
  return {
    order: tabs.map((t) => t.getAttribute("data-detail-tab")),
    selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.getAttribute("data-detail-tab")),
    roving: tabs.filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.getAttribute("data-detail-tab")),
    visible: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-detail-panel")),
    onScreen: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => p.offsetParent !== null).map((p) => p.getAttribute("data-detail-panel")),
    focused: document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute("data-detail-tab")
      : null,
    rows: new Set(boxes.map((b) => Math.round(b.top))).size,
    heights: [...new Set(boxes.map((b) => Math.round(b.height)))],
    fontSize: first.fontSize,
    activityFontSize: activity ? getComputedStyle(activity).fontSize : null,
    barWidth: Math.round(bar.getBoundingClientRect().width),
    barScrollWidth: bar.scrollWidth,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const READ_STATE = () => ({
  selected: [...document.querySelectorAll("[data-detail-tab]")]
    .filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.getAttribute("data-detail-tab")),
  roving: [...document.querySelectorAll("[data-detail-tab]")]
    .filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.getAttribute("data-detail-tab")),
  visible: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-detail-panel")),
  hash: window.location.hash,
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
  const at = (file) => `http://127.0.0.1:${port}/prototype/${file}`;
  const browser = await chromium.launch();

  const open = async (file, viewport) => {
    const errors = [];
    const page = await browser.newPage({ viewport: viewport || VIEWPORT });
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(at(file), { waitUntil: "load" });
    await page.waitForFunction(() => !!window.jQuery);
    await page.evaluate(OPEN_CARD);
    await page.waitForTimeout(250);
    return { page, errors };
  };

  try {
    for (const [name, spec] of Object.entries(PLACEMENT)) {
      /* ---- B · geometry, at both viewports --------------------------- */

      for (const [tier, viewport] of [["1512×950", VIEWPORT], ["430×932", NARROW]]) {
        const { page } = await open(name, viewport);
        const t = await page.evaluate(READ_TABS);
        check(
          `B1 ${name} @ ${tier} — the five tabs share one row and the strip does not overflow`,
          t.order.length === 5 && t.rows === 1 && t.barScrollWidth <= t.barWidth + 1 && t.docOverflowX === 0,
          `${t.rows} row(s) · bar ${t.barWidth}px / content ${t.barScrollWidth}px · page overflow-x ${t.docOverflowX}px`,
        );
        check(
          `B2 ${name} @ ${tier} — the new tab is the same size and type as the four it joins`,
          t.heights.length === 1 && t.activityFontSize === t.fontSize && t.fontSize === "12px",
          `heights ${t.heights.join("/")} · font ${t.fontSize} (activity ${t.activityFontSize})`,
        );

        await page.evaluate(PICK_TAB, "activity");
        await page.waitForTimeout(200);
        const a = await page.evaluate(READ_TABS);
        check(
          `B3 ${name} @ ${tier} — opened on the activity tab, that panel is the one on screen and the other four are not`,
          a.visible.join(",") === "activity" && a.onScreen.join(",") === "activity" && a.selected.join(",") === "activity",
          `visible ${a.visible.join("/")} · on screen ${a.onScreen.join("/")}`,
        );
        await page.close();
      }

      /* ---- C · interaction, at the wide tier -------------------------- */

      const { page, errors } = await open(name);
      const initial = await page.evaluate(READ_STATE);
      check(
        `C1 ${name} — the drawer opens on Details, as the base does`,
        initial.selected.join(",") === "details" && initial.visible.join(",") === "details",
        `selected ${initial.selected.join("/")} · visible ${initial.visible.join("/")}`,
      );

      await page.evaluate(PICK_TAB, "activity");
      await page.waitForTimeout(200);
      const clicked = await page.evaluate(READ_STATE);
      check(
        `C2 ${name} — clicking the activity tab moves the selection and the panel together, and only those`,
        clicked.selected.join(",") === "activity" && clicked.visible.join(",") === "activity" &&
          clicked.roving.join(",") === "activity",
        `selected ${clicked.selected.join("/")} · visible ${clicked.visible.join("/")} · tabindex=0 on ${clicked.roving.join("/")}`,
      );

      /* the tab strip is a roving tabindex: ←/→ walk ORDER and wrap, Home/End take the ends */
      await page.evaluate(PICK_TAB, "details");
      await page.focus('[data-detail-tab="details"]');
      const walked = [];
      for (let i = 0; i < ORDER.length; i += 1) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(60);
        walked.push(await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab")));
      }
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(60);
      const back = await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab"));
      await page.keyboard.press("Home");
      await page.waitForTimeout(60);
      const home = await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab"));
      await page.keyboard.press("End");
      await page.waitForTimeout(60);
      const end = await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab"));
      const expected = [...ORDER.slice(1), ORDER[0]];
      check(
        `C3 ${name} — ←/→ rove over all five (wrapping) and Home/End take the ends`,
        walked.join(",") === expected.join(",") && back === "leftovers" && home === "details" && end === "leftovers",
        `→ ${walked.join("/")} · ← ${back} · Home ${home} · End ${end}`,
      );

      /* the address is not the tab bar's business (需求 F) */
      await page.evaluate(PICK_TAB, "acceptance");
      await page.waitForTimeout(120);
      const afterHash = await page.evaluate(() => window.location.hash);
      await page.evaluate(PICK_TAB, "details");
      await page.waitForTimeout(120);
      const returned = await page.evaluate(READ_STATE);
      check(
        `C4 ${name} — switching tabs writes no address and returns to the initial state (需求 F)`,
        afterHash === initial.hash && returned.selected.join(",") === "details" && returned.visible.join(",") === "details",
        `hash ${JSON.stringify(initial.hash)} → ${JSON.stringify(afterHash)} · back on ${returned.selected.join("/")}`,
      );

      /* the write form, where this variant put it */
      if (spec.activityHas.form) {
        await page.evaluate(PICK_TAB, "activity");
        await page.waitForTimeout(150);
        const form = await page.evaluate(() => {
          const ta = document.querySelector('[data-detail-panel="activity"] textarea[data-comment-input]');
          if (!ta) return { present: false };
          ta.focus();
          return { present: true, focused: document.activeElement === ta, visible: ta.offsetParent !== null };
        });
        check(
          `C5 ${name} — the comment form travelled intact: its textarea is present, visible and focusable inside the new panel`,
          form.present && form.focused && form.visible,
          JSON.stringify(form),
        );
      } else {
        const form = await page.evaluate(() => {
          const ta = document.querySelector('[data-detail-panel="details"] textarea[data-comment-input]');
          if (!ta) return { present: false };
          ta.focus();
          return { present: true, focused: document.activeElement === ta, visible: ta.offsetParent !== null };
        });
        check(
          `C5 ${name} — the comment form stayed in Details and is still present, visible and focusable`,
          form.present && form.focused && form.visible,
          JSON.stringify(form),
        );
      }

      check(
        `C6 ${name} — switching every tab writes no console error and raises no page error`,
        errors.length === 0,
        errors.length ? errors.slice(0, 3).join(" | ") : "0 error(s)",
      );
      await page.close();
    }
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
  const at = (file) => `http://127.0.0.1:${port}/prototype/${file}`;
  const browser = await chromium.launch();
  const freeze = "*, *::before, *::after { transition: none !important; animation: none !important; }";

  const shoot = async (variant, viewport, face, file) => {
    const context = await browser.newContext({ viewport, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(at(variant), { waitUntil: "load" });
    await page.waitForFunction(() => !!window.jQuery);
    await page.addStyleTag({ content: freeze });
    await page.waitForTimeout(150);
    await page.evaluate(OPEN_CARD);
    await page.waitForTimeout(250);
    if (face !== "details") await page.evaluate(PICK_TAB, face);
    await page.waitForTimeout(200);
    if (file.endsWith("-tail.png")) {
      /* the difference between the variants is at the END of the Details panel —
         what the tab strip's top-of-page view cannot show. */
      await page.evaluate(() => {
        const body = document.querySelector("[data-detail-drawer] .td-drawer-body");
        body.scrollTop = body.scrollHeight;
      });
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: join(SHOTS_DIR, file) });
    process.stdout.write(`shot ${file}\n`);
    await context.close();
  };

  for (const [variant, tag] of [["index-detail-tabs-v2.html", "d2v2"], ["index-detail-tabs-v3.html", "d2v3"]]) {
    for (const [tier, viewport] of [["1512", VIEWPORT], ["430", NARROW]]) {
      for (const face of ["details", "activity"]) {
        await shoot(variant, viewport, face, `${tag}-${tier}-${face}.png`);
      }
      /* the two extra frames that carry the round's actual difference */
      await shoot(variant, viewport, "details", `${tag}-${tier}-details-tail.png`);
    }
  }

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
