# MeerkatTaskPanel — Design Specification (v1 prototype)

> Implemented from `design-style-guide.md` (visual tokens — single source of truth)
> and `design-spec.md` (structure, blocks, interactions, coverage), as amended by
> `design-spec-addendum-v1.1.md` (access model, top bar, i18n),
> `design-spec-addendum-v1.2.md` (sidebar-footer switches, access-model rewrite) and
> `design-spec-v1.3.md` (footer split into three equal thirds; theme and language become
> dialogs alongside settings), and then by **R3** — `design-spec.md` (brand re-skin,
> the brand mark, rename to MeerkatTaskPanel) together with `design-spec-r3-addendum.md`
> (daisyUI componentisation, the assignee/reporter controls, the two-column create
> dialog and the Markdown editor).
> Every value below is copied from those documents. **Nothing here is invented**;
> §9 records every point where the two documents disagree and what was chosen,
> §14 records the judgement calls the v1.1 addendum left open, §15 the v1.2 round,
> §16 the v1.3 round and §18 the R3 round.
> **R3 is the first round to change colour.** From R3 the single source of truth for
> every colour is `design/brand/tokens.css`; `design-style-guide.md` no longer governs
> the palette, and §9 is kept as the record of the pre-R3 reconciliation.

---

## 1. Style direction

**Quiet Precision** — a workhorse UI for an AI-agent team, not a marketing page.

- Information density serves "scan one project in one glance". 4px grid, tightened
  but not crowded.
- Hierarchy comes from spacing and section boundaries — never from stacked colour
  blocks or shadows.
- Exactly **one accent** (teal `#0F7A73`). Every other colour is a semantic signal
  (status / priority / risk) and never decoration.
- Hairline 1px borders on white surfaces. **Cards carry zero shadow**; only
  overlays (dropdown, modal, drawer, toast) use the single `--shadow-pop`, whose
  **dark variant is overridden** so the elevation stays visible on a dark canvas
  (§24).
- Identifiers, times and counts are tabular monospace — vertical alignment is the
  "precision" cue.
- No gradients, no illustration-style empty states, no large radii, no emoji icons.
  Icons are inline SVG, linear stroke 1.5.
- Agents and humans are visually distinguishable without a second theme:
  dashed ring + semantic platform badge, same palette.
- The mark is **Sentinel Watch** — three upright meerkats of a mob rising left-low
  to right-high, the tallest on duty and carrying the brand line, with one watch
  signal floating clear above it. Its eyes and mouth are cut as **negative-space
  knockout** (candidate A «Pin · 克制»), so the mark still restores to one colour in
  the mono state and the outer silhouette never moves; the watch signal stays outside
  the mask and is always solid. The face reads clearly from 128px up, is only just
  perceptible at 48–96px, and degenerates to the plain V2 silhouette by 32px. It is
  drawn from `design/brand/BRAND.md` §5, reads its two fills from `--color-td-ink`
  and `--color-td-accent`, and appears in the top bar, in the large empty state and
  as the favicon.

**Anti-patterns (a presence is a fail):** gradient buttons · full-screenshot pill
radii · coloured section blocks · multiple accents · shadow-floating cards ·
emoji as icons · high-saturation backgrounds.

---

## 2. Colour tokens

**Source: `design/brand/tokens.css`** — the brand single source of truth. Every
value below is reproduced from it; from R3 that file wins any disagreement.

### 2.1 Neutral & surface

| Token | Value | Used for |
|---|---|---|
| `--color-td-bg` | `#F5F6F7` | application background |
| `--color-td-surface` | `#FFFFFF` | cards, panels, column containers, top bar |
| `--color-td-sunken` | `#F5F6F7` | sidebar, column slot, inline code |
| `--color-td-hover` | `#F0F2F3` | hover surface |
| `--color-td-active` | `#E6E8EB` | pressed / selected surface |
| `--color-td-line` | `#E6E8EB` | hairline border |
| `--color-td-line-strong` | `#CFD5D9` | emphasis border, drop target |
| `--color-td-ink` | `#14181B` | primary text |
| `--color-td-ink-2` | `#4A555E` | secondary text |
| `--color-td-ink-3` | `#7E8A91` | tertiary / placeholder / meta |
| `--color-td-ink-4` | `#B8C0C5` | disabled / weakest |

### 2.2 Brand & semantic

| Token | Value | Used for |
|---|---|---|
| `--color-td-accent` | `#0F7A73` | primary button, selection, links, focus |
| `--color-td-accent-hover` | `#0D6B65` | accent hover |
| `--color-td-accent-soft` | `rgba(15,122,115,0.10)` | selected surface / tint |
| `--color-td-danger` | `#C0392B` | error / blocked |
| `--color-td-danger-soft` | `#FBEEEC` | error surface |
| `--color-td-warning` | `#8A5A00` | warning text |
| `--color-td-success` | `#187A4C` | success / done |
| `--color-td-focus` | `rgba(15,122,115,0.35)` | keyboard focus halo |

**Web-layer names for the accent pair (R6, 2026-10-12).** The board's stylesheet
(`web/src/styles/tokens.css`) carries the accent under a name of its own —
`--brand-accent` and `--brand-accent-soft` — in addition to daisyUI's
`--color-primary`. Same values as the two rows above (`#0F7A73` /
`rgba(15,122,115,0.10)`; dark `#2AA79B` / `rgba(42,167,155,0.10)`), and
deliberately a second name: `--color-primary` says *this is the primary action*,
while a **selection** — the pressed view tab, the current nav row, a status chip —
is not an action. Before R6 the board had no accent token at all, so every
selection was painted with the grey `--brand-active`; the four surfaces that read
the accent now read this pair.

### 2.3 Status — 7 values, one mapping, never mixed

| status | token | value | label | expression |
|---|---|---|---|---|
| `backlog` | `--color-td-st-backlog` | `#6C777E` | Backlog | 8px dot in the column head, 3px stripe on the card |
| `todo` | `--color-td-st-todo` | `#5A6B75` | To Do | ″ |
| `in_progress` | `--color-td-st-progress` | `#AC640D` | In Progress | ″ |
| `in_review` | `--color-td-st-review` | `#6E56CF` | In Review | ″ |
| `blocked` | `--color-td-st-blocked` | `#C0392B` | Blocked | ″ |
| `done` | `--color-td-st-done` | `#187A4C` | Done | ″ (title weakens to `--color-td-ink-3`) |
| `canceled` | `--color-td-st-canceled` | `#B8C0C5` | Canceled | ″ (title also struck through) |

`canceled` is the **non-text** tier (`BRAND.md` §6.5, owner ruling): `#B8C0C5` is for a
dot or a stripe and is never set as text. Where a canceled state has to read as text it
uses `--color-td-ink-2` or `--color-td-ink-3`.

### 2.4 Priority — 5 levels, colour **plus** shape

| priority | token | value | shape |
|---|---|---|---|
| `urgent` | `--color-td-pri-urgent` | `#C0392B` | solid square + colour |
| `high` | `--color-td-pri-high` | `#A1641A` | solid square + colour |
| `medium` | `--color-td-pri-medium` | `#8A5A00` | outlined square + colour |
| `low` | `--color-td-pri-low` | `#4779AD` | outlined square + colour |
| `none` | `--color-td-pri-none` | `#B8C0C5` | grey dash, **no colour** (noise reduction) |

`none` carries the same non-text rule as `canceled` above: it is a grey dash, and when
it has to render as text it uses `--color-td-ink-2` / `--color-td-ink-3`.

Priority is never colour-only: the glyph shape differs per level, the element
carries `role="img"` + `aria-label="Priority: High"` and a `title` tooltip.

---

## 3. Typography

| Role | Family | Size | Weight | Line height |
|---|---|---|---|---|
| App body (base) | sans | 14px | 400 | 1.5 |
| Card title | sans | 14px | 500 | 1.35 |
| Section / panel title | sans | 16–20px | 600 | 1.35 |
| Meta, labels, chips | sans | 12px | 400/500 | 1.5 |
| Badges, counters | mono | 11px | 500 | 1.5 |
| IDs, session ids, versions, counts | mono | 11–12px | 400 | 1.5 |

- Sans stack: `"Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`.
- Mono stack: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
  with `font-variant-numeric: tabular-nums`.
- **Inter** and **JetBrains Mono** are *preferred*, not loaded: the prototype ships no
  web font and makes no network request, so the stack degrades to the system faces when
  neither is installed. The size ladder and the weights are unchanged by R3.
- Ladder is `11 / 12 / 13 / 14 / 16 / 20 / 24`. **14px is the interface baseline**;
  12px is meta; 11px is badges only; ≥16px is headings only.
- The 13px step exists for dense controls (inputs, selects, menu items, drawer body).

---

## 4. Spacing, layout, radius, elevation, motion

Base grid **4px**; ladder `4 8 12 16 20 24 32 40 48`.

| Layout token | Value |
|---|---|
| Sidebar | `248px` (icon rail `64px` ≤1023px, `56px` ≤559px) |
| Top bar height | `56px` |
| Content padding | `20px 24px` |
| Board column | `300px` wide, `16px` gap, column slot padding `8px`, card gap `8px` |
| Detail drawer | `520px` from the right; full width <760px |
| Scrim | `rgba(22,22,26,0.32)` |

Radius: `--r-sm 4px` (chip/badge) · `--r-md 6px` (button/input/card) ·
`--r-lg 8px` (panel/drawer) · `--r-full 999px` (avatar/count dot).

Elevation: **one** token, `--shadow-pop = 0 8px 24px rgba(22,22,26,0.10), 0 1px 2px rgba(22,22,26,0.06)`,
used only by dropdown, modal, drawer and toast. Cards are flat.

Motion: `120ms` hover/press · `180ms` drawer/modal · easing
`cubic-bezier(0.2, 0, 0, 1)`. Only opacity / transform / border-colour are
animated. Drag: the source card drops to `opacity .5`, the target column shows a
`2px dashed var(--color-td-line-strong)` border plus a placeholder bar.
`prefers-reduced-motion: reduce` collapses every duration to 1ms.

---

## 5. Component states

| Component | States implemented |
|---|---|
| Button | default / hover / active / focus-visible / disabled / loading (`.is-loading` spinner) |
| Input, Select, Textarea | default / hover / focus / filled / disabled / invalid (`aria-invalid="true"` → danger border) |
| Task card | default / hover (border deepens, **no shadow**) / focus-visible / selected (`aria-selected` → 2px accent ring) / dragging (`data-dragging="true"` → opacity .5) / done / canceled |
| Column | default / drag-over (2px dashed) / empty (dashed placeholder + copy) / count badge |
| Chip | default / label / status (dot + text) / muted (`none` priority, grey dash) |
| Avatar | human (monogram) / agent (dashed ring + platform badge) |
| Drawer / Modal | open / closing (`data-state`) / inner scroll (`.td-drawer-body`) |
| Toast | info / success / danger, auto-dismiss after 2.5s |
| Skeleton | 1.4s linear shimmer |
| Empty state | icon + one primary line + one secondary line + primary action |
| Error state | danger-soft surface + danger icon + one primary line + one secondary line + `Retry` (`role="alert"`) |
| States gallery | hidden by default · `data-state` open/closed · `Esc` / scrim / close button dismiss |

---

## 6. Accessibility baseline

- Body text ≥4.5:1, meta ≥3:1 (the palette above is chosen to that floor).
- Every interactive element has a visible `:focus-visible` ring: 2px accent outline
  plus a 4px `--color-td-focus` halo.
- Status and priority are never colour-only: dot + label, or shape + `aria-label`.
- Cards are keyboard reachable — the card title is a real `<button>`, so `Tab`
  reaches it and `Enter`/`Space` opens the detail natively (no key simulation).
- Landmarks: `header` / `nav` / `main` / `aside` / `section` / `dialog`; icon-only
  buttons carry `aria-label`; the toast region is `role="status" aria-live="polite"`.

---

## 7. Themes

Three states, cycled from the **sidebar footer** (the top bar carries no theme control):
**Light → Dark → Auto → Light**, one press each.

| State | `<html>` attributes | Resolved by |
|---|---|---|
| **Light** (default) | `data-theme="meerkat-taskpanel"` · `data-theme-mode="light"` | explicit — fixed |
| **Dark** | `data-theme="dark"` · `data-theme-mode="dark"` | explicit — fixed |
| **Auto** | `data-theme="auto"` · `data-theme-mode="auto"` | `@media (prefers-color-scheme: dark)` |

`data-theme-mode` is the machine-checkable state; `data-theme` is what the CSS reads.
Light keeps the theme name `meerkat-taskpanel`, so the no-JS document and the **no-record
default** are the same thing: **Light** — not "follow the system". Auto is the only
state that follows the system, and the media query is the only thing that resolves it:
`app.js` never reads `matchMedia` and never writes storage (§21). Picking Light or Dark
therefore *leaves* Auto behind — an explicit choice is fixed.

Every state is a custom-property override — no component knows which theme is active.
Dark values come from `design/brand/tokens.css`'s `[data-theme="dark"]` block. Since R3
the status and priority ramps are **dark-specific**: they are no longer the light values
reused.

CSS has no way to share one declaration list across a media boundary, so the dark token
block is written **twice** in `src/input.css`: once for `html[data-theme="dark"]`, and
once inside `@media (prefers-color-scheme: dark)` for `html[data-theme="auto"]` (with
daisyUI's generated dark tokens repeated in the same block). **The two must be edited
together.** Both live outside every cascade layer — unlayered declarations outrank
layered ones — so they beat the `:root` block and daisyUI's `@layer base` output.

**R8 — the veil, the edge and the elevation are theme-scoped too.** The dark block
carries three overrides the light one does not need, all in the same pair of blocks:
`--scrim` deepens to `rgba(0, 0, 0, 0.55)` (the light `rgba(15, 20, 23, 0.32)` cannot
push a `#0f1417` canvas back), `--shadow-pop` becomes a black double shadow (a shadow
tinted from the canvas is invisible *on* the canvas), and the dialog panel's edge reads
`--color-td-line-strong` instead of `--color-td-line` (`#1f262a` sits almost exactly on
both the canvas and the panel surface, so the dialog had no readable edge). The light
values are untouched. See §24.

---

## 8. daisyUI integration

daisyUI 5 emits its component CSS into **nested sub-layers of `@layer utilities`**.
A rule placed in `@layer components` would therefore always lose to daisyUI,
whatever its specificity. The app component layer in `src/input.css` is
consequently declared inside `@layer utilities` **after** the daisyUI plugin, so:

```
theme < base < components < utilities ┊ daisyui.* < app components < tailwind utilities
```

Two custom themes are registered: **`meerkat-taskpanel`** (light, default) and **`dark`**.
Since R3 every daisyUI component class is the component's shell and the matching
`td-*` rule is a **token override only** — see §18.2 for the full mapping.

**One name collision to know about.** daisyUI reads `--border` as its structural
border *width* knob (`border: var(--border) solid …`). The pre-R3 `:root` alias block
also defined `--border` as a hairline *colour*, and because that block comes later in
the file the colour won: every daisyUI rule using `var(--border)` was invalid at
computed-value time and its border silently collapsed to zero. R3 removed the alias
(§18.1). Never re-introduce a `--border` alias in this file.

---

## 9. Reconciliation — where the two source documents disagree

`design-style-guide.md` and `design-spec.md` were both presented as authoritative
and their token tables do not match. The rule applied here:

1. the task card's hard rules (file layout, closed stack, purity, jQuery slim);
2. `design-style-guide.md` for **all visual values** — colour, type, spacing,
   radius, shadow, motion, component states, a11y (it is explicitly scoped to
   "本卡 = prototype/ v1 高保真原型" and frozen);
3. `design-spec.md` for **structure and behaviour** — block inventory B01–B25,
   `data-*` hooks, content requirements, interactions I1–I12, coverage §7, purity §8.

| # | Item | design-style-guide.md | design-spec.md | Implemented |
|---|---|---|---|---|
| 1 | App background | `#FAFAFB` | `#f5f6f8` | style guide |
| 2 | Accent | `#4F5BD5` | `#4f46e5` | style guide |
| 3 | Surfaces | `#FFFFFF` / `#F4F4F6` | `#ffffff` / `#eef0f4` | style guide |
| 4 | Border | `#E6E6EA` | `#e3e5ea` | style guide |
| 5 | Text ramp | `#16161A / #5B5B66 / #8E8E99 / #B4B4BE` | `#16181d / #5a6270 / #8a92a1 / #b6bcc7` | style guide |
| 6 | `in_progress` | `#D9930D` | `#d97706` | style guide |
| 7 | `in_review` | `#7C6BE8` (purple) | `#0891b2` (cyan) | style guide |
| 8 | `canceled` | `#B4B4BE` | `#9aa1ad` | style guide |
| 9 | Priority ramp | `#E5484D / #E8843D / #D9A721 / #5B8DEF / #B4B4BE` | `#dc2626 / #ea580c / #d97706 / #64748b / #c3c8d1` | style guide |
| 10 | Priority expression | solid / outlined square + dash | double-arrow / arrow / bar / arrow / dashed circle | style guide shapes, plus `title` + `aria-label` from the spec's "not colour alone" rule |
| 11 | Sidebar width | `248px`, rail `64px` | `240px`, rail `56px` | style guide (`64px` rail, `56px` under 560px) |
| 12 | Column width | `300px` | `280px` | style guide |
| 13 | Content padding | `20px 24px` | `16px` | style guide (`16px` ≤979px) |
| 14 | Card hover | border deepens | shadow rises + border | style guide — it lists "shadow-floating cards" as an anti-pattern |
| 15 | Card dragging | opacity .5 + dashed target | rotate 2° + `md` shadow | style guide |
| 16 | Radius scale | `4 / 6 / 8 / 999` | `6 / 8 / 12 / 999` | style guide |
| 17 | Type ladder | `11…24`, base 14, lh 1.5 / 1.35 | `12…24`, base 14, lh 1.5 / 1.3 | style guide (11px is badge-only) |
| 18 | Spacing ladder | `4…48` | `4…40` | style guide |
| 19 | Dark palette | not defined | §2.2 explicit values | design-spec §2.2 (the only non-invented source) |
| 20 | daisyUI theme names | — | `meerkat-taskpanel` / `meerkat-taskpanel-dark` | `meerkat-taskpanel` / **`dark`** — the spec mandates the attribute `data-theme="dark"`, and daisyUI keys its dark theme off `data-theme`, so the palette is registered under the name `dark` |
| 21 | File layout | — | `assets/tw.css`, `assets/app.js`, `assets/vendor/…`, `src.css` | `tw.css`, `app.js`, `vendor/…`, `src/input.css` per the task card's deliverable list (see README "File map") |

Both naming generations are still live in the stylesheet: `src/input.css` exposes
the style-guide short names (`--bg`, `--surface`, `--accent`, `--st-progress`, …)
**and** the design-spec `--td-*` aliases, all pointing at the single set of
`--color-td-*` values. One palette, no duplicated literals.

---

## 10. Team & identity model

MeerkatTaskPanel is a board for an **AI-agent team**, so the people on it are the team
that actually runs the work: six agent roles and the human owner. No invented
personas, and no second identity vocabulary anywhere in the prototype.

| Member | Kind | Platform badge | Role |
|---|---|---|---|
| `elon` | agent | `openclaw` | platform work |
| `jobs` | agent | `claude` | design + prototype work |
| `linus` | agent | `claude` | accessibility, data, CI |
| `turing` | agent | `codex` | backend, realtime, caching |
| `simons` | agent | `claude` | performance, theming |
| `assistant` | agent | `pi` | API surface |
| `Terry` | human | — | owner / reporter |

**Every task has a reporter as well as an assignee.** `Terry` files all 18 tasks
(`data-reporter="Terry"` on every card) and the agents work them, which is what makes
the `created` → `claimed` → `status:` lifecycle in the activity feed readable. The
drawer shows Assignee and Reporter as separate properties.

Identity shows up in exactly one shape per surface:

- **Card footer** — human: a monogram avatar. Agent: the platform badge (dashed, per
  the style guide's "dashed ring + semantic badge") **plus** the role handle in mono,
  so a card always states both *which platform* and *which role* holds it.
- **List row** — the role handle in the assignee column.
- **Drawer** — Assignee (monogram avatar + role + platform badge for agents) and Reporter.
- **Sidebar presence** — one row per platform, listing the roles on it, with a
  running/idle dot. Claude carries three roles (jobs, linus, simons), the others one.
- **Comments and activity** — agents render as mono handles (`jobs`, `elon`, …); the
  human renders as a plain name (`Terry`). At least one comment is the human owner's
  and at least one is a `decision`.
- **Create-task modal** — one option per team member, each carrying
  `data-assignee-kind`, and `data-agent-platform` for the six agents.

`data-assignee` therefore always holds a handle from this table, never a display name,
and `data-agent-platform` always holds one of claude / openclaw / codex / pi.

---

## 11. Review round R1

A design review of v1 asked for two gaps to be closed and one content decision to be
changed. All three are in the build:

1. **Identity model replaced.** The v1 prototype used invented human personas
   (Ana Ruiz, Dev Patel, Mira Chen, Tom Okafor) as assignees. They are gone — see §10.
   Cards, avatars, badges, session blocks, comments, activity, the sidebar presence
   list, the drawer and the create-task modal all speak one identity model now. The 18
   cards, their statuses and their priorities are unchanged.
2. **States completed** — B17 error state (`[data-error-state]`, danger-soft surface,
   wired `Retry`) and B18 states showcase (`[data-states-open]` in the sidebar footer
   opens `[data-states-panel]`, a gallery of loading / empty column / no results /
   error / three toast kinds, dismissible with `Esc` or the scrim). Both reuse the
   existing `data-state` + `hidden` overlay pattern; no new framework.
3. `[data-empty]` and `[data-skeleton]` still work as before — the new hooks are
   additional, not replacements.

The states gallery is a **prototype review surface**, not a product screen: it exists so
every non-default state can be inspected and captured in one frame. `BLOCKS.md` B18
records it as such.

---

## 12. Access model / token

**The board has no accounts.** Anything that named a person *looking at* the app is
gone: no avatar, no user name, no role chip, no account menu, no sign-in entry — in the
top bar, the sidebar or anywhere else. §10 still governs who a task is *assigned* to;
that is a different question from who is *viewing*, and the two no longer share a
component.

What replaced the sidebar identity block is a **stack of controls**, not a reachability
readout. Review round v1.2 moved the display switches out of the bar and into the footer;
v1.3 split the row into three equal thirds; v1.4 made each third act directly — a switch,
a dropdown and an icon button, no dialog between the press and the result. **R7**
(2026-10-12) briefly stacked the three into one full-width row each at *every* width; the
**21:19 revision scoped that stack to the rail**, so the footer is again **one row of three
equal thirds on the desktop column and a stack only at ≤1023px**. The three controls, their
order and their directness never changed (§23):

| Surface | Content |
|---|---|
| Top bar, right end | `[data-revision]` · `[data-new-task]` |
| Sidebar footer `[data-access-status]` | three cells, one affordance each — `[data-theme-switch]` (inline three-state theme cycle) · `[data-lang-select]` (language dropdown) · `[data-access-open]` (icon-only settings). **≥1024px**: one row, left→right. **≤1023px**: three stacked rows, top→bottom |

**One row of three equal thirds at ≥1024px, three stacked rows below (R7, revised
2026-10-12 21:19).** The footer is `display: grid` with
`grid-template-columns: repeat(3, minmax(0, 1fr))` and `align-items: stretch`, so each
`[data-access-cell]` block button owns an equal third of the sidebar column — left to
right: theme · language · settings. A cell is `display: flex; align-items: center;
justify-content: center; gap: 6px; text-align: center`, so glyph and label sit centred in
the third, with a vertical hairline `border-inline-start` separating a cell from its
neighbour (the first cell carries none) and a `:focus-visible` accent ring. At ≤1023px the
container becomes `display: flex; flex-direction: column`: each cell is then a full-width
row with `justify-content: center`, `gap: 0`, `height: 24px` and no padding, and the
separator turns with the layout — a horizontal `border-block-start` on the 2nd and 3rd
cells. A cell is **one line inside at both widths** — icon, label and, on the language
cell, the caret side by side — because R6 ⑦⑧ fixed exactly that; R7 and its revision
changed only the arrangement *between* cells. The theme cell and the language trigger
**state the value in force** — the theme's name (`Light` / `Dark` / `Auto`, 浅色 / 深色 / 自动) beside a sun, moon or display glyph, the
language's short name (`EN` / `中文`) beside a globe and a caret — written by the same
`applyTheme()` / `applyLanguageOptions()` functions the press and the pick call. The
settings cell shows nothing but a gear: it has no visible label at all, and its accessible
name comes from `access.open`, the key the panel always used. `[data-theme-toggle]` and
`[data-lang-toggle]` remain **deleted**, not hidden — what replaced them in v1.4 is a
switch *inside* the theme cell rather than a switch beside it.

**Each row acts directly (v1.4).** The theme cell **is** the control: `[data-theme-switch]`
is a three-state cycle whose press walks `html[data-theme-mode]` `light → dark → auto` (and
back to `light`), swapping `html[data-theme]`, the glyph and the name in the same pass and
reporting a toast. It is a cycle, not a toggle, so it carries no `aria-pressed`: the state
rides on `data-theme-mode` and the accessible name states both the mode in force and the one
a press reaches (§21).
The language cell opens a **menu**, not a dialog: `[data-lang-select]` toggles
`[data-lang-menu]`, the floating list that holds one `[data-lang-option]` per language, and
picking one switches the document and closes the menu. The settings cell is unchanged:
`[data-access-open]` still opens B19.

The top-bar order is exactly the one the v1.2 addendum fixes; the primary action stays
last, and the bar holds **no display-mode control**. **Nothing in the chrome reports
`Local` or `localhost` any more** — the readout, its green status dot and the styles that
drew them are deleted outright, so the old model is not reachable from any selector. The
bind address is stated *inside* B19 instead, as prose, where it can name the value the
board actually binds.

Below 1024px the sidebar is a rail, so the labels drop out with the rest of the sidebar
text and each cell becomes a centred 14px glyph on a 24px line. A third of the 64px rail
(56px under 560px) cannot hold a labelled control, so there the footer stops being a row
and **stacks**: three 24px rows, top to bottom in the same order. Glyphs stack in the rail
with no horizontal overflow at any width, and no cell ever wraps its own contents.

**B19 · Access & token settings** — `[data-access-open]` opens `[data-access-panel]`,
hidden by default and dismissed with `Esc`, the scrim (`[data-access-overlay]`) or
`[data-access-close]`. It uses the same `data-state` + `hidden` overlay contract as the
drawer: `hidden` comes off first so the transition has a frame to start from, and the
panel is only hidden again once the close transition has finished.

**B20 / B21 · Theme and language — retired in v1.4.** The v1.3 dialogs are **deleted, not
hidden**: `[data-theme-modal]` / `[data-theme-choice]` / `[data-theme-close]` /
`[data-theme-overlay]` and `[data-lang-modal]` / `[data-lang-choice]` / `[data-lang-close]` /
`[data-lang-overlay]` are gone from the document, along with the `.td-choices` /
`.td-choice` rows they were built from and the `closeOtherDialogs()` / `DIALOGS` machinery
that kept the three of them mutually exclusive. B19 is the only `role="dialog"` surface
left, and the only one with a scrim. The keys those surfaces owned
(`access.theme.open` · `access.theme.title` · `access.theme.group` · `access.theme.close` ·
`access.lang.title` · `access.lang.close` · `access.settings`) are deleted from both
catalogues with them.

**The language menu is a menu.** `[data-lang-menu]` is a plain `.menu` list at the end of
the document — a sibling of the card's "Move to" list, not a child of the cell that opens
it — positioned `position: fixed` above the trigger by `openLangMenu()`. That is the one
non-obvious mechanic in this round: the sidebar is a scroll container (`overflow-y: auto`),
so an absolutely positioned menu inside it would be clipped at the sidebar's edge and would
drag a horizontal scrollbar along with it, which is exactly what the rail cannot afford.
The trigger's box is read in viewport coordinates, which is what `position: fixed` measures
against. The chosen language is marked by `aria-pressed="true"`, accent copy and a tick,
the same three signals the retired `.td-choice` row used.

The panel states the model in the order the v1.2 addendum gives it:

1. `Access` — the panel title.
2. **Binding**: `Binds to 0.0.0.0 by default — reachable from other devices on the
   network.` The board is *not* local-only; it answers on every interface, and the two
   controls below are what narrow that back down.
3. **CIDR whitelist** `[data-cidr-whitelist]` — `Allowed source ranges (CIDR). Traffic
   outside these ranges is rejected.` under it, a `[data-cidr-add]` button beside it, and
   a `[data-cidr-list]` of `[data-cidr-row]`s: `[data-cidr-value]` (an editable input)
   plus `[data-cidr-remove]`. Three ranges ship seeded — `192.168.0.0/16` (LAN),
   `10.0.0.0/8` (LAN) and `203.0.113.0/24` (public). Adding appends one empty row and
   focuses its input; removing drops the row it belongs to.
4. **Token rule**: `Requests from outside localhost must present the token.` — localhost
   is the one source that is exempt, every other source must present the token *and* come
   from a whitelisted range.
5. `[data-token-block]` — the stand-in credential:

| Hook | Behaviour |
|---|---|
| `[data-token-value]` | the token, masked as `td_••••••••••••` — the `td_` prefix stays readable |
| `[data-token-reveal]` | toggles the mask only; `aria-pressed` and `data-token-revealed` carry the state |
| `[data-token-copy]` | reports `Token copied` in a toast. **It does not touch the clipboard** |
| `[data-token-reset]` | mints a new stand-in, shows it unmasked, reports `Token reset` |

Captions: `Generated randomly at install time.` / `Keep it private — do not share publicly.`

**Open defect, carried in from v1.1 (not introduced here, not fixed here).** The reveal
control's two glyphs are inline SVG, and SVG elements have no `hidden` IDL attribute:
`renderToken()` writes `.prop("hidden", …)`, which lands on a JS expando, so the
`[hidden]` rule never matches and the eye glyph does not swap on reveal — only the mask
does. The v1.2 theme switch, which is new code in the same file, therefore toggles the
*attribute* instead (`showGlyph()` in `app.js`). The token glyph swap needs its own card;
the token block is otherwise untouched by v1.2.

**The CIDR whitelist is a UI placeholder too.** `[data-cidr-add]` and `[data-cidr-remove]`
build and drop rows in the DOM and nothing else: no range is parsed, validated, compared
or matched against anything, and no value is stored or sent. Its aria-label and title
copy is keyed like all other copy, so rows added at runtime translate on the next
language switch.

**This is a UI placeholder and nothing else.** The value is generated in `app.js` from
`Math.random()` and `Date.now()`, stretched through a Lehmer step so it reads like a
credential and differs on every reset. It lives in `state.token` for the lifetime of the
page and is written to the DOM and nowhere else: no storage API, no transport, no
clipboard, no credential or endpoint of any kind, and no persistence across reloads.
`Reset` is the only thing that changes it.

---

## 13. i18n

**English is the default** (`<html lang="en">`). The `中文` option in the **language menu**
(the dropdown behind the footer's language cell) switches to Chinese and back; the active
option carries `aria-pressed`, the trigger always shows the language in force, the options
name their own language (`English` / `中文`) in *both* catalogues, and the menu carries an
`aria-label` from the catalogue.

**One catalogue, in memory.** `app.js` holds `MESSAGES = { en: {…}, zh: {…} }` — **209
keys per language, mirrored 1:1** (a test asserts the two key sets are identical). No
external file, no fetch, no build step; `text()` resolves against the active language,
falls back to English and then to the key itself, so a missing translation shows up as
visible copy rather than an empty element.

**Hooks.** `data-i18n` sets text; `data-i18n-placeholder`, `data-i18n-aria-label` and
`data-i18n-title` set the three attributes; `data-i18n-arg` fills a `%s` in the string
and is itself resolved as a key first — so `column.add` + `status.todo` reads
`Add task to To Do` in English and `在待办中新建任务` in Chinese from **one** key pair
instead of fourteen.

**Coverage.** Every user-visible string is keyed in that catalogue: the markup hooks carry
the static copy and `app.js` composes the rest (toast sentences, list rows, card aria
labels, the token mask) from the same table. Top bar (brand, switcher,
search, view, revision, primary action) · sidebar nav, project list,
agent presence, legend, the three footer controls · the filter bar including
**every** `<option>` · all seven column headers **and** their empty-column messages and
add-button labels · the no-results empty state · the list view · the drawer (section titles, property
labels, relation labels, comment role chips, relative timestamps, session block,
buttons) · both modals · the error state · the states gallery · the token panel ·
every toast, including the ones `app.js` composes at runtime.

**Switching** rewrites the document in one pass (`translateTree`), then regenerates the
copy `app.js` owns — card aria/titles, the drawer's status and priority *values*, list
rows, the token mask, and the names in the theme and language footer cells — and follows
with `<html lang>`, a filter pass (the result counter lives in the copy) and a toast **in
the new language**.

Two details worth recording:

- The drawer body is copied out of an inert `<template>`, which the document pass cannot
  reach, so it is translated the moment it lands in the drawer — the templates carry the
  same hooks as everything else.
- The English text in the markup **is** the default rendering: what a JavaScript-free
  reader sees is exactly what the `en` catalogue produces.

Chinese copy is plain and verb-first, matching the English tone (§4 of the style guide).
Identifiers, role handles, platform names, project names, card labels, task titles,
file names, comment bodies and `--agent-platform` values stay as authored — they are
data, not chrome.

---

## 14. Review round v1.1

The addendum asked for the access model, the top-bar change and bilingual copy. All
three are in the build, plus five judgement calls worth recording:

1. **Identity removed from the chrome.** `[data-user]` and its `.td-user` /
   `.td-avatar-lg` styles are gone; the sidebar footer now reports reachability and
   hosts the access entry. The assignee model in §10 is untouched.
2. **B19 added** — see §12.
3. **i18n added** — see §13.
4. **`[data-lang-toggle]` is a two-option segmented pair**, not a cycling button or a
   dropdown. The addendum allows a click toggle; a pair makes the current language
   visible and reuses the `[data-view-toggle]` control the top bar already has, so the
   bar gains no new component vocabulary.
5. **Two registered deviations:**
   - **760–779px.** With the language switch in it, the single-row top bar needs ~776px,
     so below that it would push the page wide — which §2.4 forbids at every width. In
     that 20px band only, the bar wraps and the shell lets its first row grow (one
     media query, `min-width: 760px and max-width: 779px`). The ≥780 and ≤759 layouts are
     byte-for-byte unchanged. *(v1.2 note: the switches this band was sized around have
     left the bar, so the band rule may now be removable — it is **kept as reviewed**
     rather than re-tuned, since re-flowing that band was not part of the v1.2 remit.)*
   - **Focus into an opened panel is deferred by one transition length.** A panel is
     still computed `visibility: hidden` on the frame it opens, so focusing a control
     inside it then is silently a no-op. The deferral is shared by the drawer, the states
     showcase and the access panel, which fixes the same latent no-op the R1 drawer and
     states panel had. No visual change.

Two dead entries inherited from the R1 copy map (`placeholder.newProject` and the
`toast.blocked` sentence, referenced by nothing) were dropped while the catalogue was
being restructured.

---

## 15. Review round v1.2

The v1.2 addendum (Terry, 2026-10-08 21:47/21:49) asked for three things: the two display
switches moved out of the top bar and into the sidebar footer, the bind-address readout
removed, and the B19 access model rewritten around a `0.0.0.0` bind plus a CIDR whitelist.
All three are in, with four judgement calls worth recording:

1. **The footer row is one row at ≥1024px and a stack below it.** §12 fixes the order
   (theme · language · access) and the compactness. The rail is 64px (56px under 560px),
   too narrow for a horizontal `EN` / `中文` pair, so at ≤1023px the three controls stack
   and the pair itself turns vertical. This is a layout accommodation for the existing
   rail, not a new token or a new component: the rail's own geometry is unchanged and no
   width overflows. **This breakpoint discipline is exactly what the footer carries again
   after R7's revision** (§23) — R7 removed it for one round, and the 21:19 revision put it
   back; the phrasing here ("the three controls stack") describes v1.2's segmented pair,
   while R7's contribution is that the rail's stacked cells became centred 24px icon rows.
2. **The language pair keeps its markup, with reduced chrome in the footer.** In the bar
   it sat in a bordered `.td-seg`; in the footer the container's background and border are
   dropped and its buttons come down to the 24px of the icon buttons beside it, so the
   three read as one cluster. `aria-pressed` still paints the active language — the state
   stays visible, which is what the addendum requires.
3. **The scope rows and the `Local · localhost` readout are gone, not hidden.** The two
   Local/Remote rows, their `.td-access-scopes` / `.td-access-row` / `.td-access-scope` /
   `.td-access-flag` styles and the footer's `.td-access-status-text` are **deleted** from
   both `src/input.css` and the built `tw.css` — the old model is not reachable by any
   selector. The `0.0.0.0` address is now stated once, in the panel, as prose.
4. **The theme glyph actually swaps now.** The v1.1 control toggled its icons with
   `.prop("hidden", …)`, which is a no-op on inline SVG (no `hidden` IDL attribute), so
   the sun never turned into the moon. The v1.2 control toggles the attribute instead.
   This is the one behaviour the round fixes beyond its brief, and only because the brief
   asks for a state-carrying glyph in the new location. **The token block's reveal glyph
   has the identical defect and is deliberately left alone** — see the open-defect note in
   §12; it needs its own card.

Recaptured for this round: `01-board-1512`, `11-viewport-1240`, `13-viewport-760`,
`05-dark-theme`, `19-board-zh`, `15-no-javascript`, plus the access trio
`17-access-panel`, `18-access-token-revealed`, `21-access-panel-dark`. The remaining
captures are the v1.1 files, unchanged: they were not part of the addendum's recapture
list, and the interaction states they show (drawer, menu, filters, modal, states panel)
are not touched by this round — note that where a v1.1 capture includes the sidebar
footer, it still shows the old readout.

Checked and clean across 1512 / 1240 / 980 / 760 / 500 px, with the panel closed and open
and with JavaScript disabled: no page-level horizontal overflow, no sidebar overflow,
7 columns · 18 cards, and zero console errors.

---

## 16. Review round v1.3

The v1.3 spec (Jobs, 2026-10-08, after Elon's rejection of v1.2) asked for two things:
theme and language must open as **dialogs** like the settings panel, and the three footer
entries must be **equal thirds, each centred**. Both are in, with three judgement calls
worth recording.

1. **The three dialogs are one component, not three.** The v1.2 theme button and language
   segmented pair are deleted outright (`[data-theme-toggle]`, `[data-lang-toggle]`, the
   `.td-seg` overrides that dressed them in the footer, and the four catalogue keys their
   labels used). B20 and B21 are built from B19's own classes — `.td-scrim`,
   `.td-access-panel`, `.td-access-head`, `.td-access-body` — so "same style as the
   settings panel" is literally the same rules, not a look-alike. The only new component
   is the `.td-choice` row inside them. No dialog uses `.td-dialog-*` or `.td-option*`:
   those class names never reached `tw.css`.
2. **The footer cell states the value, and the state has one writer.** `applyTheme()`
   writes `html[data-theme]`, the sun/moon glyph **and** the theme's name in the left
   cell; `applyLanguageOptions()` writes the language's name in the middle cell and the
   `aria-pressed` of both `[data-lang-choice]` rows. Because the click handler and the
   document-wide language pass both route through those two functions, a cell and the
   document it describes cannot disagree — including when the language changes while a
   dialog is open.
3. **Equal thirds is a grid, and it survives the rail.** The footer is
   `repeat(3, minmax(0, 1fr))` with `align-items: stretch` and a `border-inline-start`
   hairline between neighbours, so the three cells measure identical widths on every
   viewport. Below 1024px the sidebar is a 64px (56px under 560px) rail: the cells keep
   their thirds and drop their labels with the rest of the sidebar text, leaving three
   centred 14px glyphs that fit the rail without overflow. A wrapped or stacked footer
   would have broken the "three equal thirds" requirement, so the row never wraps.
   `minmax(0, 1fr)` (rather than a bare `1fr`) keeps a long label from pushing a cell
   wider than its third.

   **（经 R7 修订后回正）** — R7 briefly **replaced** this equal-thirds requirement with
   three stacked rows at *every* width; the 2026-10-12 21:19 revision **put the thirds
   back at ≥1024px** and kept the stack for the ≤1023px rail only. So this judgement call
   holds again on the desktop column (including `minmax(0, 1fr)` and its reason), while its
   "the row never wraps" consequence is now true **only above the breakpoint**, and the
   paragraph's "the cells keep their thirds" is **no longer the rail's behaviour** — the
   rail stacks. The round is kept as written above because it is the record of what v1.3
   asked for and why. See **§23** for the change, the revision and their reasons.

Recaptured for this round: `01-board-1512` (the footer's three cells), `11-viewport-1240`,
`13-viewport-760` (the rail's three icon cells), `05-dark-theme`, `19-board-zh`,
`15-no-javascript` (the cells render without JavaScript), `17-access-panel`, and two new
frames — `22-theme-modal` and `23-lang-modal`. `18-access-token-revealed` and
`21-access-panel-dark` are the v1.2 files, unchanged: the token block is not touched by
this round.

Checked and clean across 1512 / 1240 / 980 / 760 / 500 px: no page-level horizontal
overflow, the three footer cells measure equal widths, 7 columns · 18 cards, and zero
console errors.

---

## 17. Review round v1.4

The v1.4 addendum (Jobs, 2026-10-08 22:46, superseding the 22:11 note) kept the three
equal thirds and changed what each one *is*: the theme cell must switch inline, the
language cell must be a dropdown menu, and the settings cell must be an icon with no
visible "Settings" text. All three are in, with three judgement calls worth recording.

1. **The dialogs are deleted, and so is their scaffolding.** The v1.3 round built the
   theme and language choosers out of B19's own chrome, which meant three dialogs sharing
   one `DIALOGS` map, one `closeOtherDialogs()` and one `.td-choice` row. All of that goes
   with them — `openDialog()`, `closeDialog()`, `DIALOGS`, `activeTheme()` and the
   `.td-choices` / `.td-choice` / `.td-choice-label` / `.td-choice-check` rules — and B19's
   open/close is spelled out in `openAccess()` / `closeAccess()` the way the states
   showcase already spells out its own. The footer no longer has "three entries to three
   surfaces"; it has three controls, and only one of them opens anything. One consequence
   is visible in the built CSS: with the word *stack* no longer present in `app.js` (it
   appeared in the deleted comment "not a stack of surfaces"), Tailwind stops emitting
   daisyUI's unused `.stack` component — 134 lines of dead CSS leave `tw.css` as a side
   effect of the round.
2. **The language menu floats, because the sidebar scrolls.** `.td-sidebar` is
   `overflow-y: auto`, so a dropdown positioned inside it would be clipped at the rail's
   edge — at 64px wide, a 148px menu has nowhere to go. `[data-lang-menu]` therefore lives
   at the end of the document beside the card's "Move to" list and is placed
   `position: fixed` above the trigger by `openLangMenu()`, reading the trigger's box in
   viewport coordinates (`getBoundingClientRect`), which is what `position: fixed` measures
   against. This is the round's one new native call — `offset()` is document-relative and
   drifts once the sidebar has been scrolled. The clamping is the same idea as I2's:
   never off the top, never off an edge.
3. **The switch states the state, twice.** `[data-theme-switch]` is a three-state cycle
   *and* a labelled control: the glyph swaps sun↔moon↔display, `[data-theme-label]` swaps
   `Light`↔`Dark`↔`Auto` (浅色↔深色↔自动), and `aria-label` is rewritten to name both the
   state in force and the state one press *reaches* (`Theme: Light. Activate for Dark.` /
   `主题：浅色。点击切换到深色。`), so a screen-reader user hears the action rather than only
   the state. `applyTheme()` remains the single writer of all of them, `data-theme-mode`
   included.
   The language trigger shows the language in force (`EN` / `中文`) and nothing about the
   other one; the menu marks the language in force with `aria-pressed`, accent copy and a
   tick, the same three signals the retired `.td-choice` row used. Picking the language
   already in force still closes the menu and reports nothing — there is no switch to
   announce.

Recaptured for this round: `01-board-1512` (the three controls in the three thirds),
`11-viewport-1240`, `13-viewport-760` (the rail: three glyphs, caret dropped),
`05-dark-theme` (the switch in its Dark state), `19-board-zh` (浅色 / 中文 / gear),
`15-no-javascript`, `17-access-panel`, plus one new frame — `22-lang-menu`, the dropdown
open with `English` marked. `22-theme-modal` and `23-lang-modal` are **deleted with the
surfaces they showed**; `18-access-token-revealed` and `21-access-panel-dark` remain the
v1.2 files, since the token block is not touched by this round.

Checked and clean across 1512 / 1240 / 980 / 760 / 500 px: no page-level horizontal
overflow, the three footer cells measure equal widths at every width, the language menu
opens above its trigger inside the viewport at every width (including the 64px rail, where
it floats over the board), the sidebar itself never scrolls horizontally, 7 columns ·
18 cards, and zero console errors.

---

## 18. Review round R3 — brand re-skin, componentisation, roster & editor

R3 is two specs landing together: `design-spec.md` (colour, mark, rename) and
`design-spec-r3-addendum.md` (components, controls, layout, editor). Where the two touch
the same thing, the addendum governs the new surface and `design/brand/tokens.css` still
governs the values.

### 18.1 What the round changed

1. **The palette moved to the brand.** Every value in §2 is now reproduced from
   `design/brand/tokens.css`, and the two daisyUI theme blocks in `src/input.css` carry
   the brand's palette rather than Tailwind's defaults. The light daisyUI theme was
   renamed `meerkat-taskpanel` and `data-theme="dark"` is unchanged, so the attribute contract
   the app switches on never moved.
2. **The status and priority ramps are dark-specific** (§7). Before R3 dark reused the
   light values; both ramps are now re-declared for `[data-theme="dark"]`.
3. **`--border` was a collision, and is gone.** See §8. This is the one change in the
   round that touches components nobody asked about — it is a *fix*, not a re-skin, and
   it restores the 1px structural border daisyUI intends on every component that asks
   for one.
4. **The hard-coded colours are gone.** `.td-live-dot` / `@keyframes td-pulse` now pulse
   in brand success, `.td-select`'s inline caret is `%237E8A91` (`--color-td-ink-3`), and
   `--shadow-pop` / `--scrim` are `rgba(15,20,23,…)` per `BRAND.md` §4. A scan for any
   six-digit hex in `src/input.css` returns only the token block itself.
5. **The mark.** **Sentinel Watch** (`BRAND.md` §5) replaces the four-square glyph in
   `[data-brand]`, stands in the large empty state (28px, in `--color-td-ink-3` so the
   on-duty sentinel stays the only lit element), and ships as `prototype/favicon.svg`
   with a `prefers-color-scheme` pair. The mark reads its fills from `--color-td-ink`
   and `--color-td-accent`, so there is one file for both themes, not two. (The v2
   brand round remastered the geometry — see `BRAND.md` §7.)
6. **The rename.** The product name is now `MeerkatTaskPanel` across `prototype/**` and
   `design/brand/**` — the i18n catalogue, the identifier-prefix map, the daisyUI theme
   name, the brand documents and the brand poster, which was re-rasterised from the
   updated `render-poster.mjs` at its fixed 1600×2000. No colour value and no logo
   geometry was touched to do it. (The pre-R3 name is not spelled out anywhere in this
   file: the round's own gate requires that no occurrence of it survives under
   `prototype/` or `design/brand/`, and a passing sentence counts as an occurrence.)

### 18.2 daisyUI component mapping

Each row is a component whose *shell* is now daisyUI and whose `td-*` rule is a token
override only. The rule is the addendum's: use the component, keep the brand.

| surface | daisyUI | where |
|---|---|---|
| view toggle (Board / List) | `tabs tabs-box` + `tab` | top bar, `.td-tabs` / `.td-tab` |
| label filter | `dropdown` + `menu` (R9: the value is flat text, not a `badge`) | filters bar, `.td-label-trigger` / `.td-label-menu` |
| assignee / priority filters | `select select-sm` | filters bar, `.td-select` |
| create-dialog fields | `select select-sm` | Priority / Project / Status |
| label chips, decision chips | `badge badge-sm` | cards, comments, drawer, list |
| platform badge | `badge badge-xs` | card foot, drawer, combo options |
| column count | `badge badge-sm` | column head, `.td-count` |
| status dot | `status` | column head, drawer, legend |
| avatar | `avatar` + inner element | cards, comments, drawer, combos |
| roster menus, move menu, project switcher | `dropdown` + `menu` | create dialog, drawer, cards, top bar |
| detail drawer, states showcase, access panel | `modal`-adjacent panels | see the note below |
| create dialog | `modal` + `modal-box` (`<dialog>`) | `.td-modal-box` |
| toasts | `toast toast-end` + `alert` | `.td-toast-region` / `.td-toast` |
| loading | `skeleton` | states showcase, list skeleton |
| column occupancy | `progress` | under every column head, `.td-col-progress` |
| allow-list switch | `toggle toggle-sm` | access panel, `.td-switch` |
| inputs, textareas | `input input-sm` | create dialog, drawer |
| tooltips | `tooltip` | legend, states showcase |

**The drawer is the documented exception.** daisyUI's `drawer` is a *page-level* grid:
`.drawer-side` must be a sibling of `.drawer-content` inside a `.drawer` root, and the
board would have to become that `drawer-content`. The shell is already a two-row CSS grid
with its own scroll containers, and the detail panel is a fixed overlay that does not
participate in it — wrapping the shell would move the board's scroll and height model,
which is the one thing this prototype cannot regress. `.td-drawer` therefore keeps its
own shell and its own tokens, and the same reasoning applies to the states showcase and
the access panel, which are fixed dialogs rather than page drawers.

### 18.3 Assignee and reporter — two read-only rosters

Both controls are one implementation used twice (`COMBO` in `app.js`), differing only in
the hooks they answer to and the roster they read.

- **Assignee** is seeded with the team the board already names — `elon`, `jobs`, `linus`,
  `turing`, `simons`, `assistant`, `Terry` — each carrying its kind and, for an agent, its
  platform.
- **Reporter** is *derived at first pass from the cards themselves* (`data-reporter`), so
  "reporters" means exactly "who has reported here before" and cannot drift from the board.
- **Matching is a case-insensitive substring**, ranked prefix → contains → subsequence.
  The subsequence pass only runs when nothing contains the query, so `lns` finds `linus`
  without ever outranking a name that genuinely contains what was typed.
- **Updating is an upsert, and it is the only mutation.** A name that is not in the roster
  is offered as a `· new` row while you type and is added the moment it is used — at
  submit, or by accepting a row. An unknown assignee defaults to `human`, because a handle
  the board has never seen carries no platform to claim.
- **There is no roster editor anywhere, by design.** Nothing in the interface adds,
  renames or removes a roster entry; the list grows only by being used. That is the whole
  reason the addendum forbids a management entry.
- Keyboard: `↑`/`↓` move `aria-selected`, `Enter` accepts, `Esc` dismisses, `Tab` closes.
  Escape stops propagating, because the drawer also listens for it.
- The roster lives in memory for the lifetime of the page and is written to nothing.

### 18.4 The Markdown editor

- **Write** shows a monospace source pane with live syntax highlighting; **Preview** shows
  the rendered result with highlighted fenced code; **Split** shows both. The mode is
  `data-md-mode` on `.td-md-panes`, and the only writer is `setMarkdownMode()`.
- The source pane is a **transparent `<textarea>` stacked on a highlighted `<pre>`**. Both
  carry `.td-md-text`, which owns every property that can move a glyph — family, size,
  line-height, padding, `white-space: pre-wrap`, `overflow-wrap`, `word-break`, `tab-size`
  — so the painted layer and the real input break lines at the same place. The highlight
  layer is scrolled from the textarea, never by the user.
- **Dependencies are vendored, and they are first-party.** `vendor/markdown-lite.js` is a
  GFM-subset renderer and `vendor/highlight-lite.js` is a source highlighter; both are
  plain files loaded with a `<script>` tag, with no network, no CDN, no storage and no
  `eval`. They are vendored rather than hand-inlined so the prototype's "all vendor libs
  live in `prototype/vendor/`" rule holds, and first-party rather than downloaded because
  the candidate libraries carry `localStorage` references and external URLs in their own
  source, which the prototype's purity and no-external-link gates reject.
- Both escape their input. `safeUrl()` allows only `http`/`https`/`mailto`/`#`/relative
  targets, so a rendered link can never be a `javascript:` one.
- Nothing is submitted, fetched or stored: the editor renders what is typed, in the page.

### 18.5 The create dialog is two columns

Left is the work — Title, then the Description editor. Right is its routing — Priority,
Assignee, Project, Status, Reporter, then the optional Labels, Parent and Depends on. The
tracks are equal above 760px (`minmax(0, 1fr)` twice, so a long value or the editor can
never push the dialog wider than its box) and stack at ≤760px, which is its own media query
rather than the shell's 759px one, because the dialog has to be single-column *at* 760.

*(R3–R4: the right column ended at Reporter, and Labels were not a field. R5 adds them —
see §22.)*

### 18.6 Recaptured and checked

Recaptured for this round: `01-board-1512`, `11-viewport-1240`, `13-viewport-760`,
`05-dark-theme`, `19-board-zh`, `22-lang-menu`, `15-no-javascript`, `17-access-panel`,
`03-drawer-agent`, plus four new frames — `23-create-two-col`, `24-md-editor-split`,
`25-assignee-autocomplete` and `26-create-narrow-760`.

Checked and clean: `prototype-guard` passes; the purity scan returns nothing; the
pre-R3 product name appears **zero** times anywhere under `prototype/` or `design/brand/`;
no old-brand hex survives in `src/input.css`; 7 columns · 18 cards · legend · filters ·
empty state all visible with JavaScript disabled; zero console errors; and no page-level
horizontal overflow at 1512 / 1240 / 980 / 760 / 430 px, nor inside the create dialog at
1512 or 760.

## 19. Review round R4 — create dialog fixed, parent & depends-on

R4 is `design-spec-addendum.md` (2026-10-09), the follow-up to Terry's trial of the R3
create dialog. Incremental revision of `prototype/**` on top of R3 — no rewrite.

**No token change.** Every value still comes from `design/brand/tokens.css`; §2, §3, §4
and the two daisyUI theme blocks are untouched, and `design/**` is not edited by this
round. What moved is geometry and one interaction binding.

### 19.1 A1 — Write mode scrolls, and the highlight follows

The edit pane could not scroll; the preview could. Two causes:

1. **`scroll` does not bubble.** R3 bound the sync as a delegated handler on the editor
   (`$(editor).on("scroll", "[data-md-source]", …)`), which never fires — so the
   transparent textarea scrolled under a highlight `<pre>` that stayed put, and the pane
   read as frozen. R4 binds the handler directly to each source, keyed off the same
   `[data-md-source]` hook: measured `scrollTop` is now identical on both layers.
2. **The edit side has an explicit scroller.** `.td-md-source` carries `height: 100%`
   with `overflow-y: auto`, beside the preview's own `overflow: auto`. With scripting off
   the textarea keeps its native scroller and the layout is unchanged.

### 19.2 A2 — the dialog is bigger, and the left column leads

`.td-modal-box` goes from 880px to `min(1120px, 100vw − 32px)`, capped at `100vh − 48px`
with its own scroller. The tracks become `minmax(0, 1.6fr)` / `minmax(0, 1fr)` so the
description is the dominant pane, and `.td-md-panes` goes from a fixed 230px to
`clamp(280px, 46vh, 520px)` — a markedly taller editing area, still bounded so the dialog
scrolls instead of running off the screen. At ≤760px the tracks stack and the editor drops
to `clamp(220px, 40vh, 360px)`, so a phone-height window still fits the dialog.

### 19.3 B1/B2 — Parent and Depends on

Two **Optional** fields close B10's right column — after Reporter as built in R4, after
Labels as of R5. They are B22's control
reading the working project's cards instead of a people roster: **identifier as value,
title as the row's trailing text**. Parent is single-select with a clear button; Depends on
is multi-select, each choice a removable chip, deduped. Both refuse free text — a relation
can only point at a task that already exists — so there is no `· new` row and no roster is
grown. Structure and hooks: BLOCKS.md **B24**. UI only: no graph, no cycle check, nothing
stored.

Two layout corrections came out of building them, both general:

- daisyUI's `menu` is `column wrap`, so twelve rows became two narrow columns; the picker
  menu is now one scrolling column (`flex-wrap: nowrap`, `flex: none` rows).
- A menu hanging off the last field would be clipped by the dialog's own scroller, so the
  menu measures its room and flips above its control (`.td-combo[data-drop="up"]`) when
  there is none below.

### 19.4 Recaptured and checked

Recaptured (the dialog's geometry changed, so every frame that shows it did):
`10-create-task-modal`, `23-create-two-col`, `24-md-editor-split`, `25-assignee-autocomplete`,
`26-create-narrow-760`. New: `28-md-write-scroll` (Write scrolled to the tail of a 60-step
description, highlight in step), `29-create-parent-dropdown`, `30-create-depends-multiselect`.

Checked and clean: `prototype-guard` passes; the purity scan over `*.html` / `*.js` /
`*.css` returns nothing; 7 columns · 18 cards and every pre-R4 hook intact; the create
dialog scrolls its edit pane (measured `scrollHeight` 1171 → `clientHeight` 437, both layers
at `scrollTop` 260) and its preview (2479 → 437); chips add, dedupe and remove; the form
still resets after a submit; zero console errors; and no page-level horizontal overflow at
1512 / 1240 / 980 / 760 / 430 px, with or without JavaScript.

## 20. PROJECTS ordering (weight algorithm)

The `PROJECTS` sidebar list is ranked by recent activity, not by creation time or name.
This is the concrete UI expression of `ARCHITECTURE §4.6`; the prototype is **pure UI** —
it does not implement the algorithm or touch the network, it only renders the order the
server already decided.

**Factors and weights.** Three inputs combine, `A7 = 0.50`, `A30 = 0.30`, `C = 0.20`:

- `A7` — activity in the trailing 7-day window (heaviest weight: recency dominates).
- `A30` — activity in the trailing 30-day window.
- `C` — creation recency (older projects rank higher on this factor alone).

**Normalisation.** Each factor is normalised *by rank*, not by raw value, so the three
factors are comparable regardless of scale. With N participating projects and rank from 1
(largest value) upward:

```
s = (N − rank + 1) / N
```

**Composite.** The weighted sum, rounded to three decimals for display:

```
total = 0.5·A7 + 0.3·A30 + 0.2·C
```

**Tie-break.** Equal totals resolve by most-recent activity (descending), then by project
name (ascending). **Archived projects never participate** — they are excluded before
ranking.

**Activity definition.** A project's activity is the count of its `task_activities` rows in
the window, **excluding pure heartbeats** (a heartbeat alone is liveness, not work).

**Ownership.** Ranking is **computed server-side**; the frontend **consumes the order only**.
The prototype bakes the resulting order and scores into the demo data
(`data-order-score` / `data-order-rank`) so the list is machine-checkable without any
client-side computation.

### 20.1 Demo data

With N = 3, the three factors rank and normalise as below (larger value ⇒ rank 1; for `C`,
**earlier creation ⇒ smaller rank**):

| Project      | A7 (7d) | A30 (30d) | Creation | s_A7  | s_A30 | s_C   | **total** | **rank** |
|--------------|---------|-----------|----------|-------|-------|-------|-----------|----------|
| Orchestrator | 20 (r1) | 55 (r1)   | newest (r3) | 1.000 | 1.000 | 0.333 | **0.867** | **1** |
| MeerkatTaskPanel    | 12 (r2) | 40 (r2)   | mid (r2)    | 0.667 | 0.667 | 0.667 | **0.667** | **2** |
| Site Refresh | 3 (r3)  | 25 (r3)   | oldest (r1) | 0.333 | 0.333 | 1.000 | **0.467** | **3** |

⇒ **Demo display order = Orchestrator → MeerkatTaskPanel → Site Refresh.** Note this differs from
the creation-time intuition (Site Refresh is the oldest, so it wins the `C` factor — but
that factor carries the smallest weight, so it still lands last); the ordering exists to
show activity weighting in the UI. Sidebar task counts (12 / 4 / 2) are unrelated to the
ranking and stay fixed — they are the project's **total** task count, served by `/projects`
as `task_count` (every status, archived included; `0` when the project has none), which is
what `[data-project-count]` renders on every row.

---

## 21. Theme & language preferences (browser-local only)

Authority: `ARCHITECTURE §8` (client preferences). Two preferences live on the client and
**only** on the client:

| Key | Values | Default | Surface |
|---|---|---|---|
| `meerkat-taskpanel.theme` | `light` \| `dark` \| `auto` | **`light`** | the sidebar footer's theme cell (1st: left in the row, top in the rail) |
| `meerkat-taskpanel.lang` | `en` \| `zh` | **`en`** | the sidebar footer's language cell (2nd: centre in the row, middle in the rail) |

**Where they live.** Both are **stored in `localStorage` only — never on the server**. They
do not travel in a request, they are not columns on any table, and they are not tied to an
account or a device: a second browser starts at the defaults. The board's data is the same
whichever preference is in force, so nothing here can change what the service stores.

**No record ⇒ `light`.** With no stored value the theme is **Light** — an explicit light
theme, **not** "follow the system". The same rule gives the no-JS document its default
(§7): `<html data-theme="meerkat-taskpanel" data-theme-mode="light">`. Language likewise starts at
`en`.

**Explicit beats auto.** Picking `light` or `dark` records a fixed choice and **disables
auto** for as long as it stands — the system preference is not consulted again until the
reader cycles back to Auto. `auto` means exactly one thing: **follow
`prefers-color-scheme`**, dark when the OS asks for dark and light otherwise, re-evaluated
live as the OS setting changes.

**What the prototype does.** The prototype is **pure UI and writes no storage at all** —
`app.js` holds the active mode in memory for the lifetime of the page, and the three states
are demonstrated by `data-theme-mode`. The `localStorage` step belongs to the real
implementation; wiring it here would break the purity gate (§18.4) and the "no real
implementation in `prototype/**`" rule. What this document fixes is the *contract* the
implementation must honour: the key names, the value sets, the defaults, and the
light-by-default rule above.

**Auto is CSS-only.** `html[data-theme="auto"]` resolves through
`@media (prefers-color-scheme: dark)` in `src/input.css` (§7). No script reads `matchMedia`
and no script decides the colours — a reader with JavaScript off still sees the right
choices, because the no-JS document ships Light.

**Recaptured and checked.** The top footer row gained its third state, so `05-dark-theme`
was re-shot with the cell in `Dark`, and six frames are new: `33-theme-light-1512`,
`34-theme-dark-1512`, the `Auto` pair `35-theme-auto-darkos-1512` /
`36-theme-auto-lightos-1512`, and `37-theme-footer-760` with its crop. The `Auto` pair is
the proof — the same state captured under emulated dark and light system preferences
resolves to the dark and light boards respectively, while `Light` and `Dark` render the
same under either. Checked and clean across 1512 / 1240 / 980 / 760 / 500 px: no
page-level horizontal overflow at any width, no console errors, and the 7 columns × 18
cards / existing `data-*` hooks are untouched.

## 22. Labels — dynamic, no management entry

Authority: `ARCHITECTURE §4.4` (labels). This round adds the label control to the create
dialog's right column and the same control to the task drawer. Structure and
hooks: BLOCKS.md **B25**. The prototype is **pure UI** — no label is stored, fetched or
filtered by it; what this section fixes is the contract the implementation must honour.

### 22.1 One control, the same paradigm as Assignee/Reporter

Labels are **B22's control**, not a new one. The control is `.td-combo` with
`freeText: true` and the multi/chips half of the relation control (B24): free text over a
fuzzy-matched list, and every accepted name becomes a removable chip. Matching is the same
case-insensitive substring, ranked prefix → contains → subsequence; `↑`/`↓` move
`aria-selected`, `Enter` accepts and never submits the form from this input, `Esc`
dismisses, `Tab` closes. A label chip is a name, not an identifier, so it is **not**
`.td-mono` — the one place this control differs from a relation chip.

### 22.2 Dynamic growth — no preset list, no enum

There is **no preset label list and no fixed enumeration**. The roster the picker offers is
read back off the board's own cards (`data-labels`) at first pass, so "labels" means
exactly "what the board already carries" — the same derivation-by-reading rule Reporter
follows (§18.3). A name typed for the first time is offered as a `· new` row while you
type and is created by the act of being used: **create and assign are the same upsert**, the
`Assignees`/`Reporters` model exactly.

### 22.3 Normalisation — first spelling wins

Comparison is **case- and whitespace-insensitive**: `bug` / `Bug` / `bug ` are **one**
label. The entry keeps the spelling it was **first written with**, and that spelling is
what every surface then shows — the menu row, the chip, the card and the drawer. So typing
`BUG` at a board that already holds `Bug` resolves to the existing `Bug`; it does not
create a second label and does not re-case the first.

### 22.4 Auto-cleanup is backend behaviour

Reclaiming a label that has gone unused for a long period is a **server-side** concern, not
a surface. The prototype **does not implement it and has no UI for it**: nothing in the
interface deletes, renames, merges or expires a label. That is deliberate — auto-cleanup
must not be reachable, or visible, from the board.

### 22.5 No management entry — anywhere

There is **no "manage labels" / "label library" / "delete label" / "edit labels" entry, and
no such button.** The list grows only by being used, so there is nothing to manage and no
surface that could manage it. This is the same rule §18.3 states for the two rosters, and
it is what the addendum's part B hard-forbids.

### 22.6 Task detail edits labels too — one control, both surfaces

The drawer's property grid carries a **Labels** row (`[data-detail-labels]`) and it is the
**same control as the create dialog's**, not a display of it: type to fuzzy-match the
board's label roster, accept to add a chip, press a chip's `×` to drop it — the identical
`.td-combo` paradigm and keyboard loop the drawer's Assignee and Reporter already use
(§18.3 / §22.1). It differs only in the hooks it carries (`data-detail-label-*` rather than
`data-label-*`, so the two controls' delegated selectors never collide), and it is filled
from the card's `data-labels` on open, in the board's adopted spelling. Nothing about §22.4
or §22.5 changes: auto-cleanup stays a backend concern, and there is still no management
entry anywhere.

### 22.7 Recaptured and checked

Recaptured (the right column gained a field, so every frame showing the dialog did):
`10-create-task-modal`, `23-create-two-col`, `26-create-narrow-760`. New:
`39-create-label-dropdown` (the fuzzy menu over the board's labels, with the `· new` row),
`40-create-label-new-row` (a name the roster does not hold), `41-create-label-new-chip`
(the accepted name as a chip), `42-create-label-normalised` (`Triaged` · `Bug` after
`triaged` / `  Bug  ` / `BUG` / `bug` all resolved to two labels), `43-detail-labels` (the
drawer's Labels row) and `44-create-label-narrow-760`.

### 22.8 The drawer's Labels row is the control, not a display

The drawer's Labels row was a display-only chip list; it is now the **same editable
control** the create dialog carries, so a task's labels are changed where the task is
read, not only where it is created. Three frames are new: `45-detail-label-dropdown` (the
drawer's label input mid-type, fuzzy matches over the board's roster with the `· new` row),
`46-detail-label-new-chip` (a name the roster does not hold accepted into a chip) and
`47-detail-label-remove` (a chip's `×` pressed, the chip gone and the row fallen back to
the remaining labels) and `48-detail-label-narrow-760` (the same control with the drawer
full-width at 760px, no overflow). The drawer's Assignee and Reporter were already editable
(B22); the Labels row now matches them, and `43-detail-labels` is recaptured to show the
input in place of the read-only chips. Structure is BLOCKS.md **B25**.

**Checked and clean.** `prototype-guard` passes; the purity scan over `*.html` / `*.js` /
`*.css` returns **0** hits (`localStorage` / `sessionStorage` absent); no management entry
appears in any user-visible copy; no page-level horizontal overflow at 1512 / 1240 / 980 /
760 / 500 px with the drawer open and its label menu open; and the drawer's Labels row now
runs the identical control the create dialog does.

**Checked and clean.** `prototype-guard` passes; the purity grep over `*.html` / `*.js` /
`*.css` returns **0** hits — in particular `localStorage` and `sessionStorage` are absent
from every prototype file; the control was driven end to end (`ux`, `  NewThing  `, `ux`
produced exactly two chips, the created card carried `data-labels="ux,NewThing"`, its
drawer showed the same two, and the form reset to no chips and an empty input); zero
console errors; no page-level horizontal overflow at 1512 / 1240 / 980 / 760 / 430 px and
no overflow inside the create dialog at any of them; and 7 columns × 18 cards with every
pre-existing hook are intact.

---

## 23. Review round R7 — the footer's layout, and three fidelity alignments

Terry's 2026-10-12 20:59 sidebar review raised three findings and added a fourth at 21:06
(a drawer-header finding). One of the four is a **design change** — the footer layout — and
it is the only one that moves the prototype; the other three are **alignment findings**
where the prototype is already the correct side. The structural contract for all four is
`design/fidelity-r7.md` (the §⑨.1 "Before" document; the implementation and verification
cards are separate).

**The design change was revised the same evening** (Terry, 2026-10-12 21:19): R7 stacked
the footer at *every* width, and the revision scopes the stack to the rail — the desktop
column is back on one row of three equal thirds. §23.1 records both, because the round's
own record is the reason the revision exists.

### 23.1 The footer layout (the design change)

#### 23.1.1 What R7 landed — and what the 21:19 revision changed

The sidebar footer `[data-access-status]` was **one row of three equal thirds** (v1.3, kept
through v1.4). R7 turned it into **three stacked full-width rows**, top to bottom: theme ·
language · settings — container `display: grid; grid-template-columns: repeat(3, minmax(0,
1fr))` → `display: flex; flex-direction: column`, each `[data-access-cell]` a full-width row
with its glyph at the **inline start** (`justify-content: flex-start`, `gap: 8px`,
`padding: 0 8px`), and the separator turned from a vertical `border-inline-start` between
neighbours to a horizontal `border-block-start` on the 2nd and 3rd rows. A new hook,
`[data-access-cell]`, names the three cells so the contract can address them without
counting children — *that* part stands.

**The revision keeps the hook and the cell count, and moves the stacking behind the
breakpoint.** Landing state:

| | R7 as landed (2026-10-12, superseded) | After the revision (2026-10-12 21:19) |
|---|---|---|
| Container, all widths | `display: flex; flex-direction: column` | **≥1024px**: `display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch` · **≤1023px**: `display: flex; flex-direction: column` |
| Cell, ≥1024px | `justify-content: flex-start` · `gap: 8px` · `padding: 0 8px` · `text-align: start` | `justify-content: center` · `gap: 6px` · `padding: 0 2px` · `text-align: center` (a third of the column, centred) |
| Cell, ≤1023px | `justify-content: center` · `gap: 0` · `height: 24px` · `padding: 0` | unchanged |
| Separator | horizontal `border-block-start` on the 2nd/3rd rows, all widths | **≥1024px**: vertical `border-inline-start` on the 2nd/3rd cells (first cell none) · **≤1023px**: horizontal `border-block-start` |

Nothing else in R7's change is revised: `[data-access-cell]`, the three hooks inside the
cells, the DOM order and the cell count are all as R7 landed them.

#### 23.1.2 Why the stack exists — and why it is the rail's only

A third of the sidebar column is ~74px at 1512px. Nothing legible fits three labelled
controls in 74px each: the language trigger alone needs a globe, a name and a disclosure
caret. But **that arithmetic is what makes the stack the rail's answer, not the desktop's**:
below 1024px the sidebar is a 64px (56px under 560px) rail, and a third of *that* is
narrower still — so the rail must stack, while the desktop column can afford the row it had
since v1.3, where the thirds were already accepted as legible for these three short labels
(`Light`, `EN`, a gear). R7 generalised the rail's accommodation to every width; the
revision un-generalises it. The order is unchanged (theme → language → settings) in both
bands, so nothing has to be relearned either way.

#### 23.1.3 Constraints the layout carries

1. **A cell stays one line inside, at both widths.** Each `[data-access-cell]` is
   `display: flex; flex-direction: row` — icon, label and caret side by side. R6 ⑦⑧ fixed
   that and neither R7 nor its revision undoes it; the change is between cells, never within
   one. The two are orthogonal and the contract asserts them separately.
2. **The rail's cell geometry is the thing R7 got right there.** Below 1024px each cell
   narrows to a centred 14px glyph on a 24px line with the label and the caret gone — the
   rail stacks them rather than placing them side by side, and the footer's own top rule
   spans what it spanned before (the footer is content-width in the rail, before and after).
3. **No new token.** Both separator orientations reuse `--color-td-line`.
4. **Height is band-dependent.** The desktop column is back to **37px** (one 28px cell +
   8px `padding-top` + 1px rule) — the v1.4 height, so §23's original "+28px on the desktop
   column" no longer holds. The rail is **81px** (3×24px + 8px + 1px), which is the design
   change's standing cost. Measured with no page-level horizontal overflow at
   1512 / 1240 / 1024 / 980 / 760 / 430 / 1023 in both themes.
5. **The breakpoint is `1023/1024`, with no grey band.** Measured: 1024px is the row, 1023px
   is the stack.

The §12 "current state" passages are rewritten to the band-split description; the v1.3 round
(§16, judgement call 3) keeps its record with a "（已于 R7 变更）" note pointing here, since
its "the row never wraps" consequence is the thing R7 reversed.

### 23.2 The three alignment findings (no prototype change)

These are recorded here because they change what the **implementation** must look like, not
what the prototype is. In each case the prototype was already correct, so the prototype's
markup and CSS are untouched by R7.

1. **The nav glyphs lost their icon face.** The four `[data-nav-item]` glyphs are stroked
   line icons (`.td-icon`: `fill: none`, `stroke: currentColor`, `stroke-width: 1.5`,
   round caps and joins, 16×16). The implementation gave them a size utility but not the
   face, so they render as solid black shapes — and carried the `data-side-icon` hook that
   belongs to the project **monogram**, which the rail's chip rule then matched, boxing the
   nav glyph in a 24px chip at ≤1023px. The prototype's nav glyphs are bare 16px icons; the
   monogram is the only chip. This is a misapplied-class finding, not an icon-design one:
   the four path strings are byte-identical on both sides.
2. **The project count lost its brand face.** The count pill is
   `badge badge-sm td-count` on a `<span>` **inside** the project row, carrying
   `data-project-count` on the pill itself — the hook names the number, not the row. The
   implementation put the hook on the row `<button>` and dressed the pill in
   `badge badge-sm td-mono`, so the pill measures 34.45×20 with a 4px radius instead of the
   brand's 20×18 with a full radius. The count semantics are unchanged and stay the
   prototype's: a finite number — `0` included — renders the pill; `null` renders none
   rather than a fabricated zero (§20.1).
3. **The drawer's close button fell out of the header's top row.** In the prototype
   `[data-detail-close]` sits **inside** the header's first row, beside
   `[data-detail-identifier]` and the status chip, pushed to the row's end, and its glyph is
   `svg.td-icon` (the ✕ path `M6 6l12 12M18 6 6 18`). The implementation made it a third
   child of the `flex-col` header with `self-end`, so it lands **below** the title at the
   bottom-right, and its glyph is a text `✕`. The fix is structural: back into the row,
   aligned to its end, with the icon glyph. One measurement caveat is recorded in the
   contract: the same-row check must use centre-line coincidence and the row's right edge,
   because the row's two boxes differ in height (their `top`s differ by 7px in the
   prototype itself) and because `margin-inline-start: auto` computes to its used pixel
   value, never to the literal `auto`.

### 23.3 Recaptured and checked

Ten prototype frames — 1512 / 1240 / 980 / 760 / 430 × light and dark — are captured for
this round as the **baseline** (`design/fidelity-r7.md` §6 records the口径; the files live
in the card's workspace, not in the repository). The theme is driven through the footer's
own `[data-theme-switch]`, so the capture exercises the control it photographs.

**Checked and clean.** Zero console errors and zero page errors in the prototype at every
captured width and theme; no page-level horizontal overflow in any of the ten frames
(`scrollWidth ≤ clientWidth + 1`); the three footer rows measure strictly increasing tops
28px apart on the desktop column and 24px apart in the rail; `count [data-nav-item]` stays
4; 7 columns × 18 cards intact. The implementation-side comparison is the verification
card's to run, per the same口径.

> **Superseded for the footer.** The rows/steps quoted above describe R7 as landed (stacked
> at every width). After the 21:19 revision the desktop column is a row again: the three
> cells share one `top` and their `left`s step by a third; only the rail keeps 24px-apart
> tops. The **revision's** ten frames live in `T-20261012-212138`'s workspace.

### 23.4 The revision, recaptured and checked

The revision was recaptured the same way — 10 frames (5 viewports × light/dark) plus two
**breakpoint-boundary** probes at 1024 and 1023, which are measured but not photographed.
The theme is again driven through `[data-theme-switch]`.

**Checked and clean.** Zero console errors and zero page errors; no page-level horizontal
overflow in any band or theme (`scrollWidth ≤ clientWidth + 1`); `count [data-nav-item]`
stays 4; 7 columns × 18 cards; the footer's three cells report `display: grid` with three
tracks of ~74.33px and **one shared `top`** at 1512 / 1240 / 1024, and `display: flex;
flex-direction: column` with tops 24px apart at 1023 / 980 / 760 / 430; `.td-caret` is
visible in the wide band and hidden in the rail; `svg.td-icon` measures 14×14 in both
bands (`fill: none`, `stroke-width: 1.5px`).

**A build trap the revision surfaced.** Tailwind v4 scans the *whole* source file for
candidate class names, comments included: a bare `stack` in an HTML comment made the
toolchain emit daisyUI's `.stack` component (+2242 bytes, +49 selectors) with no element to
match. Wording the comment as "stacked form" removes it. Any edit to `index.html` /
`app.js` comments must therefore be followed by a `tw.css` rebuild **and** a diff review.

---

## 24. Review round R8 — the list's header, the dark dialog, the identifier's cap

Three findings from Terry (2026-10-12 21:11). All three are **design changes**, not
implementation drift: the prototype had no rule for any of them, which is exactly why
the implementation did not either. `design/fidelity-r8.md` is the machine-checkable
contract; this section is the prose. Screenshot口径 and the assertion list live there.

### 24.1 The dark dialog separates on three layers, not one

The 2026-10-12 sighting — "in dark mode the create-task dialog is indistinguishable
from the background" — is not a weak scrim. Measured on the prototype before the round,
**all three** of the dialog's separation devices were inert in the dark:

| Layer | What was wrong |
|---|---|
| Veil | `--scrim` was declared once in `:root` (`rgba(15, 20, 23, 0.32)`) and never re-declared for the dark ⇒ the dark veil was **byte-identical** to the light one |
| Panel edge | `.modal-box` used `--color-td-line` (`#1f262a`), which sits almost exactly on both the canvas (`#0f1417`) and the panel surface (`#161b1e`) |
| Elevation | `--shadow-pop` is tinted `rgba(15, 20, 23, ·)` — the canvas colour — so the shadow vanished into the canvas it was supposed to lift off |

The fix is scoped to the dark and touches only those three (§7 has the token table):
`--scrim` → `rgba(0, 0, 0, 0.55)`, the panel edge → `--color-td-line-strong` (`#313b41`),
`--shadow-pop` → a black double shadow. The panel's **surface colour is deliberately
unchanged** — that value is a global token and moving it would move every surface on the
site. `.td-modal-box` inherits `.modal-box`, so **B11**'s create-project dialog gets the
same treatment from the same rules, and the drawer's `.td-scrim` reads the same
`--scrim`, so every veil in the app deepens together. Light is untouched: measured
before and after, the light veil, edge and shadow are byte-identical.

### 24.2 The list header is the rows' own template

The list read as "not a table" for a structural reason: `.td-list-head` was
`display: flex` holding a **single** label (`list.columns.identifier`), while
`.td-list-row` was a **6-track grid**. The header therefore had no column widths at all —
it could not align to the rows even in principle.

R8 makes the header `grid` and gives header and rows **one shared declaration**
(`grid-template-columns` / `gap` / `padding`), so drift is structurally impossible rather
than merely absent. All six columns are now named — ID · Title · Status · Assignee ·
Priority · Revision — matching the six row cells one-for-one, in track order. The
three middle columns carry `td-hide-sm` on **both** sides, so the same
`@media (max-width: 759px)` rule narrows header and rows together to three tracks.

Two consequential details, both recorded in the contract: the header's
`grid-template-columns` computed value **resolves to pixels** and varies with the
viewport (`74px 648px …` at 1512, `74px 96px …` at 760, `64px 144px 84px` at 430), so the
machine-checkable signal is **header-equals-row**, never a literal; and the **loading**
header (B13) is a caption, not a column row — it keeps its single span, which now spans
the whole template so it cannot be squeezed into the 74px first track.

### 24.3 An identifier renders at most eight characters plus `…`

Real identifiers run from six characters (`TD-128`) to nine (`PROJ-0007`), so the cap has
a genuine trigger, not a hypothetical one. The ruling:

- **What is shown** — the identifier's own first **eight** characters, with `…` appended
  when it was longer. Not a hard cut: two long ids must not become visually identical.
- **How** — a **render-layer character slice** (`len > 8 ? slice(0, 8) + "…" : id`), not
  a CSS width. `max-width: 9ch` is a *width* — it depends on the face's advance width and
  on letter-spacing, and cannot promise "exactly eight characters". A `ch` cap is kept
  as a **single-line guard** (`.td-id`: `nowrap` + overflow ellipsis), never as the
  truncation mechanism itself.
- **What is preserved** — the full id stays on `title` (hover) and on the row / card /
  drawer root's `data-identifier`. The visible text is a *display value*; identity never
  travels in it.

That last point has a consequence the round had to fix, and it is written into the
contract as a regression rule: the drawer's comment handler used to read the identifier
**out of the span's text** to find its card. A nine-character id would have broken it.
It now reads `[data-detail-drawer]`'s `data-identifier`, and the drawer root gained that
attribute. Any future code that resolves an entity must read the attribute, never the
rendered text.

The five new column labels the header needs land in the catalogue as
`list.columns.title` / `status` / `assignee` / `priority` / `revision` (en + zh), taking
the prototype's mirrored set from 215 to **220** keys — see §13.

### 24.4 Recaptured and checked

Ten prototype frames — 1512 / 1240 / 980 / 760 / 430 × light and dark — are captured for
this round as the **baseline** (`design/fidelity-r8.md` §6 records the口径; the files
live in the card's workspace, not in the repository), each in two states: the list view
and the create-task dialog open. The theme is driven through the prototype's own
`[data-theme-switch]`, so the capture exercises the control it photographs.

**Checked and clean.** Zero console errors and zero page errors; no page-level horizontal
overflow at any of the five widths (`scrollWidth === clientWidth`); 49 of 49 selector-level
assertions pass, including every light-mode regression gate. The measured dark values are
`rgba(0, 0, 0, 0.55)` (veil) / `rgb(49, 59, 65)` (edge) / `rgba(0, 0, 0, 0.6) 0 16px
40px` (elevation); the header's columns string equals the rows' at all three measured
bands; and the nine-character sample renders `PROJ-000…` in all three identifier
positions while `TD-128` renders untouched.

---

## 25. Review round R9 — one dismiss rule, one filter control, two list states

Three findings filed by Terry against the live board on 2026-10-12 22:47. All three are
interaction/rendering defects rather than new features, so this round adds **no block**:
each one lands inside an existing entry (B02 · B04 · B08/B13). The executable contract is
`design/fidelity-r9.md`; the block inventory carries the per-block changes.

### 25.1 A press outside closes a floating control (items ① and ②①)

The two `<details class="dropdown">` controls in the shell behaved differently from each
other and from everything else on the page. The project switcher (B02) had no
outside-press rule at all — `app.js` closed it only when one of its own options was
chosen — so it stayed open until its `<summary>` was pressed again; because its menu
floats over the filters bar, it also swallowed presses aimed at the controls beneath it.
The label selector (B04) closed, but through a handler that named it by hook, so the rule
was a property of that one element rather than of a kind.

Both now carry **`data-dismiss-on-outside`**, and one document-level handler owns the
behaviour: a press whose target is not a descendant of a member closes every member that
is `[open]`, `Esc` closes them alongside the drawer and the two panels, and opening one
member closes the other so the two menus can never overlap. Membership is the attribute
and nothing else — no class name, no hook list — so a third dropdown joins by carrying it.
The B22/B24/B25 roster menus and the floating card menus are deliberately **not** members:
they float from a trigger that is not a `<details>`, and they keep their own dismiss rules.

**Not a new pattern, a named one.** `<details>` already gives the open/closed state and the
`<summary>` toggle for free; R9 only gives the state a second way out, and gives that exit
a name the contract can point at.

### 25.2 The label selector is one control family with the two selects (item ②②)

The label filter's trigger read as a different kind of thing from `Assignee:` and
`Priority:` beside it, and it was: a 28px shell holding a **label chip** — a bordered,
accent-tinted, fully-rounded pill (`badge td-chip td-chip-label`) — where the selects are
30px of plain 12px text with a caret.

R9 flattens the value to text and matches the shell: 30px tall like the two selects (one
baseline, one height), 12px/400 in `--color-td-ink`, and the same 14px caret parked at
`right 6px`. The scoping is the point — the flattening is pinned to
`.td-label-trigger [data-filter-label-summary]` and **`.td-chip-label` is untouched**, so
the chips on cards, in the drawer and in the two dialogs are still pills. The `<details>`
markup, the `[data-filter-label]` / `[data-filter-label-value]` / `[data-filter-label-summary]`
/ `[data-filter-label-option]` hooks and the seventeen options are all unchanged.

The design question behind it — whether to abandon the dropdown for a native `<select>` —
was considered and rejected: the addendum names this control specifically (it is the one
filter with seventeen choices, and it has to state its value without being opened), and a
`<select>` cannot hold that shape. Recorded as an evaluated alternative, not a decision.

### 25.3 The list is in one of two states (item ③)

The list view rendered the loading skeleton **and** the data rows at the same time. The
cause was a missing transition rather than a missing state: `renderList()` filled
`[data-list-rows]` and never took `[data-skeleton]` down, so the document's static loading
markup stayed on screen above the data it was supposed to hold the place for.

`[data-list]` now carries **`data-list-state="loading" | "data"`**, the two halves are
`[data-skeleton]` and `[data-list-rows]`, and the rule is written on the attribute:
the group the state does not name is out of the flow. Writing it as a state rule rather
than as a per-element `hidden` swap means the mutual exclusion survives the markup as
shipped, not only once the script has run — and it takes the data group's column header
with it, so the loading state is the caption and the shimmer rows and nothing else.

`data` is the resting state (the skeleton ships `hidden`). Opening the view is a fetch:
the prototype enters `loading` when the view is opened and settles to `data` a beat later,
so both states are reachable from the interface itself — and so a recapture of the list
frame has to wait for the settle, which `design/fidelity-r9.md` §6 states.

### 25.4 Checked

The selector-level assertions in `design/fidelity-r9.md` §5 are measured against the
prototype in a real browser, before and after. Before: the switcher stayed open through a
synthetic *and* a real outside press, two dropdowns were open at once, `Esc` closed
neither, `.td-label-trigger` was 28px/500 against the selects' 30px/400, the trigger's
value was a 999px pill, and `[data-skeleton]` and `[data-list-rows]` were both in the flow.
After: every one of those reads the other way, the three filter controls measure 30px
each, and `[data-skeleton]` and `[data-list-rows]` are mutually exclusive in both states
(at rest and mid-load). Zero console errors, zero page errors. No token was added or
changed: `.td-label-trigger` and the list states are expressed with the tokens that were
already in force.

---

## 26. Review round R10 — the board’s own empty state, drawer saves, and a description that fills

Three findings filed by Terry against the live board on 2026-10-12 23:04. All three are
rendering/interaction defects rather than new features, so this round adds **no block**:
each one lands inside an existing entry (B05/B12 · B09/B22/B25 · B10/B23). The executable
contract is `design/fidelity-r10.md`; the block inventory carries the per-block changes.

### 26.1 The board view is two states, and only one of them is on screen (item ①)

The board had no view-level state at all. `[data-board]` and the no-results `[data-empty]`
were siblings under `[data-main]`, and the only rule relating them lived in
`applyFilters()` as `total > 0 && shown === 0` — a condition that describes *filtered to
nothing* and silently excludes *nothing to filter*. So a board whose project holds no cards
kept the no-results block `hidden` and drew its seven columns instead, each showing its own
"no tasks" body; and in the filtered case it showed both, the global empty state above a
full board.

The fix is the one R9 established for the list, applied to the board: a **state root**
`[data-board-view]` owns the state (`data-board-state`), the two members are its **direct
children**, and the state is written in one call (`setBoardState`) that sets the attribute
and both `hidden` props together. The condition becomes `shown === 0`, which **subsumes**
`total === 0` rather than sitting beside it. Two rules in `src/input.css` read the attribute,
so the mutual exclusion holds in the shipped markup with the script off.

| | R9 — the list | R10 — the board |
|---|---|---|
| State root | `[data-list]` | `[data-board-view]` |
| Attribute | `data-list-state` | `data-board-state` |
| Values | `loading` \| `data` | `empty` \| `data` |
| Members | `[data-skeleton]` · `[data-list-rows]` | `[data-board]` · `[data-empty][data-empty-kind="no-results"]` |
| Rests at | `data` | `data` |

**The column-level empty is not a member.** `[data-empty][data-empty-kind="column"]` (seven
of them, one per column) says *that column is bare*; the board-level block says *this view
has nothing to show*. Only the latter is a state of the view, and a board-level tally that
included both would count the same emptiness twice.

**The state root has to be a flex pass-through, not a block.** The wrapper was first
specified as `display: block`. Measured, that is not a neutral wrapper: `[data-main]` is a
column flex container and `.td-board` carries `flex: 1 1 auto`, which can only be resolved
against a flex parent — behind a block wrapper the board falls back to its content height
(812px → 331.56px, with the columns losing their internal scrollers). The root therefore
takes `display: flex; flex-direction: column; flex: 1 1 auto` and passes the growth inward,
which measures **identically to shipping the board as `[data-main]`'s own child**. The
experiment is `verify/wrapper-experiment2.mjs`; the numbers are in `fidelity-r10.md` §2.1.2.

### 26.2 The drawer’s three editable fields save as they change (item ②)

`renderDetail()` filled `[data-detail-assignee-label]`, `[data-detail-reporter-label]` and
the label chips, and that was the end of it: nothing in the drawer listened for a commit, so
editing any of the three changed the control and nothing else — no state, no feedback, no
way for the reader to tell an edit from a no-op.

The three fields now commit **as they change**, with one state region for all of them:
`[data-detail-save]` carries `data-save-state` (`idle` \| `saving` \| `saved` \| `error`) and
`[data-detail-save-error]` (`role="alert"`) is its only visible half. The commit points are
the ones the controls already had:

| Field | Commits when | Hook |
|---|---|---|
| Assignee | focus leaves the input and the value moved, or a roster row is accepted | `[data-detail-assignee-label]` · `[data-assignee-option]` |
| Reporter | same rule | `[data-detail-reporter-label]` · `[data-reporter-option]` |
| Labels | a chip arrives or is dropped | `[data-detail-label-option]` · `[data-detail-label-remove]` |

The field names travel on the rows themselves (`data-detail-save-field`), so a reader can
tell which row a state belongs to without a second lookup. Three deliberate properties:

- **Typing is not a commit.** A field whose value did not move when focus left it is left
  alone — the drawer is opened, read and closed constantly, and none of that is a write.
- **One settle sequence serves all three.** A commit arriving while one is running folds
  into it rather than starting a second, so three quick edits produce one save and the last
  edit's verdict.
- **Opening a card resets it.** The baseline each field is compared against is the card's
  value at open, and the state returns to `idle` — an open drawer never wears the previous
  card's verdict.

The failure path is a **deterministic client-side check**, because the prototype has no
backend: a single-valued field that is empty after trimming fails, and the state holds at
`error` until the next commit. Labels cannot fail this way — the set is allowed to be empty.
Implementation-side failures (a 409, a dropped connection) reuse the same state machine; the
contract anchors on the attribute and the alert, not on what made the save fail.

**The error string is inline, and that is a deliberate boundary.**
`test/web/i18n.catalogue.mjs` is a byte-for-byte mirror of the prototype's `MESSAGES` table,
and `i18n.catalogue.test.mjs` checks both the entries and that every `data-i18n` hook
resolves against the catalogue. This round may not touch `test/**`, so a new key or a new
hook would turn that suite red on the host; the string is inlined as the no-JS fallback and
the translation is the implementing card's call (see `fidelity-r10.md` §7).

### 26.3 The description fills the column it sits in (item ③)

The create dialog's description stopped short of the bottom of its own column. Three links
were broken, and fixing any two of them changes nothing:

1. `.td-two-col` used `align-items: start`, so the left column ended at its own content
   height while the routing column (which carries more fields) ran on. → `stretch`.
2. `.td-field-grow` was a **block** container, so `.td-md-editor`'s `flex: 1 1 auto` had no
   flex parent to resolve against and the editor fell back to its content height. →
   `display: flex; flex-direction: column`.
3. `.td-md-panes` had a fixed `height: clamp(280px, 46vh, 520px)` — a **viewport** rule. The
   dialog could grow with its content; the editing area could not, so the difference piled up
   under it. → `flex: 1 1 auto; min-height: 200px`.

At 1512×950 the editor's bottom edge now lands on the column's (`65px` of slack → `0`), and
the panes measure `502px` against the old fixed `437px`. Below 760 the two tracks stack, so
there is no neighbouring height to stretch to and the panes keep a bounded height with the
base rule's `200px` as the floor.

**R4's cap survives.** `.td-modal-box` keeps `max-height: calc(100vh - 48px)` and its own
scroller. At 1120×800 that box scrolls internally by **49px, before and after** — the
routing column's natural height, not the description's. This is worth stating plainly
because the round's first draft asked for "no internal overflow at 1120×800": that assertion
is false in **both** states, so it could never have separated them, and holding it would have
meant deleting R4's viewport cap. It is replaced by a regression gate — the overflow is
unchanged — and the same is true of the draft's other height assertion, which compared the
editor against `[data-create-left]` (an element that is content-sized in both layouts, so
the difference is 0 either way). Both replacements are recorded in `fidelity-r10.md` §2.3.2
rather than quietly dropped.

### 26.4 Checked

Every selector-level assertion in `design/fidelity-r10.md` §5 is measured against the
prototype in a real browser, before and after, at 1512×950 / 1120×800 / 760×900. Before: a
genuinely empty board painted **7** columns and hid the no-results block; a filtered-to-empty
board painted **2** blocks at once; the drawer had no commit path and no feedback whatsoever;
and the description left **65px** of blank column under it. After: the board paints exactly
one member in both paths, the drawer reports `saving` → `saved` → `idle` on a change and
`error` on an empty single-valued field, and the description reaches the bottom of its column
with the board's own geometry unchanged (812px, page overflow 0). Zero console errors, zero
page errors. No token was added or changed: the error block uses the existing
`--color-td-danger` / `--color-td-danger-soft` pair, and the stretch chain introduces no
value of its own.

---

## 27. Review round R11 — the status filter, and the roster names that route to it

Two requests from Terry, both about *reaching the work that is in flight*. ① The filters bar
could narrow by assignee, priority and label, but not by status — the one first-class field
a reader actually sorts by. ② The sidebar's "Active agents" roster was a readout: the names
were text, so seeing that `jobs` was running told you nothing you could act on. The round
adds one control and makes the roster a set of routes. No block is added: the control is a
fourth member of **B04**, the routes live in **B03**, and the view they open is **B08**.
The executable contract is `design/fidelity-r11.md`.

### 27.1 The status filter is a multi-select, and it is the label control's sibling

The tempting shape is a third native `<select>`. It was evaluated and rejected: request ②
needs `in_progress` **and** `in_review` in force at once, and a single-choice control cannot
say that. `<select multiple>` is the other obvious one, and it is rejected too — it is a
list box, not a dropdown: it has no trigger that can state the current value without being
opened, and it cannot be made to look like the three controls it sits beside.

So the control is a `<details class="dropdown">` carrying a `menu` — the same family as
`[data-filter-label]`, and flattened to the same `.td-select` metrics by R9 ②, which is why
the bar still reads as one row of one component. It adds exactly one idea: the chosen set
rides on **`data-filter-status-value`** as a comma-joined subset of the seven first-class
status keys, or `all` when nothing is chosen.

| | |
|---|---|
| Value | `"all"` (un-filtered, the resting value) or a comma-joined subset of the seven keys |
| Semantics | multiple choice is **OR** — a card passes when its status is *any* chosen one; `all` (or empty) filters nothing |
| Rows | `all` + the seven keys in `DESIGN.md` §2.3 order, each `[data-filter-status-option]` with `data-status-value` and its own `aria-pressed` |
| Dot | 8px, `--status-color` through the existing `[data-status="…"]` plumbing — the key is written once and the colour follows |
| Dismissal | `data-dismiss-on-outside` — the third member of R9's light-dismiss rule, so `Esc` and an outside press close it with no new branch |

The value domain is the **menu itself**: the script reads the seven keys out of
`[data-filter-status-option]` rather than repeating the list. An eighth status is therefore
one more row and nothing else — no script edit, no second place to forget — and the script
can never name a status the document does not carry. Measured, the option values equal the
seven `data-status` values the columns and the cards already use, which is the round's
machine check for "no magic number".

`in_progress` and `in_review` are worth naming precisely, because they are the two the
roster route selects: `in_progress` is work an agent has claimed and is running now;
`in_review` is work that has left the agent's hands and is waiting on a reviewer. They are
the only two that mean *in flight* — `blocked` has stopped, `done` and `canceled` are over,
`backlog` and `todo` have not started.

### 27.2 A roster name is a route, not a narrowing on the name

Every name in `[data-agents-presence]` is now its own `<button data-agent-assignee>`; the
row still reads as one sentence, separators and all. A press does three things, in this
order: switch to the **list** view, write `{"in_progress","in_review"}` into the status
control, and run one filter pass. The list then shows exactly the work in flight, and the
filter bar states why.

**What a press deliberately does not do is filter by the name.** The assignee filter's
domain is `all | me | human | agent` — `me` is the local human, `human`/`agent` are the two
*kinds* — and it carries no given name. Narrowing to `jobs` would mean extending that
domain, which is a different requirement (a name-scoped filter is a query, not a route) and
is recorded as a boundary in `fidelity-r11.md` rather than smuggled into this round. The
frame that proves it is the one after the press: *Status: In Progress +1*, *Assignee: All*.

The name is also the button's accessible name, and the button sits inside the row's text, so
keyboard reach, `Enter`/`Space` and the `:focus-visible` ring all come from the element
being a real `<button>` — no `role`, no key handler, no `tabindex`. The face is the text it
replaced, with the pointer and a hover underline as the only affordance: the sidebar is a
readout first, and a roster that looked like a toolbar of buttons would fight the numbers
beside it.

### 27.3 Rejected alternatives

| Alternative | Why not |
|---|---|
| A third native `<select>` for status | Single choice only — cannot hold `in_progress` **and** `in_review`, which is exactly what request ② needs |
| `<select multiple>` | Not a dropdown: no trigger that states the set, no room in a 30px bar of one-line controls |
| One `<select>` per status (seven of them) | Seven controls for one field; the bar would stop being a bar |
| A chip row of seven toggle buttons in the bar | Every status permanently on screen, and the bar's height becomes a function of the status count |
| Routing by *writing the name into the assignee filter* | The domain has no given name (`all/me/human/agent`); extending it is a separate requirement, and the route's meaning is "what is in flight", not "what is jobs's" |
| Filtering on the **platform** the roster row names (`claude`, `openclaw`, …) | The row names a platform and lists names; the press is on a *name*, and a platform-scoped route is a different control that was not asked for |
| Reusing the label control verbatim (single choice) | The label menu states its choice with `aria-current`, which cannot express a set; multiple choice needs `aria-pressed` on every row |

### 27.4 Checked

Measured in a real browser against the prototype, before and after, at 1512×950, in both
languages. Before, the document carried **no** status control and **no** clickable name;
after, the bar holds `[data-filter-status]` resting on `all` with the trigger reading
`Status: All`, its menu holds exactly **eight** rows whose values are the seven first-class
keys plus `all`, and the four field controls in the bar compute to **one** height (30px).
Pressing `jobs` lands on the list with `data-filter-status-value="in_progress,in_review"`,
both rows `aria-pressed="true"` and every list row carrying one of only those two statuses;
pressing `In Review` alone leaves the `in_review` cards and nothing else, with the count
reading the *filtered* caliber; `Clear` returns all four filters to `all`. With scripting
off the control, its eight rows and all six names are still painted, because every one of
them is static markup. Zero console errors, zero page errors, both rounds. **No token and no
colour was added**: the dots use the existing `--color-td-st-*` values through the existing
`[data-status]` mapping, and the trigger reuses `.td-label-trigger` rather than a new one.

## 28. Review round R12 — the drawer's identifier shows the whole id

One request from Terry, and it is narrow: in the task detail drawer, the identifier should
read as the whole id — `TD-20261012-222353`, not `TD-20261…`. The cards and the list rows
are to keep what R8 gave them. The round therefore adds **no block, no hook and no i18n
key**; it removes one function call from one render path and adds one named exception to
one rule. The executable contract is `design/fidelity-r12.md`.

### 28.1 The cap lives in two places, and lifting one of them is not enough

R8 ③ split the truncation deliberately: the **character slice** (`identifierText()`) is what
decides *how many characters*, and `.td-id`'s `max-width: 9ch` is only a **single-line
guard** — a width, which the style guide says explicitly cannot promise a character count.
That split is why "just print the whole string" does not satisfy this request. Printing the
whole string stops the *slice*, but the span still wears `.td-id`, so an id longer than the
guard is **clipped by width** and the ellipsis returns — the reader sees a longer
abbreviation, not the id. Measured: with the slice removed and only `.td-id` in force, an
18-character id renders **65.02px wide** and its own `scrollWidth` (128) exceeds its
`clientWidth` (65). So the round changes both halves, on that one element:

| | |
|---|---|
| Text | `[data-detail-identifier]` is written from the card's own `data-identifier`, verbatim — the `identifierText()` call is removed from `openDetail()` |
| Width | the span adds **`.td-id-full`** beside `.td-id`: `max-width: none; overflow: visible; text-overflow: clip` |
| Unchanged | `title` = the full id; the drawer root's `data-identifier` = the full id; `[data-detail-id]` (the internal `td_…`) is not touched |

`.td-id` itself is untouched, because it is **shared** — B07's cards and B08's rows are
exactly where an eight-character abbreviation is wanted, and an abbreviation is what the
list's 74px ID column is designed around. The exception is carried by the element that
needs it, so the rule and its exception are both visible where they apply.

Two smaller things worth writing down. `identifierText()` **stays**: two render points still
call it (the card markup generated for a move, and `renderList()`), and an exception in the
drawer is not a reason to delete the rule. And the **identity rule does not lapse**: R8 made
the drawer's head a *display value* and moved identity to `[data-detail-drawer]`'s
`data-identifier`; the text now happens to be complete, but code that resolves the drawer's
task still reads the attribute, never the text.

### 28.2 What the uncapped head costs, measured

Nothing at the bands the board ships. The head renders the same width (63.95px) at 1512,
1240, 980, 760 and 500, no page overflows, and with an 18-character id swapped in it grows
to **127.89px** — still inside the drawer at every one of those bands. The rounded
half-hundredth is worth naming: `9ch` computes to **65.0215px** at the head's 12px face but
**59.603px** on a card, because `ch` follows the font size. That is the concrete reason the
contract asserts "a finite width" for the capped elements and `none` for the uncapped one,
rather than comparing against the string `9ch`.

The head is also a flex item (its parent is a `flex items-center gap-2` row), so
`inline-block` blockifies: computed `display` is `block` in every one of those bands. The
declaration and the measurement disagree, and the measurement is what the contract records.

### 28.3 Rejected alternatives

| Alternative | Why not |
|---|---|
| Drop `max-width` from `.td-id` itself | `.td-id` is shared with B07's cards and B08's rows; the request explicitly keeps their cap |
| Print the whole id and leave `.td-id` alone | The slice stops, the clip does not — an 18-character id still renders 65.02px wide (measured) |
| Special-case the drawer with an inline `style="max-width:none"` | An exception with no name: invisible in the stylesheet, unreviewable, and it cannot be asserted as a class in the manifest |
| Show the full id only on hover / in a tooltip | `title` already does that; the request is about the value being *readable*, not about a second way to find it |
| Truncate with a middle ellipsis (`TD-202…2353`) | Invents a second display format and a second rule; the drawer is the one place with room to show the id as it is |
| Let the head wrap onto a second line | An id is one unbroken token; wrapping splits an indivisible string, which reads worse than the width it saves |
| Make the head a horizontally scrollable box | "Fully visible" would become "fully reachable", which is a different promise; it also adds a scroll region to a two-line header |
| Give the head a copy button | The drawer's internal id row already has `[data-detail-id-copy]`; a second copy control for a value that is now fully on screen is chrome |

### 28.4 Checked

Measured in a real browser against the prototype, before and after, at 1512×950 and across
five widths. Before, opening the nine-character card `PROJ-0007` printed `PROJ-000…` in the
head — the same abbreviation the card and the list row showed — and an eighteen-character id
was clipped to 65.02px. After, the head reads `PROJ-0007` with computed `max-width: none`,
`text-overflow: clip` and `white-space: nowrap`, and the eighteen-character id measures
127.89px inside the drawer at every band. The reverse holds exactly: `[data-card-identifier]`
still reads `PROJ-000…` under a finite `max-width` (59.603px, ellipsis) and
`[data-list-identifier]` likewise (65.0215px), and neither element carries `.td-id-full`;
`title` and the drawer root's `data-identifier` were already the full id and did not move.
A six-character id is unchanged on both sides. With scripting off, the head's static seed is
still painted and now carries `.td-id-full`. Zero console errors, zero page errors, both
rounds. **Nothing else moved**: the prototype's i18n seats are 622 before and after and its
`MESSAGES` tables hold 224 keys each on both sides, and the rebuilt `tw.css` is 89 bytes
longer with exactly one added class selector — `.td-id-full`.

---

## 29. Review round R12x — the Activity view lands in the board

> **Amendment (later the same round).** This chapter was written while B27 was still pending,
> and three of its sentences say so: the closing of the introduction ("deliberately **not**
> here"), the last paragraph of §29.2 ("`[data-waiting-view]` does not exist yet … the one
> visible seam the two-segment plan leaves"), and the parenthetical in §29.5 ("`waiting`
> routes and lands nowhere (B27 pending)"). The third segment of the round closed the seam
> and **§30** below is that work. The chapter is left as it was written rather than rewritten:
> it is the record of what the integration round knew when it landed, and the two together are
> the round.

Terry's 2026-10-13 request, in one sentence: the design the previous round produced for the
sidebar's **Activity** should be in `index.html` — the press should enter it, instead of
answering with a toast. The previous round had built the view as a page of its own
(`design/activity/prototype.html` with its own script, its own catalogue and its own machine
check) and stopped there, because the block inventory defined four blocks and no fifth
surface. This round is the integration, and it is the round where the two stand-ins in the
sidebar — `activity` and `waiting` — stop being stand-ins: the chapter below is the
integration of the first. The second (`waiting`, **B27**) is deliberately **not** here; the
routing it needs is, so it lands as a root and nothing else.

The design itself is unchanged and was not re-opened: `design/activity/DESIGN-activity.md`
is still its contract (admission rules, levels, folding, density, empty states, the 132
assertions), and `design/activity/prototype.html` stays in the repository as the design
source and as the round's own evidence page. What moved is where the board *reads* it from.

### 29.1 What integration means here, and what it deliberately is not

| | |
|---|---|
| Structure | `[data-activity-view]` is copied **verbatim** from the design page's own section — same hooks, same order, same copy, same row data. Retyping is where a hook drifts, so the block was spliced from the source rather than rewritten |
| Placement | third child of `main.td-main`, beside `[data-board-view]` and `[data-list]`; it ships **`hidden`**, so the no-script default view stays the board |
| Routing | `setView()` takes four values; the nav's click handler hands it every `[data-nav-item]`, and the branch that answered `activity`/`waiting` with a revision toast is **deleted** |
| Copy | read from `app.js`'s `MESSAGES`, the document's one catalogue. The design page's own `[data-activity-i18n]` carrier is **not** carried over — two dictionaries in one document drift page by page |
| Styles | the design page's scoped `<style>` block moves into `src/input.css`, unchanged in value and in selector, and `tw.css` is rebuilt |
| A row's drawer | it lands on the board's own **B09**, on the task the row names. The design page's stand-in drawer was exactly that — a stand-in for a page with no board behind it |
| The design page | untouched and still green: `node design/activity/check-activity.mjs` reports 132/132 after the rebuild |

The activity view's *behaviour* comes over with it — the three controls, the count, the
unread boundary, the fold, `Load older`, the address bar — because a view whose controls do
nothing would be the same defect in a new costume. The one rule that changed hands is the
drawer: the design page opened a shell filled from the feed, and the board opens the drawer
it already has.

**The round's own name.** It is written `R12x` and not `R13` because it is the integration
of R11/R12's sibling round rather than a new numbered review round: the numbered sequence
belongs to the fidelity contracts (`design/fidelity-rN.md`), and this round's contract is
this chapter plus the card's own probe (`verify/probe.mjs` in the card workspace), because
its write surface is closed to a new document under `design/`.

### 29.2 The four destinations, and the one number that rides one of them

The sidebar has carried four `[data-nav-item]` buttons since C6, but only two of them did
anything: the handler switched `board` and `list` and answered `activity` and `waiting` with
`toast.activity` — the revision and the filter count, in a toast. Terry's phrase for the
result is the round's whole reason. The fix is one rule instead of two branches:

| | |
|---|---|
| `setView(view)` | toggles four roots — `[data-board-view]`, `[data-list]`, `[data-activity-view]`, `[data-waiting-view]` — and writes `aria-current="page"` on the nav item whose name equals the view, clearing it off the others |
| Scope | `[data-nav]` only. The **project rows** carry `aria-current="page"` too, for the current project, so "exactly one" is a property of the nav and not of the document |
| `[data-nav-count="activity"]` | the feed's unread count, in B03's existing `.badge.td-count` shell; `hidden` at zero, the rule the `waiting` pill already follows |
| The top bar's toggle | still exactly `board | list`, still frozen. It is a *layout* control for the board area; the sidebar's is a four-way destination list. They are different controls and R12x does not touch the first |
| The board's filter bar | stands down on the two destinations that are not the board area, and comes back on the toggle's own state when either returns. It narrows cards, and a feed narrowed by its own three controls does not want a second row of controls above it that changes nothing — the defect this round exists to remove, in a new place |

`[data-waiting-view]` does not exist yet, so a press on `waiting` moves the current-item mark
and shows no view body — the one visible seam the two-segment plan leaves, closed by B27.
Routing it now rather than later is deliberate: the round that adds the root then adds no
routing at all, and the rule "every nav item routes" is true in one place instead of two.

### 29.3 What the count means, and why there is only one of it

The pill, the boundary in the feed and the boundary's own counter are the same number — the
unread rows the reader can currently *see*. One writer (`applyActivityUnread`) feeds all
three, so they cannot disagree, and a filter that hides the new rows takes all three off
screen together rather than leaving a number pointing at nothing. At zero the pill is
`hidden` — the rule B03 already had for `waiting`, applied to the second destination that
has a count. `Mark all read` clears the flag on every row and re-runs the pass; nothing is
persisted anywhere, which is what the design decided (DESIGN-activity.md §17 leaves
"local or server-side" open for the implementation card).

### 29.4 The price, stated rather than discovered

Two costs, both known before the work started and both recorded here:

- **The `test/web/` mirror.** `test/web/i18n.catalogue.mjs` mirrors the prototype's
  `MESSAGES` byte for byte, and `test/web/blocks.contract.mjs` counts the document's hooks.
  The catalogue grows by 50 names per language and the document by 127 `data-i18n*` seats, so
  those mirrors are **now behind** — the same mechanism R11's status filter produced. This
  round's write surface is `design/**`; `test/**` is closed to it, so the mirror update and
  the implementation change land together in the implementing card.
- **One dead key.** `toast.activity` was written for the stand-in and nothing else read it.
  It is left in the catalogue rather than deleted: removing a key is a change to a mirrored
  surface, and it belongs with the same pass. It is named here so the next reader does not
  have to diff the catalogue to find it.

### 29.5 Checked

`verify/probe.mjs` (the card's workspace, not the repository) drives a real Chromium over a
loopback server, once against a pristine copy of `design/prototype` at the round's base and
once against the integrated build. The "before" side is measured, not inferred: clicking
Activity there leaves `aria-current` on `board`, raises a toast, and the document holds zero
`[data-activity-row]`. The "after" side is **48/48**: the view opens with a real box and its
rows, board and list both stand down, exactly one nav item is current and it is the one
pressed, `board`/`list`/`activity` are mutually exclusive, the board's own filter bar stands
down with the board and comes back with it, neither nav press raises a toast node any more,
`waiting` routes and lands nowhere (B27 pending), and the top bar's toggle is still exactly
two values. With **JavaScript disabled** the view is present, complete and
merely `hidden`: 17 rows, 4 day groups, 17 identifiers, 17 stamps, 17 native `<details>`,
zero templates, and the default view is still the board. The feed's own rules hold — every
row inside exactly one day group, day headings and row instants both newest-first, each row's
visible stamp equal to its own instant, and one burst folding four items. Every `data-i18n*` key the view asks for resolves in **both**
catalogues, the two catalogues hold the same names, and switching language moves the title,
the day heading and the accessible name of the row buttons (`动态` / `今天`). The controls
work: `actor = Agents` narrows the feed to agents only, the count sentence becomes the number
of rows still standing, the address becomes `#/activity?actor=agent`, Reset restores the
feed, and `Mark all read` takes the boundary *and* the sidebar pill to zero together. A row's
open button lands on B09 with `data-identifier="TD-134"` and the drawer's own activity
section filled. **Zero console errors and zero page errors** on both sides, and no page-level
sideways overflow at 1512 / 1240 / 980 / 760 / 430.

The moved stylesheet block declares **no custom property** and **no colour literal**, and
every `var(--…)` it reads already resolves in `tw.css` — so the token set is unchanged, in
the strong sense: not only no new hue, but no reference to a token that does not exist. The
rebuilt `tw.css` grows by **7478 bytes** across **349 added lines and zero removed**, of
which one class selector is not the round's own: **`.absolute`**, emitted because
`data-activity-day-kind="absolute"` is a hook *value* in the document and the scanner reads
prose and attributes alike. It is the round's one scanner artefact and it is named here
rather than silently kept; three others — `.relative`, `.link` and `.steps` — were caught by
the rebuild-and-review-the-diff rule the prototype's README prescribes, and reworded away.
The design page's own check still reports **132/132**.

### 29.6 Rejected alternatives

| Alternative | Why not |
|---|---|
| Keep the toast for `waiting`, route only `activity` | Leaves the second dead control Terry's request names, and makes the handler two rules where one does |
| Merge Activity and Waiting into one surface | Decided against by the design round: they answer different questions (a ledger of what happened vs. a list of what is on your side) and Terry's request keeps two entries |
| Give the view a second catalogue of its own (`[data-activity-i18n]`) | Two dictionaries in one document is the failure R-3 names: the page-local one silently falls behind the shared one, and a language switch translates one surface and not the next |
| Load `design/activity/activity.js` beside `app.js` | Two interaction layers binding one document: the drawer, the language pass and Escape would each be owned twice |
| Ship the view hidden and reachable by URL only | That is very nearly what the round replaces; the ask is a destination that a reader can press |
| Reuse the design page's stand-in drawer for a row | The board has a real B09 with the task's description, comments and session; opening a shell instead would be a regression *introduced* by the integration |
| Port the styles as Tailwind utilities in the markup | `tw.css` is a static `@source` build and the design's values are already tokens; semantic `.td-activity-*` classes keep the view's geometry reviewable in one block and add no utility the class scanner has to guess at |
| Build `[data-waiting-view]` in the same pass | Two single-writer segments of one file; the design for B27 (rows, reasons, the "since" column) was not settled when this round closed — it was settled before the round ended, and §30 is that segment |
| Delete `toast.activity` while here | A mirrored surface; the deletion belongs with the mirror update in the implementing card |

## 30. Review round R12x, second half — the Waiting view lands in the board

This is the other half of §29's round, and the answer to the seam §29.2 named. Terry's request
carried two names: `Activity` and the waiting entry, and from the moment routing landed, a
press on **Waiting on me** moved the sidebar's current-item mark and left the main column
empty — the same defect the round exists to remove, in the one place the round had not yet
reached. This chapter lands `[data-waiting-view]` (**B27**), and settles what the round's
design ruling (design-spec **R-4**, Jobs) had fixed only in outline: what the queue holds, how
a row reads, what the two reason kinds are, and what is on screen when nothing is owed.

### 30.1 What the queue is, and the one thing it is not

`Activity` and `Waiting on me` stand next to each other in the sidebar and are **not two views
of one thing**:

| | Activity (B26) | Waiting on me (B27) |
|---|---|---|
| Question it answers | what happened | what is owed *by me* |
| Holds | every event the design's allow-list admits | only the items whose ball is in the reader's court |
| Order | newest first — a chronology | oldest wait first — a queue |
| Reads as | a ledger you scan for recent change | a queue you work from the overdue end |
| Ends | a family of controls: filters, fold, paging, unread boundary | one press per row: into the task |

The ruling that keeps them apart is Elon's (card comment, 2026-10-12 19:04: *two independent
entries, not merged*), and Terry's own request implies it — both names are named, and both are
to be fixed. Two roots, two questions: a merge would answer neither well.

### 30.2 The rows, and why the wait is the sort key

A waiting row is B26's row by *measurement*, not by class: the same 30px line, the same 12px
actor, the same 11px identifier and stamp, the same 10px gutter, the same 24px opener — spelled
in its own family (`.td-waiting-*`) so that either view can move without dragging the other.

One difference is deliberate: **there is no tick rail**. B26's rail exists to say "unread" or
"a folded burst", and every item in this queue is unread by definition, so the rail would be a
mark that means nothing — decoration on the one line that has least room for it. What carries
the kind here is the reason chip, which is a fact.

**Why oldest first.** The queue's whole value is that its overdue end is visible. A chronology
reads newest first because "what happened" is a question about now; a queue read the same way
hides the item that has waited five days behind the one that arrived a minute ago — which is
the failure a queue exists to prevent. So the list runs oldest → newest, and the row that has
waited longest is the first thing the reader meets. (`Rejected: newest first, for symmetry
with the feed` — see §30.6.)

Three things the rows state, and how:

| | |
|---|---|
| The wait | `[data-waiting-since]` carries the instant on `datetime`, the row carries it again on `data-since`, and the visible text is that instant read the way the feed reads one. The three `time.*` keys are reused rather than restated, and in the shipped document the text already equals what the page would compute — so the script has nothing to recompute here, and a reader without it sees the same sentence |
| The identifier | `[data-waiting-task]` renders at most eight characters plus `…`, whole value on `title` — R8 ③'s rule, the one B07's cards and B08's rows follow. Waiting is the first surface that can *prove* the rule without a script: `PROJ-0007` is the board's only identifier longer than eight characters, so its cell reads `PROJ-000…` in the markup itself |
| The open press | `[data-waiting-open]` is the keyboard affordance and the row body its pointer twin, and both land on the board's own **B09** for the task the row names. The queue is a way *into* a task, never a second task page |

### 30.3 The two kinds, and how a colour reaches the chip without a new hue

`data-waiting-reason-kind` is the whole domain, and it has two values:

| Kind | What it means | Its dot |
|---|---|---|
| `question` | someone asked, and the answer is yours — a delivery waiting on a verdict reads this way | `--color-td-st-review`, through `--status-color` |
| `blocked` | the task cannot move without you | `--color-td-st-blocked`, through `--status-color` |

Two, because the ruling fixes two: a third kind is a change to the ruling, not an addition to a
list. The chip is read from the row's own attribute — one attribute → one custom property, the
rule the `[data-status]` and `[data-priority]` bindings already follow — so the component that
draws the dot never names a colour, and both kinds read a *status* token because the reason
**is** the task's own state. The declared token registry is byte-identical to the round's base;
no hue enters the sheet.

The header states the queue's size — `[data-waiting-count]` is `waiting.count` around a number
— and its heading is `waiting.title`, byte-identical to `nav.waiting`: the destination pressed
and the heading over the list are one string per language, so a rename lands in one place.

**The sidebar gets no second pill.** Activity carries `[data-nav-count]` because that view's
number is *not* the length of what is on screen — the feed filters, folds and pages. A queue's
number is exactly its length, and the header already says it; a pill two inches to the left
would restate one sentence twice, which is the decoration R12x took off the nav rather than a
second one.

### 30.4 The empty state

`[data-waiting-empty]` ships in the document and `hidden`, as B26's two empties do, so a reader
without the script still gets a complete view. When nothing is owed the design's answer is one
line where the queue stood — centred in the view and capped in width, because a dashed rule
stretched across 1300px is the shape of a drop target, not the shape of an answer — and the
header's tally stands down with the queue, since "0 waiting on you" above "Nothing is waiting on
you" is one sentence printed twice.

The prototype cannot reach that state: nothing in this queue filters, and the seeded board has
five items. Its frame is therefore driven by the capture script moving one attribute — the same
arrangement the activity design's own empty-state frames used, and the same disclosure.

### 30.5 Checked

`verify/probe-waiting.mjs` (the card's workspace, not the repository) drives a real Chromium
over a loopback server, once against a pristine copy of `design/prototype` at the round's base
(`94b5c28`) and once against this build. The **before** side is measured, not inferred — **9/9**
— and it is the seam itself: no `[data-waiting-view]` in the document at all, the press *does*
move the current-item mark (routing landed in the previous segment), and every view root is
`hidden` afterwards, so the main column is left with nothing. The **after** side is **46/46**:

- **Routing.** The view opens with a real box (1216 × 854 at 1512), the other three roots all
  stand down, and exactly one nav item is current and it is the one pressed — everywhere in
  `[data-nav]`, checked after each of the four presses. Board, list and activity each take the
  mark back from waiting, and waiting takes it back again from activity.
- **No toast.** Two presses on `waiting` add no child to `[data-toast-region]`: the branch that
  answered this name with a revision is gone.
- **The header.** `waiting.title` and the sidebar's own text for the destination are the same
  words, the tally reads `5 waiting on you` and equals the rows under it, and it sits beside the
  heading on the same line.
- **The queue.** The first row's own button opens B09 with `data-identifier="TD-118"` and the
  drawer's activity section filled; a different row's *body* opens the same surface on its own
  task; the identifier rule holds (`PROJ-000…` on screen, `PROJ-0007` on `title`, every
  short identifier verbatim); the reason domain is exactly `question | blocked` with both copies
  present; each of the five stamps equals the instant it carries read by the page's own rule;
  the waits run non-decreasing down the list; and all five rows name a task the board carries,
  so no opener is a dead press.
- **Scripting off.** Five items in the document, the list's own count equal to the source count,
  **zero templates**, and all six fields present on all five rows; the first row still reads as
  a sentence (`elon Blocked TD-118 Migrate attachments to object storage 5d ago`); the tally is
  the static sentence it ships; the default view is still the board.
- **One dictionary.** The view asks for **9** catalogue names, every one resolves in both
  catalogues, the two catalogues hold the same names, three of the nine are the reused `time.*`
  keys, and there is no second carrier. Switching to `zh` re-words the heading, the tally, the
  reason chips, the stamps and the accessible name of the openers (`等你回复` / `5 项等你回复` /
  `已阻塞` / `5 天前` / `打开 TD-118`), with no raw key left on screen.
- **Tokens.** The waiting rules declare no custom property, carry no colour literal, and every
  `var(--…)` they read already resolves in `tw.css`; the declared token registry is
  byte-identical to the base commit.
- **Width and errors.** No page-level sideways overflow at 1512 / 1240 / 980 / 760 / 430 and no
  element escaping the viewport, the title keeps a real width at every band (the row moves the
  identifier and its title to a second line below 761px rather than crushing them), and **zero
  console errors and zero page errors** on both sides.

The round's own activity probe is re-run against this build and is **48/48**, unchanged: the
waiting block was added beside B26's, and B26's rules and hooks are untouched. The rebuilt
`tw.css` grows by **185 added lines and zero removed**, every selector of which belongs to the
two families the round added (no scanner artefact this time). The capture set is
`design/assets/r12x-waiting/` — 8 frames (1512 / 1240 / 980 / 760 / 430, `zh`, the empty state,
and the script-off frame), with the two attribute-moved frames disclosed in its README.

### 30.6 Rejected alternatives

| Alternative | Why not |
|---|---|
| Merge Waiting into Activity | The ruling keeps two entries and Terry's request names two; the two answer different questions (§30.1), and a merged surface would have to be both a chronology and a queue — which means one of the two readings is wrong for half its rows |
| Read the queue newest first, like the feed | Symmetry with B26 is worth less than the queue working: the oldest wait is the one at risk, and the top of the list is the only place a reader reliably looks |
| Give each row a second line with the reason as a sentence | The 30px line is the family's density target (B26 §7), and the reason is one of two values — a chip says it in 60px, a sentence costs every row a second line |
| Copy B26's tick rail | It would be a mark that encodes nothing (§30.2). Every row here is unread, and there is no burst |
| Put the tally in the sidebar as a second `[data-nav-count]` | It would restate, on the other side of the screen, the sentence the header already carries — Activity's pill earns its place because its number is not the length of what is on screen |
| Make the row's task an anchor back to the board, the way `[data-activity-task]` is | That anchor exists in B26 because the feed is a log you follow up on; here the reader is already being asked to act, so the row opens the task in place, and a second route would make the queue leave the view it belongs to |
| Add a third kind for "a delivery waiting on a verdict" | The ruling's domain is two, and `question` already reads that way (the answer is the reader's). A third kind is a change to the ruling, not an addition |
| Give `waiting` its own filter bar, as the feed has | A queue of what is owed is not something to narrow: the count of it is the point, and a filter would let a reader hide the overdue item — the failure the ordering exists to prevent |

## 31. Review round R13 — the roster name narrows as well as routes, and the chosen name wears a capsule

R11 made every roster name a route: a press opened the list with the two in-flight statuses in
force, and the round said explicitly what it did **not** do — it did not filter by the name,
because the assignee control's domain (`all | me | human | agent`, §27.1) carried no given name,
and narrowing to a name was recorded as a boundary rather than smuggled in. Terry's next request
is that boundary: a press on `jobs` should reduce the list to *jobs's work that is in flight*,
the pressed name should look chosen, and a press on its `✕` should take the name back out
without disturbing anything else.

The round adds **no block**. The roster is **B03**, the control is **B04**, the view it lands on
is **B08**, and the name-scoped value is a fifth class of value in a control that already
exists. The executable contract is `design/fidelity-r13.md`.

### 31.1 A name is a narrowing *and* a route, and one press does both

The press is four steps in a fixed order: switch to the **list** view (R11), write
`{"in_progress","in_review"}` into the status control (R11), write the **name** into the
assignee control (R13), and run one filter pass. The first two are R11's and are untouched; the
third is the round. What the reader gets is the intersection — a name press means *this
person's work that is in flight*, and the filter bar states both halves:
*Status: In Progress +1*, *Assignee: jobs*.

The two conditions are **ANDed**, like any two fields of the bar. That is the whole reason the
round is small: the assignee control already ANDs against the status set, so a name-scoped
route needed a value in that control and nothing else — no new control, no second filter bar, no
special case inside `applyFilters()` beyond one more arm in the assignee clause.

Pressing the name **already in force** is the capsule's own close, not a fresh route: it takes
the name out and leaves the status set and the view alone — the ordinary toggle semantics of an
`aria-pressed` button, and the same move the `✕` makes.

### 31.2 One truth (the control), two things rendered from it (the control's options and the roster's capsules)

The value lives where it always lived — on the native `<select>` that is `[data-filter-assignee]`
— and the round is careful not to give it a second home. A JS variable or a stored preference
would be a second truth, and the first thing to drift.

What the round does add is that a name is **not in the document**. The four static options are
the two *kinds* (`human`, `agent`), the local human (`me`) and the un-filtered resting value
(`all`); a roster name is none of those. So the named option is **generated when it is needed
and removed when the control leaves it**, at most one at a time, always inside the control
itself — and `renderAssigneeFilter()` is the single writer of both halves:

| It reads | It writes |
|---|---|
| `[data-filter-assignee]`.value | the control's own named option (added when the value is a name, removed when it is not) |
| | every `[data-assignee-item]`: `data-assignee-active` (`"true"` for the name in force), the name button's `aria-pressed`, and the `✕`'s `hidden` |

Because the capsule is *derived* rather than *toggled*, every path that changes the value ends in
the same restatement — a press on a name, a press on the `✕`, a press on the name already in
force, a human using the native `<select>`, and `resetFilters()` — and the roster cannot state a
name the control is not showing. Measured: after a press, exactly **one** item is active and
exactly **one** named option exists; after the `✕`, zero and zero; switching names leaves one of
each, with the old name's option gone.

The round also opens the assignee filter to a value the *board* did not previously produce. The
**matching rule is the card's own attribute** (`data-assignee`) — the field the drawer already
shows and the cards already carry — so the control adds no second source for who a card belongs
to, and `me` / `human` / `agent` keep their R11 meanings.

### 31.3 The capsule is a shell around the name, and it costs no new token

A selected roster name wears a **capsule**: a 20px pill with a `1px --color-td-line-strong`
edge, a `999px` radius, the `--color-td-active` bed, a `2px` gap and a 14px `✕` at its end. The
shell sits on a **wrapper** (`[data-assignee-item]`) that holds the name button and the `✕` as
**siblings** — a nested `<button>` is illegal, and the wrapper is what makes two controls one
item. Putting the shell on the wrapper rather than on the name button is deliberate: the face
stays exactly the text it was, in the same `.td-mono` at the same size, so the *press target* and
the *reading* are both unchanged and only the surrounding state is new.

The wrapper is also what keeps the row still. The capsule is shorter than the row and the row's
height is fixed, so selecting a name moves nothing: measured, all four `[data-agent-row]` heights
are identical before and after a press (**delta 0**). R11's resting face — no shell, no border,
no padding — is untouched, because the capsule's rules are scoped to
`[data-assignee-active="true"]`; at rest the wrapper is an inline span and the row reads exactly
as R11 left it.

The `✕` is static markup that is `hidden` until the name is in force, which is what makes the
script-off document honest: a reader without the script gets all six names and **no** selection,
so every `✕` is legitimately hidden. Both the `✕` and the name are real `<button>`s, so
`Enter`/`Space` and the `:focus-visible` rings come from the element, not from a key handler —
measured, the name takes R11's ring and the `✕` takes `--color-td-focus`.

**No token and no colour was added.** The capsule and the `✕` read only `--color-td-*` values
that already existed, the glyph is text (`✕`, no image, no icon font), and the declared `:root`
registry in the rebuilt stylesheet is **byte-identical** to the base — 205 declarations, none
added, removed or reworded. The rebuild adds **34 lines and removes none**, and every one of them
is a rule the round meant to write.

### 31.4 The `✕` takes the name out and touches nothing else

Terry's request is precise — the `✕` should remove *the assignee condition* — and the round
treats the rest of the bar as out of scope: no view switch, no status change (the two in-flight
statuses stay in force), no priority, label or search change, no menu opened or closed, and no
toast. The event is stopped at the button, so a press on it can never fall through to the
wrapper and be read as a press on the name — which would re-route instead of clearing.

What that leaves is a filter bar that can say *Status: In Progress +1* and *Assignee: All* after
a press that never left the list view, and a roster with no capsule — the frame the round's
capture set calls "cleared". Reset still lives on `Clear` alone and needs no new branch: the
control is set back to `all`, and the roster and the options follow from the same restatement
that already runs on every filter pass.

### 31.5 Checked

Measured in a real browser against the prototype, over a loopback static server, at 1512×950 in
both languages unless stated. The round's own contract runs **45 assertions — A (structure),
B (geometry / computed style) and C (interaction) — and all 45 pass**; the script-off pass is
run separately and the same structure assertions hold with scripting disabled.

- **Structure.** Six `[data-assignee-item]`, each with exactly one name button and one `✕` keyed
  to its own name; at rest every item is inactive and every `✕` is hidden and unpainted; the
  control holds **four** static options and **zero** named ones. With scripting off: six items,
  all six names readable, six `✕` hidden, four static options.
- **Geometry.** The selected item computes to `border-radius: 999px`, `border-top-width: 1px`,
  `display: inline-flex`; a resting item has **0px** of border. No row moves (delta 0 on all
  four). The document does not scroll sideways at any of the five tiers
  (1512/1240/980/760/430), and below 1024 — where the row's text is hidden whole — the items go
  with it: not visible at 980, 760 or 430, visible at 1240 and 1512.
- **Interaction.** A press on `jobs` lands on the list with `data-filter-status-value` =
  `in_progress,in_review` and the control on `jobs`, and the list shows **exactly the cards the
  script independently computes** for that pair (1 of 12 in the demo project); exactly one
  capsule is active and its `✕` is shown; the `✕` returns the control to `all`, drops the named
  option, restores the roster, keeps the status set and stays in the list; switching to `linus`
  leaves exactly one capsule and exactly one named option; a second press on it clears; and
  `Enter` on either focused button reproduces the two presses. Zero console errors, zero page
  errors, and no toast from either press.
- **The round's one measured cost.** The capsule is **20px wider** than the flat name it
  replaces (the claude row's line goes 143px → 163px) while its single-line host is 144px, so at
  1512 the row's last name is ellipsized by **19px**. §3.2's contract protects the row's *height*
  and says nothing about its width; the round implements the specified numbers and records the
  measurement as an open item (`design/fidelity-r13.md` §8 U-3) rather than choosing a remedy.
- **Hook ownership.** `[data-assignee-option]` was **already taken** by B22's dialog menus (14
  seats, bare attributes). The round keeps the specified hook name, scopes every read to the
  control it means, and adds no seat to B22's (measured 14 before and after); the collision is
  recorded in `fidelity-r13.md` §8 U-1.
- **One new i18n seat.** The `✕` needs an accessible name and no existing key reads as "remove
  the assignee filter", so the round adds exactly one — `assignee.clear` — which is what moves
  the catalogue by one in each language and the markup's `aria-label` hooks by six.

### 31.6 Rejected alternatives

| Alternative | Why not |
|---|---|
| A second filter bar (or a chip row) for the chosen name | The name is already a value of an existing control; a chip row would put the same truth in two places, and the roster capsule already carries the selected state the request asked for |
| Draw the selected state on the control rather than the roster | Terry's request is about the pressed name; the control is a native `<select>` that can state the value but cannot wear a capsule, and emphasising the same name twice would be two answers to one question |
| Make the assignee filter multi-select so several names can be chosen | The domain is a scalar (`all`/`me`/`human`/`agent`) and the request says "that name"; a set would change the control's contract and every reader of it |
| Leave the name out of the filter and keep R11's route-only press | That is the defect: the list would show everyone's in-flight work under a name's heading |
| Clear the status set along with the name when the `✕` is pressed | The request is explicit — the `✕` removes *the assignee condition*. Dropping the status set too would silently widen the list, which is the opposite of what the surface just promised |
| Put the `✕` inside the name button (one control, two targets) | Nested `<button>` is illegal HTML, and a single button cannot both re-route and clear |
| Always render the `✕` and hide it with a class | The script-off document must be honest without the script; a `hidden` attribute on static markup gives a reader with no script a roster with no selection, rather than six stray crosses |
| Store the chosen name on the element and read it back instead of reading the control | It would be a second truth beside the control's value, and the first thing to drift when `Clear` resets the control |
| Give the capsule an accent bed, like a primary action | The accent is the brand line and belongs to primary actions; a selected filter is a state, not a call to action, and the round's contract forbids a new hue |
