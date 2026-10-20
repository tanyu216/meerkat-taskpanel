#!/usr/bin/env node
/**
 * C-RAIL-2 · the rail chip's overflow — the browser leg the contract requires.
 *
 * `design/contracts/rail-chip-overflow.md` §7 lists D1–D7 as assertions the
 * **implementation card must bring itself**, and §7 note 1 says why: every
 * existing gate is blind to this defect. There is no chip-box rule anywhere —
 * the prototype-comparison manifests carried none (a `grep side-icon` over them
 * hit one prose string),
 * `blocks.contract.mjs` pins a single `count … equals: 0` about the hook, and
 * `docOverflow` is `{0,0}` both before and after the breakage, so dom-smoke's
 * viewport rule never fires. A green suite therefore says nothing about this
 * contract, and this script is the only thing that does.
 *
 * **What "drawn text" means here, and why it is not circular.** The chip's own
 * `getBoundingClientRect()` is 24×24 whether or not its contents spill out of
 * it, so the element box cannot report the defect; the text's line boxes come
 * from `Range.getClientRects()`, which is what §7 note 4 prescribes. What
 * *paints* is then the intersection of those line boxes with the chip's border
 * box **when the chip clips**, and the raw line boxes when it does not — which
 * is exactly the difference the bug is made of: the baseline draws four 15px
 * lines out of a 24px box, upward into one neighbour's row and downward into
 * the other's, and also gives the rail 15–23px of horizontal scroll. D2 is the
 * clip-independent half of that (the rail's own `scrollWidth`), and it is
 * reported next to D1 so a red can be read without trusting either one alone.
 *
 * **D8 is this card's half, not the contract's.** §7 lists D1–D7. The a11y
 * reading this script has always taken was recorded and deliberately left
 * *unasserted*: it was the design confirmation's unmet gate ②
 * (`workspace/T-20261015-050446/review/design-confirmation.md` §4), a known gap
 * owned by a card of its own. That card is `T-20261015-055434`, so the reading
 * becomes an assertion here rather than in a second script that would have to
 * rebuild the same two engines to ask the same question: at every measured width
 * the project row's computed accessible name must be non-empty **and** name the
 * project. D1–D7 are untouched by it.
 *
 * **Two engines, one assertion set.** The `taskd` engine runs the real thing —
 * a real `createTaskd` over a scratch SQLite board seeded through the real
 * `createProject`, whose 36-character legacy prefix is produced by the real
 * `projectPrefix` fallback, not by a fixture. The `fixture` engine runs the
 * same `web/dist` through the fixture harness `dom-smoke.mjs` provides, with the
 * same token (derived by the same real function)
 * injected into that harness's payload, so the leg also runs where a database
 * is not wanted. `--engine both` (default) reports both; the assertions are
 * identical and neither is skipped silently.
 *
 * **D5 without a stored baseline.** "No regression for a ≤3-character prefix"
 * is a *pixel* claim, so it is checked in pixels: the chip is photographed, then
 * the containment is removed on **that one element** with an inline
 * `overflow: visible`, and it is photographed again. Since the whole fix is the
 * two declarations this leg's contract added to the chip's rule, the second
 * frame *is* the pre-fix paint — so the comparison needs no golden image, no
 * second checkout and no stored hash. It is also what tells the two candidate
 * mechanisms apart: `overflow: hidden` clips at the padding box, where the
 * chip's 1px border leaves 22px, so a 3-character prefix (23.48px) loses 0.74px
 * off each end and the hashes differ; `overflow: clip; overflow-clip-margin:
 * border-box` puts the clip edge on the 24px box itself and they match.
 *
 * Usage: node web/scripts/rail-chip-overflow.mjs [options]
 *   --json <path>       write the full artifact (default: stdout summary only)
 *   --shots <dir>       write a per-viewport PNG of the rail
 *   --engine <name>     taskd | fixture | both            (default both)
 *   --theme <mode>      light | dark | auto               (default light)
 *   --lang <code>       en | zh                           (default en)
 *   --port <n>          force a port for the taskd engine (default: ephemeral)
 *
 * Exit: 0 every assertion holds (D1–D7 + D8); 1 at least one failed; 2 the leg
 *       could not run
 * (no Playwright, no `web/dist`).
 *
 * Host-side on purpose: `docs/docker.md` §Host-allowed-checks keeps
 * browser-rendered frontend checks on the host because the image carries no
 * Chromium. No `npm install` is performed — Playwright is resolved if present.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const ROOT = resolve(WEB, "..");
const DIST = join(WEB, "dist");

/* ------------------------------------------------------------------ argv */

const argv = process.argv.slice(2);
const opt = { engine: "both", theme: "light", lang: "en", json: null, shots: null, port: 0 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = (name) => (a.startsWith(`${name}=`) ? a.slice(name.length + 1) : argv[++i]);
  if (a === "--json" || a.startsWith("--json=")) opt.json = resolve(take("--json"));
  else if (a === "--shots" || a.startsWith("--shots=")) opt.shots = resolve(take("--shots"));
  else if (a === "--engine" || a.startsWith("--engine=")) opt.engine = take("--engine");
  else if (a === "--theme" || a.startsWith("--theme=")) opt.theme = take("--theme");
  else if (a === "--lang" || a.startsWith("--lang=")) opt.lang = take("--lang");
  else if (a === "--port" || a.startsWith("--port=")) opt.port = Number(take("--port"));
  else {
    process.stderr.write(`unknown argument: ${a}\n`);
    process.exit(2);
  }
}
if (!["taskd", "fixture", "both"].includes(opt.engine)) {
  process.stderr.write(`--engine must be taskd|fixture|both, got ${JSON.stringify(opt.engine)}\n`);
  process.exit(2);
}
if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) {
  process.stderr.write(`--port must be 0-65535, got ${JSON.stringify(opt.port)}\n`);
  process.exit(2);
}

if (!existsSync(join(DIST, "index.html"))) {
  process.stderr.write(`no build at ${DIST} — run \`npm --prefix web run build\` first (the leg asserts the shipped artifact, not the sources)\n`);
  process.exit(2);
}

const { startServer, resolvePlaywright } = await import("./dom-smoke.mjs");
const playwright = resolvePlaywright();
if (!playwright) {
  process.stderr.write("Playwright is not installed on this host — `resolvePlaywright()` found nothing\n");
  process.exit(2);
}

/* ------------------------------------------------------------- the population */

/** The UUID-shaped project id the legacy case is named after. */
const LEGACY_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
/** A 36-character id with no separator at all — no break opportunity in its prefix. */
const SOLID_ID = "f".repeat(36);

/**
 * Both engines carry the *same* tokens, and neither copies them by hand: they
 * are what `identifierPrefix` makes of the two ids — the real fallback C-PREFIX-1
 * M3 applies to a project that was created before the prefix slot existed.
 *
 * Two shapes, because they break differently and only one of them wraps
 * (C-RAIL-2 §2.3): a hyphenated token wraps into four 15px lines, and a solid
 * (break-opportunity-free) one never wraps at all — it leaves the box as a
 * single 281.77px line, which is the worst case for the rail's inline box and
 * therefore for P2. A leg that only measured the wrapping shape would be testing
 * the easier half.
 */
const { identifierPrefix } = await import(resolve(ROOT, "src/foundation/ids.mjs"));
const LEGACY_TEXT = identifierPrefix(LEGACY_ID);
const SOLID_TEXT = identifierPrefix(SOLID_ID);

/* The rail viewports the ruling measured at (980 / 760 / 500 — the 64px rail,
 * and the 56px one under 560px), plus both sides of the breakpoint P4 turns on:
 * 1023 draws the chip, 1024 must not, and 1512 is the desktop board. */
const VIEWPORTS = [980, 760, 500, 1023, 1024, 1512];
const RAIL_MAX = 1023;

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

/* ------------------------------------------------------------------ the probe */

/**
 * Read one rail state. Runs **inside the page**; everything it needs is local.
 *
 * `getClientRects()` on a Range is the only way to see a *text block* — the
 * element's own rect still reports 24px and tells you nothing. `drawn` is what
 * survives the clip (or the raw line boxes when nothing clips), and every
 * assertion is stated against `drawn`, so a variant judged here is judged on
 * what a reader can see.
 */
function probe() {
  const ROW = "[data-project-list] [data-project]";
  /* Both hook vocabularies, so one probe reads the implementation
     (`data-side-icon`) and the prototype (`.td-side-icon`) — §7 note 4. */
  const CHIP = "[data-side-icon], .td-side-icon";
  const list = document.querySelector("[data-project-list]");
  const aside = document.querySelector("[data-sidebar]") ?? list?.closest("aside");
  const round = (n) => +n.toFixed(2);
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height) };
  };
  const inter = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const t = Math.min(a.y + a.h, b.y + b.h);
    if (r <= x || t <= y) return null;
    return { x: round(x), y: round(y), w: round(r - x), h: round(t - y) };
  };

  const rows = [...document.querySelectorAll(ROW)].map((row, index) => {
    const chip = row.querySelector(CHIP);
    const rb = box(row);
    if (!chip) return { index, project: row.getAttribute("data-project"), rowBox: rb, hasChip: false };
    const cb = box(chip);
    const cs = getComputedStyle(chip);
    const range = document.createRange();
    range.selectNodeContents(chip);
    const lines = [...range.getClientRects()]
      .filter((r) => r.width > 0 || r.height > 0)
      .map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }));
    const clipped = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const drawn = clipped ? lines.map((l) => inter(l, cb)).filter(Boolean) : lines;
    const union = lines.length
      ? {
          x: Math.min(...lines.map((l) => l.x)),
          right: Math.max(...lines.map((l) => l.x + l.w)),
          top: Math.min(...lines.map((l) => l.y)),
          bottom: Math.max(...lines.map((l) => l.y + l.h)),
        }
      : null;
    return {
      index,
      project: row.getAttribute("data-project"),
      hasChip: true,
      rowBox: rb,
      chipBox: cb,
      visible: cs.display !== "none",
      text: chip.textContent,
      textLen: chip.textContent.length,
      textNodes: chip.childNodes.length,
      title: chip.getAttribute("title"),
      style: {
        display: cs.display,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        overflowClipMargin: cs.overflowClipMargin,
        whiteSpace: cs.whiteSpace,
        textOverflow: cs.textOverflow,
        justifyContent: cs.justifyContent,
        width: cs.width,
        height: cs.height,
      },
      lineCount: lines.length,
      lines,
      drawn,
      union: union
        ? {
            x: round(union.x),
            right: round(union.right),
            top: round(union.top),
            bottom: round(union.bottom),
            w: round(union.right - union.x),
            h: round(union.bottom - union.top),
          }
        : null,
      /** Nothing of the text is clipped away (D5's geometric half). */
      nothingClipped:
        clipped ? union !== null && drawn.length === lines.length && drawn.every((d, i) => d.w === lines[i].w && d.h === lines[i].h) : true,
      /** The text sits inside the chip's own border box horizontally. */
      unionInsideChipBox: union ? union.x >= cb.x - 0.01 && union.right <= cb.x + cb.w + 0.01 : null,
      /** Centre offset, in px: |left gap − right gap| inside the chip's box. */
      centring: union ? round(Math.abs(union.x - cb.x - (cb.x + cb.w - union.right))) : null,
      /** D1 · no drawn pixel leaves this row's own box. */
      escapesOwnRow: drawn.some((d) => d.x < rb.x - 0.5 || d.x + d.w > rb.x + rb.w + 0.5 || d.y < rb.y - 0.5 || d.y + d.h > rb.y + rb.h + 0.5),
      escapesRailX: null,
    };
  });

  const asideBox = aside ? box(aside) : null;
  for (const r of rows) {
    r.overlapsOtherRows = rows
      .filter((o) => o !== r && o.hasChip)
      .filter((o) =>
        r.drawn.some((d) => d.y < o.rowBox.y + o.rowBox.h && d.y + d.h > o.rowBox.y && d.x < o.rowBox.x + o.rowBox.w && d.x + d.w > o.rowBox.x),
      )
      .map((o) => o.project);
    if (asideBox) r.escapesRailX = r.drawn.some((d) => d.x < asideBox.x - 0.5 || d.x + d.w > asideBox.x + asideBox.w + 0.5);
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    railWidth: aside ? getComputedStyle(aside).width : null,
    aside: aside
      ? {
          box: asideBox,
          overflow: getComputedStyle(aside).overflow,
          clientW: aside.clientWidth,
          scrollW: aside.scrollWidth,
          innerScrollX: aside.scrollWidth - aside.clientWidth,
        }
      : null,
    docOverflow: {
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    },
    rows,
  };
}

/* ------------------------------------------------------------------ engines */

/** The fixture harness `dom-smoke.mjs` provides, with the long token injected. */
async function startFixtureEngine() {
  const { server, port, data } = await startServer();
  const like = (p, id, name, prefix) => ({ ...structuredClone(p), id, name, prefix, task_count: 0 });
  // The fixture's three rows are the prototype's seeds (TD / ORC / SR — 2, 3
  // and 2 characters, which is exactly what D5 must not regress). The wrapping
  // token goes in the **middle** so it has a row above *and* below it — the
  // baseline's harm was that it painted over both — and the solid one sits next
  // to it so the leg measures the shape that never wraps.
  const [p1, p2, p3] = data.projects;
  const legacyRow = like(p2, "p-hardcase", "Zulu Legacy Importer", LEGACY_TEXT);
  const solidRow = like(p2, "p-solid", "Victor Solid Token", SOLID_TEXT);
  data.projects = [p1, p2, legacyRow, solidRow, p3];
  data.orderDebug = [
    ...data.orderDebug,
    { id: legacyRow.id, name: legacyRow.name, order: 3.5, total: 0.1, archived: false },
    { id: solidRow.id, name: solidRow.name, order: 3.6, total: 0.1, archived: false },
  ];
  return {
    name: "fixture",
    baseUrl: `http://127.0.0.1:${port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** The real thing: scratch SQLite, real use-cases, real `taskd`, real `web/dist`. */
async function startTaskdEngine() {
  const dir = join(tmpdir(), `rail-chip-overflow-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "board.sqlite");
  const dataDir = join(dir, "data");
  const env = { ...process.env, TASKD_DB: dbPath };

  const { openBoard } = await import(resolve(ROOT, "src/core/index.mjs"));
  const seed = await openBoard({ dataDir, dbPath, pointer: false, env });
  // Names order the rail. The 2- and 3-character prefixes are the factory-seed
  // shape D5 protects; the two 36-character rows come out of `projectPrefix`'s
  // real fallback, so this engine's values are the defect's real values and not
  // copies of the fixture's. Note that this engine's *row order* is the server's
  // own and is not pinned by this leg (see the report); that the long tokens sit
  // between short ones is guaranteed by the fixture engine, not here.
  for (const project of [
    { name: "MeerkatTaskPanel", meta: { prefix: "td" } },
    { name: "Orchestrator", meta: { prefix: "orc" } },
    { name: "Site Refresh", meta: { prefix: "sr" } },
    { id: LEGACY_ID, name: "Zulu Legacy Importer", meta: {} },
    { id: SOLID_ID, name: "Victor Solid Token", meta: {} },
  ]) {
    seed.commands.createProject(project);
  }
  await seed.close();

  const { createTaskd } = await import(resolve(ROOT, "src/server/index.mjs"));
  const taskd = await createTaskd({ host: "127.0.0.1", port: opt.port, dbPath, dataDir, env, staticDir: DIST });
  return {
    name: "taskd",
    baseUrl: `${taskd.url}/`,
    close: async () => {
      await taskd.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ pixels */

/** A 34×34 crop centred on the chip's box — the box is 24×24 and does not move (P4). */
function pixelClip(box) {
  return { x: Math.round(box.x + box.w / 2 - 17), y: Math.round(box.y + box.h / 2 - 17), width: 34, height: 34 };
}

/* ------------------------------------------------------------------ the run */

/**
 * Drive one engine and return `{ assertions, viewports, wire, a11y }`.
 *
 * Geometry and screenshot come from **one** `evaluate` + `screenshot` pair per
 * state: the rail is `overflow: auto`, so a sample taken while it settles reads
 * pre-settle row positions (§7 note 4 — the design card's own trap).
 */
async function runEngine(engine, failures) {
  const browser = await playwright.chromium.launch({ headless: true });
  const consoleErrors = [];
  const out = { engine: engine.name, baseUrl: engine.baseUrl, theme: opt.theme, lang: opt.lang, viewports: {}, wire: null, consoleErrors };

  const check = (id, ok, detail) => {
    if (!ok) failures.push({ engine: engine.name, id, detail });
    return { id, ok, detail };
  };
  /**
   * Run `fn` with the chip's containment lifted on **that one element**.
   *
   * Inline `overflow: visible` (and a zero clip margin) is exactly the pre-fix
   * paint: the whole of C-RAIL-2's implementation is the two declarations this
   * rule gained, so nothing else can be responsible for a difference. Only the
   * chip under test is touched, so a long neighbour stays contained and cannot
   * bleed into the crop.
   */
  const unconstrained = async (page, project, fn) => {
    const set = async (on) => {
      await page.evaluate(
        ({ project, on }) => {
          const row = [...document.querySelectorAll("[data-project-list] [data-project]")].find((el) => el.getAttribute("data-project") === project);
          const chip = row.querySelector("[data-side-icon], .td-side-icon");
          chip.style.overflow = on ? "visible" : "";
          chip.style.overflowClipMargin = on ? "0px" : "";
        },
        { project, on },
      );
      await page.waitForTimeout(150);
    };
    await set(true);
    const value = await fn();
    await set(false);
    return value;
  };

  try {
    // The wire the sidebar reads — compared verbatim against D3/D4. Fetched from
    // the same origin the page uses, so "the value in the DOM" and "the value on
    // the wire" are one server's answer.
    const res = await fetch(`${engine.baseUrl}api/v1/projects`);
    const body = await res.json();
    out.wire = { status: res.status, projects: (body.data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, prefix: p.prefix })) };
    const byName = new Map(out.wire.projects.map((p) => [p.name, p]));

    for (const width of VIEWPORTS) {
      const rail = width <= RAIL_MAX;
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 3 });
      // Theme and language are the app's own persisted prefs, set before the
      // first paint so the gate's screenshot comparison can hold them fixed.
      await context.addInitScript(
        ([theme, lang]) => {
          localStorage.setItem("meerkat-taskpanel.theme", theme);
          localStorage.setItem("meerkat-taskpanel.lang", lang);
        },
        [opt.theme, opt.lang],
      );
      const page = await context.newPage();
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${width}: ${m.text()}`));
      page.on("pageerror", (e) => consoleErrors.push(`${width}: pageerror: ${e.message}`));
      await page.goto(engine.baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-project-list] [data-project]", { timeout: 20000 });
      await page.waitForTimeout(700);

      const snap = await page.evaluate(probe);
      const assertions = [];
      const chips = snap.rows.filter((r) => r.hasChip);

      // D2 · the rail does not scroll in the inline direction.
      if (rail) {
        assertions.push(check("D2", Boolean(snap.aside) && snap.aside.innerScrollX === 0, `aside ${snap.aside?.clientW}/${snap.aside?.scrollW} innerScrollX=${snap.aside?.innerScrollX}`));
      }

      // D7 · the page's own overflow is untouched (rail containment may not be
      // bought with document-level containment).
      assertions.push(check("D7", snap.docOverflow.x === 0 && snap.docOverflow.y === 0, JSON.stringify(snap.docOverflow)));

      // D1 · drawn text stays in its own row and hits no neighbour.
      if (rail) {
        const escaped = chips.filter((r) => r.visible && (r.escapesOwnRow || r.overlapsOtherRows.length > 0 || r.escapesRailX));
        assertions.push(
          check(
            "D1",
            escaped.length === 0,
            escaped
              .map((r) => `${r.project}: lines=${r.lineCount} escapesOwnRow=${r.escapesOwnRow} escapesRailX=${r.escapesRailX} overlaps=${JSON.stringify(r.overlapsOtherRows)}`)
              .join("; ") || `${chips.length} chips: no drawn text leaves its own row`,
          ),
        );
      }

      // D3 · the value is verbatim and undeformed.
      const d3 = [];
      for (const r of chips) {
        const wire = byName.get(r.project);
        if (!wire) d3.push(`${r.project}: not on the wire`);
        else if (r.text !== wire.prefix) d3.push(`${r.project}: DOM ${JSON.stringify(r.text)} ≠ wire ${JSON.stringify(wire.prefix)}`);
        if (r.text.includes("…") || r.text.includes("...")) d3.push(`${r.project}: ellipsis in the value`);
        if (!r.text.length) d3.push(`${r.project}: empty chip`);
        if (r.textNodes !== 1) d3.push(`${r.project}: ${r.textNodes} child nodes (the value must be one text node)`);
        if (r.style.textOverflow === "ellipsis" && r.textLen > 3) d3.push(`${r.project}: text-overflow: ellipsis on an over-long value`);
      }
      assertions.push(check("D3", d3.length === 0, d3.join("; ") || `${chips.length} chips match the wire verbatim`));

      // D4 · P5 — the whole prefix is reachable through `title`.
      const d4 = [];
      for (const r of chips) {
        const wire = byName.get(r.project);
        if (!wire) d4.push(`${r.project}: not on the wire`);
        else if (r.title !== wire.prefix) d4.push(`${r.project}: title ${JSON.stringify(r.title)} ≠ wire ${JSON.stringify(wire.prefix)}`);
      }
      assertions.push(check("D4", d4.length === 0, d4.join("; ") || `${chips.length} chips carry title = the full prefix`));

      // D6 · ≥1024px there is no chip at all (B03 stays "rail only").
      if (!rail) {
        const drawn = chips.filter((r) => r.visible || r.lineCount > 0 || r.chipBox.w > 0 || r.chipBox.h > 0);
        assertions.push(
          check("D6", drawn.length === 0, drawn.map((r) => `${r.project}: display=${r.style.display} box=${JSON.stringify(r.chipBox)}`).join("; ") || `every chip is display:none (${chips.length} rows)`),
        );
      }

      // D5 · ≤3-character prefixes are untouched — geometry **and** pixels.
      let d5;
      if (rail) {
        const short = chips.filter((r) => r.visible && r.text.length <= 3);
        const geo = [];
        for (const r of short) {
          if (r.chipBox.w !== 24 || r.chipBox.h !== 24) geo.push(`${r.project}: box ${r.chipBox.w}×${r.chipBox.h}`);
          if (r.lineCount !== 1) geo.push(`${r.project}: ${r.lineCount} lines`);
          if (!r.nothingClipped) geo.push(`${r.project}: the clip removes part of the text`);
          if (!r.unionInsideChipBox) geo.push(`${r.project}: text leaves the chip's border box`);
          if (r.centring === null || r.centring > 0.5) geo.push(`${r.project}: off-centre by ${r.centring}px`);
        }
        const px = [];
        for (const r of short) {
          const clip = pixelClip(r.chipBox);
          const before = sha(await page.screenshot({ clip }));
          const after = await unconstrained(page, r.project, async () => sha(await page.screenshot({ clip })));
          if (before !== after) px.push(`${r.project} (${r.text}): ${before} → ${after}`);
        }
        d5 = { short: short.map((r) => r.project), geo, px };
        assertions.push(
          check("D5", geo.length === 0 && px.length === 0, [...geo, ...px.map((d) => `pixels differ without the containment: ${d}`)].join("; ") || `${short.length} ≤3-character chips: 24×24, one line, nothing clipped, centred, pixel-identical with the containment lifted`),
        );
      }

      // D1's non-vacuous half. D1 is stated over whatever chips are on the
      // board, so it would pass trivially if none of them were longer than its
      // box. This pins the other end: the population *does* contain an
      // over-long chip (its text box is wider than the 24px chip), and that
      // chip — the one the assertion is really about — keeps its own row.
      //
      // Deliberately not "the containment changed the pixels": C-RAIL-2 §3.1
      // leaves the mechanism free (clipping *or* a constrained content box), so
      // a legitimate fix need not live on this element's `overflow`. The
      // constrained/unconstrained frames are recorded as evidence below, not
      // asserted.
      let overLong = [];
      const longs = rail ? chips.filter((r) => r.visible && r.union && r.union.w > r.chipBox.w + 1) : [];
      for (const long of longs) {
        const clip = pixelClip(long.chipBox);
        const before = sha(await page.screenshot({ clip }));
        const after = await unconstrained(page, long.project, async () => sha(await page.screenshot({ clip })));
        overLong.push({ project: long.project, text: long.text, textLen: long.textLen, unionW: long.union.w, chipBox: long.chipBox, lineCount: long.lineCount, shaConstrained: before, shaUnconstrained: after });
      }
      if (longs.length) {
        const bad = longs.filter((r) => r.escapesOwnRow || r.overlapsOtherRows.length > 0 || r.escapesRailX);
        assertions.push(
          check(
            "D1-nonvacuous",
            bad.length === 0,
            longs.map((r) => `${r.project}: ${r.textLen} chars → text box ${r.union.w}px in a ${r.chipBox.w}px chip, ${r.lineCount} lines, escapesOwnRow=${r.escapesOwnRow} overlaps=${JSON.stringify(r.overlapsOtherRows)} escapesRailX=${r.escapesRailX}`).join("; "),
          ),
        );
      }

      /**
       * A per-chip crop of the rail as it *shipped*, recorded so the gate can
       * compare screenshots across viewports, themes and languages.
       *
       * Not an A/B against the pre-fix build: the baseline's rail carries a
       * horizontal scrollbar (that is D2's defect), which shifts every row, so
       * two runs across the fix differ in *every* crop — a whole-rail
       * before/after says nothing about the ≤3-character chips. The clean A/B is
       * D5's, taken in one page with the scrollbar held still.
       */
      const chipCrops = {};
      for (const r of chips.filter((c) => c.visible)) chipCrops[r.project] = sha(await page.screenshot({ clip: pixelClip(r.chipBox) }));

      out.viewports[width] = { ...snap, rail, assertions, d5: d5 ?? null, overLong, chipCrops };

      if (opt.shots && rail) {
        mkdirSync(opt.shots, { recursive: true });
        await page.screenshot({ path: join(opt.shots, `${engine.name}-rail-${width}.png`), clip: { x: 0, y: 150, width: 90, height: 330 } });
      }
      await context.close();
    }

    // Accessibility (acceptance ⑤): the chip is `aria-hidden`, so P5's `title`
    // reaches a pointer and not assistive technology. What the row's `<button>`
    // is *called* is therefore the whole question, and it is the browser's name
    // computation that answers it — not a reading of the markup.
    out.a11y = {};
    for (const width of [980, 1512]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(engine.baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-project-list] [data-project]", { timeout: 20000 });
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => {
        const walk = (el) => {
          if (el.nodeType === 3) return el.data;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || el.getAttribute("aria-hidden") === "true") return "";
          return [...el.childNodes].map(walk).join("");
        };
        return [...document.querySelectorAll("[data-project-list] [data-project]")].map((row) => ({
          project: row.getAttribute("data-project"),
          tag: row.tagName.toLowerCase(),
          chipAriaHidden: row.querySelector("[data-side-icon]")?.getAttribute("aria-hidden") ?? null,
          chipTitle: row.querySelector("[data-side-icon]")?.getAttribute("title") ?? null,
          chipDisplayed: row.querySelector("[data-side-icon]") ? getComputedStyle(row.querySelector("[data-side-icon]")).display !== "none" : null,
          nameByContents: walk(row).replace(/\s+/g, " ").trim(),
        }));
      });
      // Playwright's own computation, where this build has one.
      let snapshots = null;
      let source = "in-page walk (button contents)";
      let error = null;
      try {
        snapshots = [];
        for (const row of rows) snapshots.push(await page.locator(`[data-project-list] [data-project][data-project="${row.project}"]`).ariaSnapshot());
        source = "locator.ariaSnapshot()";
      } catch (err) {
        error = err.message;
      }

      // D8 · T-20261015-055434 — the row button's **computed** name is not empty,
      // and it names the project. This is the assertion §4 of the design
      // confirmation (`workspace/T-20261015-050446/review/design-confirmation.md`)
      // recorded as unmet and left to a card of its own: the chip is
      // `aria-hidden`, so its `title` (P5, the prefix) reaches a pointer, and the
      // rail drops every visible text node of the row, so name-from-contents
      // yields nothing at ≤1023px. The reading above is the browser's own name
      // computation — not a reading of the markup — which is why it can only be
      // asserted here.
      //
      // The claim is width-dependent on purpose and both halves are required:
      // ≤1023px the name must exist at all (it is the rail's only identity cue),
      // and at ≥1024px it must *still* contain the project name, because that is
      // the control reading acceptance ① compares against. Note what is **not**
      // asserted: the exact string. At ≥1024px the visible name and the count
      // both feed the name (`MeerkatTaskPanel 12`) while in the rail the row's
      // own `title` answers alone (`MeerkatTaskPanel`), so pinning one literal
      // would forbid the other — `includes(project)` is the invariant both share.
      rows.forEach((row, index) => {
        const snap = snapshots?.[index] ?? null;
        row.accessibleName = snap ? (/"(.*)"/.exec(snap)?.[1] ?? "") : row.nameByContents;
      });
      const unnamed = rows.filter((r) => !r.accessibleName.length);
      const misnamed = rows.filter((r) => r.accessibleName.length > 0 && !r.accessibleName.includes(r.project));
      const d8 =
        unnamed.length === 0 && misnamed.length === 0
          ? `${rows.length} rows: ${width <= RAIL_MAX ? "rail" : "full"} name = ${JSON.stringify(rows[0]?.accessibleName ?? "")}`
          : [
              ...unnamed.map((r) => `${r.project}: empty accessible name`),
              ...misnamed.map((r) => `${r.project}: named ${JSON.stringify(r.accessibleName)}`),
            ].join("; ");
      out.a11y[width] = { rows, snapshots, source, error, assertions: [check("D8", unnamed.length === 0 && misnamed.length === 0, `@${width} ${d8}`)] };
      await context.close();
    }
  } finally {
    await browser.close();
    await engine.close();
  }
  return out;
}

/* ------------------------------------------------------------------ main */

const failures = [];
const artifact = {
  contract: "design/contracts/rail-chip-overflow.md §7 (D1–D7)",
  generatedAt: new Date().toISOString(),
  node: process.version,
  // The two over-long tokens, both taken from `identifierPrefix` rather than
  // typed out, and both shapes the ruling has to hold for: a hyphenated one
  // (wraps) and a solid one (never wraps).
  longTokens: {
    hyphenated: { id: LEGACY_ID, prefix: LEGACY_TEXT, len: LEGACY_TEXT.length },
    solid: { id: SOLID_ID, prefix: SOLID_TEXT, len: SOLID_TEXT.length },
  },
  options: opt,
  viewports: VIEWPORTS,
  engines: [],
};

for (const which of opt.engine === "both" ? ["taskd", "fixture"] : [opt.engine]) {
  let engine;
  try {
    engine = which === "taskd" ? await startTaskdEngine() : await startFixtureEngine();
  } catch (err) {
    failures.push({ engine: which, id: "setup", detail: `${err.message}` });
    continue;
  }
  artifact.engines.push(await runEngine(engine, failures));
}

if (opt.json) {
  mkdirSync(dirname(opt.json), { recursive: true });
  writeFileSync(opt.json, `${JSON.stringify(artifact, null, 2)}\n`);
}

/* ------------------------------------------------------------- the summary */

for (const engine of artifact.engines) {
  console.log(`\n=== engine: ${engine.engine}  ${engine.baseUrl}`);
  console.log(`    wire ${engine.wire?.status}: ${(engine.wire?.projects ?? []).map((p) => `${p.name}=${JSON.stringify(p.prefix)}(${p.prefix?.length})`).join("  ")}`);
  for (const width of VIEWPORTS) {
    const v = engine.viewports[width];
    if (!v) continue;
    console.log(`  ${String(width).padStart(4)}px ${v.rail ? "rail" : "full"}  aside=${v.aside?.clientW}/${v.aside?.scrollW} railW=${v.railWidth} doc=${JSON.stringify(v.docOverflow)}  ${v.assertions.map((a) => `${a.id}:${a.ok ? "PASS" : "FAIL"}`).join(" ")}`);
    for (const r of v.rows) {
      if (!r.hasChip) continue;
      /* `text` is the whole text block (all line boxes), `drawn` is what
         survives the clip — the two differ exactly when the chip is over-long. */
      const text = r.union ? `${r.union.x}..${r.union.right} × ${r.union.top}..${r.union.bottom}` : "—";
      const drawn = r.drawn.length ? `${Math.min(...r.drawn.map((d) => d.x))}..${Math.max(...r.drawn.map((d) => d.x + d.w))} × ${Math.min(...r.drawn.map((d) => d.y))}..${Math.max(...r.drawn.map((d) => d.y + d.h))}` : "—";
      console.log(
        `        ${String(r.project).padEnd(22)} len=${String(r.textLen).padStart(2)} ${r.visible ? `${r.chipBox.w}×${r.chipBox.h}` : "hidden"} lines=${r.lineCount} text=${text} drawn=${drawn} ownRow=${!r.escapesOwnRow} others=${JSON.stringify(r.overlapsOtherRows)} title=${r.title ? JSON.stringify(r.title.length > 14 ? `${r.title.slice(0, 14)}…` : r.title) : "—"}`,
      );
    }
    for (const a of v.assertions) if (!a.ok) console.log(`        x ${a.id}: ${a.detail}`);
    if (v.d5) console.log(`        D5 set: ${JSON.stringify(v.d5.short)}`);
    for (const o of v.overLong ?? []) {
      console.log(`        over-long: ${o.project} ${o.textLen} chars, text box ${o.unionW}px in a ${o.chipBox.w}px chip, ${o.lineCount} lines; constrained=${o.shaConstrained} unconstrained=${o.shaUnconstrained}`);
    }
  }
  for (const [width, a11y] of Object.entries(engine.a11y ?? {})) {
    console.log(`  a11y @${width} (name source: ${a11y.source}${a11y.error ? `, ariaSnapshot unavailable: ${a11y.error}` : ""})  ${(a11y.assertions ?? []).map((a) => `${a.id}:${a.ok ? "PASS" : "FAIL"}`).join(" ")}`);
    for (const r of a11y.rows) console.log(`        ${String(r.project).padEnd(22)} <${r.tag}> chipShown=${r.chipDisplayed} chipAriaHidden=${r.chipAriaHidden} nameByContents=${JSON.stringify(r.nameByContents)} accessibleName=${JSON.stringify(r.accessibleName ?? null)}`);
    for (const a of a11y.assertions ?? []) if (!a.ok) console.log(`        x ${a.id}: ${a.detail}`);
    for (const s of a11y.snapshots ?? []) console.log(`        ariaSnapshot: ${JSON.stringify(s)}`);
  }
  if (engine.consoleErrors.length) console.log(`  console errors: ${engine.consoleErrors.length} ${JSON.stringify(engine.consoleErrors.slice(0, 3))}`);
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURE(S)`}${opt.json ? ` — artifact: ${opt.json}` : ""}`);
for (const f of failures) console.log(`  x [${f.engine}] ${f.id}: ${f.detail}`);

/* `taskd` holds an open SSE stream per page and its `close()` waits on active
 * requests; the artifact is on disk by now, so leaving the loop explicitly is
 * the difference between an exit code and a hang. */
process.exit(failures.length === 0 ? 0 : 1);
