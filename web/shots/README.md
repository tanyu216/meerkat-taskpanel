# Prototype ↔ implementation screenshots — M6b · F3

Side-by-side evidence for **Jobs' UI/UX certification** of the M6b board frontend.

**Comparison basis (Elon's ruling O7): structural + geometric machine check, plus human
review. There is NO pixel diff.** The prototype is jQuery + static HTML and the
implementation is a Vue SPA; pixel equality is unattainable and a diff would only produce
noise. What is machine-checked instead is the block contract, the error counters, the
per-viewport overflow assertion, and the layout-divergence probe described below.

These artefacts are **review artefacts and are deliberately not committed to the
repository** — they live in this task workspace only. The generator *is* durable and stays
in the repo at `web/scripts/shot-compare.mjs`.

---

## 1. Combination matrix

Every shot is `<viewport>px × 950px` CSS, `deviceScaleFactor: 2` (the prototype's own
screenshot convention). Each row produces three files:

| files | meaning |
|---|---|
| `proto-<combo>-<w>.png` | `prototype/index.html` over `file://` |
| `impl-<combo>-<w>.png` | built `web/dist`, served against the fixture API |
| `side-by-side-<combo>-<w>.png` | **the sheet to review** — prototype \| implementation, same viewport/theme/language |

| combination | theme | lang | viewports | sheets |
|---|---|---|---|---|
| `light-en` | light | en | 1512, 1240, 980, 760, 500 | [1512](side-by-side-light-en-1512.png) · [1240](side-by-side-light-en-1240.png) · [980](side-by-side-light-en-980.png) · [760](side-by-side-light-en-760.png) · [500](side-by-side-light-en-500.png) |
| `dark-en` | dark | en | 1512 | [1512](side-by-side-dark-en-1512.png) |
| `light-zh` | light | zh | 1512 | [1512](side-by-side-light-zh-1512.png) |

7 combinations × 2 halves = 14 shots, plus 7 sheets, plus `report.json`.
**Nothing in the required matrix was skipped** — all 7 were captured and every one is in
this directory.

How each side is driven into the declared state (asserted, then recorded per shot in
`report.json`):

* **implementation** — its two `localStorage` keys (`taskpanel.theme`, `taskpanel.lang`)
  are seeded before the first paint, so the shell never flashes the wrong scheme or copy;
* **prototype** — `prototype/app.js` persists nothing, so it is *driven*: a programmatic
  click on `[data-theme-switch]` (light → dark is one press of its three-state cycle) and
  on `[data-lang-option="zh"]`. Both raise a toast, so the capture waits 3.3 s for it to
  expire — otherwise the pair would compare a board against a notice.

## 2. How to re-run

```bash
node web/scripts/shot-compare.mjs                    # capture + machine check
node web/scripts/shot-compare.mjs --strict           # …and fail on layout divergences
node web/scripts/shot-compare.mjs --out=<dir>        # different output directory
node web/scripts/shot-compare.mjs --json             # machine-readable report on stdout
```

Exit codes: **0** all acceptance-bar checks green · **1** a check failed (or, with
`--strict`, a layout divergence) · **2** skip — no `web/dist`, no prototype, or no browser.

Host-only, by design: Playwright is resolved from an already-installed location exactly as
`web/scripts/dom-smoke.mjs` does. The container image carries no browser, so inside Docker
this exits 2; rendering is the host-allowed exception (plan §9.1 exception 4,
`docs/docker.md`). It reads the fixture server, the Playwright resolver and the in-page rule
evaluator **from `dom-smoke.mjs`** — those are not duplicated here.

Prerequisite: `npm -w web run build` (produces `web/dist`).

## 3. Machine check — result of this run

```
contract rules (browser layer): 99/99 passed
console errors: 0
page errors:    0
```

Per-viewport horizontal overflow (`documentElement.scrollWidth <= clientWidth + 1`), both
sides, at every captured shot:

| viewport | prototype | implementation |
|---|---|---|
| 1512 | ok | ok |
| 1240 | ok | ok |
| 980 | ok | ok |
| 760 | ok | ok |
| 500 | ok | ok |

The 99 rules are `BROWSER_LAYER_RULES` from `test/web/blocks.contract.mjs`, evaluated by
`dom-smoke.mjs`'s own entry point (board view + list view + states showcase). Interaction
smoke also green: drawer open/close, the 7-row "Move to" menu, the three-state theme cycle
returning to its start, and en ⇄ zh switching. Full detail in `report.json`.

## 4. What a human reviewer should know before comparing

These are **not** defects — they are the two sides using different data, and are expected:

* **Card count differs: prototype 18, implementation 4.** The prototype ships a bundled
  12-task/18-card demo document; the implementation is driven by the DOM smoke's **fixture
  API** (4 tasks: one each in `todo`, `in_progress`, `done`, `blocked`). Columns with no
  fixture task show the implementation's intentional empty state ("No tasks / Drop a card
  here to move it to …"). Read the columns' *structure*, not their fill.
* **`<html lang>` is `zh-CN` in the prototype and `zh` in the implementation** — the
  prototype uses the region-qualified form, the implementation the plain tag. Both localise
  the whole surface; this is the only localisation difference.
* **Board columns scroll horizontally within the board**, not the document — at 1512 the
  implementation shows five of seven columns and `Done`/`Canceled` are reached by scrolling
  the board. This is why the document-level overflow assertion passes on both sides.

**no-JS:** the prototype ships a readable static document with JS disabled
(`prototype/screenshots/15-no-javascript.png`). The implementation is a Vue SPA with no
SSR, so with JS disabled only the empty `#app` shell renders. This is a **structural
consequence** of the architecture, not a regression — the plan records it as the
combination's number-one documented difference. The matrix above therefore captures **JS
enabled**; there is no meaningful implementation counterpart to the prototype's no-JS shot
and none is fabricated here.

## 5. Layout divergences found by this pass

The generator runs one geometric probe the unit contract cannot express: per side it records
every element whose own content is wider than the box clipping it, then reports the
**asymmetry**. Whatever *both* sides clip is shared intent (the board's horizontal scroller;
the `sr-only`/`td-sr` visually-hidden labels — dropped by geometry, not by class name, since
the two codebases name them differently). A key present on one side only is a divergence.

**One divergence, at 980 / 760 / 500:**

```
light-en@980  implementation only: aside.td-sidebar
light-en@760  implementation only: aside.td-sidebar
light-en@500  implementation only: aside.td-sidebar
```

At ≤1023px the sidebar becomes an **icon rail** — `prototype/DESIGN.md` L148: "Sidebar
`248px` (icon rail `64px` ≤1023px, `56px` ≤559px)". The contract is explicit that the text
goes with it; `prototype/BLOCKS.md` B03 (L119–122):

> At the ≤1023px rail the three thirds hold (the row is never allowed to wrap) and **the
> labels drop out with the rest of the sidebar text**, so each cell is a centred 24px icon:
> three 14px glyphs still fit the 64px rail (56px under 560px) without horizontal overflow.

The implementation sizes the rail correctly (`web/src/styles/app.css`,
`@media (max-width: 1023px) { .td-sidebar { width: 64px } }`) but the nav items keep their
**text labels**, which the rail then truncates mid-word ("Activity", "openclaw", "States").
Measured at 500px: `aside.td-sidebar` clientWidth 55 / scrollWidth 68, with the
`button.td-side-item` boxes at 4..51px inside the 56px rail — the label text overflows the
button and the rail clips it. The 4× sidebar crops make it plain: prototype = board / list /
clock glyphs + `ORC`/`TD`/`SR` monograms; implementation = the same items as clipped text.

The `display: none` list in that media query targets `.td-side-label`, `.td-side-name` and
`.td-side-text` — class names the nav markup does not use — so the labels are never hidden.
Visible in every ≤1023px sheet in this directory; easiest to see at
[760](side-by-side-light-en-760.png) and [500](side-by-side-light-en-500.png), prototype
rail beside implementation rail.

This is **reported, not fixed**: UI changes are outside this pass's write surface. It does
not fail the acceptance bar (no document overflow, all 99 rules pass, zero errors), so the
probe is non-gating by default — `node web/scripts/shot-compare.mjs --strict` exits 1 on it.

## 6. `report.json`

The machine-readable record of the run: the combination matrix, per-shot state readback
(`data-theme-mode`, `lang`, column/card counts), per-shot overflow for both sides, the
clipped-content sets, the layout divergences, the full machine-check block and the capture
time error lists. Regenerate with the command in §2.
