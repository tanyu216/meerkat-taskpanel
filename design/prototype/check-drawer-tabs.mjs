#!/usr/bin/env node
/* =====================================================================
   check-drawer-tabs.mjs — the machine check for the drawer-tab variants.

   Rounds:
     T-20261015-171422  v2 (甲) / v3 (丙) — comments / activity leave Details.
     v4                 the sixth, last tab `Sessions`: the Agent-session block
                        leaves Details for a session TRAIL, and the tab is
                        visible only when the card has at least one session.

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
const V4_PATH = join(HERE, "index-detail-tabs-v4.html");
const SHOTS_DIR = join(HERE, "screenshots");

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes("--static-only");
const SHOTS = argv.includes("--shots");

const VIEWPORT = { width: 1512, height: 950 };
const MID = { width: 760, height: 950 };
const NARROW = { width: 430, height: 932 };

/* The tab set v2/v3 share, in the order the panel script walks it. */
const ORDER = ["details", "activity", "reports", "acceptance", "leftovers"];
const BASE_ORDER = ["details", "reports", "acceptance", "leftovers"];

/* v4 adds the session trail as the LAST tab: on a 430px viewport the five
   existing tabs still fit one row (365px of 389px), and only the new one
   wraps. Measured, not assumed. */
const ORDER6 = [...ORDER, "sessions"];
const SESSIONS_LABEL = "Sessions";

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
/* v4 is this round's new artefact; a missing file is a readable red, not ENOENT. */
const v4 = existsSync(V4_PATH) ? readFileSync(V4_PATH, "utf8") : null;

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

/* --- the one registered move (v4) --------------------------------------
   The Agent-session block sits BEFORE Attachments in the母本, so moving it to
   the last panel reorders lines and cannot pass the insertion-only walk. v4
   registers exactly that one move: the 18-line span must be byte-identical to
   the母本's, must occur once, must live in the Sessions panel, and — when put
   back before the blank line that precedes Attachments — must restore the
  母本's 5602-line order (v4's own insertions remain, as they should). */
const MOVE_START = '        <section class="td-section" data-detail-agent-session>';
const MOVE_END = "        </section>";
const MOVE_ANCHOR =
  '        <section class="td-section" data-detail-attachments-section data-detail-save-field="attachments">';

/** The slice, its 0-based start line, and the full line list. */
function spanOf(text) {
  const lines = text.split("\n");
  const start = lines.indexOf(MOVE_START);
  if (start === -1) return null;
  const end = lines.indexOf(MOVE_END, start + 1);
  if (end === -1) return null;
  return { lines, start, end, span: lines.slice(start, end + 1) };
}

/** How many times a contiguous slice occurs in a line list, and where first. */
function sliceCount(lines, span) {
  let count = 0;
  let first = -1;
  for (let i = 0; i <= lines.length - span.length; i += 1) {
    let hit = true;
    for (let j = 0; j < span.length; j += 1) {
      if (lines[i + j] !== span[j]) { hit = false; break; }
    }
    if (hit) { count += 1; if (first === -1) first = i; }
  }
  return { count, first };
}

/** Remove the moved span, then put it back before the blank line immediately
    preceding the Attachments opener. Returns the restored text, or null when
    the span is not there (which is exactly what the negative control wants). */
function restoreMoved(variantText, span) {
  const lines = variantText.split("\n");
  const at = sliceCount(lines, span);
  if (at.count !== 1) return null;
  const removed = [...lines.slice(0, at.first), ...lines.slice(at.first + span.length)];
  const anchor = removed.indexOf(MOVE_ANCHOR);
  if (anchor === -1) return null;
  const insertAt = anchor > 0 && removed[anchor - 1] === "" ? anchor - 1 : anchor;
  return [...removed.slice(0, insertAt), ...span, ...removed.slice(insertAt)].join("\n");
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

/* --- A8–A11 · v4: the sixth tab and the registered move ----------------- */

if (!v4) {
  check("A0.0 index-detail-tabs-v4.html exists", false, `missing ${V4_PATH}`);
} else {
  check("A0.0 index-detail-tabs-v4.html exists", true);

  /* A8 · the one registered move, proved byte-for-byte. */
  const baseSpan = spanOf(html);
  check(
    "A8.0 the母本's Agent-session block is locatable and 18 lines long",
    !!baseSpan && baseSpan.span.length === 18,
    baseSpan ? `${baseSpan.start + 1}–${baseSpan.end + 1} (${baseSpan.span.length} lines)` : "not found",
  );
  const baseSpanText = baseSpan ? baseSpan.span.join("\n") : null;
  const v4Lines = v4.split("\n");
  const movedAt = baseSpan ? sliceCount(v4Lines, baseSpan.span) : { count: 0, first: -1 };
  check(
    "A8.1 the exact 18-line block occurs exactly once in v4 (moved, not cloned or dropped)",
    !!baseSpan && movedAt.count === 1,
    `occurrences=${movedAt.count}`,
  );

  const v4Details = panelSegment(v4, "details", "<!-- /Details panel -->");
  const v4Sessions = panelSegment(v4, "sessions", "<!-- /Sessions panel -->");
  check(
    "A8.2 the moved block sits inside the Sessions panel and not inside Details",
    !!baseSpan && !!v4Sessions && !!v4Details &&
      v4Sessions.includes(baseSpanText) && !v4Details.includes(baseSpanText),
    `sessions panel ${v4Sessions ? v4Sessions.length : 0} chars · details panel ${v4Details ? v4Details.length : 0} chars`,
  );
  check(
    "A8.3 the moved block is byte-identical to the母本's (whitespace included)",
    !!baseSpan && !!v4Sessions && v4Sessions.includes(baseSpanText) &&
      v4Sessions.indexOf(baseSpanText) !== -1,
    baseSpan ? `${baseSpanText.length} chars compared` : "no span",
  );

  const restored = baseSpan ? restoreMoved(v4, baseSpan.span) : null;
  const restoredWalk = restored ? insertionWalk(html, restored) : null;
  check(
    "A8.4 putting the block back before the Attachments blank line restores the母本's line order (5602/5602)",
    !!restoredWalk && restoredWalk.ok,
    restoredWalk ? `${restoredWalk.matched}/${restoredWalk.total} · ${restoredWalk.inserted} inserted (v4's own additions)` : "restore failed",
  );
  /* Falsifiability: one changed character must make the same restore fail. */
  const tampered = baseSpan ? baseSpan.span.map((line) => line.replace("Agent session", "Agent sessions")) : null;
  const tamperedRestore = tampered ? restoreMoved(v4, tampered) : null;
  check(
    "A8.5 negative control — a one-character change to the span makes the move proof fail",
    !!baseSpan && tamperedRestore === null,
    tamperedRestore === null ? "tampered span not found (expected)" : "tampered span was accepted",
  );
  const hookCounts = [
    ["data-detail-agent-session", countAttr(v4, "data-detail-agent-session")],
    ["data-detail-agent-session-body", countAttr(v4, "data-detail-agent-session-body")],
    ['data-i18n="drawer.session"', (v4.match(/data-i18n="drawer\.session"/g) || []).length],
  ];
  check(
    "A8.6 the three session-section hooks survive exactly once each",
    hookCounts.every(([, n]) => n === 1),
    hookCounts.map(([k, n]) => `${k}=${n}`).join(" "),
  );

  /* A9 · placement. */
  check(
    "A9.1 the Details and Sessions panel segments are both locatable and non-empty",
    !!v4Details && !!v4Sessions &&
      v4Details.includes('data-detail-panel="details"') &&
      v4Sessions.includes('data-detail-panel="sessions"'),
    `details ${v4Details ? v4Details.length : 0} · sessions ${v4Sessions ? v4Sessions.length : 0}`,
  );
  check(
    "A9.2 Details drops the Agent-session section; the Sessions panel holds it",
    !!v4Details && !!v4Sessions &&
      !v4Details.includes("data-detail-agent-session") &&
      v4Sessions.includes("data-detail-agent-session"),
    `details has=${v4Details ? v4Details.includes("data-detail-agent-session") : "?"} · sessions has=${v4Sessions ? v4Sessions.includes("data-detail-agent-session") : "?"}`,
  );
  check(
    "A9.3 the Sessions panel carries no comments / activity / attachments / write-form hooks",
    !!v4Sessions &&
      !v4Sessions.includes("data-detail-comments") &&
      !v4Sessions.includes("data-detail-activity") &&
      !v4Sessions.includes("data-detail-attachments") &&
      !v4Sessions.includes("data-comment-form"),
    v4Sessions
      ? `comments=${v4Sessions.includes("data-detail-comments")} activity=${v4Sessions.includes("data-detail-activity")} attachments=${v4Sessions.includes("data-detail-attachments")} form=${v4Sessions.includes("data-comment-form")}`
      : "no sessions panel",
  );
  {
    const panelNames = [...v4.matchAll(/<div[^>]*data-detail-panel="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    check(
      "A9.4 the Sessions panel follows Leftovers and is the last panel",
      panelNames.indexOf("sessions") > panelNames.indexOf("leftovers") &&
        panelNames[panelNames.length - 1] === "sessions",
      panelNames.join(" / "),
    );
  }
  {
    const counts = SECTIONS.map((k) => [k, (v4.match(new RegExp(`data-i18n="${k}"`, "g")) || []).length]);
    const bad = counts.filter(([, n]) => n !== 1);
    check(
      "A9.5 each of the母本's seven region headings survives exactly once in v4",
      bad.length === 0,
      counts.map(([k, n]) => `${k.split(".")[1]}=${n}`).join(" "),
    );
  }

  /* A10 · the TD-134 sample trail. */
  const tpl134 = (() => {
    const start = v4.indexOf('<template data-detail-for="TD-134">');
    if (start === -1) return null;
    const slot = v4.indexOf('<div data-slot="agent-session">', start);
    if (slot === -1) return null;
    /* the slot's own close, not the whole template: the activity slot below it
       also uses .td-activity-ts, and counting that would be a false positive. */
    const nextSlot = v4.indexOf('<div data-slot="', slot + 1);
    return nextSlot === -1 ? null : v4.slice(slot, nextSlot);
  })();
  const trailRows = tpl134 ? (tpl134.match(/class="td-session"/g) || []).length : 0;
  const statuses = tpl134 ? [...tpl134.matchAll(/data-session-status="([^"]+)"/g)].map((m) => m[1]) : [];
  const stamps = tpl134 ? [...tpl134.matchAll(/data-session-ts="([^"]+)"/g)].map((m) => m[1]) : [];
  const countIn = (text, re) => (text ? (text.match(re) || []).length : 0);
  check(
    "A10.1 TD-134's template carries a trail of at least three .td-session rows",
    !!tpl134 && trailRows >= 3,
    `${trailRows} row(s)`,
  );
  check(
    "A10.2 the trail's source order is running / closed / failed",
    statuses.join(",") === "running,closed,failed",
    statuses.join(" / "),
  );
  check(
    "A10.3 data-session-ts is non-increasing (running first, then newest-first)",
    stamps.length === trailRows && stamps.every((s, i) => i === 0 || stamps[i - 1] >= s),
    stamps.join(" / "),
  );
  check(
    "A10.4 exactly one Resume, inside the running row; every row has a copyable session id",
    countIn(tpl134, /data-agent-resume/g) === 1 &&
      countIn(tpl134, /data-agent-session-id/g) === trailRows,
    `resume=${countIn(tpl134, /data-agent-resume/g)} · ids=${countIn(tpl134, /data-agent-session-id/g)}`,
  );
  check(
    "A10.5 every row carries owner / seg / phase / a relative timestamp",
    countIn(tpl134, /data-session-owner=/g) === trailRows &&
      countIn(tpl134, /data-session-seg=/g) === trailRows &&
      countIn(tpl134, /data-session-phase=/g) === trailRows &&
      countIn(tpl134, /td-activity-ts/g) === trailRows,
    `owner=${countIn(tpl134, /data-session-owner=/g)} seg=${countIn(tpl134, /data-session-seg=/g)} phase=${countIn(tpl134, /data-session-phase=/g)} ts=${countIn(tpl134, /td-activity-ts/g)}`,
  );
  check(
    "A10.6 no pid is shown anywhere in the trail",
    !!tpl134 && !/\bpid\b/.test(tpl134),
    tpl134 ? "pid absent" : "no template",
  );
  check(
    "A10.7 the SAMPLE DATA marker appears at least twice (Sessions panel + TD-134 slot)",
    (v4.match(/SAMPLE DATA/g) || []).length >= 2,
    `${(v4.match(/SAMPLE DATA/g) || []).length} marker(s)`,
  );
  check(
    "A10.8 the status labels are literals, with no data-i18n hook",
    !!(tpl134 && /<span(?![^>]*data-i18n)[^>]*>Running<\/span>/.test(tpl134) &&
      /<span(?![^>]*data-i18n)[^>]*>Closed<\/span>/.test(tpl134) &&
      /<span(?![^>]*data-i18n)[^>]*>Failed<\/span>/.test(tpl134)),
    tpl134 ? "Running / Closed / Failed present as literals" : "no template",
  );

  /* A11 · tab set / script mechanics / shared surface. */
  /* Count tags, not attribute names: the inline script carries selectors such
     as [data-detail-tab="…"], which a raw attribute scan would count as tabs. */
  const v4Tabs = [...v4.matchAll(/<button[^>]*data-detail-tab="[^"]+"/g)].length;
  const v4Panels = [...v4.matchAll(/<div[^>]*data-detail-panel="[^"]+"/g)].length;
  const v4Order = (v4.match(/var ORDER = (\[[^\]]*\]);/) || [])[1];
  const v4Parsed = v4Order ? JSON.parse(v4Order) : null;
  const listed4 = [...v4.matchAll(/<button[^>]*data-detail-tab="([^"]+)"/g)].map((m) => m[1]);
  check(
    "A11.1 v4 has six tabs and six panels",
    v4Tabs === 6 && v4Panels === 6,
    `${v4Tabs} tab(s), ${v4Panels} panel(s)`,
  );
  check(
    "A11.2 ORDER has exactly the six names and puts sessions last",
    !!v4Parsed && v4Parsed.join(",") === ORDER6.join(","),
    `ORDER = ${v4Order}`,
  );
  check(
    "A11.3 the buttons are listed in ORDER's order, sessions last",
    listed4.join(",") === ORDER6.join(","),
    listed4.join(" / "),
  );
  check(
    "A11.4 Details is the tab selected at rest and the only one in the tab order",
    (v4.match(/<button[^>]*aria-selected="true"/g) || []).length === 1 &&
      /<button[^>]*data-detail-tab="details"[^>]*aria-selected="true"/.test(v4) &&
      (v4.match(/<button[^>]*data-detail-tab="[^"]+"[^>]*tabindex="0"/g) || []).length === 1,
    "one aria-selected=\"true\" · one tabindex=\"0\"",
  );
  {
    const openTags = [...v4.matchAll(/<div[^>]*data-detail-panel="([^"]+)"[^>]*>/g)];
    const hidden = Object.fromEntries(
      openTags.map((m) => [m[1], /(?:^|\s)hidden(?=[\s>])/.test(m[0]) ? "hidden" : "shown"]),
    );
    const others = ORDER6.filter((n) => n !== "details");
    check(
      "A11.5 Details is shown at rest and the other five panels are hidden",
      openTags.length === 6 && hidden.details === "shown" && others.every((n) => hidden[n] === "hidden"),
      Object.entries(hidden).map(([k, v]) => `${k}:${v}`).join(" "),
    );
    const sessionsTag = openTag(v4, (t) => t.attrs["data-detail-tab"] === "sessions");
    check(
      "A11.6 the Sessions tab is visible at rest (the static no-JS row is its floor)",
      !!sessionsTag && sessionsTag.attrs.hidden === undefined,
      sessionsTag ? `hidden=${sessionsTag.attrs.hidden === undefined ? "absent" : "present"}` : "no sessions tab",
    );
  }
  {
    const ids = new Set([...v4.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const tabs = [...v4.matchAll(/<button[^>]*data-detail-tab="([^"]+)"[^>]*>/g)];
    const panels = [...v4.matchAll(/<div[^>]*data-detail-panel="([^"]+)"[^>]*>/g)];
    const controls = tabs.map((m) => (m[0].match(/aria-controls="([^"]+)"/) || [])[1]);
    const labelled = panels.map((m) => (m[0].match(/aria-labelledby="([^"]+)"/) || [])[1]);
    const tabIds = tabs.map((m) => (m[0].match(/\bid="([^"]+)"/) || [])[1]);
    const ok = tabs.length === 6 && panels.length === 6 &&
      new Set(tabs.map((m) => m[1])).size === 6 &&
      new Set(panels.map((m) => m[1])).size === 6 &&
      controls.every((c) => ids.has(c) && new RegExp(`data-detail-panel="${panelNameOf(c)}"`).test(v4)) &&
      labelled.every((l) => ids.has(l) && tabIds.includes(l));
    check(
      "A11.7 with the script off the markup still stands: six tabs, six panels, every ARIA pointer resolves",
      ok,
      `tabs=${tabs.length} panels=${panels.length}`,
    );
  }
  {
    const baseKeys = i18nKeys(base);
    const extra = [...i18nKeys(v4)].filter((k) => !baseKeys.has(k));
    check(
      "A11.8 v4 adds no i18n key the base does not already carry",
      extra.length === 0,
      extra.length ? extra.slice(0, 5).join(", ") : `0 new key(s) over the base's ${baseKeys.size}`,
    );
    const tag = openTag(v4, (t) => t.attrs["data-detail-tab"] === "sessions");
    const labelAt = tag ? tag.index + tag.raw.length : -1;
    const labelled = labelAt > 0 && v4.startsWith(`${SESSIONS_LABEL}</button>`, labelAt);
    check(
      "A11.9 the Sessions tab is a literal, like the five it joins — no data-i18n hook",
      !!tag && tag.attrs["data-i18n"] === undefined && labelled,
      tag ? `label "${SESSIONS_LABEL}" · data-i18n: ${tag.attrs["data-i18n"] === undefined ? "absent" : "present"}` : "no sessions tab",
    );
  }
  {
    /* The card templates legitimately carry data-assignee-kind on avatars; the
       claim is about the TAB SCRIPT, so read only that slice. */
    const scriptFrom = v4.indexOf('var ORDER = ["details"');
    const scriptText = scriptFrom === -1 ? "" : v4.slice(scriptFrom, v4.indexOf("</script>", scriptFrom));
    check(
      "A11.10 the tab script reads the session body's children and never the assignee kind",
      scriptText.includes('$("[data-detail-agent-session-body]").children()') &&
        !scriptText.includes("assignee-kind"),
      "hasSessions = body children · assignee-kind absent from the tab script",
    );
  }
  check(
    "A11.11 the script writes no address (需求 F)",
    !/location\.hash\s*=/.test(v4) && !/pushState\s*\(/.test(v4) && !/replaceState\s*\(/.test(v4),
    "no location.hash= / pushState( / replaceState(",
  );
  check(
    "A11.12 a hidden tab is display:none, not just the hidden property (daisyUI sets display:inline-flex)",
    /\[hidden\][^{}]*\{[^}]*display:\s*none/.test(v4),
    "author [hidden] display:none rule present",
  );
  {
    const linksTw = (v4.match(/href="tw\.css"/g) || []).length;
    const loadsApp = (v4.match(/src="app\.js"/g) || []).length;
    const inlinesCss = /<style[^>]*>[\s\S]{0,400}tailwindcss/i.test(v4);
    const inlinesApp = v4.includes("function identifierText(");
    check(
      "A11.13 v4 references the shared tw.css and app.js, and inlines neither",
      linksTw === 1 && loadsApp === 1 && !inlinesCss && !inlinesApp,
      `tw.css link=${linksTw} · app.js src=${loadsApp} · inlined css=${inlinesCss} · inlined app=${inlinesApp}`,
    );
  }
  /* The raw walk must fail; A8.4 is the normalized proof, and this is the note
     that keeps the allowance honest. */
  const rawWalk = insertionWalk(html, v4);
  check(
    "A8.7 the un-normalized insertion walk is expected to fail (the registered move is real)",
    !rawWalk.ok,
    `${rawWalk.matched}/${rawWalk.total} — the move reorders the blocked span`,
  );
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

/* =====================================================================
   v4 RENDER SUITE — the Sessions tab
   ===================================================================== */

/* Open a named card, not the "first with comments" heuristic: the trail sample
   lives on TD-134, and the no-session case on TD-126. */
const OPEN_CARD_BY_ID = (id) => {
  const cards = [...document.querySelectorAll("[data-card]")];
  const card = cards.find(
    (c) => ((c.querySelector("[data-card-identifier]") || {}).textContent || "").trim() === id,
  );
  (card || cards[0]).click();
};

const READ_V4_TABS = () => {
  const tabs = [...document.querySelectorAll("[data-detail-tab]")];
  const visible = tabs.filter((t) => !t.hidden && getComputedStyle(t).display !== "none");
  const boxes = visible.map((t) => t.getBoundingClientRect());
  const bar = document.querySelector("[data-detail-tabs]");
  const sessions = document.querySelector('[data-detail-tab="sessions"]');
  const body = document.querySelector("[data-detail-agent-session-body]");
  const section = document.querySelector("[data-detail-agent-session]");
  const drawerBody = document.querySelector("[data-detail-drawer] .td-drawer-body");
  return {
    order: tabs.map((t) => t.getAttribute("data-detail-tab")),
    visibleOrder: visible.map((t) => t.getAttribute("data-detail-tab")),
    selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.getAttribute("data-detail-tab")),
    roving: tabs.filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.getAttribute("data-detail-tab")),
    visiblePanels: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-detail-panel")),
    onScreenPanels: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => p.offsetParent !== null).map((p) => p.getAttribute("data-detail-panel")),
    sessions: sessions
      ? { hidden: sessions.hidden, display: getComputedStyle(sessions).display, offsetParent: sessions.offsetParent !== null }
      : null,
    sessionBodyChildren: body ? body.children.length : null,
    sectionHidden: section ? section.hidden : null,
    rows: new Set(boxes.map((b) => Math.round(b.top))).size,
    heights: [...new Set(boxes.map((b) => Math.round(b.height)))],
    fontSize: visible[0] ? getComputedStyle(visible[0]).fontSize : null,
    barWidth: Math.round(bar.getBoundingClientRect().width),
    barScrollWidth: bar.scrollWidth,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    drawerBodyOverflowX: drawerBody ? drawerBody.scrollWidth - drawerBody.clientWidth : null,
  };
};

async function renderSessionsSuite() {
  suite("render-v4");

  const chromium = await loadPlaywright();
  if (!chromium) {
    check("S0.0 Playwright reachable for v4", false, "no playwright module on this host");
    return;
  }
  check("S0.0 Playwright reachable for v4", true);
  if (!v4) {
    check("S0.1 index-detail-tabs-v4.html exists for the v4 render suite", false, `missing ${V4_PATH}`);
    return;
  }
  check("S0.1 index-detail-tabs-v4.html exists for the v4 render suite", true);

  const server = await serveDesignRoot();
  const { port } = server.address();
  const at = (file) => `http://127.0.0.1:${port}/prototype/${file}`;
  const browser = await chromium.launch();
  const V4 = "index-detail-tabs-v4.html";

  const open = async (viewport, cardId) => {
    const errors = [];
    const page = await browser.newPage({ viewport });
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(at(V4), { waitUntil: "load" });
    await page.waitForFunction(() => !!window.jQuery);
    await page.evaluate(OPEN_CARD_BY_ID, cardId);
    await page.waitForTimeout(300);
    return { page, errors };
  };

  try {
    /* B4/B5 · geometry at three tiers for the agent card, and the human card at 430 */
    for (const [tier, viewport, rows] of [
      ["1512×950", VIEWPORT, 1],
      ["760×950", MID, 1],
      ["430×932", NARROW, 2],
    ]) {
      const { page } = await open(viewport, "TD-134");
      const t = await page.evaluate(READ_V4_TABS);
      check(
        `B4 v4 @ ${tier} — six tabs share ${rows} row(s) and nothing overflows`,
        t.visibleOrder.length === 6 && t.rows === rows &&
          t.barScrollWidth <= t.barWidth + 1 && t.docOverflowX === 0,
        `${t.visibleOrder.length} visible · ${t.rows} row(s) · bar ${t.barWidth}px / ${t.barScrollWidth}px · page overflow-x ${t.docOverflowX}px`,
      );
      check(
        `B5 v4 @ ${tier} — every visible tab is the same height and 12px`,
        t.heights.length === 1 && t.fontSize === "12px",
        `heights ${t.heights.join("/")} · font ${t.fontSize}`,
      );
      await page.close();
    }
    {
      const { page } = await open(NARROW, "TD-126");
      const t = await page.evaluate(READ_V4_TABS);
      check(
        "B6 v4 @ 430×932 human card — five tabs, one row; the Sessions tab is display:none",
        t.visibleOrder.length === 5 && !t.visibleOrder.includes("sessions") &&
          t.sessions && t.sessions.display === "none" && t.sessions.offsetParent === false &&
          t.rows === 1 && t.docOverflowX === 0,
        `${t.visibleOrder.join("/")} · sessions display=${t.sessions ? t.sessions.display : "?"} · ${t.rows} row(s)`,
      );
      await page.close();
    }

    /* C7 · the Sessions face and the six-tab keyboard walk */
    {
      const { page, errors } = await open(VIEWPORT, "TD-134");
      const initial = await page.evaluate(READ_V4_TABS);
      check(
        "C7.1 v4 agent card — opens on Details with the Sessions tab visible and its panel hidden",
        initial.selected.join(",") === "details" &&
          initial.visiblePanels.join(",") === "details" &&
          initial.visibleOrder.includes("sessions") &&
          initial.sessions && initial.sessions.display !== "none",
        `selected ${initial.selected.join("/")} · visible ${initial.visiblePanels.join("/")} · sessions ${initial.sessions ? initial.sessions.display : "?"}`,
      );
      await page.evaluate(PICK_TAB, "sessions");
      await page.waitForTimeout(200);
      const s = await page.evaluate(READ_V4_TABS);
      check(
        "C7.2 v4 agent card — clicking Sessions moves selection, panel and roving tabindex together",
        s.selected.join(",") === "sessions" && s.visiblePanels.join(",") === "sessions" &&
          s.onScreenPanels.join(",") === "sessions" && s.roving.join(",") === "sessions",
        `selected ${s.selected.join("/")} · visible ${s.visiblePanels.join("/")} · on screen ${s.onScreenPanels.join("/")}`,
      );
      await page.evaluate(PICK_TAB, "details");
      await page.focus('[data-detail-tab="details"]');
      const walked = [];
      for (let i = 0; i < ORDER6.length; i += 1) {
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
      const expected = [...ORDER6.slice(1), ORDER6[0]];
      check(
        "C7.3 v4 agent card — ←/→ rove over all six (wrapping) and Home/End take the ends",
        walked.join(",") === expected.join(",") && back === "sessions" && home === "details" && end === "sessions",
        `→ ${walked.join("/")} · ← ${back} · Home ${home} · End ${end}`,
      );

      /* C8 · the trail itself */
      await page.evaluate(PICK_TAB, "sessions");
      await page.waitForTimeout(200);
      const trail = await page.evaluate(() => ({
        ids: [...document.querySelectorAll("[data-detail-agent-session-body] [data-agent-session-id]")]
          .map((e) => e.textContent.trim()),
        statuses: [...document.querySelectorAll("[data-detail-agent-session-body] [data-session-status]")]
          .map((e) => e.getAttribute("data-session-status")),
        resumes: document.querySelectorAll("[data-detail-agent-session-body] [data-agent-resume]").length,
        text: (document.querySelector("[data-detail-agent-session-body]") || {}).textContent || "",
      }));
      check(
        "C8.1 v4 agent card — the trail renders three sessions, running / closed / failed",
        trail.ids.length === 3 && trail.statuses.join(",") === "running,closed,failed",
        `${trail.ids.length} row(s) · ${trail.statuses.join("/")}`,
      );
      check(
        "C8.2 v4 agent card — exactly one Resume and no pid",
        trail.resumes === 1 && !/\bpid\b/.test(trail.text),
        `resume=${trail.resumes} · pid=${/\bpid\b/.test(trail.text)}`,
      );
      await page.evaluate(() => document.querySelector("[data-detail-agent-session-body] [data-agent-session-id]").click());
      await page.waitForTimeout(200);
      const toast = await page.evaluate(() => {
        const items = [...document.querySelectorAll("[data-toast-region] [data-toast-text]")];
        return items.length ? items[items.length - 1].textContent : null;
      });
      check(
        "C8.3 v4 agent card — clicking a session id runs the existing copy path",
        !!toast && trail.ids.length > 0 && toast.includes(trail.ids[0]),
        `toast ${JSON.stringify(toast)}`,
      );
      check(
        "C8.4 v4 agent card — the whole sequence raises no console or page error",
        errors.length === 0,
        errors.length ? errors.slice(0, 3).join(" | ") : "0 error(s)",
      );
      await page.close();
    }

    /* C9 · a human card: five tabs, no Sessions tab, no empty tab */
    {
      const { page, errors } = await open(VIEWPORT, "TD-126");
      const t = await page.evaluate(READ_V4_TABS);
      check(
        "C9.1 v4 human card — Sessions is hidden, its section is empty/hidden, and Details is selected",
        t.visibleOrder.length === 5 && !t.visibleOrder.includes("sessions") &&
          t.sessions && t.sessions.hidden === true && t.sessions.display === "none" &&
          t.sessionBodyChildren === 0 && t.sectionHidden === true &&
          t.selected.join(",") === "details" && t.visiblePanels.join(",") === "details",
        `${t.visibleOrder.join("/")} · body children=${t.sessionBodyChildren} · section hidden=${t.sectionHidden}`,
      );
      await page.evaluate(PICK_TAB, "details");
      await page.focus('[data-detail-tab="details"]');
      const walked = [];
      for (let i = 0; i < ORDER.length; i += 1) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(60);
        walked.push(await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab")));
      }
      await page.keyboard.press("End");
      await page.waitForTimeout(60);
      const end = await page.evaluate(() => document.activeElement.getAttribute("data-detail-tab"));
      check(
        "C9.2 v4 human card — the keyboard walk is five tabs long and never reaches Sessions",
        walked.join(",") === [...ORDER.slice(1), ORDER[0]].join(",") && end === "leftovers" &&
          !walked.includes("sessions"),
        `→ ${walked.join("/")} · End ${end}`,
      );
      check(
        "C9.3 v4 human card — no console or page error",
        errors.length === 0,
        errors.length ? errors.slice(0, 3).join(" | ") : "0 error(s)",
      );
      await page.close();
    }

    /* C10 · switching cards: selected-Sessions falls back, then the tab returns */
    {
      const { page, errors } = await open(VIEWPORT, "TD-134");
      await page.evaluate(PICK_TAB, "sessions");
      await page.waitForTimeout(150);
      const before = await page.evaluate(READ_V4_TABS);
      await page.evaluate(OPEN_CARD_BY_ID, "TD-126");
      await page.waitForTimeout(300);
      const human = await page.evaluate(READ_V4_TABS);
      await page.evaluate(OPEN_CARD_BY_ID, "TD-134");
      await page.waitForTimeout(300);
      const again = await page.evaluate(READ_V4_TABS);
      check(
        "C10.1 v4 switching to a human card falls back to Details and hides Sessions",
        before.selected.join(",") === "sessions" &&
          human.selected.join(",") === "details" &&
          human.visiblePanels.join(",") === "details" &&
          human.visibleOrder.length === 5 && !human.visibleOrder.includes("sessions"),
        `before ${before.selected.join("/")} · human ${human.selected.join("/")} / ${human.visibleOrder.join("/")}`,
      );
      check(
        "C10.2 v4 switching back to the agent card brings the Sessions tab back (Details stays selected)",
        again.visibleOrder.length === 6 && again.visibleOrder.includes("sessions") &&
          again.selected.join(",") === "details" && again.visiblePanels.join(",") === "details",
        `${again.visibleOrder.join("/")} · selected ${again.selected.join("/")}`,
      );
      check(
        "C10.3 v4 the card-switch sequence raises no console or page error",
        errors.length === 0,
        errors.length ? errors.slice(0, 3).join(" | ") : "0 error(s)",
      );
      await page.close();
    }

    /* C11 · the narrow viewport with the Sessions panel open */
    {
      const { page } = await open(NARROW, "TD-134");
      await page.evaluate(PICK_TAB, "sessions");
      await page.waitForTimeout(200);
      const t = await page.evaluate(READ_V4_TABS);
      check(
        "C11 v4 @ 430×932 — the open Sessions panel causes no horizontal overflow",
        t.docOverflowX === 0 && t.drawerBodyOverflowX !== null && t.drawerBodyOverflowX <= 1,
        `page overflow-x ${t.docOverflowX}px · drawer body ${t.drawerBodyOverflowX}px`,
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

  const shoot = async (variant, viewport, face, file, opener = OPEN_CARD, openerArg = undefined) => {
    const context = await browser.newContext({ viewport, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(at(variant), { waitUntil: "load" });
    await page.waitForFunction(() => !!window.jQuery);
    await page.addStyleTag({ content: freeze });
    await page.waitForTimeout(150);
    await page.evaluate(opener, openerArg);
    await page.waitForTimeout(300);
    const tabName = face.startsWith("sessions") ? "sessions" : face;
    if (tabName !== "details") await page.evaluate(PICK_TAB, tabName);
    await page.waitForTimeout(200);
    if (file.endsWith("-tail.png") || face === "sessions-trail") {
      /* the difference between the variants is at the END of the Details panel —
         what the tab strip's top-of-page view cannot show. The trail shot uses
         the same move to bring the lower session rows into the frame. */
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

  /* v4 — the Sessions tab and its trail, on the card that carries the sample */
  for (const [tier, viewport] of [["1512", VIEWPORT], ["430", NARROW]]) {
    for (const face of ["details", "sessions", "sessions-trail"]) {
      await shoot(
        "index-detail-tabs-v4.html",
        viewport,
        face,
        `d2v4-${tier}-${face}.png`,
        OPEN_CARD_BY_ID,
        "TD-134",
      );
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
  await renderSessionsSuite();
} else {
  suite("render");
  check("R0.0 render suite", true, "skipped by --static-only");
  suite("render-v4");
  check("S0.0 v4 render suite", true, "skipped by --static-only");
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n== SUMMARY == ${results.length - failed.length}/${results.length} passed${
    failed.length ? `, ${failed.length} failed:\n  - ${failed.map((f) => f.id).join("\n  - ")}` : ""
  }\n`,
);
process.exitCode = failed.length ? 1 : 0;
