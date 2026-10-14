#!/usr/bin/env node
/* =====================================================================
   check-activity.mjs — the machine check for the B26 · Activity proposal
   ---------------------------------------------------------------------
   Usage
     node design/activity/check-activity.mjs                # static + render
     node design/activity/check-activity.mjs --static-only   # no browser
     node design/activity/check-activity.mjs --shots         # write screenshots/

   Zero dependencies beyond Node's standard library; the render half drives
   the host's Playwright if one is reachable and FAILS (it does not skip)
   when one is not, because an assertion nobody can evaluate is not a
   passing assertion.

   Two suites, one exit code:
     static — parses prototype.html / activity.js / DESIGN-activity.md as
              text. Every assertion is a claim about the shipped artefact.
     render — loads the page over a throwaway loopback server and drives it
              through `window.tdActivity`. No network beyond 127.0.0.1.
   ===================================================================== */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, "..");

const HTML_PATH = join(HERE, "prototype.html");
const JS_PATH = join(HERE, "activity.js");
const DOC_PATH = join(HERE, "DESIGN-activity.md");
const TW_CSS_PATH = join(DESIGN, "prototype", "tw.css");
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
  const mark = ok ? "  ok  " : " FAIL ";
  process.stdout.write(`[${mark}] ${id}${detail ? " — " + detail : ""}\n`);
}

function near(a, b) {
  return a <= b;
}

/* ------------------------------------------------------------- sources */

const html = readFileSync(HTML_PATH, "utf8");
const js = readFileSync(JS_PATH, "utf8");
const doc = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : "";

/* ------------------------------------------------------ tiny tag parser */

/** Every start tag in the document, as {name, attrs, raw, index}. */
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

/** The inner text of a start tag's element, when it holds no child element. */
function innerTextOf(source, tag) {
  const end = tag.index + tag.raw.length;
  const close = source.indexOf(`</${tag.name}>`, end);
  if (close === -1) return null;
  const inner = source.slice(end, close);
  if (inner.includes("<")) return null;
  return inner;
}

/** All (tag, key) pairs for a `data-i18n*` family. */
function i18nHooks(source, attr) {
  const out = [];
  for (const tag of startTags(source)) {
    if (Object.prototype.hasOwnProperty.call(tag.attrs, attr)) {
      out.push({ tag, key: tag.attrs[attr], arg: tag.attrs["data-i18n-arg"] });
    }
  }
  return out;
}

/** The document with its comments removed — "the first child" is an element. */
function withoutComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

/** The first element that opens inside `tag`'s block, comments ignored. */
function firstChildTag(source, tag) {
  const body = withoutComments(source.slice(tag.index + tag.raw.length));
  const m = body.match(/<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/);
  return m ? { name: m[1].toLowerCase(), attrs: parseAttrs(m[2]), raw: m[0] } : null;
}

/** A tag's `class` attribute, as a set of names. */
function classSet(tag) {
  return new Set(String((tag && tag.attrs.class) || "").split(/\s+/).filter(Boolean));
}

/** A single rule's declaration block, as text — `""` when the rule is gone. */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  return css.slice(at, css.indexOf("}", at) + 1);
}

/* =====================================================================
   STATIC SUITE
   ===================================================================== */

suite("static");

/* --- 1 · the block roots exist ---------------------------------------- */
check(
  "S1.1 [data-activity-view] present exactly once",
  (html.match(/data-activity-view(?=[\s>])/g) || []).length === 1,
  `${(html.match(/data-activity-view(?=[\s>])/g) || []).length} occurrence(s)`
);
check(
  "S1.2 [data-activity-feed] present exactly once",
  (html.match(/data-activity-feed(?=[\s>])/g) || []).length === 1
);
for (const hook of [
  "data-activity-filters",
  "data-activity-filter-reset",
  "data-activity-filter-count",
  "data-activity-day",
  "data-activity-row",
  "data-activity-actor",
  "data-activity-sentence",
  "data-activity-task",
  "data-activity-at",
  "data-activity-detail",
  "data-activity-unread-divider",
  "data-activity-mark-read",
  "data-activity-burst",
  "data-activity-burst-count",
  "data-activity-empty",
  "data-activity-empty-reset",
  "data-activity-more",
]) {
  /* The whole token, so `data-activity-task` is not satisfied by
     `data-activity-task-id` and `data-activity-burst` by
     `data-activity-burst-count`. */
  check(`S1.3 [${hook}] present`, new RegExp(`${hook}(?=[\\s=>])`).test(html));
}
for (const name of ["actor", "event", "task"]) {
  check(
    `S1.4 [data-activity-filter="${name}"] present`,
    html.includes(`data-activity-filter="${name}"`)
  );
}

/* --- 2 · ordering ------------------------------------------------------ */
const dayTags = startTags(html).filter((t) => t.attrs["data-activity-day"] !== undefined);
check("S2.1 every [data-activity-day] carries data-day", dayTags.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.attrs["data-day"] || "")), `${dayTags.length} day group(s)`);
{
  const days = dayTags.map((t) => t.attrs["data-day"]);
  const sortedDesc = days.every((d, i) => i === 0 || days[i - 1] >= d);
  check("S2.2 day groups are non-increasing", sortedDesc, days.join(" → "));
}
{
  /* Rows are read off the document in order, so the check sees the rendered
     sequence, not a sorted copy of it. */
  const rows = startTags(html).filter((t) => t.attrs["data-activity-row"] !== undefined);
  const times = rows.map((t) => t.attrs["data-at"]);
  const allIso = times.every((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v || ""));
  check("S2.3 every [data-activity-row] carries an ISO data-at", allIso, `${rows.length} row(s)`);
  check(
    "S2.4 rows are non-increasing in document order",
    times.every((v, i) => i === 0 || times[i - 1] >= v)
  );
  const rowInners = rows.map((t, i) => {
    const end = i + 1 < rows.length ? rows[i + 1].index : html.length;
    return html.slice(t.index + t.raw.length, end);
  });
  check(
    "S2.5 every row's [data-activity-at] datetime equals the row's data-at",
    rows.every((t, i) => {
      const m = rowInners[i].match(/<time[^>]*data-activity-at[^>]*datetime="([^"]+)"/);
      return m !== null && m[1] === t.attrs["data-at"];
    })
  );

  /* The two oldest day headings are the only dates the document ships as
     prose rather than as a catalogue key. They still have to be the same
     string the script would compute, or the JS-off document and the JS-on
     document disagree about what day it is. */
  const dated = [...html.matchAll(/data-activity-day-kind="absolute"><time datetime="([^"]+)">([^<]*)<\/time>/g)].map(
    (m) => ({ iso: m[1], text: m[2] })
  );
  const fmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });
  const wrongDates = dated.filter(
    (d) => d.text !== fmt.format(new Date(Date.parse(d.iso + "T12:00:00Z")))
  );
  check(
    "S2.6 the absolute day headings are the en-US dates the script would compute",
    dated.length === 2 && wrongDates.length === 0,
    dated.length ? dated.map((d) => d.text).join(" / ") : "none found"
  );
}

/* --- 3 · the JS-off floor --------------------------------------------- */
{
  const rows = (html.match(/data-activity-row(?=[\s>])/g) || []).length;
  const days = dayTags.length;
  const details = (html.match(/<details[^>]*data-activity-detail/g) || []).length;
  const times = (html.match(/<time[^>]*data-activity-at/g) || []).length;
  const ids = (html.match(/data-activity-task-id(?=[\s>])/g) || []).length;
  const templates = (html.match(/<template[^>]*data-activity/g) || []).length;

  check("S3.1 the feed is static markup, not a template", templates === 0, `${templates} activity template(s)`);
  check("S3.2 day groups in the static document", days >= 3, `${days} day group(s)`);
  check("S3.3 rows in the static document", rows >= 10, `${rows} row(s)`);
  check("S3.4 task identifiers in the static document", ids === rows, `${ids} for ${rows} row(s)`);
  check("S3.5 relative times in the static document", times === rows, `${times} <time> for ${rows} row(s)`);
  check(
    "S3.6 an expandable <details> per row (JS-off interactive)",
    details === rows,
    `${details} detail(s) for ${rows} row(s)`
  );
  check(
    "S3.7 the <details> detail holds at least one change row",
    (html.match(/data-activity-change(?=[\s=>])/g) || []).length >= rows,
    `${(html.match(/data-activity-change(?=[\s=>])/g) || []).length} change row(s)`
  );
}

/* --- 4 · nav ----------------------------------------------------------- */
{
  const navStart = html.indexOf("data-nav ");
  const navEnd = html.indexOf("</nav>", navStart);
  const nav = html.slice(navStart, navEnd);
  const current = (nav.match(/data-nav-item="[^"]+"[^>]*aria-current="page"|aria-current="page"[^>]*data-nav-item="[^"]+"/g) || []).length;
  check("S4.1 exactly one nav item is aria-current inside [data-nav]", current === 1, `${current} marked`);
  check(
    "S4.2 the marked nav item is the activity item",
    /<button[^>]*data-nav-item="activity"[^>]*aria-current="page"|<button[^>]*aria-current="page"[^>]*data-nav-item="activity"/.test(nav)
  );
  const pill = startTags(html).find((t) => t.attrs["data-nav-count"] === "activity");
  check("S4.3 [data-nav-count=activity] exists", !!pill);
  const pillText = pill ? (html.slice(pill.index + pill.raw.length).match(/^\s*(\d+)/) || [])[1] : null;
  const unreadRows = (html.match(/data-activity-unread(?=[\s>])/g) || []).length;
  check(
    "S4.4 the pill starts at the number of unread rows",
    pillText !== null && Number(pillText) === unreadRows,
    `${pillText} in the pill · ${unreadRows} unread row(s)`
  );
  check(
    "S4.5 the pill's 0-state rule is authored (hidden ⇒ display:none)",
    /\[data-nav-count\]\[hidden\]\s*\{[^}]*display:\s*none/.test(html)
  );
  check(
    "S4.6 the script writes hidden on the pill at zero",
    /nav-count="activity"[\s\S]{0,400}?hidden/.test(js) && /unread === 0/.test(js)
  );
}

/* --- 5 · filters ------------------------------------------------------- */
{
  const actorValues = optionValues(html, "data-activity-filter=\"actor\"");
  const kinds = new Set(
    startTags(html)
      .filter((t) => t.attrs["data-activity-row"] !== undefined)
      .map((t) => t.attrs["data-assignee-kind"])
  );
  check(
    "S5.1 every actor kind on a row is addressable by the actor filter",
    [...kinds].every((k) => actorValues.includes(k)),
    `rows: ${[...kinds].join(", ")} · options: ${actorValues.join(", ")}`
  );

  const eventValues = optionValues(html, "data-activity-filter=\"event\"");
  const groups = new Set(
    startTags(html)
      .filter((t) => t.attrs["data-activity-row"] !== undefined)
      .map((t) => t.attrs["data-activity-group"])
  );
  check(
    "S5.2 every event group is either filterable or the explicit backdrop",
    [...groups].every((g) => g === "meta" || eventValues.includes(g)),
    `groups: ${[...groups].join(", ")}`
  );

  const taskValues = optionValues(html, "data-activity-filter=\"task\"");
  const tasks = new Set(
    startTags(html)
      .filter((t) => t.attrs["data-activity-row"] !== undefined)
      .map((t) => t.attrs["data-task"])
  );
  const uncovered = [...tasks].filter((t2) => !taskValues.includes(t2));
  check(
    "S5.3 every task on a row has an option in the task filter",
    uncovered.length === 0,
    uncovered.length ? `uncovered: ${uncovered.join(", ")}` : `${tasks.size} task(s)`
  );

  check(
    "S5.4 the count hook is aria-live",
    /data-activity-filter-count[^>]*aria-live="polite"|aria-live="polite"[^>]*data-activity-filter-count/.test(html)
  );
}

function optionValues(source, selectNeedle) {
  const at = source.indexOf(selectNeedle);
  if (at === -1) return [];
  const open = source.lastIndexOf("<select", at);
  const close = source.indexOf("</select>", at);
  const body = source.slice(open, close);
  return [...body.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]);
}

/* --- 6 · empty states -------------------------------------------------- */
{
  const empties = startTags(html).filter((t) => t.attrs["data-activity-empty"] !== undefined);
  check("S6.1 two [data-activity-empty] variants", empties.length === 2, `${empties.length} variant(s)`);
  const kinds = empties.map((t) => t.attrs["data-activity-empty-kind"]).sort();
  check("S6.2 the two kinds are project and filter", kinds.join(",") === "filter,project", kinds.join(", "));
  check("S6.3 both ship hidden in the static document", empties.every((t) => t.attrs.hidden !== undefined));
  const filterEmpty = empties.find((t) => t.attrs["data-activity-empty-kind"] === "filter");
  if (filterEmpty) {
    const slice = html.slice(filterEmpty.index, html.indexOf("</div>", filterEmpty.index));
    check("S6.4 the filter empty carries [data-activity-empty-reset]", slice.includes("data-activity-empty-reset"));
  }
  check(
    "S6.5 the script renders empty only when it has no rows",
    /admissible === 0/.test(js) && /shown === 0/.test(js)
  );
}

/* --- 7 · burst --------------------------------------------------------- */
{
  const burst = startTags(html).find((t) => t.attrs["data-activity-burst"] !== undefined);
  check("S7.1 a [data-activity-burst] row exists", !!burst);
  if (burst) {
    const countTag = startTags(html).find((t) => t.attrs["data-activity-burst-count"] !== undefined);
    const declared = countTag ? Number(countTag.attrs["data-activity-burst-count"]) : NaN;
    const slice = html.slice(burst.index, html.indexOf("</details>", burst.index));
    const items = [...slice.matchAll(/data-activity-burst-item[^>]*data-at="([^"]+)"/g)].map((m) => m[1]);
    check("S7.2 the burst's [data-activity-burst-count] equals its item count", declared === items.length, `${declared} declared · ${items.length} item(s)`);
    check(
      "S7.3 the visible count reads ×N",
      countTag !== undefined &&
        new RegExp(`data-activity-burst-count="${declared}"[^>]*>×${declared}<`).test(html)
    );
    if (items.length > 1) {
      const ms = items.map((v) => Date.parse(v));
      const span = (Math.max(...ms) - Math.min(...ms)) / 60000;
      check("S7.4 every burst item is inside one five-minute window", span <= 5, `${span} minute(s)`);
    }
    /* "Same event family" here means the field-edit family: one agent
       touching one card's fields in a row. The burst row names the family
       (`meta`); each folded item names which field it changed. */
    const FIELD_EDITS = ["assignee", "label", "priority", "title", "status"];
    const kinds = [
      ...new Set(
        startTags(slice)
          .filter((t) => t.attrs["data-activity-change"] !== undefined)
          .map((t) => t.attrs["data-activity-change"])
      ),
    ];
    check(
      "S7.5 the burst folds one family — field edits",
      burst.attrs["data-event"] === "meta" && kinds.length > 0 && kinds.every((k) => FIELD_EDITS.includes(k)),
      `event ${burst.attrs["data-event"]} · kinds ${kinds.join(", ")}`
    );
    check(
      "S7.6 the burst's actor, task and family are the folded ones",
      burst.attrs["data-actor"] === "jobs" && burst.attrs["data-task"] === "TD-123",
      `${burst.attrs["data-actor"]} · ${burst.attrs["data-task"]}`
    );
  }
}

/* --- 8 · i18n ---------------------------------------------------------- */
{
  const m = html.match(/<script[^>]*data-activity-i18n[^>]*>([\s\S]*?)<\/script>/);
  let catalogue = null;
  try {
    catalogue = JSON.parse(m[1]);
  } catch (err) {
    catalogue = null;
  }
  check("S8.1 the catalogue parses as JSON", !!catalogue);

  if (catalogue) {
    const en = Object.keys(catalogue.en || {}).sort();
    const zh = Object.keys(catalogue.zh || {}).sort();
    check("S8.2 en and zh carry the same key set", en.join("\u0000") === zh.join("\u0000"), `en ${en.length} · zh ${zh.length}`);
    const missingZh = en.filter((k) => !(k in (catalogue.zh || {})));
    const missingEn = zh.filter((k) => !(k in (catalogue.en || {})));
    check("S8.3 no key is missing on either side", missingZh.length === 0 && missingEn.length === 0, [...missingZh, ...missingEn].join(", "));

    for (const hook of ["data-i18n", "data-i18n-aria-label", "data-i18n-title", "data-i18n-placeholder"]) {
      const unresolved = i18nHooks(html, hook)
        .filter((h) => !(h.key in catalogue.en) || !(h.key in catalogue.zh))
        .map((h) => h.key);
      check(`S8.4 every ${hook} key resolves in both languages`, unresolved.length === 0, [...new Set(unresolved)].join(", "));
    }

    /* The static copy IS the English catalogue — that is what makes the
       JS-off document and the JS-on document the same document. */
    const literal = (key, arg) => {
      let value = catalogue.en[key];
      if (value === undefined) return null;
      if (arg !== undefined) value = value.replace("%s", resolveArg(arg, catalogue));
      return value;
    };
    const wrong = [];
    let literalHooks = 0;
    for (const hook of i18nHooks(html, "data-i18n")) {
      const text = innerTextOf(html, hook.tag);
      if (text === null) {
        wrong.push(`${hook.key}: the element has child markup and cannot be read literally`);
        continue;
      }
      literalHooks += 1;
      const want = literal(hook.key, hook.arg);
      if (text !== want) wrong.push(`${hook.key}: "${text}" ≠ "${want}"`);
    }
    check(
      "S8.5 the static text equals the English catalogue",
      wrong.length === 0,
      wrong.length ? wrong.slice(0, 3).join(" | ") : `${literalHooks} hook(s)`
    );

    const wrongAria = [];
    for (const hook of i18nHooks(html, "data-i18n-aria-label")) {
      const value = hook.tag.attrs["aria-label"];
      const want = literal(hook.key, hook.arg);
      if (value !== want) wrongAria.push(`${hook.key}: "${value}" ≠ "${want}"`);
    }
    check("S8.6 every aria-label equals the English catalogue", wrongAria.length === 0, wrongAria.slice(0, 3).join(" | "));

    check(
      "S8.7 no visible text renders a raw key",
      !/>\s*activity\.[a-zA-Z.]+\s*</.test(html) && !/data-i18n="[^"]*"[^>]*>[^<]*data-i18n-/.test(html)
    );
    check(
      "S8.8 the document declares a language",
      /<html[^>]*lang="(en|zh-CN)"/.test(html) && /attr\("lang"/.test(js)
    );
  }
}

function resolveArg(arg, catalogue) {
  const en = catalogue.en || {};
  if (Object.prototype.hasOwnProperty.call(en, arg)) return en[arg];
  return arg;
}

/* --- 9 · tokens -------------------------------------------------------- */
{
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  const css = style ? style[1] : "";
  check("S9.1 the scoped <style> block exists", css.length > 0);

  const declarations = [...css.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[2]);
  check("S9.2 the scoped block declares no new custom property", declarations.length === 0, declarations.join(", "));

  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g)].map((m) => m[0]);
  check("S9.3 the scoped block contains no colour literal", literals.length === 0, [...new Set(literals)].join(", "));

  const tw = readFileSync(TW_CSS_PATH, "utf8");
  const used = [...new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))];
  const undefinedTokens = used.filter((name) => !new RegExp(`${name}\\s*:`).test(tw));
  check(
    "S9.4 every token the scoped block reads already exists in tw.css",
    undefinedTokens.length === 0,
    undefinedTokens.length ? undefinedTokens.join(", ") : `${used.length} token(s)`
  );
  check(
    "S9.5 the document pulls in the frozen stylesheet, not a rebuild",
    /<link[^>]*href="\.\.\/prototype\/tw\.css"/.test(html)
  );
  check(
    "S9.6 the vendored script is the only other dependency",
    /src="\.\.\/prototype\/vendor\/jquery\.slim\.min\.js"/.test(html) && !/(https?:)?\/\//.test((html.match(/<script[^>]*src="[^"]*"/g) || []).join("")) && !/(https?:)?\/\/cdn/.test(html)
  );
}

/* --- 10 · the document ------------------------------------------------ */
{
  const anchors = [...doc.matchAll(/[A-Za-z0-9_./-]+\.(?:md|mjs|js|html|css):\d+/g)].map((m) => m[0]);
  check("S10.1 DESIGN-activity.md carries no line-number anchor", anchors.length === 0, anchors.slice(0, 3).join(", "));
  check(
    "S10.2 DESIGN-activity.md states the §⑫ sync verdict",
    doc.includes("⑫") && /不触发|不改|判定/.test(doc)
  );
  check(
    "S10.3 DESIGN-activity.md lists the full block list",
    ["B26", "B26.1", "B26.2", "B26.3", "B26.4", "B26.5", "B26.6"].every((b) => doc.includes(b))
  );
  check(
    "S10.4 DESIGN-activity.md carries the allow-list, not adjectives",
    doc.includes("allow-list") || doc.includes("准入")
  );
  check(
    "S10.5 DESIGN-activity.md carries the en/zh table",
    doc.includes("activity.verb.created") && doc.includes("创建了")
  );
  check(
    "S10.6 the doc declares the boundary (no product implementation)",
    /不写实现|不碰|写面/.test(doc)
  );
}

/* --- 11 · the empty states, read B12's way -----------------------------
   Board B12 is the reference the card names: the brand mark first, the
   large size, the buttons the state actually has, and the block at the top
   of its container. The board's own copy is `design/prototype/index.html`,
   so the two rules the family shares are read off `tw.css` — the file both
   pages load — while the page's own scoped copy is read off the document. */
{
  const empties = startTags(html).filter((t) => t.attrs["data-activity-empty"] !== undefined);
  const project = empties.find((t) => t.attrs["data-activity-empty-kind"] === "project");
  const filter = empties.find((t) => t.attrs["data-activity-empty-kind"] === "filter");

  const kids = { project: project && firstChildTag(html, project), filter: filter && firstChildTag(html, filter) };
  const isMark = (tag) =>
    tag !== null && tag !== undefined && tag.name === "svg" &&
    classSet(tag).has("td-logo") && classSet(tag).has("td-logo-lg");
  check(
    "S11.1 both empty states open on the brand mark (svg.td-logo.td-logo-lg)",
    isMark(kids.project) && isMark(kids.filter),
    `project: ${kids.project ? kids.project.raw : "none"} · filter: ${kids.filter ? kids.filter.raw : "none"}`
  );

  check(
    "S11.2 both empty states are the large size (td-empty-lg)",
    classSet(project).has("td-empty-lg") && classSet(filter).has("td-empty-lg"),
    `project: "${project && project.attrs.class}" · filter: "${filter && filter.attrs.class}"`
  );

  /* The pair is the point: the project state has no filter in force, so it
     must not offer a control that clears one. */
  const blockOf = (source, tag) => (tag ? source.slice(tag.index, source.indexOf("</div>", tag.index)) : "");
  const projectBlock = blockOf(html, project);
  const filterBlock = blockOf(html, filter);
  check(
    "S11.3 the project empty carries no [data-activity-empty-reset]",
    projectBlock.length > 0 && !projectBlock.includes("data-activity-empty-reset")
  );
  check(
    "S11.4 the filter empty carries [data-activity-empty-reset] (and the contrast holds)",
    filterBlock.includes("data-activity-empty-reset") && !projectBlock.includes("data-activity-empty-reset")
  );

  /* A mask is addressed by id, so a repeated id silently re-points every
     reference at the last one declared — B12's comment states the rule and
     this measures it. */
  const maskIds = [...html.matchAll(/mask\s+id="([^"]+)"/g)].map((m) => m[1]);
  const dupeIds = maskIds.filter((id, i) => maskIds.indexOf(id) !== i);
  check(
    "S11.5 every mask id in the document is unique",
    maskIds.length === 3 && dupeIds.length === 0,
    `${maskIds.length} mask(s): ${maskIds.join(", ")}${dupeIds.length ? ` · repeated: ${dupeIds.join(", ")}` : ""}`
  );
  const refs = [...html.matchAll(/url\(#(face-[^)]+)\)/g)].map((m) => m[1]);
  const dangling = refs.filter((id) => !maskIds.includes(id));
  check(
    "S11.6 every mask reference resolves to a declared id",
    refs.length === 3 && dangling.length === 0,
    `refs: ${[...new Set(refs)].join(", ")}${dangling.length ? ` · dangling: ${dangling.join(", ")}` : ""}`
  );

  /* The rules themselves: the vertical centring the card withdrew must be
     gone from the page's scoped copy *and* from the stylesheet the board
     reads, and the block must be the large one on both sides.

     These three are *declaration* guards, and they are only that: they read
     one rule body's text, so a centring device that arrives from another rule
     (an override, a `justify-content` on the container) leaves them green.
     The placement itself is read after layout — `R9.*.flow-gap` and
     `R9.*.not-v-centred` below, and `DESIGN-activity.md` §11.1. */
  const scoped = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || ["", ""])[1];
  const scopedRule = ruleBody(scoped, ".td-activity-empty") || "";
  check(
    "S11.7 the page's scoped .td-activity-empty declares no centring",
    scopedRule.length > 0 && !/auto\s*;/.test(scopedRule) && !/align-self/.test(scopedRule) && /margin:\s*0 12px/.test(scopedRule),
    scopedRule.replace(/\s+/g, " ").trim()
  );

  const tw = readFileSync(TW_CSS_PATH, "utf8");
  const boardActivity = ruleBody(tw, ".td-activity-empty") || "";
  const boardWaiting = ruleBody(tw, ".td-waiting-empty") || "";
  check(
    "S11.8 tw.css's .td-activity-empty declares no centring",
    boardActivity.length > 0 && !/auto\s*;/.test(boardActivity) && !/align-self/.test(boardActivity) && /margin:\s*0 12px/.test(boardActivity),
    boardActivity.replace(/\s+/g, " ").trim()
  );
  check(
    "S11.9 tw.css's .td-waiting-empty drops align-self and keeps only horizontal auto margins",
    boardWaiting.length > 0 && !/align-self/.test(boardWaiting) &&
      /margin:\s*0 auto/.test(boardWaiting) && /max-width:\s*420px/.test(boardWaiting),
    boardWaiting.replace(/\s+/g, " ").trim()
  );

  /* The waiting state is B27's, and it lives on the board page — its block
     is read there, so the family's own check does not stop at this page. */
  const board = readFileSync(join(DESIGN, "prototype", "index.html"), "utf8");
  const waiting = startTags(board).find((t) => t.attrs["data-waiting-empty"] !== undefined);
  check("S11.10 the board's [data-waiting-empty] exists", !!waiting);
  if (waiting) {
    const kid = firstChildTag(board, waiting);
    check(
      "S11.11 the waiting empty opens on the brand mark and is the large size",
      isMark(kid) && classSet(waiting).has("td-empty-lg"),
      `${kid ? kid.raw : "none"} · class "${waiting.attrs.class}"`
    );
    const waitingBlock = blockOf(board, waiting);
    check(
      "S11.12 the waiting empty carries a hint and no button",
      /class="td-empty-hint"[^>]*data-i18n="waiting\.empty\.hint"/.test(waitingBlock) &&
        !/<button/.test(waitingBlock),
      waitingBlock.match(/data-i18n="waiting\.empty[^"]*"/g).join(", ")
    );
    const maskIds2 = [...board.matchAll(/mask\s+id="([^"]+)"/g)].map((m) => m[1]);
    const dupeIds2 = maskIds2.filter((id, i) => maskIds2.indexOf(id) !== i);
    check(
      "S11.13 the board's mask ids are unique",
      dupeIds2.length === 0,
      `${maskIds2.length} mask(s): ${maskIds2.join(", ")}`
    );
  }
}

/* =====================================================================
   RENDER SUITE
   ===================================================================== */

/** The Chromium browser type, or null when Playwright is not reachable. */
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
  const base = `http://127.0.0.1:${port}/activity/prototype.html`;
  const browser = await chromium.launch();

  try {
    /* -- R1 · the wide reading, plus the console/pageerror hard gate ----- */
    let page = await browser.newPage({ viewport: { width: 1512, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.tdActivity);

    check("R1.1 no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
    check("R1.2 no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

    const boot = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-activity-row]")];
      const visible = rows.filter((r) => !r.hidden);
      return {
        days: document.querySelectorAll("[data-activity-day]").length,
        rows: rows.length,
        visible: visible.length,
        count: document.querySelector("[data-activity-filter-count]").textContent.trim(),
        unread: document.querySelectorAll("[data-activity-row][data-activity-unread]").length,
        pill: document.querySelector('[data-nav-count="activity"]').textContent.trim(),
        pillHidden: document.querySelector('[data-nav-count="activity"]').hidden,
        dividerHidden: document.querySelector("[data-activity-unread-divider]").hidden,
        emptyVisible: [...document.querySelectorAll("[data-activity-empty]")].filter((e) => !e.hidden).length,
        times: [...document.querySelectorAll("[data-activity-at]")].slice(0, 3).map((t) => t.textContent.trim()),
        navCurrent: document.querySelectorAll('[data-nav] [data-nav-item][aria-current="page"]').length,
        navCurrentIsActivity: document.querySelector('[data-nav] [data-nav-item][aria-current="page"]')?.getAttribute("data-nav-item"),
      };
    });

    check("R1.3 the feed boots with visible rows", boot.visible === 15, `${boot.visible} visible of ${boot.rows} row(s)`);
    check("R1.4 the count reports the visible rows", boot.count === `${boot.visible} entries`, `"${boot.count}"`);
    check("R1.5 the sidebar pill reports the unread rows", boot.pill === String(boot.unread) && !boot.pillHidden, `${boot.pill} · unread ${boot.unread}`);
    check("R1.6 the unread divider is up", !boot.dividerHidden);
    check("R1.7 no empty state is up", boot.emptyVisible === 0);
    check("R1.8 the script-only empty states stay hidden", boot.emptyVisible === 0);
    check("R1.9 relative times are the reference instant's", boot.times[0] === "9m ago" && boot.times[2] === "39m ago", boot.times.join(" | "));
    check("R1.10 exactly one nav item is current, and it is activity", boot.navCurrent === 1 && boot.navCurrentIsActivity === "activity");

    /* -- R2 · filters ---------------------------------------------------- */
    const agents = await page.evaluate(() => {
      const select = document.querySelector('[data-activity-filter="actor"]');
      select.value = "agent";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const rows = [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden);
      return {
        visible: rows.length,
        allAgents: rows.every((r) => r.getAttribute("data-assignee-kind") === "agent"),
        count: document.querySelector("[data-activity-filter-count]").textContent.trim(),
        hash: location.hash,
      };
    });
    check("R2.1 the actor filter narrows the feed", agents.visible > 0 && agents.visible < boot.visible, `${agents.visible} of ${boot.visible}`);
    check("R2.2 every surviving row is an agent", agents.allAgents);
    check("R2.3 the count follows the filter", agents.count === `${agents.visible} entries`, `"${agents.count}"`);
    check("R2.4 the filter state is in the URL hash", agents.hash === "#/activity?actor=agent", agents.hash);

    const empty = await page.evaluate(() => {
      /* Humans never filed a delivery report in this feed, so the pair
         matches nothing — the filter empty state, not the project one. */
      const actor = document.querySelector('[data-activity-filter="actor"]');
      actor.value = "human";
      actor.dispatchEvent(new Event("change", { bubbles: true }));
      const select = document.querySelector('[data-activity-filter="event"]');
      select.value = "delivery";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        visible: [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden).length,
        filterEmpty: !document.querySelector('[data-activity-empty][data-activity-empty-kind="filter"]').hidden,
        projectEmpty: !document.querySelector('[data-activity-empty][data-activity-empty-kind="project"]').hidden,
        dividerHidden: document.querySelector("[data-activity-unread-divider]").hidden,
        pillHidden: document.querySelector('[data-nav-count="activity"]').hidden,
        count: document.querySelector("[data-activity-filter-count]").textContent.trim(),
      };
    });
    check("R2.5 a filter that matches nothing shows the filter empty state", empty.visible === 0 && empty.filterEmpty);
    check("R2.6 the project empty state is not the one shown", empty.projectEmpty === false);
    check("R2.7 the divider and the pill stand down with the rows", empty.dividerHidden && empty.pillHidden);
    check("R2.8 the count reads zero", empty.count === "0 entries", `"${empty.count}"`);

    const reset = await page.evaluate(() => {
      document.querySelector("[data-activity-empty-reset]").click();
      return {
        visible: [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden).length,
        hash: location.hash,
        count: document.querySelector("[data-activity-filter-count]").textContent.trim(),
      };
    });
    check("R2.9 reset restores the full feed", reset.visible === boot.visible && reset.count === `${boot.visible} entries`, `${reset.visible} · "${reset.count}"`);
    check("R2.10 reset clears the hash", reset.hash === "#/activity", reset.hash);

    /* -- R3 · the unread boundary --------------------------------------- */
    const read = await page.evaluate(() => {
      document.querySelector("[data-activity-mark-read]").click();
      const pill = document.querySelector('[data-nav-count="activity"]');
      return {
        pillHidden: pill.hidden,
        pillText: pill.textContent.trim(),
        dividerHidden: document.querySelector("[data-activity-unread-divider]").hidden,
        marked: document.querySelectorAll("[data-activity-row][data-activity-unread]").length,
      };
    });
    check("R3.1 Mark all read clears the marker", read.marked === 0);
    check("R3.2 the pill hides itself at zero", read.pillHidden && read.pillText === "0");
    check("R3.3 the divider goes with it", read.dividerHidden);

    /* -- R4 · paging ----------------------------------------------------- */
    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.tdActivity);
    const paged = await page.evaluate(() => {
      const before = [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden).length;
      document.querySelector("[data-activity-more]").click();
      const after = [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden).length;
      return { before, after, footHidden: document.querySelector(".td-activity-foot").hidden };
    });
    check("R4.1 Load older reveals the next page", paged.after > paged.before, `${paged.before} → ${paged.after}`);
    check("R4.2 the button stands down once the log is spent", paged.footHidden);

    /* -- R5 · the drawer -------------------------------------------------- */
    const drawer = await page.evaluate(() => {
      const opened = window.tdActivity.openDrawer("TD-134");
      const el = document.querySelector("[data-detail-drawer]");
      return {
        opened,
        state: el.getAttribute("data-state"),
        id: document.querySelector("[data-detail-identifier]").textContent.trim(),
        title: document.querySelector("[data-detail-title]").textContent.trim(),
        rows: document.querySelectorAll("[data-detail-activity] .td-activity").length,
      };
    });
    check("R5.1 opening a row opens the detail drawer", drawer.opened && drawer.state === "open");
    check("R5.2 the drawer names the task it was opened from", drawer.id === "TD-134" && drawer.title.length > 0, `${drawer.id} · ${drawer.title}`);
    check("R5.3 the drawer shows that task's own history", drawer.rows >= 1, `${drawer.rows} row(s)`);

    const closed = await page.evaluate(() => {
      document.querySelector("[data-detail-close]").click();
      return document.querySelector("[data-detail-drawer]").getAttribute("data-state");
    });
    check("R5.4 the drawer closes", closed === "closed");

    /* -- R6 · language ---------------------------------------------------- */
    const zh = await page.evaluate(() => {
      window.tdActivity.setLang("zh");
      return {
        lang: document.documentElement.lang,
        title: document.querySelector("[data-activity-title]").textContent.trim(),
        count: document.querySelector("[data-activity-filter-count]").textContent.trim(),
        time: document.querySelector("[data-activity-at]").textContent.trim(),
        day: document.querySelector('[data-activity-day-kind="absolute"] time').textContent.trim(),
        titleAttr: document.querySelector(".td-brand-name").textContent.trim(),
      };
    });
    check("R6.1 switching language moves <html lang>", zh.lang === "zh-CN", zh.lang);
    check("R6.2 copy is translated, not left as a key", zh.title === "动态" && !/^activity\./.test(zh.title), zh.title);
    check("R6.3 the count sentence is translated", /条动态$/.test(zh.count), zh.count);
    check("R6.4 relative times are translated", /分钟前$/.test(zh.time), zh.time);
    check("R6.5 the absolute day heading is localised", /月/.test(zh.day), zh.day);
    check("R6.6 untranslated proper nouns survive", zh.titleAttr === "MeerkatTaskPanel");

    /* -- R6b · an empty project -------------------------------------------
       Driven through the DOM rather than through a filter: this is the state
       a brand-new project is in, and it is the one the filter empty state
       must not be confused with. */
    const bare = await page.evaluate(() => {
      document.querySelectorAll("[data-activity-row]").forEach((r) => r.remove());
      window.tdActivity.applyFilters();
      const kinds = [...document.querySelectorAll("[data-activity-empty]")];
      return {
        rows: document.querySelectorAll("[data-activity-row]").length,
        projectEmpty: kinds
          .filter((e) => e.getAttribute("data-activity-empty-kind") === "project")
          .every((e) => !e.hidden),
        filterEmpty: kinds
          .filter((e) => e.getAttribute("data-activity-empty-kind") === "filter")
          .some((e) => !e.hidden),
        footHidden: document.querySelector(".td-activity-foot").hidden,
      };
    });
    check("R6b.1 an empty project shows the project empty state, not the filter one", bare.rows === 0 && bare.projectEmpty && !bare.filterEmpty);
    check("R6b.2 an empty project offers no Load older", bare.footHidden);

    /* -- R9 · the empty-state family, read after layout ---------------------
       B12's reading is the family's: the block opens on the brand mark, the
       mark is the large one (28×28), and the block stands at the **top** of
       its container instead of being centred in it. The last of those three
       is a *layout* fact, and it is read here as geometry — off
       `getBoundingClientRect`, never off a declaration:

         flow-gap      the block's offset from its container's content top is
                       the flow's offset: give the container 240px more height
                       and the block does not move. A device that splits free
                       space — `margin: auto`, `justify-content: center`, a
                       `flex: 1` spacer — moves it by half the extra height.
         not-v-centred the free space is not split evenly around the block:
                       decisively more of it lies below than above. A *fixed*
                       post-layout offset (a set `top`, a spacer of set height)
                       is what this one catches, and it is the reading the
                       flow-gap probe cannot see.

       Why neither can be a declaration: `getComputedStyle` resolves an auto
       margin to its **used** px value, so a re-centred block still reports
       `marginTop !== "auto"`; and a container that centres its children leaves
       the child's own `margin` / `align-self` at `0px / auto`. Both devices
       are measured against this contract in `DESIGN-activity.md` §11.1.

       The board page is the page the shipped blocks live on — B26.5's two
       states and B27.3's one — so the family is read there at every width the
       design is drawn for, plus once on this page, whose two states are the
       family's origin. */
    const MEASURE_EMPTY = `(el) => {
      const read = () => {
        const host = el.parentElement;
        const hcs = getComputedStyle(host);
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const hbox = host.getBoundingClientRect();
        const padTop = parseFloat(hcs.paddingTop) || 0;
        const padBottom = parseFloat(hcs.paddingBottom) || 0;
        const mark = el.firstElementChild;
        const mcs = mark ? getComputedStyle(mark) : null;
        /* The waiting view's own header, when there is one — the block has to
           come after it, not be pushed to the top over it. */
        const head = host.querySelector("[data-waiting-head]");
        return {
          gapAbove: Math.round((box.top - (hbox.top + padTop)) * 100) / 100,
          gapBelow: Math.round((hbox.bottom - padBottom - box.bottom) * 100) / 100,
          blockHeight: Math.round(box.height * 100) / 100,
          hostHeight: Math.round(hbox.height * 100) / 100,
          headHeight: head ? Math.round(head.getBoundingClientRect().height * 100) / 100 : 0,
          marginTop: cs.marginTop,
          marginBottom: cs.marginBottom,
          alignSelf: cs.alignSelf,
          isSvg: !!mark && mark.tagName.toLowerCase() === "svg",
          markClasses: mark ? mark.getAttribute("class") : null,
          markSize: mcs ? mcs.width + " / " + mcs.height : null,
        };
      };
      const natural = read();
      /* The flow-gap probe: 240px of free space, then the offset again. */
      const host = el.parentElement;
      const was = host.style.minHeight;
      host.style.minHeight = host.getBoundingClientRect().height + 240 + "px";
      const tall = read();
      host.style.minHeight = was;
      return { natural, tall, shift: Math.round((tall.gapAbove - natural.gapAbove) * 100) / 100 };
    }`;
    const reachKind = (kind) => `() => {
      const kinds = [...document.querySelectorAll("[data-activity-empty]")];
      kinds.forEach((e) => { e.hidden = true; });
      const el = kinds.find((e) => e.getAttribute("data-activity-empty-kind") === ${JSON.stringify(kind)});
      el.hidden = false;
      return el;
    }`;
    const REACH_WAITING = `() => {
      document.querySelector("[data-waiting-list]").hidden = true;
      const el = document.querySelector("[data-waiting-empty]");
      el.hidden = false;
      return el;
    }`;
    const measureEmpty = async (p, reach) => {
      const handle = await p.evaluateHandle(eval(reach));
      const m = await p.evaluate(eval(MEASURE_EMPTY), handle);
      await handle.dispose();
      return m;
    };
    const checkMark = (id, m) => {
      const n = m.natural;
      check(
        `${id} the empty state opens on the 28×28 brand mark`,
        n.isSvg && /(^|\s)td-logo(\s|$)/.test(n.markClasses) && /(^|\s)td-logo-lg(\s|$)/.test(n.markClasses) && n.markSize === "28px / 28px",
        `${n.markClasses} · ${n.markSize}`
      );
    };
    const checkPlacement = (where, state, m) => {
      const n = m.natural;
      check(
        `R9.${where}.${state}.flow-gap the empty state stands in the flow at the top`,
        m.shift <= 2,
        `+240px of container height moves it ${m.shift}px (top offset ${n.gapAbove}px of ${n.hostHeight}px; a centred block moves 120px)`
      );
      check(
        `R9.${where}.${state}.not-v-centred the empty state is not vertically centred`,
        n.gapBelow - n.gapAbove >= 8,
        `${n.gapAbove}px above / ${n.gapBelow}px below (centred would be even; declared margin ${n.marginTop}/${n.marginBottom}, align-self ${n.alignSelf})`
      );
      /* B27's view has a header above the block, and the reading that used to
         carry "the block stands at the top of the view, under the header"
         carried this clause too: the flow's first stop is the header, so the
         block comes after it and immediately after it. */
      if (n.headHeight > 0) {
        check(
          `R9.${where}.${state}.under-header the empty state stands under the queue's header`,
          n.gapAbove >= n.headHeight && n.gapAbove <= n.headHeight + 32,
          `${n.gapAbove}px above the block, header ${n.headHeight}px (head + gap is the flow's own offset)`
        );
      }
    };

    await page.evaluate(() => window.tdActivity.setLang("en"));
    for (const kind of ["project", "filter"]) {
      const m = await measureEmpty(page, reachKind(kind));
      checkPlacement("page", kind, m);
      checkMark(`R9.page.${kind}.mark`, m);
    }

    for (const vp of VIEWPORTS) {
      const boardPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const boardErrors = [];
      boardPage.on("console", (m) => {
        if (m.type() === "error") boardErrors.push(m.text());
      });
      boardPage.on("pageerror", (e) => boardErrors.push(String(e)));
      await boardPage.goto(`http://127.0.0.1:${port}/prototype/index.html`, { waitUntil: "load" });
      await boardPage.evaluate(() => document.querySelector('[data-nav-item="activity"]').click());
      await boardPage.waitForFunction(() => !document.querySelector("[data-activity-view]").hidden);
      /* The feed's rows go: the empty state is what is left of the view, the
         same way B26.5's project reading empties it. */
      await boardPage.evaluate(() => document.querySelectorAll("[data-activity-row]").forEach((r) => r.remove()));
      for (const kind of ["project", "filter"]) {
        const m = await measureEmpty(boardPage, reachKind(kind));
        checkPlacement(`board.${vp.label}`, kind, m);
        if (vp.width === 1512) checkMark(`R9.board.1512.${kind}.mark`, m);
      }
      /* B27.3: the queue stands down and the empty state comes up in its
         place — the two attributes are the state. */
      await boardPage.evaluate(() => document.querySelector('[data-nav-item="waiting"]').click());
      await boardPage.waitForFunction(() => !document.querySelector("[data-waiting-view]").hidden);
      const waiting = await measureEmpty(boardPage, REACH_WAITING);
      checkPlacement(`board.${vp.label}`, "waiting", waiting);
      if (vp.width === 1512) checkMark("R9.board.1512.waiting.mark", waiting);
      check(`R9.board.${vp.label}.clean the board page is clean`, boardErrors.length === 0, boardErrors.slice(0, 2).join(" | "));
      await boardPage.close();
    }

    await page.close();

    /* -- R7 · the breakpoints --------------------------------------------- */
    for (const vp of VIEWPORTS) {
      const vpage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const errors = [];
      vpage.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      vpage.on("pageerror", (e) => errors.push(String(e)));
      await vpage.goto(base, { waitUntil: "load" });
      await vpage.waitForFunction(() => !!window.tdActivity);
      const metrics = await vpage.evaluate(() => {
        const de = document.documentElement;
        const overflowing = [...document.querySelectorAll("[data-activity-view] *")]
          .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
          .slice(0, 3)
          .map((el) => el.className || el.tagName);
        return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflowing };
      });
      check(
        `R7.${vp.label} no horizontal overflow at ${vp.label}px`,
        near(metrics.scrollWidth, metrics.clientWidth) && metrics.overflowing.length === 0,
        `scrollWidth ${metrics.scrollWidth} vs ${metrics.clientWidth}${metrics.overflowing.length ? " · " + metrics.overflowing.join(", ") : ""}`
      );
      check(`R7.${vp.label}b no console errors at ${vp.label}px`, errors.length === 0, errors.slice(0, 2).join(" | "));

      await vpage.close();
    }

    /* -- R8 · the JS-off floor, verified in a browser --------------------- */
    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1512, height: 900 } });
    const noJsPage = await noJs.newPage();
    await noJsPage.goto(base, { waitUntil: "load" });
    const floor = await noJsPage.evaluate(() => ({
      days: document.querySelectorAll("[data-activity-day]").length,
      rows: [...document.querySelectorAll("[data-activity-row]")].filter((r) => !r.hidden).length,
      ids: document.querySelectorAll("[data-activity-task-id]").length,
      times: document.querySelectorAll("[data-activity-at]").length,
      details: document.querySelectorAll("[data-activity-detail]").length,
      pill: document.querySelector('[data-nav-count="activity"]').textContent.trim(),
    }));
    check("R8.1 the day groups render with the script off", floor.days >= 3, `${floor.days} day group(s)`);
    check("R8.2 the rows render with the script off", floor.rows >= 15, `${floor.rows} row(s)`);
    check("R8.3 identifiers and times render with the script off", floor.ids === floor.rows && floor.times === floor.rows);
    check("R8.4 the <details> disclosure renders with the script off", floor.details === floor.rows);
    check("R8.5 the unread pill renders with the script off", floor.pill === "4", floor.pill);
    await noJs.close();
  } finally {
    await browser.close();
    server.close();
  }
}

/* ---------------------------------------------------------- screenshots */

/* The named capture set of DESIGN-activity.md §渲染证据. Kept here rather
   than in a second file so the deliverable list stays what the spec names.

   `01-current-board-1512.png` and `02-current-activity-click-noop.png` are
   NOT produced here: they are the upstream diagnostic evidence of the
   *current* build, archived verbatim from the task workspace. Re-shooting
   them would mean re-shooting a running board this proposal does not touch,
   which would make them a claim about something other than what they
   document. */
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
  const base = `http://127.0.0.1:${port}/activity/prototype.html`;
  const browser = await chromium.launch();
  const freeze = "*, *::before, *::after { transition: none !important; animation: none !important; }";

  const shoot = async (file, opts) => {
    const context = await browser.newContext({
      viewport: opts.viewport,
      javaScriptEnabled: opts.js !== false,
      colorScheme: opts.colorScheme || "light",
    });
    const p = await context.newPage();
    await p.goto(opts.url || base, { waitUntil: "load" });
    if (opts.js !== false) {
      await p.waitForFunction(() => !!window.tdActivity);
      /* `addStyleTag` drives the page through script evaluation, which a
         `javaScriptEnabled: false` context does not have — it never
         settles. Without a script nothing animates here anyway. */
      await p.addStyleTag({ content: freeze });
    }
    if (opts.act) await opts.act(p);
    await p.waitForTimeout(120);
    await p.screenshot({ path: join(SHOTS_DIR, file) });
    process.stdout.write(`shot ${file}\n`);
    await context.close();
  };

  await shoot("10-activity-1512.png", { viewport: { width: 1512, height: 900 } });
  await shoot("11-activity-1240.png", { viewport: { width: 1240, height: 900 } });
  await shoot("12-activity-980.png", { viewport: { width: 980, height: 900 } });
  await shoot("13-activity-760.png", { viewport: { width: 760, height: 900 } });
  await shoot("14-activity-430.png", { viewport: { width: 430, height: 900 } });
  await shoot("20-activity-dark.png", { viewport: { width: 1512, height: 900 }, colorScheme: "dark", url: `${base}?theme=dark` });
  await shoot("21-activity-zh.png", { viewport: { width: 1512, height: 900 }, url: `${base}?lang=zh` });
  await shoot("22-activity-nojs.png", { viewport: { width: 1512, height: 900 }, js: false });
  await shoot("23-activity-empty.png", {
    viewport: { width: 1512, height: 900 },
    act: (p) => p.evaluate(() => {
      document.querySelectorAll("[data-activity-row]").forEach((r) => r.remove());
      window.tdActivity.applyFilters();
    }),
  });
  await shoot("24-activity-filter-empty.png", {
    viewport: { width: 1512, height: 900 },
    act: (p) => p.evaluate(() => {
      const actor = document.querySelector('[data-activity-filter="actor"]');
      actor.value = "human";
      actor.dispatchEvent(new Event("change", { bubbles: true }));
      const event = document.querySelector('[data-activity-filter="event"]');
      event.value = "delivery";
      event.dispatchEvent(new Event("change", { bubbles: true }));
    }),
  });
  await shoot("25-activity-burst.png", {
    viewport: { width: 1512, height: 900 },
    act: (p) => p.evaluate(() => {
      const burst = document.querySelector("[data-activity-burst] [data-activity-detail]");
      burst.open = true;
      burst.scrollIntoView({ block: "center" });
    }),
  });
  await shoot("26-activity-drawer.png", {
    viewport: { width: 1512, height: 900 },
    act: (p) => p.evaluate(() => window.tdActivity.openDrawer("TD-134")),
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
  }\n`
);
process.exitCode = failed.length ? 1 : 0;
