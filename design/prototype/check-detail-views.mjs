#!/usr/bin/env node
/* =====================================================================
   check-detail-views.mjs — the machine check for the task-detail drawer's
   two "full details" proposals (task T-20261015-025759).

   Usage
     node design/prototype/check-detail-views.mjs                 # static + render
     node design/prototype/check-detail-views.mjs --static-only    # no browser
     node design/prototype/check-detail-views.mjs --shots          # write screenshots/

   Zero dependencies beyond Node's standard library. The render half drives the
   host's Playwright if one is reachable and FAILS (it does not skip) when one is
   not, because an assertion nobody can evaluate is not a passing assertion.

   Two suites, one exit code:
     static — parses the four new files, plus index.html as the母本, as text.
              Every assertion is a claim about the shipped artefact.
     render — loads each variant over a throwaway loopback server and drives it
              the way a reader does: open a card, throw the switch, reload, walk
              the tabs by pointer and by keyboard. No network beyond 127.0.0.1.

   The spec's A-table (design-spec.md §6) is the contract: A1–A6 plus the
   S-checks the A-table rests on. The S-checks are kept separate so the mapping
   stays readable.

   On "the three shared files are unchanged" (§7.4): that is proved here as a
   *structural* property rather than by shelling out to git — each variant must
   contain every line of index.html, in order, with only insertions around them
   (S1.x), and app.js / tw.css must be referenced, never inlined (S1.3–S1.4).
   The git-side evidence (`git diff --stat` against the lane base, showing
   `index.html` / `app.js` / `tw.css` untouched) is recorded in
   `evidence/verify.txt` beside the run's output.
   ===================================================================== */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, "..");

const INDEX_PATH = join(HERE, "index.html");
const FULL_PATH = join(HERE, "index-detail-full.html");
const TABS_PATH = join(HERE, "index-detail-tabs.html");
const COMPARE_PATH = join(HERE, "index-detail-compare.html");
const SHOTS_DIR = join(HERE, "screenshots");

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes("--static-only");
const SHOTS = argv.includes("--shots");

const VIEWPORT = { width: 1512, height: 950 };

/* The one memory key the spec fixes (§2.4). Stated once, read by both suites. */
const MEMORY_KEY = "meerkat.detail.fullDetails";

/* The four blocks 方案一 adds, and the four panels 方案二 adds, by the names the
   spec gives. Both suites walk these, so a rename cannot half-land. */
const FULL_BLOCKS = ["reports", "conclusion", "acceptance", "leftovers"];
const TAB_NAMES = ["details", "reports", "acceptance", "leftovers"];

/* The drawer's seven existing regions, by the i18n key their heading wears —
   the S-check that neither proposal tore the drawer apart. Each occurs exactly
   once in index.html. */
const EXISTING_SECTIONS = [
  "drawer.properties",
  "drawer.description",
  "drawer.relations",
  "drawer.session",
  "drawer.attachments",
  "drawer.comments",
  "drawer.activity",
];

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
const full = readFileSync(FULL_PATH, "utf8");
const tabs = readFileSync(TABS_PATH, "utf8");
const compare = readFileSync(COMPARE_PATH, "utf8");

/** How many times an attribute appears as an attribute (not as a word). */
const countAttr = (source, attr) => (source.match(new RegExp(`${attr}(?=[\\s=>])`, "g")) || []).length;

/** One element's opening tag, as text — `null` when it is not there. */
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

/** Every element's opening tag matching a predicate, in document order. */
function openTags(source, predicate) {
  const out = [];
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
    if (predicate(tag)) out.push(tag);
  }
  return out;
}

/** The text of one attribute on one element, or `null`. */
const attrOf = (source, key, value) =>
  openTag(source, (t) => t.attrs[key] === value);

/** The inner text of the `n`-th element carrying `attr` (no nesting of it). */
function innerText(source, attr, n = 0) {
  const tags = openTags(source, (t) => Object.prototype.hasOwnProperty.call(t.attrs, attr));
  const tag = tags[n];
  if (!tag) return null;
  const close = source.indexOf(">", tag.index + tag.raw.length - 1);
  const end = source.indexOf("</", close);
  return end === -1 ? null : source.slice(close + 1, end);
}

/* =====================================================================
   STATIC SUITE
   ===================================================================== */

suite("static");

/* --- S1 · the three shared files are untouched -------------------------
   The claim is structural: a variant is index.html PLUS insertions. If any
   line of the母本 had been rewritten or dropped, its line would be missing
   from the ordered walk below. */

function insertionOnly(variant, label) {
  const base = html.split("\n");
  const other = variant.split("\n");
  let i = 0;
  let inserted = 0;
  for (const line of other) {
    if (i < base.length && line === base[i]) i += 1;
    else inserted += 1;
  }
  return { matched: i, total: base.length, inserted, ok: i === base.length };
}

/** The lines a variant carries that index.html does not, in order. */
function addedLines(variant) {
  const base = html.split("\n");
  const out = [];
  let i = 0;
  for (const line of variant.split("\n")) {
    if (i < base.length && line === base[i]) i += 1;
    else out.push(line);
  }
  return { lines: out, complete: i === base.length };
}

for (const [label, variant] of [
  ["index-detail-full.html", full],
  ["index-detail-tabs.html", tabs],
]) {
  const walk = insertionOnly(variant, label);
  check(
    `S1.1 ${label} carries every line of index.html in order (insertions only, nothing rewritten)`,
    walk.ok && walk.inserted > 0,
    `${walk.matched}/${walk.total} lines matched · ${walk.inserted} inserted`,
  );
}

for (const [label, variant] of [
  ["index-detail-full.html", full],
  ["index-detail-tabs.html", tabs],
]) {
  check(
    `S1.2 ${label} links the shared tw.css exactly once and never inlines it`,
    (variant.match(/<link rel="stylesheet" href="tw\.css"/g) || []).length === 1 &&
      !variant.includes("tailwindcss v4"),
    `${(variant.match(/<link rel="stylesheet" href="tw\.css"/g) || []).length} link(s), tailwind banner inlined: ${variant.includes("tailwindcss v4")}`,
  );
  check(
    `S1.3 ${label} loads the shared app.js exactly once and never inlines it`,
    countAttr(variant, "src") === 4 &&
      (variant.match(/<script src="app\.js"><\/script>/g) || []).length === 1 &&
      !variant.includes("MeerkatTaskPanel v1 prototype — interaction layer"),
    `${countAttr(variant, "src")} src attribute(s)`,
  );
  check(
    `S1.4 ${label} adds its own script after app.js, so the母本's wiring is already bound`,
    variant.indexOf('<script src="app.js"></script>') < variant.lastIndexOf("<script>"),
  );
}

/* --- S2 · the existing drawer survived ---------------------------------- */

for (const [label, variant] of [
  ["index-detail-full.html", full],
  ["index-detail-tabs.html", tabs],
]) {
  const missing = EXISTING_SECTIONS.filter((key) => countAttr(variant, `data-i18n="${key}"`) !== 1);
  check(
    `S2.1 ${label} keeps the drawer's seven existing regions, each exactly once`,
    missing.length === 0,
    missing.length ? `missing/duplicated: ${missing.join(", ")}` : `${EXISTING_SECTIONS.length} keys`,
  );
  check(
    `S2.2 ${label} keeps the drawer openable on its one root hook, unchanged`,
    (variant.match(/data-detail-drawer(?=[\s>])/g) || []).length === 1,
  );
}

/* --- A1/A2 · 方案一's switch and its four blocks ------------------------- */

{
  check(
    "A1.1 方案一 carries [data-detail-fulltoggle] exactly once, as a checkbox",
    countAttr(full, "data-detail-fulltoggle") === 1 &&
      countAttr(full, "data-detail-fulltoggle-label") === 1 &&
      (() => {
        const input = openTag(full, (t) => t.attrs["data-detail-fulltoggle"] !== undefined);
        return !!input && input.name === "input" && input.attrs.type === "checkbox";
      })(),
    `${countAttr(full, "data-detail-fulltoggle")} toggle(s), ${countAttr(full, "data-detail-fulltoggle-label")} label(s)`,
  );
  const drawer = openTag(full, (t) => t.attrs["data-detail-drawer"] !== undefined);
  check(
    'A1.2 the drawer ships with data-detail-mode="drawer" — the default is today\'s drawer',
    !!drawer && drawer.attrs["data-detail-mode"] === "drawer",
    drawer ? `data-detail-mode=${JSON.stringify(drawer.attrs["data-detail-mode"])}` : "drawer root not found",
  );
  check(
    "A1.3 the switch sits in the drawer head, left of [data-detail-close]",
    (() => {
      const label = openTag(full, (t) => t.attrs["data-detail-fulltoggle-label"] !== undefined);
      const close = openTag(full, (t) => t.attrs["data-detail-close"] !== undefined);
      const head = full.indexOf('<header class="td-drawer-head">');
      return !!label && !!close && !!head && label.index > head && label.index < close.index;
    })(),
  );
  check(
    "A1.4 the switch's accessible name is its own aria-label, not the wrapping label text alone",
    (() => {
      const input = openTag(full, (t) => t.attrs["data-detail-fulltoggle"] !== undefined);
      return !!input && typeof input.attrs["aria-label"] === "string" && input.attrs["aria-label"].trim() !== "";
    })(),
  );

  const missing = FULL_BLOCKS.filter((name) => countAttr(full, `data-detail-full-${name}`) !== 1);
  check(
    "A2.1 方案一 carries each of the four new block hooks exactly once",
    missing.length === 0,
    missing.length ? `wrong: ${missing.join(", ")}` : FULL_BLOCKS.map((n) => `[data-detail-full-${n}]`).join(" "),
  );
  const hidden = FULL_BLOCKS.filter((name) => {
    const tag = openTag(full, (t) => t.attrs[`data-detail-full-${name}`] !== undefined);
    return !tag || !Object.prototype.hasOwnProperty.call(tag.attrs, "hidden");
  });
  check(
    "A2.2 the four blocks ship [hidden] — the drawer face is today's until the switch says otherwise",
    hidden.length === 0,
    hidden.length ? `not hidden at rest: ${hidden.join(", ")}` : "all four hidden at rest",
  );
  check(
    "A2.3 the four blocks sit after the Activity region, inside .td-drawer-body",
    (() => {
      const activity = full.indexOf('data-i18n="drawer.activity"');
      const bodyEnd = full.indexOf("      </div>\n    </aside>");
      const first = full.indexOf("data-detail-full-reports");
      const last = full.indexOf("data-detail-full-leftovers");
      return activity !== -1 && bodyEnd !== -1 && first > activity && last < bodyEnd;
    })(),
  );
  check(
    "A2.4 every sample datum is marked with the SAMPLE DATA banner the spec fixes",
    (full.match(/SAMPLE DATA · 实现卡需接 GET \/api\/v1\/tasks\/:ref\/reports/g) || []).length >= 4,
    `${(full.match(/SAMPLE DATA · 实现卡需接 GET \/api\/v1\/tasks\/:ref\/reports/g) || []).length} banner(s)`,
  );
}

/* --- A3 · 方案一's script: the key, and no route ------------------------ */

{
  const script = full.slice(full.lastIndexOf("<script>"), full.lastIndexOf("</script>"));
  check(
    `A3.1 方案一's inline script names the one memory key, ${MEMORY_KEY}`,
    script.includes(`"${MEMORY_KEY}"`),
  );
  const routes = ["location.hash", "location.href =", "pushState", "replaceState", "location.replace"];
  const found = routes.filter((needle) => script.includes(needle));
  check(
    "A3.2 方案一's script writes no address and adds no route (需求 F)",
    found.length === 0,
    found.join(", ") || "no hash, no history, no navigation",
  );
  check(
    "A3.3 the switch's writer is the one place that sets both the mode and the blocks' visibility",
    (() => {
      const fn = script.slice(script.indexOf("function apply("), script.indexOf("apply(remembered())"));
      return fn.includes('attr("data-detail-mode"') && fn.includes('.prop("hidden"') && fn.includes("prop(\"checked\"");
    })(),
  );
  check(
    "A3.4 the switch is what a reader drives — a change handler, not a load-time guess",
    script.includes('$("[data-detail-fulltoggle]").on("change"'),
  );
}

/* --- A4 · 方案二's tab grammar ------------------------------------------ */

{
  check(
    'A4.1 方案二 carries role="tablist" exactly once, on [data-detail-tabs]',
    (tabs.match(/role="tablist"/g) || []).length === 1 &&
      !!openTag(tabs, (t) => t.attrs["data-detail-tabs"] !== undefined && t.attrs.role === "tablist"),
  );
  const tabEls = openTags(tabs, (t) => t.attrs["data-detail-tab"] !== undefined);
  const panelEls = openTags(tabs, (t) => t.attrs["data-detail-panel"] !== undefined);
  check(
    "A4.2 方案二 carries four [data-detail-tab] and four [data-detail-panel]",
    tabEls.length === 4 && panelEls.length === 4,
    `${tabEls.length} tab(s), ${panelEls.length} panel(s)`,
  );
  const tabNames = tabEls.map((t) => t.attrs["data-detail-tab"]);
  const panelNames = panelEls.map((t) => t.attrs["data-detail-panel"]);
  check(
    "A4.3 the tab names and the panel names are the same set, one for one",
    tabNames.length === 4 &&
      new Set(tabNames).size === 4 &&
      panelNames.length === 4 &&
      new Set(panelNames).size === 4 &&
      TAB_NAMES.every((n) => tabNames.includes(n) && panelNames.includes(n)),
    `tabs: ${tabNames.join(", ")} · panels: ${panelNames.join(", ")}`,
  );
  check(
    "A4.4 every tab is a role=tab button whose aria-controls names an existing panel",
    tabEls.every(
      (t) =>
        t.name === "button" &&
        t.attrs.role === "tab" &&
        typeof t.attrs["aria-controls"] === "string" &&
        typeof t.attrs["aria-selected"] === "string" &&
        panelEls.some((p) => p.attrs.id === t.attrs["aria-controls"]),
    ),
  );
  check(
    "A4.5 every panel is a role=tabpanel whose aria-labelledby names an existing tab",
    panelEls.every(
      (t) =>
        t.attrs.role === "tabpanel" &&
        typeof t.attrs["aria-labelledby"] === "string" &&
        tabEls.some((b) => b.attrs.id === t.attrs["aria-labelledby"]),
    ),
  );
  check(
    "A4.6 Details is the one tab selected at rest, and its panel is the one not hidden",
    (() => {
      const selected = tabEls.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.attrs["data-detail-tab"]);
      const shown = panelEls.filter((p) => !Object.prototype.hasOwnProperty.call(p.attrs, "hidden")).map((p) => p.attrs["data-detail-panel"]);
      return selected.length === 1 && selected[0] === "details" && shown.length === 1 && shown[0] === "details";
    })(),
  );
  check(
    "A4.7 the tab bar sits at the top of .td-drawer-body: after the save-state region, before the Details panel",
    (() => {
      const save = tabs.indexOf("data-detail-save-error");
      const list = tabs.indexOf("data-detail-tabs");
      const panel = tabs.indexOf('data-detail-panel="details"');
      return save !== -1 && list !== -1 && panel !== -1 && save < list && list < panel;
    })(),
  );
  const script = tabs.slice(tabs.lastIndexOf("<script>"), tabs.lastIndexOf("</script>"));
  const routes = ["location.hash", "location.href =", "pushState", "replaceState", "location.replace"];
  const found = routes.filter((needle) => script.includes(needle));
  check(
    "A4.8 方案二's script writes no address and adds no route (需求 F)",
    found.length === 0,
    found.join(", ") || "no hash, no history, no navigation",
  );
  check(
    "A4.9 the one writer sets aria-selected and the panels' hidden together",
    (() => {
      const fn = script.slice(script.indexOf("function select("), script.indexOf('select("details"'));
      return fn.includes('attr("aria-selected"') && fn.includes('.prop("hidden"');
    })(),
  );
  check(
    "A4.10 the keyboard follows roving tabindex: ←/→/Home/End, and focus only on a key move",
    script.includes("ArrowRight") &&
      script.includes("ArrowLeft") &&
      script.includes("Home") &&
      script.includes("End") &&
      script.includes('select($(this).attr("data-detail-tab"), false)') &&
      script.includes("select(ORDER[next], true)"),
  );
}

/* --- A5 · the prototype stays a document --------------------------------
   The claim is about the lines this card ADDED, not about the母本 it copied:
   the shipped drawer already names a stand-in access token and already carries
   the description's `type="text/plain"` slots, and inheriting those is not this
   card introducing them. So each variant's inserted lines are isolated first. */

const ADDED = {
  "index-detail-full.html": addedLines(full),
  "index-detail-tabs.html": addedLines(tabs),
  /* the comparison page is not a copy of anything: every line of it is new. */
  "index-detail-compare.html": { lines: compare.split("\n"), complete: true },
};

{
  const impure = ["fetch(", "XMLHttpRequest", "WebSocket", "navigator.sendBeacon", "indexedDB"];
  for (const [label, added] of Object.entries(ADDED)) {
    const text = added.lines.join("\n");
    const hits = impure.filter((needle) => text.includes(needle));
    check(`A5.1 ${label} adds no API call and opens no channel`, hits.length === 0, hits.join(", ") || "none");
    const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
    check(`A5.2 ${label} adds no remote origin`, urls.length === 0, urls.slice(0, 3).join(", ") || "none");
    /* Credential-shaped, not the bare word `token`: the母本 already names a
       stand-in access token (B17), and this card's own stylesheet comments say
       "token" meaning a design token. What must not appear is a *credential*. */
    const creds = [...text.matchAll(/\b(Bearer|Authorization|api[_-]?key|apiKey|access[_-]?token|secret|password|credential)\b/gi)].map((m) => m[0]);
    check(`A5.3 ${label} adds no credential vocabulary`, creds.length === 0, creds.slice(0, 3).join(", ") || "none");
  }
  /* The one storage use the spec allows, and only where the spec allows it:
     方案一 remembers the switch; 方案二 has no business touching storage at all. */
  const fullStores = [...ADDED["index-detail-full.html"].lines.join("\n").matchAll(/localStorage\.(\w+)/g)].map((m) => m[1]);
  check(
    'A5.4 方案一 adds storage use only to remember the switch (getItem/setItem on the one key)',
    fullStores.length > 0 && fullStores.every((m) => m === "getItem" || m === "setItem"),
    fullStores.join(", ") || "no localStorage use",
  );
  check(
    "A5.5 方案二 adds no storage use at all — it has nothing to remember",
    !ADDED["index-detail-tabs.html"].lines.join("\n").includes("localStorage"),
  );
  check(
    'A5.6 neither variant adds a new description slot (type="text/plain" is the母本\'s, and stays its count)',
    (full.match(/type="text\/plain"/g) || []).length === (html.match(/type="text\/plain"/g) || []).length &&
      (tabs.match(/type="text\/plain"/g) || []).length === (html.match(/type="text\/plain"/g) || []).length,
    `index.html ${(html.match(/type="text\/plain"/g) || []).length} · full ${(full.match(/type="text\/plain"/g) || []).length} · tabs ${(tabs.match(/type="text\/plain"/g) || []).length}`,
  );
  check(
    'A5.7 the comparison page carries no description slot either',
    (compare.match(/type="text\/plain"/g) || []).length === 0,
  );
}

/* --- A6 · the comparison page frames both proposals --------------------- */

{
  const frames = openTags(compare, (t) => t.name === "iframe");
  const srcs = frames.map((f) => f.attrs.src);
  check(
    "A6.1 the comparison page frames both proposals, one iframe each",
    frames.length === 2 &&
      srcs.includes("index-detail-full.html") &&
      srcs.includes("index-detail-tabs.html"),
    srcs.join(", ") || `${frames.length} iframe(s)`,
  );
  check(
    "A6.2 every framed page exists",
    srcs.every((src) => existsSync(join(HERE, src))),
  );
  check(
    "A6.3 the comparison page shows the two side by side at ≥980px and stacks below",
    compare.includes("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)") &&
      compare.includes("@media (max-width: 979px)"),
  );
  /* Its own shell is styled by the shared stylesheet, and the frames are driven
     to a state — neither is visible if the link or the frame-ready wait is
     missing, and both failures are silent. */
  check(
    "A6.4 the comparison page links the shared tw.css (its shell is not bare HTML)",
    (compare.match(/<link rel="stylesheet" href="tw\.css"/g) || []).length === 1,
    `${(compare.match(/<link rel="stylesheet" href="tw\.css"/g) || []).length} link(s)`,
  );
  /* The page NAMES the memory key in its prose — that is the delivery note, not
     a call — so the bar is a storage *access*, not the word. */
  check(
    "A6.5 the comparison page is a shell with no script of its own — the two frames do the work",
    !compare.includes("<script") &&
      !/localStorage\s*\.\s*(get|set|remove)Item/.test(ADDED["index-detail-compare.html"].lines.join("\n")),
  );
}

/* --- S3 · the no-JS floor ------------------------------------------------ */

{
  /* Each variant carries its OWN new copy as literal text — 方案一's switch and
     its four block headings, 方案二's four tab labels — so both survive with the
     script off. 方案一 has no Conclusion tab and 方案二 has no full-details
     switch, so one list per variant rather than one list for both. */
  const WANTED = {
    "方案一": ["Full details", "Reports", "Conclusion", "Acceptance", "Leftovers"],
    "方案二": ["Details", "Reports", "Acceptance", "Leftovers"],
  };
  const MISSING = {
    "方案一": WANTED["方案一"].filter((word) => !full.includes(word)),
    "方案二": WANTED["方案二"].filter((word) => !tabs.includes(word)),
  };
  check(
    "S3.1 each variant carries its own new copy as literal text (the headings are also the tab labels)",
    MISSING["方案一"].length === 0 && MISSING["方案二"].length === 0,
    Object.entries(MISSING).filter(([, v]) => v.length).map(([k, v]) => `${k} missing ${v.join(", ")}`).join(" · ") ||
      `${WANTED["方案一"].length} + ${WANTED["方案二"].length} phrase(s)`,
  );
  /* Chrome copy that is deliberately absent: the proposal must not smuggle the
     other proposal's control in. */
  check(
    "S3.1b 方案二 carries no full-details switch, and 方案一 carries no tablist",
    !tabs.includes("data-detail-fulltoggle") &&
      !full.includes('role="tablist"') &&
      !full.includes("data-detail-tab"),
  );
  const hooked = FULL_BLOCKS.filter((name) => new RegExp(`data-detail-full-${name}[^>]*data-i18n`).test(full));
  check(
    "S3.2 the new blocks carry no data-i18n hook — this round touches zero catalogue keys (§5)",
    hooked.length === 0,
    hooked.join(", ") || "0 hooks on the new blocks",
  );
  const newHooks = (full.match(/data-i18n(?:-[a-z-]+)?="drawer\.(fullDetails|reports|conclusion|acceptance|leftovers|detailsTab)"/g) || []).length;
  const newHooksTabs = (tabs.match(/data-i18n(?:-[a-z-]+)?="drawer\.(fullDetails|reports|conclusion|acceptance|leftovers|detailsTab)"/g) || []).length;
  check(
    "S3.3 the six proposed keys are nowhere in the prototypes (0 keys reached the catalogue)",
    newHooks === 0 && newHooksTabs === 0,
    `${newHooks} + ${newHooksTabs} hook(s)`,
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

/* The page, driven the way a reader drives it. */
const OPEN_CARD = (index = 0) => {
  const cards = document.querySelectorAll("[data-card]");
  cards[Math.min(index, cards.length - 1)].click();
};
const TOGGLE = () => document.querySelector("[data-detail-fulltoggle]").click();
const PICK_TAB = (name) => document.querySelector(`[data-detail-tab="${name}"]`).click();

const READ_DRAWER = () => {
  const drawer = document.querySelector("[data-detail-drawer]");
  const box = drawer.getBoundingClientRect();
  const style = getComputedStyle(drawer);
  const body = drawer.querySelector(".td-drawer-body");
  return {
    mode: drawer.getAttribute("data-detail-mode"),
    state: drawer.getAttribute("data-state"),
    identifier: drawer.getAttribute("data-identifier"),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    borderRadius: style.borderRadius,
    maxWidth: style.maxWidth,
    blocksVisible: [...document.querySelectorAll(
      "[data-detail-full-reports], [data-detail-full-conclusion], [data-detail-full-acceptance], [data-detail-full-leftovers]"
    )].filter((block) => !block.hidden).map((block) => block.getAttribute("data-detail-full-reports") !== null ? "reports" : block.getAttribute("data-detail-full-conclusion") !== null ? "conclusion" : block.getAttribute("data-detail-full-acceptance") !== null ? "acceptance" : "leftovers"),
    bodyScrolls: body ? body.scrollHeight > body.clientHeight : false,
    checked: document.querySelector("[data-detail-fulltoggle]")
      ? document.querySelector("[data-detail-fulltoggle]").checked
      : null,
    memory: (() => {
      try {
        return window.localStorage.getItem("meerkat.detail.fullDetails");
      } catch (err) {
        return "<unavailable>";
      }
    })(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    docScroll: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
  };
};

const READ_SURROUNDINGS = () => ({
  hash: window.location.hash,
  views: [...document.querySelectorAll("[data-view][aria-pressed='true']")].map((b) => b.getAttribute("data-view")),
  activityHidden: document.querySelector("[data-activity-view]")
    ? document.querySelector("[data-activity-view]").hidden
    : null,
  boardHidden: document.querySelector("[data-board-view]")
    ? document.querySelector("[data-board-view]").hidden
    : null,
});

const READ_TABS = () => ({
  selected: [...document.querySelectorAll("[data-detail-tab]")]
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.getAttribute("data-detail-tab")),
  visible: [...document.querySelectorAll("[data-detail-panel]")]
    .filter((p) => !p.hidden)
    .map((p) => p.getAttribute("data-detail-panel")),
  roving: [...document.querySelectorAll("[data-detail-tab]")]
    .filter((t) => t.getAttribute("tabindex") === "0")
    .map((t) => t.getAttribute("data-detail-tab")),
  focused: document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute("data-detail-tab")
    : null,
});

async function openPage(browser, base, errors) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.jQuery);
  return page;
}

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

  try {
    /* ---------------------------------------------------------- 方案一 */

    const fullErrors = [];
    const fullPage = await openPage(browser, at("index-detail-full.html"), fullErrors);
    /* the memory key is global and per-origin; a fresh port is a fresh origin,
       but say so rather than assume it — a stale "1" would fake R1. */
    await fullPage.evaluate((key) => window.localStorage.removeItem(key), MEMORY_KEY);
    await fullPage.reload({ waitUntil: "load" });
    await fullPage.waitForFunction(() => !!window.jQuery);

    const shellDrawer = await fullPage.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--shell-drawer").trim()
    );

    await fullPage.evaluate(OPEN_CARD, 0);
    await fullPage.waitForTimeout(250);
    const atRest = await fullPage.evaluate(READ_DRAWER);
    check(
      "R1.1 the drawer opens on a card and keeps the existing geometry, not the full-screen one",
      atRest.state === "open" &&
        atRest.mode === "drawer" &&
        Math.abs(atRest.box.width - parseFloat(shellDrawer)) <= 1 &&
        atRest.box.width < atRest.viewport.width / 2,
      `mode=${atRest.mode} width=${atRest.box.width} (--shell-drawer=${shellDrawer})`,
    );
    check(
      "R1.2 at rest the four new blocks are out of the flow — the drawer face is today's",
      atRest.blocksVisible.length === 0,
      atRest.blocksVisible.join(", ") || "none visible",
    );
    check("R1.3 no console or page errors opening the drawer", fullErrors.length === 0, fullErrors.slice(0, 2).join(" | "));

    const beforeToggle = await fullPage.evaluate(READ_SURROUNDINGS);
    await fullPage.evaluate(TOGGLE);
    await fullPage.waitForTimeout(120);
    const thrown = await fullPage.evaluate(READ_DRAWER);
    check(
      "R2.1 throwing the switch makes the drawer the whole viewport (≤2px)",
      thrown.mode === "full" &&
        Math.abs(thrown.box.x) <= 2 &&
        Math.abs(thrown.box.y) <= 2 &&
        Math.abs(thrown.box.width - thrown.viewport.width) <= 2 &&
        Math.abs(thrown.box.height - thrown.viewport.height) <= 2,
      `rect ${Math.round(thrown.box.x)},${Math.round(thrown.box.y)} ${Math.round(thrown.box.width)}×${Math.round(thrown.box.height)} vs ${thrown.viewport.width}×${thrown.viewport.height}`,
    );
    check(
      "R2.2 the full-screen face is flat: no max-width, no radius",
      thrown.maxWidth === "none" && parseFloat(thrown.borderRadius) === 0,
      `max-width=${thrown.maxWidth} radius=${thrown.borderRadius}`,
    );
    check(
      "R2.3 the four new blocks are all in the flow, and the drawer body scrolls for them",
      thrown.blocksVisible.length === 4 && thrown.bodyScrolls,
      `${thrown.blocksVisible.join(", ")} · body scrolls: ${thrown.bodyScrolls}`,
    );
    check(
      "R2.4 the switch stays a view control: the drawer is still open, on the same card",
      thrown.state === "open" && thrown.identifier === atRest.identifier,
      `state=${thrown.state} card=${thrown.identifier}`,
    );
    check(
      "R2.5 the switch records itself as the global memory value (\"1\")",
      thrown.memory === "1" && thrown.checked === true,
      `${MEMORY_KEY}=${JSON.stringify(thrown.memory)}`,
    );

    const afterToggle = await fullPage.evaluate(READ_SURROUNDINGS);
    check(
      "R4.1 the address is untouched by the switch (需求 F)",
      afterToggle.hash === beforeToggle.hash,
      `${JSON.stringify(beforeToggle.hash)} → ${JSON.stringify(afterToggle.hash)}`,
    );
    check(
      "R4.2 the view is untouched by the switch — activity stays where it was (需求 F)",
      JSON.stringify(afterToggle.views) === JSON.stringify(beforeToggle.views) &&
        afterToggle.activityHidden === beforeToggle.activityHidden &&
        afterToggle.boardHidden === beforeToggle.boardHidden,
      `views ${beforeToggle.views.join(",")} → ${afterToggle.views.join(",")}`,
    );

    /* the memory is global and survives a reload */
    await fullPage.reload({ waitUntil: "load" });
    await fullPage.waitForFunction(() => !!window.jQuery);
    const afterReload = await fullPage.evaluate(READ_DRAWER);
    check(
      "R3.1 a reload comes back with the switch still on and the mode still full",
      afterReload.mode === "full" && afterReload.checked === true && afterReload.memory === "1",
      `mode=${afterReload.mode} checked=${afterReload.checked} ${MEMORY_KEY}=${JSON.stringify(afterReload.memory)}`,
    );

    /* "the next task's drawer obeys the switch" — a different card, same page */
    await fullPage.evaluate(OPEN_CARD, 1);
    await fullPage.waitForTimeout(250);
    const otherCard = await fullPage.evaluate(READ_DRAWER);
    check(
      "R3.2 opening a different card obeys the switch without touching it",
      otherCard.state === "open" &&
        otherCard.identifier !== atRest.identifier &&
        otherCard.mode === "full" &&
        otherCard.blocksVisible.length === 4,
      `${atRest.identifier} → ${otherCard.identifier}, mode=${otherCard.mode}, blocks=${otherCard.blocksVisible.length}`,
    );

    /* back off: the memory is written both ways, and the drawer returns */
    await fullPage.evaluate(TOGGLE);
    await fullPage.waitForTimeout(120);
    const switchedOff = await fullPage.evaluate(READ_DRAWER);
    check(
      'R3.3 switching back writes "0" and restores the drawer face',
      switchedOff.mode === "drawer" &&
        switchedOff.memory === "0" &&
        switchedOff.checked === false &&
        switchedOff.blocksVisible.length === 0 &&
        Math.abs(switchedOff.box.width - parseFloat(shellDrawer)) <= 1,
      `mode=${switchedOff.mode} memory=${JSON.stringify(switchedOff.memory)} width=${switchedOff.box.width}`,
    );

    const fullOverflow = await fullPage.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      const doc = document.documentElement;
      const over = [...drawer.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
        .slice(0, 3)
        .map((el) => el.className || el.tagName);
      return { scroll: doc.scrollWidth, client: doc.clientWidth, over };
    });
    check(
      "R7.1 the full-screen face produces no horizontal overflow",
      fullOverflow.scroll <= fullOverflow.client + 1 && fullOverflow.over.length === 0,
      `scrollWidth ${fullOverflow.scroll} vs clientWidth ${fullOverflow.client}${fullOverflow.over.length ? " · over: " + fullOverflow.over.join(", ") : ""}`,
    );
    await fullPage.close();

    /* ---------------------------------------------------------- 方案二 */

    const tabsErrors = [];
    const tabsPage = await openPage(browser, at("index-detail-tabs.html"), tabsErrors);
    await tabsPage.evaluate(OPEN_CARD, 0);
    await tabsPage.waitForTimeout(250);
    const tabsAtRest = await tabsPage.evaluate(READ_TABS);
    check(
      "R5.1 方案二 opens on Details, with exactly one of the four panels in the flow",
      tabsAtRest.selected.length === 1 &&
        tabsAtRest.selected[0] === "details" &&
        tabsAtRest.visible.length === 1 &&
        tabsAtRest.visible[0] === "details",
      `selected=${tabsAtRest.selected.join(",")} visible=${tabsAtRest.visible.join(",")}`,
    );
    check(
      "R5.2 the roving tabindex follows the selection — one tab is tabbable",
      tabsAtRest.roving.length === 1 && tabsAtRest.roving[0] === "details",
      tabsAtRest.roving.join(",") || "none tabbable",
    );
    check("R5.3 no console or page errors opening the drawer", tabsErrors.length === 0, tabsErrors.slice(0, 2).join(" | "));

    const byPointer = [];
    for (const name of TAB_NAMES.slice(1)) {
      await tabsPage.click(`[data-detail-tab="${name}"]`);
      await tabsPage.waitForTimeout(90);
      const read = await tabsPage.evaluate(READ_TABS);
      byPointer.push(`${name}:${read.selected.join(",")}/${read.visible.join(",")}`);
      check(
        `R6.1 clicking ${name} moves aria-selected and the visible panel together`,
        read.selected.length === 1 &&
          read.selected[0] === name &&
          read.visible.length === 1 &&
          read.visible[0] === name &&
          read.roving.join(",") === name,
        `selected=${read.selected.join(",")} visible=${read.visible.join(",")} roving=${read.roving.join(",")}`,
      );
      check(
        `R6.2 the focus stays on the tab the reader pressed, not on the drawer (${name})`,
        read.focused === name,
        `focus on ${JSON.stringify(read.focused)}`,
      );
    }

    await tabsPage.click('[data-detail-tab="details"]');
    await tabsPage.keyboard.press("ArrowRight");
    await tabsPage.waitForTimeout(90);
    const arrowed = await tabsPage.evaluate(READ_TABS);
    check(
      "R6.3 ArrowRight walks to the next tab, carrying focus with it",
      arrowed.selected.join(",") === "reports" && arrowed.visible.join(",") === "reports" && arrowed.focused === "reports",
      `selected=${arrowed.selected.join(",")} focus=${arrowed.focused}`,
    );
    await tabsPage.keyboard.press("ArrowLeft");
    await tabsPage.waitForTimeout(90);
    const back = await tabsPage.evaluate(READ_TABS);
    check(
      "R6.4 ArrowLeft walks back, and from the first tab it wraps to the last",
      back.selected.join(",") === "details" && back.focused === "details",
      `selected=${back.selected.join(",")} focus=${back.focused}`,
    );
    await tabsPage.keyboard.press("End");
    await tabsPage.waitForTimeout(90);
    const ended = await tabsPage.evaluate(READ_TABS);
    await tabsPage.keyboard.press("ArrowRight");
    await tabsPage.waitForTimeout(90);
    const wrapped = await tabsPage.evaluate(READ_TABS);
    check(
      "R6.5 End reaches the last tab and ArrowRight wraps to the first",
      ended.selected.join(",") === "leftovers" &&
        ended.focused === "leftovers" &&
        wrapped.selected.join(",") === "details",
      `End → ${ended.selected.join(",")} · ArrowRight → ${wrapped.selected.join(",")}`,
    );

    const tabsOverflow = await tabsPage.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      const doc = document.documentElement;
      const over = [...drawer.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
        .slice(0, 3)
        .map((el) => el.className || el.tagName);
      return { scroll: doc.scrollWidth, client: doc.clientWidth, over };
    });
    check(
      "R7.2 the four panels produce no horizontal overflow",
      tabsOverflow.scroll <= tabsOverflow.client + 1 && tabsOverflow.over.length === 0,
      `scrollWidth ${tabsOverflow.scroll} vs clientWidth ${tabsOverflow.client}${tabsOverflow.over.length ? " · over: " + tabsOverflow.over.join(", ") : ""}`,
    );
    await tabsPage.close();

    /* ----------------------------------- R7b · the narrow drawer heads -------
       A new control in the drawer head is exactly the change that breaks the
       narrow drawer: the head is one flex row (identifier, status chip, [new],
       close) and at 430px there is not much of it. */

    for (const [file, label] of [
      ["index-detail-full.html", "方案一"],
      ["index-detail-tabs.html", "方案二"],
    ]) {
      const narrow = [];
      for (const width of [760, 430]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(at(file), { waitUntil: "load" });
        await page.waitForFunction(() => !!window.jQuery);
        await page.evaluate(OPEN_CARD, 0);
        await page.waitForTimeout(200);
        const read = await page.evaluate(() => {
          const doc = document.documentElement;
          const head = document.querySelector(".td-drawer-head");
          const over = [...document.querySelectorAll("[data-detail-drawer] *")]
            .filter((el) => {
              const box = el.getBoundingClientRect();
              return box.right > doc.clientWidth + 1 || box.left < -1;
            })
            .slice(0, 3)
            .map((el) => (typeof el.className === "string" && el.className) || el.tagName);
          return { scroll: doc.scrollWidth, client: doc.clientWidth, headOverflow: head.scrollWidth - head.clientWidth, over };
        });
        narrow.push(`${width}:${read.scroll}/${read.client} head+${read.headOverflow}${read.over.length ? " over " + read.over.join(",") : ""}`);
        check(
          `R7.${label === "方案一" ? "3" : "4"}.${width} ${label}'s drawer head fits at ${width}px with the new control in it`,
          read.scroll <= read.client + 1 && read.headOverflow <= 1 && read.over.length === 0,
          narrow[narrow.length - 1],
        );
        await page.close();
      }
    }

    /* ------------------------------------- R9 · the comparison page's frames */

    {
      const compareErrors = [];
      const comparePage = await browser.newPage({ viewport: VIEWPORT });
      comparePage.on("console", (msg) => {
        if (msg.type() === "error") compareErrors.push(msg.text());
      });
      comparePage.on("pageerror", (err) => compareErrors.push(String(err)));
      await comparePage.goto(at("index-detail-compare.html"), { waitUntil: "load" });
      await comparePage.waitForFunction(() =>
        [...document.querySelectorAll("iframe")].every(
          (f) => f.contentDocument && f.contentDocument.querySelectorAll("[data-card]").length > 0
        )
      );
      const framed = [];
      for (const frame of comparePage.frames()) {
        if (!/index-detail-(full|tabs)\.html/.test(frame.url())) continue;
        const read = await frame.evaluate(() => ({
          cards: document.querySelectorAll("[data-card]").length,
          jQuery: !!window.jQuery,
          stylesheet: document.styleSheets.length,
          drawerOpen:
            document.querySelector("[data-detail-drawer]").getAttribute("data-state") === "open",
        }));
        framed.push(`${frame.url().split("/").pop()}:${read.cards}card/${read.stylesheet}sheet/open=${read.drawerOpen}`);
        check(
          `R9.1 the framed page ${frame.url().split("/").pop()} is live (cards, jQuery, the shared stylesheet)`,
          read.cards > 0 && read.jQuery && read.stylesheet >= 1,
          framed[framed.length - 1],
        );
      }
      check("R9.2 both proposals are framed", framed.length === 2, framed.join(" · "));
      check(
        "R9.3 the comparison page's own shell loads the shared stylesheet",
        (await comparePage.evaluate(() => document.styleSheets.length)) >= 1 &&
          (await comparePage.evaluate(() => getComputedStyle(document.body).margin)) === "0px",
      );
      check("R9.4 no console or page errors on the comparison page", compareErrors.length === 0, compareErrors.slice(0, 2).join(" | "));
      check(
        "R9.5 neither frame overflows the shell horizontally",
        (await comparePage.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        )) === true,
      );
      await comparePage.close();
    }

    /* ------------------------------------------------- R8 · the no-JS floor */

    for (const [label, file, words] of [
      ["方案一", "index-detail-full.html", ["Full details", "Reports", "Conclusion", "Acceptance", "Leftovers", "Properties", "Activity"]],
      ["方案二", "index-detail-tabs.html", ["Details", "Reports", "Acceptance", "Leftovers", "Properties", "Activity"]],
    ]) {
      const context = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(at(file), { waitUntil: "load" });
      const content = await page.content();
      const missing = words.filter((word) => !content.includes(word));
      check(
        `R8.${label === "方案一" ? "1" : "2"} with the script off, ${label}'s core copy is still in the document`,
        missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : `${words.length} phrase(s)`,
      );
      await context.close();
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

  const shoot = async (file, opts) => {
    const context = await browser.newContext({ viewport: opts.viewport || VIEWPORT, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(opts.url || at("index-detail-full.html"), { waitUntil: "load" });
    /* the comparison page loads no script of its own — only the two frames do —
       so the ready bar is per shot rather than "jQuery, always". */
    await page.waitForFunction(opts.ready || (() => !!window.jQuery));
    await page.addStyleTag({ content: freeze });
    if (opts.before) await opts.before(page);
    await page.waitForTimeout(150);
    /* A card is opened the way a reader opens one, so every state shot is a
       state of a real drawer rather than of a document that never opened. */
    if (opts.openCard !== false) await page.evaluate(OPEN_CARD, opts.card || 0);
    await page.waitForTimeout(250);
    if (opts.act) await opts.act(page);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS_DIR, file) });
    process.stdout.write(`shot ${file}\n`);
    await context.close();
  };

  const urlFull = at("index-detail-full.html");
  const urlTabs = at("index-detail-tabs.html");

  /* the memory key is per-origin and the port is fresh every run, but clear it
     anyway so the two "default" shots are the default by construction. */
  const clear = (page) => page.evaluate((key) => window.localStorage.removeItem(key), MEMORY_KEY);

  await shoot("d1-full-default.png", { url: urlFull, before: clear });
  await shoot("d1-full-on.png", { url: urlFull, before: clear, act: (p) => p.evaluate(TOGGLE) });
  /* the full-screen face scrolled down to the four new blocks — the state the
     card is actually about, which the top-of-page shot cannot show. */
  await shoot("d1-full-blocks.png", {
    url: urlFull,
    before: clear,
    act: (p) =>
      p.evaluate(() => {
        document.querySelector("[data-detail-fulltoggle]").click();
        const body = document.querySelector("[data-detail-drawer] .td-drawer-body");
        body.scrollTop = body.scrollHeight * 0.62;
      }),
  });
  /* on, then back off — the same page, the switch and the geometry returned */
  await shoot("d1-full-off.png", {
    url: urlFull,
    before: clear,
    act: (p) =>
      p.evaluate(() => {
        const toggle = document.querySelector("[data-detail-fulltoggle]");
        toggle.click();
        toggle.click();
      }),
  });

  for (const name of TAB_NAMES) {
    await shoot(`d2-tabs-${name}.png`, {
      url: urlTabs,
      act: (p) => p.evaluate((tab) => document.querySelector(`[data-detail-tab="${tab}"]`).click(), name),
    });
  }

  /* The comparison page is a shell around two live frames, so both frames are
     driven to the state the page is meant to compare: 方案一's switch thrown,
     方案二's Reports tab picked. Neither frame is a screenshot of a closed
     drawer. */
  await shoot("cmp-1512.png", {
    url: at("index-detail-compare.html"),
    openCard: false,
    ready: () =>
      [...document.querySelectorAll("iframe")].every(
        (f) => f.contentDocument && f.contentDocument.querySelectorAll("[data-card]").length > 0
      ),
    act: async (page) => {
      for (const frame of page.frames()) {
        if (!/index-detail-(full|tabs)\.html/.test(frame.url())) continue;
        await frame.addStyleTag({ content: freeze });
        await frame.evaluate(() => {
          const card = document.querySelector("[data-card]");
          if (card) card.click();
        });
        await frame.evaluate(() => {
          const toggle = document.querySelector("[data-detail-fulltoggle]");
          if (toggle) toggle.click();
          const tab = document.querySelector('[data-detail-tab="reports"]');
          if (tab) tab.click();
          const body = document.querySelector("[data-detail-drawer] .td-drawer-body");
          if (body) body.scrollTop = body.scrollHeight * 0.55;
        });
      }
    },
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
