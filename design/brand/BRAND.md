# TaskDashboard — Brand Layer v1

> **Token authority.** `tokens.css` in this directory is the single source of
> truth. This document quotes it and adds the reasoning; where the two could
> ever disagree, `tokens.css` wins and this file is the bug.
> Values are fixed by `brief.md` §2–§4, with three light-mode corrections
> applied under §6 and listed in [WCAG AA verification](#wcag-aa-verification).

---

## 1. Positioning

**English.** TaskDashboard — a calm command surface for AI-agent teams: one
glance to see every task, every agent, every handoff.

**中文.** TaskDashboard —— 为 AI Agent 团队打造的安静指挥面：一眼看清每个任务、每个
agent、每次交接。

**Style.** *Quiet Precision / 安静精确* — a workhorse UI, not a marketing page.
Restrained density. Whitespace carries the hierarchy. One primary line colour.
Hairline borders. Zero ornamental surplus. If an element cannot justify the space
it occupies, it is removed rather than styled.

---

## 2. Palette

Every value below is reproduced from `tokens.css`. The token name in the left
column is the canonical CSS custom property; daisyUI v5 also reads the
`--color-*` aliases, which `tokens.css` defines alongside the v4 legacy names
(`--p`, `--b1`, …).

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

¹ corrected under `brief.md` §6 — see [§6.3](#63-applied-corrections).
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

## 5. Logo — “Signal Bars”

**Concept.** Three rounded columns stepping left-low to right-high — the board’s
own progression, backlog → in progress → done. The tallest column is capped by a
single dot: the completed node, the agent that delivered. Read together the mark
is a rising signal: **task progression + live signal**. It is abstract enough to
survive 16px, and it carries no letterform, so it needs no localisation.

**Geometry** (viewBox `0 0 32 32`, absolute; fixed by `brief.md` §5).

| element | x | y | w | h | rx | fill (light) | fill (dark) | fill (mono) |
|---|---|---|---|---|---|---|---|---|
| bar1 | 5 | 17 | 6 | 10 | 3 | `#14181B` | `#E6EDF0` | `currentColor` |
| bar2 | 13 | 12 | 6 | 15 | 3 | `#14181B` | `#E6EDF0` | `currentColor` |
| bar3 | 21 | 10 | 6 | 17 | 3 | `#0F7A73` | `#2AA79B` | `currentColor` |
| node | cx 24 | cy 6 | r 2.75 | — | — | `#0F7A73` | `#2AA79B` | `currentColor` |

All three columns are bottom-aligned at `y = 27`. `rx = 3` is exactly half the
6-unit width, so every column is a true capsule with fully round ends. No frame,
no gradient, no shadow. The node sits 1.25 units clear of the tallest column, so
the two never touch — that gap is what makes the dot read as separate and
delivered rather than as a cap on the bar.

**Files.**

| file | ground |
|---|---|
| `logo.svg` | light — ink columns, teal accent |
| `logo-dark.svg` | dark — base-content columns, lifted teal |
| `logo-mono.svg` | single colour via `currentColor`, any surface |

---

## 6. WCAG AA verification

Computed by `verify-contrast.mjs` out of the box — pure node, no dependencies,
no install step — against the WCAG 2.1 relative-luminance definition. That script
*is* the evidence: re-run it to reproduce every ratio below, and it rewrites its
own `contrast.txt` transcript as it goes. **48 pairs checked — 46 PASS, 2 held by
owner ruling** (see §6.5).

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

Three light-mode values failed the §6 target. `brief.md` §6 permits a mechanical
correction that keeps the hue and moves only lightness; these are the smallest
8-bit steps that clear **4.5:1 with a 0.05 margin** (so no value can round back
below AA). Hue and HSL saturation are unchanged in all three.

| token | before | was | after | now | hue held |
|---|---|---|---|---|---|
| `--brand-st-backlog` | `#7E8A91` | 3.54:1 | `#6C777E` | 4.59:1 | 202.1° |
| `--brand-st-progress` | `#B4690E` | 4.23:1 | `#AC640D` | 4.58:1 | 32.9° |
| `--brand-pri-low` | `#4A7FB5` | 4.20:1 | `#4779AD` | 4.56:1 | 210.3° |

`--brand-st-progress` sits inside the brief’s authorised amber family (30–45°).
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
indistinguishable steps, breaking the 7-state mapping that `brief.md` §2 fixes as
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

---

## 7. Delivery checklist

| file | what it is |
|---|---|
| `BRAND.md` | this document — positioning, palette, type, tokens, AA audit, logo spec |
| `tokens.css` | the single source of truth — daisyUI v5 `--color-*` + v4 aliases + brand extensions |
| `logo.svg` | brand mark, light duotone, transparent ground |
| `logo-dark.svg` | the same mark for dark grounds, transparent |
| `logo-mono.svg` | single-colour mark via `currentColor` |
| `logo-512.png` / `logo-512-dark.png` | 512×512, transparent |
| `logo-1024.png` / `logo-1024-dark.png` | 1024×1024, transparent |
| `favicon-32.png` / `favicon-16.png` | favicon sizes, duotone on transparent |
| `brand-philosophy.md` | canvas-design step ① — the *Signal Order* philosophy |
| `brand-poster.png` | canvas-design step ② — 1600×2000 brand surface |
| `DIFFERENCE-dashi.md` | side-by-side separation from dashi-taskboard |

Evidence is reproducible rather than archived: the generators below live in the
brand task workspace outside the repo, and re-running one regenerates its
artefact on the spot — `node verify-contrast.mjs` rewrites its `contrast.txt`
transcript, `render-logo.mjs` rewrites all four logo PNGs, `render-poster.mjs`
rewrites `brand-poster.png`. No machine-local path is recorded here, so the
scripts stay portable.

| file | what it is |
|---|---|
| `verify-contrast.mjs` | the WCAG audit — pure node, no dependencies |
| `contrast.txt` | its full terminal output |
| `render-logo.mjs` | rasterises the mark to the four PNG sizes |
| `render-poster.mjs` | lays out and rasterises `brand-poster.png` |

**Notes**

- §6.5 owner ruling: Option 1 accepted — `canceled` / `none` stay `#B8C0C5`, for
  non-text markers only.
