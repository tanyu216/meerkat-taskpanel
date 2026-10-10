/**
 * Sentinel Watch — the BRAND.md §5 mark geometry, asserted value by value.
 *
 * The mark's coordinates are a hard contract, fixed by `BRAND.md` §5: three
 * rising meerkats (a capsule body, a concentric head circle and two mirrored
 * ears each) plus one floating watch dot, all inside `viewBox 0 0 32 32`. Until
 * now that contract lived only in prose notes, so a silent coordinate drift in
 * `prototype/index.html` or `prototype/favicon.svg` would pass the checks.
 *
 * `BRAND.md` §5 is the **single authority**: every expected value below is
 * parsed out of its three tables (parts, placement, watch signal) — nothing is
 * hard-coded a second time — and the three rendered marks are then matched
 * against it shape by shape, number by number:
 *
 *   1. `prototype/index.html`   top bar     `.td-logo`
 *   2. `prototype/index.html`   empty state `.td-logo.td-logo-lg`
 *   3. `prototype/favicon.svg`  (light fills; the dark pair follows the scheme)
 *
 * The last block is the non-vacuity proof: it feeds deliberately mutated SVG to
 * the same comparison and asserts each drift is reported, so a guard that could
 * never go red fails here instead of passing forever.
 *
 * **Where this runs.** It needs `design/brand/BRAND.md` and `prototype/`, and
 * `.dockerignore` excludes both from the image — so, like the prototype half of
 * `test/web/i18n.catalogue.test.mjs`, the suite self-skips (with a printed
 * reason) inside the container and guards where the sources exist: the CI `check`
 * job, which runs `node --test` against a full checkout, and local `npm run check`.
 *
 * Pure static check — Node builtins only, no file is written.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The §5 authority and the marks that must render it. */
const SOURCES = ["design/brand/BRAND.md", "prototype/index.html", "prototype/favicon.svg"];
const MISSING = SOURCES.filter((rel) => !existsSync(resolve(ROOT, rel)));
const HAS_SOURCES = MISSING.length === 0;

// ─── Markdown-table and SVG helpers (pure, source-agnostic) ─────────────────

const NUMBER = "-?\\d+(?:\\.\\d+)?";
const SIGN = "[+\\u2212-]"; // §5 writes ear L's offset with a U+2212 MINUS SIGN
const one = (n) => Number(n.toFixed(3));

/** Trimmed cells of one markdown table row (backticks stripped). */
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replace(/`/g, ""));

/** Body rows of the first table in `text` whose header cells satisfy `match`. */
function table(text, name, match) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith("|") && match(cellsOf(line)));
  assert.ok(at !== -1, `BRAND.md §5: the ${name} table is missing`);
  assert.match(lines[at + 1].trim(), /^\|[\s:|-]+\|$/, `BRAND.md §5: the ${name} table has no separator row`);
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].trim().startsWith("|"); i += 1) rows.push(cellsOf(lines[i]));
  assert.ok(rows.length > 0, `BRAND.md §5: the ${name} table has no rows`);
  return rows;
}

/** The number after a bare `key <n>` (e.g. `width 5.2`). */
function num(text, key) {
  const m = new RegExp(`\\b${key}\\s+(${NUMBER})`).exec(text);
  assert.ok(m, `BRAND.md §5: no \`${key} <number>\` in "${text}"`);
  return Number(m[1]);
}

/** The number in a bare `key = <n>` (e.g. base `y = 27`). */
function eqNum(text, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*(${NUMBER})`).exec(text);
  assert.ok(m, `BRAND.md §5: no \`${key} = <number>\` in "${text}"`);
  return Number(m[1]);
}

/** An `lhs = base ± n` relation (e.g. `cy = top + 2.6`, `cx = cx − 1.9`). */
function relation(text, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*([A-Za-z]+)\\s*(${SIGN})\\s*(${NUMBER})`).exec(text);
  assert.ok(m, `BRAND.md §5: no \`${key} = base ± n\` relation in "${text}"`);
  return { base: m[1], sign: m[2] === "+" ? 1 : -1, offset: Number(m[3]) };
}

const ATTR = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
/** The attributes of one element's raw tag text. */
function attrsOf(raw) {
  const attrs = {};
  for (const m of raw.matchAll(ATTR)) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * The shapes of one rendered mark, in document order. `fill` and `cls` resolve
 * to the element's own attribute or, failing that, the nearest ancestor `<g>`.
 */
function shapesOf(svg) {
  const out = [];
  const stack = [];
  const re = /<g\b([^>]*)>|<\/g>|<(rect|circle)\b([^>]*?)\/?>/g;
  for (const m of svg.matchAll(re)) {
    if (m[0].startsWith("<g")) {
      stack.push(attrsOf(m[1] ?? ""));
      continue;
    }
    if (m[0] === "</g>") {
      stack.pop();
      continue;
    }
    const attrs = attrsOf(m[3] ?? "");
    const inherited = (key) => [...stack].reverse().map((g) => g[key]).find((v) => v != null) ?? null;
    out.push({ tag: m[2], attrs, fill: attrs.fill ?? inherited("fill"), cls: attrs.class ?? inherited("class") });
  }
  return out;
}

const GEOM_KEYS = ["x", "y", "width", "height", "rx", "cx", "cy", "r"];
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

/** Every place a rendered mark departs from the §5 expectation — `[]` is a match. */
function drift(shapes, expected) {
  if (shapes.length !== expected.length) return [`shape count ${shapes.length} != ${expected.length}`];
  const out = [];
  expected.forEach((want, i) => {
    const got = shapes[i];
    if (got.tag !== want.tag) out.push(`[${i}].tag ${got.tag} != ${want.tag}`);
    if (got.fill !== want.fill) out.push(`[${i}].fill ${got.fill} != ${want.fill}`);
    for (const key of GEOM_KEYS) {
      if (!(key in want)) continue;
      if (!(key in got.attrs)) out.push(`[${i}].${key} missing`);
      else if (!close(got.attrs[key], want[key])) out.push(`[${i}].${key} ${got.attrs[key]} != ${want[key]}`);
    }
  });
  return out;
}

// ─── The guard (skips where design/ and prototype/ are absent) ──────────────

describe(
  "Sentinel Watch mark geometry == BRAND.md §5",
  { skip: HAS_SOURCES ? false : `not in this tree — ${MISSING.join(", ")} (excluded from the image)` },
  () => {
    const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
    const BRAND_MD = read("design/brand/BRAND.md");
    const PROTOTYPE_HTML = read("prototype/index.html");
    const FAVICON_SVG = read("prototype/favicon.svg");

    // §5 is the single authority: parse its three tables, never restate them.
    const start = BRAND_MD.indexOf("\n## 5.");
    const end = BRAND_MD.indexOf("\n## 6.", start + 1);
    assert.ok(start !== -1, "BRAND.md has no `## 5.` logo section");
    assert.ok(end > start, "BRAND.md §5 is not followed by a `## 6.` heading");
    const SEC5 = BRAND_MD.slice(start, end);

    const PART = new Map(
      table(SEC5, "parts", (h) => h[0] === "part" && h[1] === "shape").map((r) => [r[0], r[2]]),
    );
    assert.deepEqual(
      [...PART.keys()].sort(),
      ["body", "ear L", "ear R", "head"],
      "BRAND.md §5 parts table must list body, head, ear L and ear R",
    );

    const BODY = {
      width: num(PART.get("body"), "width"),
      rx: num(PART.get("body"), "rx"),
      base: eqNum(PART.get("body"), "y"),
    };
    const HEAD = { r: num(PART.get("head"), "r"), cy: relation(PART.get("head"), "cy") };
    const EAR_L = {
      r: num(PART.get("ear L"), "r"),
      cy: relation(PART.get("ear L"), "cy"),
      cx: relation(PART.get("ear L"), "cx"),
    };
    const EAR_R = {
      r: num(PART.get("ear R"), "r"),
      cy: relation(PART.get("ear R"), "cy"),
      cx: relation(PART.get("ear R"), "cx"),
    };

    const PLACE = table(SEC5, "placement", (h) => h[0] === "#");
    assert.equal(PLACE.length, 3, "BRAND.md §5 must place exactly three sentinels");
    const SENTINELS = PLACE.map((row, i) => {
      assert.equal(Number(/^(\d+)/.exec(row[0])?.[1]), i + 1, `BRAND.md §5 placement row ${i} is not numbered ${i + 1}`);
      const s = { n: i + 1, cx: Number(row[1]), top: Number(row[2]), height: Number(row[3]) };
      assert.ok(
        [s.cx, s.top, s.height].every(Number.isFinite),
        `BRAND.md §5 placement row ${i} (${row.join(" | ")}) is not numeric`,
      );
      return s;
    });

    /** The §5 fill columns: the two lead figures are the mob, the third is on duty. */
    const FILL = {
      light: { mob: PLACE[0][4], sentinel: PLACE[2][4] },
      dark: { mob: PLACE[0][5], sentinel: PLACE[2][5] },
    };

    const DOT_ROWS = table(SEC5, "watch-signal", (h) => h[0] === "part" && h[1] === "cx");
    assert.equal(DOT_ROWS.length, 1, "BRAND.md §5 must carry exactly one watch-signal row");
    assert.equal(DOT_ROWS[0][0], "watch dot", "BRAND.md §5 watch-signal row is not the watch dot");
    const DOT = { cx: Number(DOT_ROWS[0][1]), cy: Number(DOT_ROWS[0][2]), r: Number(DOT_ROWS[0][3]) };

    /** One mark's ordered shapes, with the fill each figure carries. */
    function expectedShapes({ mob, sentinel }) {
      const out = [];
      SENTINELS.forEach((s, i) => {
        const fill = i === SENTINELS.length - 1 ? sentinel : mob;
        out.push({
          tag: "rect",
          fill,
          x: one(s.cx - BODY.width / 2),
          y: one(s.top),
          width: one(BODY.width),
          height: one(s.height),
          rx: one(BODY.rx),
        });
        out.push({ tag: "circle", fill, cx: one(s.cx), cy: one(s.top + HEAD.cy.offset), r: one(HEAD.r) });
        out.push({
          tag: "circle",
          fill,
          cx: one(s.cx + EAR_L.cx.sign * EAR_L.cx.offset),
          cy: one(s.top + EAR_L.cy.offset),
          r: one(EAR_L.r),
        });
        out.push({
          tag: "circle",
          fill,
          cx: one(s.cx + EAR_R.cx.sign * EAR_R.cx.offset),
          cy: one(s.top + EAR_R.cy.offset),
          r: one(EAR_R.r),
        });
      });
      out.push({ tag: "circle", fill: sentinel, cx: one(DOT.cx), cy: one(DOT.cy), r: one(DOT.r) });
      return out;
    }

    const EXPECTED_COUNT = SENTINELS.length * 4 + 1;

    const TOKEN = {
      ink: "var(--color-td-ink)",
      ink3: "var(--color-td-ink-3)",
      accent: "var(--color-td-accent)",
    };

    const INDEX_MARKS = [...PROTOTYPE_HTML.matchAll(/<svg class="td-logo[^"]*"[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    assert.equal(
      INDEX_MARKS.length,
      2,
      "prototype/index.html must carry exactly two `.td-logo` marks (top bar + empty state)",
    );

    const FAV_STYLE = /<style>([\s\S]*?)<\/style>/.exec(FAVICON_SVG)?.[1] ?? "";
    assert.ok(FAV_STYLE.includes("@media"), "prototype/favicon.svg must colour the mark by colour scheme");
    const [FAV_LIGHT_CSS, FAV_DARK_CSS = ""] = FAV_STYLE.split("@media");
    assert.match(
      FAV_DARK_CSS,
      /prefers-color-scheme:\s*dark/,
      "favicon.svg: the media block must be `prefers-color-scheme: dark`",
    );
    const favFillIn = (css, cls) => {
      const m = new RegExp(`\\.${cls}\\s*\\{\\s*fill:\\s*([^;]+);`).exec(css);
      assert.ok(m, `favicon.svg: no \`.${cls} { fill: … }\``);
      return m[1].trim();
    };
    const FAV_LIGHT = { mob: favFillIn(FAV_LIGHT_CSS, "mob"), sentinel: favFillIn(FAV_LIGHT_CSS, "sentinel") };
    const FAV_DARK = { mob: favFillIn(FAV_DARK_CSS, "mob"), sentinel: favFillIn(FAV_DARK_CSS, "sentinel") };

    // ── §5 stands on its own ─────────────────────────────────────────────────

    describe("BRAND.md §5 — the mark's contract is internally sound", () => {
      it("draws three sentinels rising left-low to right-high, evenly spaced", () => {
        assert.equal(SENTINELS.length, 3);
        const tops = SENTINELS.map((s) => s.top);
        assert.deepEqual(tops, [...tops].sort((a, b) => b - a), "§5: the sentinels must rise (each top above the last)");
        const gaps = SENTINELS.slice(1).map((s, i) => one(s.cx - SENTINELS[i].cx));
        assert.equal(new Set(gaps).size, 1, `§5: adjacent sentinels must be evenly spaced (gaps ${gaps.join(", ")})`);
      });

      it("makes each body a true capsule of the stated width", () => {
        assert.equal(BODY.rx, BODY.width / 2, "§5: rx must be exactly half the body width");
        for (const s of SENTINELS) {
          assert.equal(one(s.height), one(BODY.base - s.top), `§5: sentinel ${s.n}'s height must be base − top`);
        }
      });

      it("puts a concentric head and two mirrored ears on every sentinel", () => {
        assert.equal(HEAD.cy.base, "top", "§5: the head's cy must be measured from `top`");
        assert.equal(EAR_L.cy.base, "top", "§5: the ears' cy must be measured from `top`");
        assert.equal(EAR_L.cx.base, "cx", "§5: the ears' cx must be measured from the sentinel's `cx`");
        assert.equal(EAR_R.r, EAR_L.r, "§5: the two ears must share a radius");
        assert.equal(EAR_L.cy.offset, EAR_R.cy.offset, "§5: the two ears must sit at the same height");
        assert.deepEqual(
          [EAR_L.cx.offset, EAR_L.cx.sign, EAR_R.cx.sign],
          [EAR_R.cx.offset, -1, 1],
          "§5: the ears must be mirrored either side of the centre",
        );
      });

      it("floats the watch dot clear above the on-duty sentinel", () => {
        const tallest = SENTINELS[SENTINELS.length - 1];
        assert.equal(DOT.cx, tallest.cx, "§5: the watch dot must sit above the tallest (on-duty) sentinel");
        const clearance = one(tallest.top - (DOT.cy + DOT.r));
        assert.ok(clearance >= 1.5, `§5: the watch dot must clear the crown by at least 1.5 units (got ${clearance})`);
      });
    });

    // ── Every rendered mark carries exactly that geometry ────────────────────

    describe("the rendered marks match it, value by value", () => {
      it("prototype/index.html top bar `.td-logo`", () => {
        const shapes = shapesOf(INDEX_MARKS[0]).map((s) => ({ ...s }));
        assert.equal(shapes.length, EXPECTED_COUNT, "the top-bar mark must render every §5 shape");
        assert.deepEqual(drift(shapes, expectedShapes({ mob: TOKEN.ink, sentinel: TOKEN.accent })), []);
      });

      it("prototype/index.html empty state `.td-logo-lg`", () => {
        const shapes = shapesOf(INDEX_MARKS[1]).map((s) => ({ ...s }));
        assert.equal(shapes.length, EXPECTED_COUNT, "the empty-state mark must render every §5 shape");
        assert.deepEqual(drift(shapes, expectedShapes({ mob: TOKEN.ink3, sentinel: TOKEN.accent })), []);
      });

      it("both index.html marks paint only `--color-td-*` tokens (no bare hex)", () => {
        for (const [i, svg] of INDEX_MARKS.entries()) {
          assert.deepEqual(svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], `mark[${i}] carries a bare hex colour`);
          for (const { fill } of shapesOf(svg)) {
            assert.ok(Object.values(TOKEN).includes(fill), `mark[${i}] paints a non-token fill ${JSON.stringify(fill)}`);
          }
        }
      });

      it("prototype/favicon.svg — the shared geometry, light fills", () => {
        const shapes = shapesOf(FAVICON_SVG).map((s) => ({
          ...s,
          fill: s.cls === "sentinel" ? FAV_LIGHT.sentinel : FAV_LIGHT.mob,
        }));
        assert.equal(shapes.length, EXPECTED_COUNT, "the favicon must render every §5 shape");
        assert.deepEqual(drift(shapes, expectedShapes({ mob: FAV_LIGHT.mob, sentinel: FAV_LIGHT.sentinel })), []);
      });

      it("prototype/favicon.svg — paints §5's light/dark duotone by colour scheme", () => {
        assert.equal(FAV_LIGHT.mob.toLowerCase(), FILL.light.mob.toLowerCase(), "favicon light mob fill != §5");
        assert.equal(FAV_LIGHT.sentinel.toLowerCase(), FILL.light.sentinel.toLowerCase(), "favicon light sentinel fill != §5");
        assert.equal(FAV_DARK.mob.toLowerCase(), FILL.dark.mob.toLowerCase(), "favicon dark mob fill != §5");
        assert.equal(FAV_DARK.sentinel.toLowerCase(), FILL.dark.sentinel.toLowerCase(), "favicon dark sentinel fill != §5");
      });
    });

    // ── The guard is not vacuous ─────────────────────────────────────────────

    describe("the geometry guard can actually go red", () => {
      const pristine = INDEX_MARKS[0];
      const want = expectedShapes({ mob: TOKEN.ink, sentinel: TOKEN.accent });
      const audit = (svg) => drift(shapesOf(svg), want);

      /** Mutate the pristine mark textually and return the drift that mutation causes. */
      const mutate = (from, to) => {
        const mutated = pristine.replace(from, to);
        assert.notEqual(mutated, pristine, `the mutation ${from} → ${to} did not apply`);
        return audit(mutated);
      };

      it("passes on the pristine mark, so the oracle itself can be green", () => {
        assert.deepEqual(audit(pristine), []);
      });

      it("reports a widened ear — r 0.85 → 1.85", () => {
        const d = mutate(`r="${one(EAR_L.r)}"`, `r="${one(EAR_L.r + 1)}"`);
        const hit = `${one(EAR_L.r + 1)} != ${one(EAR_L.r)}`;
        assert.ok(
          d.some((m) => m.includes(".r ") && m.includes(hit)),
          `ear-radius drift not reported: ${JSON.stringify(d)}`,
        );
      });

      it("reports a shifted head centre — cx 7.2 → 7.3", () => {
        const d = mutate(`cx="${one(SENTINELS[0].cx)}"`, `cx="${one(SENTINELS[0].cx + 0.1)}"`);
        const hit = `${one(SENTINELS[0].cx + 0.1)} != ${one(SENTINELS[0].cx)}`;
        assert.ok(
          d.some((m) => m.includes(".cx ") && m.includes(hit)),
          `head-centre drift not reported: ${JSON.stringify(d)}`,
        );
      });

      it("reports a fattened capsule — width 5.2 → 5.4", () => {
        const d = mutate(`width="${one(BODY.width)}"`, `width="${one(BODY.width + 0.2)}"`);
        assert.ok(d.some((m) => m.includes(".width ")), `capsule-width drift not reported: ${JSON.stringify(d)}`);
      });

      it("reports a moved baseline — y 17.6 → 17.7", () => {
        const d = mutate(`y="${one(SENTINELS[0].top)}"`, `y="${one(SENTINELS[0].top + 0.1)}"`);
        assert.ok(d.some((m) => m.includes(".y ")), `baseline drift not reported: ${JSON.stringify(d)}`);
      });

      it("reports a dragged watch dot — cy 5.2 → 5.5", () => {
        const d = mutate(`cy="${one(DOT.cy)}"`, `cy="${one(DOT.cy + 0.3)}"`);
        assert.ok(d.some((m) => m.includes(".cy ")), `watch-dot drift not reported: ${JSON.stringify(d)}`);
      });

      it("reports a repainted figure — ink → ink-3", () => {
        const d = mutate(`fill="${TOKEN.ink}"`, `fill="${TOKEN.ink3}"`);
        assert.ok(d.some((m) => m.includes(".fill ")), `fill drift not reported: ${JSON.stringify(d)}`);
      });

      it("reports a dropped shape", () => {
        const d = mutate(/<circle[^>]*\/>/, "");
        assert.ok(d.some((m) => m.includes("shape count")), `dropped-shape drift not reported: ${JSON.stringify(d)}`);
      });
    });
  },
);
