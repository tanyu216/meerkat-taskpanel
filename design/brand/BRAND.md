# meerkat-taskpanel — Brand Layer v2

> **Token authority.** `tokens.css` in this directory is the single source of
> truth. This document quotes it and adds the reasoning; where the two could
> ever disagree, `tokens.css` wins and this file is the bug.
> The palette is fixed by `brief.md` §5 as **frozen from v1** — no token was
> added, removed, renamed or re-valued in v2, and no colour was introduced.
> The three light-mode corrections carried forward from v1 are listed in
> [WCAG AA verification](#wcag-aa-verification).

---

## 1. Positioning

**English.** meerkat-taskpanel — a sentinel watch for AI-agent teams: a mob of
agents working in parallel, and one that is always on duty.

**中文.** meerkat-taskpanel —— 为 AI Agent 团队打造的「哨卫式」任务面板：多
agent 并行领卡（群），轮值巡检与告警（哨）。

**Style.** *Quiet Precision / 安静精确* — a workhorse UI, not a marketing page.
Restrained density. Whitespace carries the hierarchy. One primary line colour.
Hairline borders. Zero ornamental surplus. If an element cannot justify the space
it occupies, it is removed rather than styled.

### 1.1 The brand narrative — why a meerkat

Two habits of the species are, exactly, the two mechanisms of the product.

| meerkat behaviour | product mechanism | visual landing |
|---|---|---|
| **Mobbing** — the group forages and digs together, with clear division of labour | many agents claiming cards and running concurrently | **a row of upright sentinels (the mob)** — many bodies, one posture |
| **Sentry rotation** — one individual always stands erect on watch, rotating through the group, raising the alarm on danger | patrol, alerting, heartbeat, on-duty rotation | **the tallest one + one signal point above it (the sentinel on duty)** |

The one-line version: **a mob at work, one always on watch.**
中文：**一群 agent 并行干活，一个哨兵始终在岗。**

`Sentinel Watch` is a deliberate evolution of v1, not a break from it — see
[v2 change record](#v2-change-record).

---

## 2. Palette

Every value below is reproduced from `tokens.css`. The token name in the left
column is the canonical CSS custom property; daisyUI v5 also reads the
`--color-*` aliases, which `tokens.css` defines alongside the v4 legacy names
(`--p`, `--b1`, …). **The palette is unchanged from v1.**

### 2.1 Light — `:root`

**Semantic (daisyUI theme).**

| token | value | content | content token | use |
|---|---|---|---|---|
| `--color-primary` | `#0F7A73` | `#FFFFFF` | `--color-primary-content` | THE brand line: primary buttons, selection, links, focus |
| `--color-secondary` | `#3A474E` | `#FFFFFF` | `--color-secondary-content` | secondary buttons, neutral emphasis |
| `--color-accent` | `#A1641A` | `#FFFFFF` | `--color-accent-content` | warm signal — sparingly, for highlight |
| `--color-neutral` | `#1F2A2E` | `#F5F6F7` | `--color-neutral-content` | neutral face, dark top bar |
| `--color-base-100` | `#FFFFFF` | — | — | cards, panels, column containers |
| `--color-base-200` | `#F5F6F7` | — | — | app canvas, sunken surfaces |
| `--color-base-300` | `#E6E8EB` | — | — | partitions, hairline bed |
| `--color-base-content` | `#14181B` | — | — | primary text |
| `--color-info` | `#3B6FD4` | `#FFFFFF` | `--color-info-content` | information |
| `--color-success` | `#187A4C` | `#FFFFFF` | `--color-success-content` | success / done |
| `--color-warning` | `#8A5A00` | `#FFFFFF` | `--color-warning-content` | warning |
| `--color-error` | `#C0392B` | `#FFFFFF` | `--color-error-content` | error / blocked |

**Brand extension tokens** (non-daisyUI, consumed directly by product code).

| token | value | use |
|---|---|---|
| `--brand-bg` | `#F5F6F7` | app canvas |
| `--brand-surface` | `#FFFFFF` | cards and panels |
| `--brand-sunken` | `#F5F6F7` | sidebar, column slots, code bed |
| `--brand-hover` | `#F0F2F3` | hover face |
| `--brand-active` | `#E6E8EB` | selected / pressed |
| `--brand-border` | `#E6E8EB` | hairline border |
| `--brand-border-strong` | `#CFD5D9` | emphasis border, drop target |
| `--brand-text` | `#14181B` | primary text |
| `--brand-text-2` | `#4A555E` | secondary text |
| `--brand-text-3` | `#7E8A91` | auxiliary / placeholder |
| `--brand-text-4` | `#B8C0C5` | disabled / weakest |
| `--brand-focus-ring` | `rgba(15,122,115,0.35)` | keyboard focus ring |

**Status — 7 states, one mapping each, never mixed.**

| status | token | value |
|---|---|---|
| backlog | `--brand-st-backlog` | `#6C777E` ¹ |
| todo | `--brand-st-todo` | `#5A6B75` |
| in_progress | `--brand-st-progress` | `#AC640D` ¹ |
| in_review | `--brand-st-review` | `#6E56CF` |
| blocked | `--brand-st-blocked` | `#C0392B` |
| done | `--brand-st-done` | `#187A4C` |
| canceled | `--brand-st-canceled` | `#B8C0C5` ² |

**Priority — 5 levels.**

| level | token | value |
|---|---|---|
| urgent | `--brand-pri-urgent` | `#C0392B` |
| high | `--brand-pri-high` | `#A1641A` |
| medium | `--brand-pri-medium` | `#8A5A00` |
| low | `--brand-pri-low` | `#4779AD` ¹ |
| none | `--brand-pri-none` | `#B8C0C5` ² |

¹ corrected under the v1 brief's mechanical-adjustment clause — see [§6.3](#63-applied-corrections).
² held at the brief value, deliberately — see [§6.4](#64-owner-review-note).

**Priority expression rule** (from the style guide):
urgent / high → filled square + colour ｜ medium / low → outlined square +
colour ｜ none → grey dash, no colour.

### 2.2 Dark — `[data-theme="dark"]`

| token | value | content | use |
|---|---|---|---|
| `--color-primary` | `#2AA79B` | `#0F1417` | the brand line, lifted for dark ground |
| `--color-secondary` | `#8B969C` | `#0F1417` | secondary |
| `--color-accent` | `#E8A93A` | `#0F1417` | warm signal |
| `--color-neutral` | `#2A3236` | `#E6EDF0` | neutral face |
| `--color-base-100` | `#0F1417` | — | card / panel |
| `--color-base-200` | `#161B1E` | — | body surface |
| `--color-base-300` | `#1F262A` | — | partition |
| `--color-base-content` | `#E6EDF0` | — | primary text |
| `--color-info` | `#7EA6F0` | `#0F1417` | information |
| `--color-success` | `#57C98A` | `#0F1417` | success / done |
| `--color-warning` | `#E0A93A` | `#0F1417` | warning |
| `--color-error` | `#F0796E` | `#0F1417` | error / blocked |

**Brand extension (dark).**

| token | value | | token | value |
|---|---|---|---|---|
| `--brand-bg` | `#0F1417` | | `--brand-border` | `#1F262A` |
| `--brand-sunken` | `#0F1417` | | `--brand-border-strong` | `#313B41` |
| `--brand-surface` | `#161B1E` | | `--brand-text` | `#E6EDF0` |
| `--brand-hover` | `#1F262A` | | `--brand-text-2` | `#9BA7AE` |
| `--brand-active` | `#283034` | | `--brand-text-3` | `#7C868C` |
| `--brand-focus-ring` | `rgba(42,167,155,0.40)` | | `--brand-text-4` | `#5A646A` |

**Status (dark).** backlog `#8B969C` ｜ todo `#9BA7AE` ｜ in_progress `#E0A93A` ｜
in_review `#A99BFF` ｜ blocked `#F0796E` ｜ done `#57C98A` ｜ canceled `#7C868C`

**Priority (dark).** urgent `#F0796E` ｜ high `#E0A93A` ｜ medium `#E8A93A` ｜
low `#7EA6F0` ｜ none `#7C868C`

---

## 3. Typography

**Families.** No network font dependency — Inter and JetBrains Mono are
preferred, and the stack degrades to the system faces when they are absent.

```css
--font-sans: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont,
  "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

**Scale.** `11 / 12 / 13 / 14 / 16 / 20 / 24`. Interface body baseline is
**14px**; 12px carries meta and labels; 11px is for corner badges; 16px and up
are reserved for titles.

| size | token | role |
|---|---|---|
| 11px | `--text-11` | corner badges |
| 12px | `--text-12` | meta, labels |
| 13px | `--text-13` | dense UI text |
| **14px** | `--text-14` | **interface body baseline** |
| 16px | `--text-16` | titles |
| 20px | `--text-20` | titles |
| 24px | `--text-24` | titles |

**Line height.** Body `1.5` (`--leading-body`) ｜ titles `1.35`
(`--leading-title`).

**Weight.** `400` body ｜ `500` emphasis and labels ｜ `600` titles.

**Rule.** Numerals, IDs, timestamps and counts are always set in `--font-mono`,
so columns of figures stay in vertical register.

---

## 4. Space, radius, border, elevation, motion

**Spacing — 4px grid.** `4 8 12 16 20 24 32 40 48` as `--space-1` … `--space-9`.

**Radius.**

| token | value | applies to |
|---|---|---|
| `--radius-selector` | `4px` | chips, badges |
| `--radius-field` | `6px` | buttons, inputs, cards |
| `--radius-box` | `8px` | panels, drawers |
| `--radius-full` | `999px` | avatars, count dots |

**Border.** Default `1px solid var(--brand-border)`. Partition hairlines use
`0.5px` (`--brand-hairline`).

**Elevation.**

```css
--shadow-pop: 0 8px 24px rgba(15,20,23,0.10), 0 1px 2px rgba(15,20,23,0.06);
```

Floats only — dropdowns, dialogs, drawers. **Cards cast no shadow**, ever; a
card is defined by its hairline edge and its surface, not by depth.

**Motion.**

| token | value | use |
|---|---|---|
| `--dur-1` | `120ms` | hover, press |
| `--dur-2` | `180ms` | drawer, dialog |
| `--ease-brand` | `cubic-bezier(0.2, 0, 0, 1)` | all of the above |

---

## 5. Logo — “Sentinel Watch”

**Concept.** Three upright meerkats of a mob, standing left-low to right-high on
one baseline. The tallest — the rightmost — is **the sentinel on duty**, and it
carries the brand line colour. Above it, clear of the head, floats a single
solid dot: **the watch signal**, an independent point rather than a cap, so it
reads as *a signal being sent*, not as headgear. The whole mark is the v1
skeleton — three rising forms and a node — re-read as a species: **same
skeleton, new animal.**

**Geometry** (viewBox `0 0 32 32`, absolute; fixed by `brief.md` §4). Ground
baseline `y = 27`. No stroke, no gradient, no shadow; every shape is a circle or
a rounded rectangle, so the mark reduces to one colour (the mono state).

*Sentinel parts — one per figure.*

| part | shape | parameters |
|---|---|---|
| body | rounded rect (capsule) | `width 5.2`, `rx 2.6`, base `y = 27` |
| head | circle | `r 2.6`, `cy = top + 2.6` |
| ear L | circle | `r 0.85`, `cy = top + 1.0`, `cx = cx − 1.9` |
| ear R | circle | `r 0.85`, `cy = top + 1.0`, `cx = cx + 1.9` |

`rx = 2.6` is exactly half the 5.2 body width, so each body is a true capsule.
The head is concentric with the capsule's own rounded crown — the head circle
and the body's top arc are the same semicircle — so the head defines the
silhouette rather than adding a bulge.

*Placement — left-low to right-high.*

| # | cx | top | height (top→27) | fill (light) | fill (dark) | fill (mono) |
|---|---|---|---|---|---|---|
| 1 (shortest) | 7.2 | 17.6 | 9.4 | `#14181B` | `#E6EDF0` | `currentColor` |
| 2 (middle) | 16.0 | 12.4 | 14.6 | `#14181B` | `#E6EDF0` | `currentColor` |
| 3 (on duty, tallest) | 24.8 | 9.6 | 17.4 | `#0F7A73` | `#2AA79B` | `currentColor` |

*Watch signal.*

| part | cx | cy | r | fill (light) | fill (dark) | fill (mono) |
|---|---|---|---|---|---|---|
| watch dot | 24.8 | 5.2 | 1.7 | `#0F7A73` | `#2AA79B` | `currentColor` |

Each figure occupies `cx ± 2.75` including its ears; adjacent centres are 8.8
apart, so the three never touch (gap ≈ 3.3 units). The mark's full ink extent is
`x ∈ [4.45, 27.55]`, `y ∈ [3.5, 27]` — margins of 4.45 left, 4.45 right, 3.5 top
and 5 bottom inside the 32-unit box. The watch dot clears the tallest figure's
crown by **2.7 units**, comfortably above the 1.5-unit floor that keeps the dot
reading as a separate signal.

**Size behaviour.** At 512/1024 the head and the small ears are legible and the
row reads as standing meerkats. At 32 and 16 the ears fall below one pixel and
the mark degrades, by design, to *three rising round-headed bars plus one dot* —
the same small-size read as v1, so the favicon still holds. `brief.md` §4 permits
an optical nudge to the ear radius or inset **only** if the small sizes blur into
blobs; they do not (see `small-size-inspection.png` in the brand task workspace),
so **no adjustment was applied and every value above is verbatim §4.**

**Files.**

| file | ground |
|---|---|
| `logo.svg` | light — mob in ink, the sentinel on duty and its signal in the brand line |
| `logo-dark.svg` | dark — mob lifted to base-content, on-duty sentinel and signal in the dark brand line |
| `logo-mono.svg` | single colour via `currentColor`, any surface |

All three are **static SVG**: no `<script>`, no `on*` attributes, no
`<foreignObject>`, no external references of any kind. The only URL in any of
them is the SVG namespace. They render with scripting disabled.

---

## 6. WCAG AA verification

Computed by `verify-contrast.mjs` out of the box — pure node, no dependencies,
no install step — against the WCAG 2.1 relative-luminance definition. That
script *is* the evidence: re-run it to reproduce every ratio below, and it
rewrites its own `contrast.txt` transcript as it goes. **48 pairs checked —
46 PASS, 2 held by owner ruling** (see §6.5).

Re-run unchanged for v2: because no colour moved, the audit reproduces every
figure below exactly, including the three shipped corrections in §6.3.

### 6.1 Content on its own background — target ≥ 4.5:1

| pair | light | dark |
|---|---|---|
| primary-content on primary | 5.18:1 ✅ | 6.27:1 ✅ |
| secondary-content on secondary | 9.58:1 ✅ | 6.13:1 ✅ |
| accent-content on accent | 4.82:1 ✅ | 8.98:1 ✅ |
| neutral-content on neutral | 13.58:1 ✅ | 11.03:1 ✅ |
| info-content on info | 4.76:1 ✅ | 7.59:1 ✅ |
| success-content on success | 5.35:1 ✅ | 8.94:1 ✅ |
| warning-content on warning | 5.93:1 ✅ | 8.74:1 ✅ |
| error-content on error | 5.44:1 ✅ | 6.77:1 ✅ |

### 6.2 Body text — target ≥ 4.5:1

| pair | ratio |
|---|---|
| `--brand-text` on `--brand-surface` | 17.85:1 ✅ |
| `--brand-text` on `--brand-bg` | 16.50:1 ✅ |
| `--brand-text-2` on `--brand-surface` | 7.63:1 ✅ |
| `--brand-text-2` on `--brand-bg` | 7.05:1 ✅ |
| dark `--brand-text` on `--brand-bg` | 15.66:1 ✅ |
| dark `--brand-text` on `--brand-surface` | 14.66:1 ✅ |
| dark `--brand-text-2` on `--brand-bg` | 7.53:1 ✅ |
| dark `--brand-text-2` on `--brand-surface` | 7.05:1 ✅ |

### 6.3 Status and priority on `base-100` — target ≥ 4.5:1

**Light**, on `#FFFFFF`:

| token | ratio | | token | ratio |
|---|---|---|---|---|
| status backlog | 4.59:1 ✅ | | priority urgent | 5.44:1 ✅ |
| status todo | 5.53:1 ✅ | | priority high | 4.82:1 ✅ |
| status in_progress | 4.58:1 ✅ | | priority medium | 5.93:1 ✅ |
| status in_review | 5.39:1 ✅ | | priority low | 4.56:1 ✅ |
| status blocked | 5.44:1 ✅ | | priority none | 1.84:1 ⚠️ held |
| status done | 5.35:1 ✅ | | | |
| status canceled | 1.84:1 ⚠️ held | | | |

**Dark**, on `#0F1417` — every value passes:

| token | ratio | | token | ratio |
|---|---|---|---|---|
| status backlog | 6.13:1 ✅ | | priority urgent | 6.77:1 ✅ |
| status todo | 7.53:1 ✅ | | priority high | 8.74:1 ✅ |
| status in_progress | 8.74:1 ✅ | | priority medium | 8.98:1 ✅ |
| status in_review | 7.79:1 ✅ | | priority low | 7.59:1 ✅ |
| status blocked | 6.77:1 ✅ | | priority none | 4.98:1 ✅ |
| status done | 8.94:1 ✅ | | | |
| status canceled | 4.98:1 ✅ | | | |

### 6.4 Applied corrections

Three light-mode values failed the §6 target. The v1 brief permits a mechanical
correction that keeps the hue and moves only lightness; these are the smallest
8-bit steps that clear **4.5:1 with a 0.05 margin** (so no value can round back
below AA). Hue and HSL saturation are unchanged in all three. **v2 carries them
forward unchanged**, and re-running the auditor reproduces all three.

| token | before | was | after | now | hue held |
|---|---|---|---|---|---|
| `--brand-st-backlog` | `#7E8A91` | 3.54:1 | `#6C777E` | 4.59:1 | 202.1° |
| `--brand-st-progress` | `#B4690E` | 4.23:1 | `#AC640D` | 4.58:1 | 32.9° |
| `--brand-pri-low` | `#4A7FB5` | 4.20:1 | `#4779AD` | 4.56:1 | 210.3° |

`--brand-st-progress` sits inside the brief's authorised amber family (30–45°).
`--brand-st-backlog` and `--brand-pri-low` are grey-cyan and azure; the brief
names hue families for teal and amber only, so for these two the instruction was
read literally — hue and saturation exactly preserved, lightness alone moved.
`tokens.css` carries the corrected values, so the two files agree.

### 6.5 Owner ruling — decision closed

**Two tokens are held at the brief value and still measure 1.84:1:**
`--brand-st-canceled` and `--brand-pri-none`, both `#B8C0C5`.

Applying the §6 remedy to them lands both on `#697881` (4.56:1). The corrected
`--brand-st-backlog` lands on `#6C777E` (4.59:1). **Those two greys differ by
3/255 in red, 1/255 in green and 3/255 in blue** — below the threshold of
reliable discrimination. Darkening `canceled` and `none` would therefore
collapse a three-step grey ladder (canceled → backlog → todo) into two
indistinguishable steps, breaking the 7-state mapping that the brief fixes as
*“one mapping each, never mixed”*. Two hard requirements conflict; the smaller
one was escalated rather than resolved silently.

The §6 target is scoped to *“when used as text”*, and §2 itself defines these two
as the non-text / weakest tier:

- `none` — §2 priority rule: rendered as a **grey dash, no colour used**;
- `canceled` — §2: `#B8C0C5` is the disabled / weakest value.

No third option keeps both the AA-as-text target *and* the grey ladder, which is
why this was escalated as a decision rather than resolved as a calculation.

**Owner ruling — Option 1 ACCEPTED. Decision closed.**

1. **Accept as-is — ✔ ACCEPTED.** `--brand-st-canceled` and `--brand-pri-none`
   remain `#B8C0C5`. The other five light status values and four light priority
   values all clear AA (≥ 4.5:1) and ship as corrected in §6.4.
2. **Harden both to `#697881`, backlog to `#55636B` — ✘ NOT adopted.** Recorded
   above for context only; do not apply.

**Rationale.** These two tokens are the *absence tier*: `canceled` is the
disabled / weakest value and `none` is a grey dash that uses no colour. They are
non-text markers — a dot, a stripe — and are always accompanied by a text label,
so colour is never the sole carrier of the meaning. Darkening them would collapse
the three-step grey ladder (canceled → backlog → todo) that the fixed 7-state
mapping depends on, and would buy no accessibility in return.

**Rule for implementers.** The two `#B8C0C5` swatches are for **non-text markers
only**. When a canceled or none state must render as *text*, use `--brand-text-2`
(`#4A555E`) or `--brand-text-3` (`#7E8A91`) instead — never `#B8C0C5`.

**Status:** ruling dated 2026-10-08, by Jobs (design owner). No further action open.
Carried into v2 unchanged; the v2 remaster touched no colour.

---

## 7. v2 change record

The remaster is **narrative and mark only**. Every token, ratio and typographic
rule in this document is carried over from v1 untouched.

| # | dimension | v1 | v2 |
|---|---|---|---|
| 1 | **Product name** | TaskPanel | **meerkat-taskpanel** |
| 2 | **Positioning** | a calm command surface for AI-agent teams | **a sentinel watch for AI-agent teams** |
| 3 | **Narrative** | glanceable command surface | **mobbing (parallel agents) + sentry rotation (patrol / alert / heartbeat)** |
| 4 | **Mark name** | Signal Bars | **Sentinel Watch** |
| 5 | **Mark reading** | three rising columns = board progression; the dot = the delivered node | three **upright meerkats** of a mob, left-low to right-high; the tallest is **on duty**; the dot = **the watch signal** |
| 6 | **Mark skeleton** | three rising forms, bottom-aligned at `y=27`, plus a node above the tallest | **unchanged** — same three-form skeleton, same baseline, same "dot clear of the tallest" rule |
| 7 | **Mark geometry** | `6`-wide capsule columns `rx=3` at `x=5/13/21`, node `r=2.75` at `(24,6)` | `5.2`-wide capsule bodies `rx=2.6` at `cx=7.2/16/24.8`, plus head `r=2.6` and ears `r=0.85`; watch dot `r=1.7` at `(24.8, 5.2)` |
| 8 | **Small-size behaviour** | three rising bars + dot | three rising **round-headed** bars + dot (ears fall below 1px by 32px) |
| 9 | **Palette** | teal `#0F7A73` / ink `#14181B` (+ dark lifts) | **unchanged** — same two roles, same values, no colour added |
| 10 | **Typography / spacing / radius / motion** | see §3, §4 | **unchanged** |
| 11 | **Design philosophy** | *Signal Order* | ***Vigil Order*** — see `brand-philosophy.md` |
| 12 | **New asset** | — | `compare-v1-vs-meerkat.png` |

**What did not change, on purpose.** The composition contract is preserved: three
forms rising left-to-right on one baseline, the tallest carrying the brand line
and a detached signal above it. Anyone who knew the v1 mark will recognise the
v2 mark instantly; anyone new will read it as a row of animals on watch. That is
the intended continuity — a rename and a species, not a new geometry.

---

## 8. Delivery checklist

| file | what it is |
|---|---|
| `BRAND.md` | this document — positioning, palette, type, tokens, AA audit, logo spec, v2 change record |
| `tokens.css` | the single source of truth — daisyUI v5 `--color-*` + v4 aliases + brand extensions |
| `logo.svg` | brand mark, light duotone, transparent ground |
| `logo-dark.svg` | the same mark for dark grounds, transparent |
| `logo-mono.svg` | single-colour mark via `currentColor` |
| `logo-512.png` / `logo-512-dark.png` | 512×512, transparent |
| `logo-1024.png` / `logo-1024-dark.png` | 1024×1024, transparent |
| `favicon-32.png` / `favicon-16.png` | favicon sizes, duotone on transparent |
| `brand-philosophy.md` | canvas-design step ① — the *Vigil Order* philosophy |
| `brand-poster.png` | canvas-design step ② — 1600×2000 brand plate |
| `compare-v1-vs-meerkat.png` | 1600×900 before/after — v1 Signal Bars vs v2 Sentinel Watch |
| `DIFFERENCE-dashi.md` | side-by-side separation from dashi-taskboard |

Evidence is reproducible rather than archived: the generators live in the brand
task workspace outside the repo, and re-running one regenerates its artefact on
the spot — `render-logo.mjs` rewrites the three SVGs and all six logo PNGs,
`render-poster.mjs` rewrites `brand-poster.png`, `render-compare.mjs` rewrites
`compare-v1-vs-meerkat.png`, `verify-contrast.mjs` rewrites its `contrast.txt`
transcript, and `verify-brand.mjs` re-asserts the mark's geometry and the
static-SVG contract. No machine-local path is recorded here, so the scripts stay
portable.

**Notes**

- §6.5 owner ruling: Option 1 accepted — `canceled` / `none` stay `#B8C0C5`, for
  non-text markers only.
- The PNG rasters are produced with scripting disabled in the rendering browser,
  which is also the evidence for the "visible with JS off" requirement: the
  browser is given no JavaScript at all and still paints the mark.
