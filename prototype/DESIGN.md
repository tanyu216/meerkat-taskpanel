# TaskPanel — Design Specification (v1 prototype)

> Implemented from `design-style-guide.md` (visual tokens — single source of truth)
> and `design-spec.md` (structure, blocks, interactions, coverage), as amended by
> `design-spec-addendum-v1.1.md` (access model, top bar, i18n),
> `design-spec-addendum-v1.2.md` (sidebar-footer switches, access-model rewrite) and
> `design-spec-v1.3.md` (footer split into three equal thirds; theme and language become
> dialogs alongside settings), and then by **R3** — `design-spec.md` (brand re-skin,
> Signal Bars mark, rename to TaskPanel) together with `design-spec-r3-addendum.md`
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
  overlays (dropdown, modal, drawer, toast) use the single `--shadow-pop`.
- Identifiers, times and counts are tabular monospace — vertical alignment is the
  "precision" cue.
- No gradients, no illustration-style empty states, no large radii, no emoji icons.
  Icons are inline SVG, linear stroke 1.5.
- Agents and humans are visually distinguishable without a second theme:
  dashed ring + semantic platform badge, same palette.
- The mark is **Signal Bars** — three rising capsules and one delivered node, the
  board's own progression. It is drawn from `design/brand/BRAND.md` §5, reads its
  two fills from `--color-td-ink` and `--color-td-accent`, and appears in the top
  bar, in the large empty state and as the favicon.

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

Light is the default (`<html data-theme="taskpanel">`). Dark is
`<html data-theme="dark">`, toggled from the **sidebar footer** (the top bar carries
no theme control) and driven entirely by custom-property overrides — no component
knows which theme is active.

Dark values come from `design/brand/tokens.css`'s `[data-theme="dark"]` block. Since
R3 the status and priority ramps are **dark-specific**: they are no longer the light
values reused. Both ramps are re-declared inside `html[data-theme="dark"]` in
`src/input.css`, which is the only place that override can live — the token blocks sit
outside every cascade layer, and unlayered declarations outrank layered ones.

---

## 8. daisyUI integration

daisyUI 5 emits its component CSS into **nested sub-layers of `@layer utilities`**.
A rule placed in `@layer components` would therefore always lose to daisyUI,
whatever its specificity. The app component layer in `src/input.css` is
consequently declared inside `@layer utilities` **after** the daisyUI plugin, so:

```
theme < base < components < utilities ┊ daisyui.* < app components < tailwind utilities
```

Two custom themes are registered: **`taskpanel`** (light, default) and **`dark`**.
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
3. `design-spec.md` for **structure and behaviour** — block inventory B01–B16,
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
| 20 | daisyUI theme names | — | `taskpanel` / `taskpanel-dark` | `taskpanel` / **`dark`** — the spec mandates the attribute `data-theme="dark"`, and daisyUI keys its dark theme off `data-theme`, so the palette is registered under the name `dark` |
| 21 | File layout | — | `assets/tw.css`, `assets/app.js`, `assets/vendor/…`, `src.css` | `tw.css`, `app.js`, `vendor/…`, `src/input.css` per the task card's deliverable list (see README "File map") |

Both naming generations are still live in the stylesheet: `src/input.css` exposes
the style-guide short names (`--bg`, `--surface`, `--accent`, `--st-progress`, …)
**and** the design-spec `--td-*` aliases, all pointing at the single set of
`--color-td-*` values. One palette, no duplicated literals.

---

## 10. Team & identity model

TaskPanel is a board for an **AI-agent team**, so the people on it are the team
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

What replaced the sidebar identity block is a **row of controls**, not a reachability
readout. Review round v1.2 moved the display switches out of the bar and into the footer;
v1.3 split the row into three equal thirds; v1.4 made each third act directly — a switch,
a dropdown and an icon button, no dialog between the press and the result:

| Surface | Content |
|---|---|
| Top bar, right end | `[data-revision]` · `[data-new-task]` |
| Sidebar footer `[data-access-status]` | three equal cells, one affordance each — `[data-theme-switch]` (inline theme switch) · `[data-lang-select]` (language dropdown) · `[data-access-open]` (icon-only settings) |

**Three equal thirds, each centred.** The footer is `display: grid` with
`grid-template-columns: repeat(3, minmax(0, 1fr))` and `align-items: stretch`, so the
three cells are each exactly one third of the sidebar column. Every cell is a
`.td-access-cell` block button that fills its third, with icon and label centred on both
axes (`display: flex; align-items: center; justify-content: center; gap: 6px;
text-align: center`), a hairline `border-inline-start` between neighbours and a
`:focus-visible` accent ring. The theme cell and the language trigger **state the value in
force** — the theme's name (`Light` / `Dark`, 浅色 / 深色) beside a sun or moon glyph, the
language's short name (`EN` / `中文`) beside a globe and a caret — written by the same
`applyTheme()` / `applyLanguageOptions()` functions the press and the pick call. The
settings cell shows nothing but a gear: it has no visible label at all, and its accessible
name comes from `access.open`, the key the panel always used. `[data-theme-toggle]` and
`[data-lang-toggle]` remain **deleted**, not hidden — what replaced them in v1.4 is a
switch *inside* the theme cell rather than a switch beside it.

**Each third acts directly (v1.4).** The theme cell **is** the switch: `[data-theme-switch]`
is a `aria-pressed` button whose press flips `html[data-theme]` between `taskpanel` and
`dark` on the spot, swapping the glyph and the name in the same pass and reporting a toast.
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

The footer stays three equal thirds down to the smallest width; below 1024px the sidebar
is a rail, so the labels drop out with the rest of the sidebar text and each third becomes
a centred 14px glyph. Three glyphs fit the 64px rail (56px under 560px) with no horizontal
overflow at any width, and the row itself never wraps.

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
(the dropdown behind the middle footer cell) switches to Chinese and back; the active
option carries `aria-pressed`, the trigger always shows the language in force, the options
name their own language (`English` / `中文`) in *both* catalogues, and the menu carries an
`aria-label` from the catalogue.

**One catalogue, in memory.** `app.js` holds `MESSAGES = { en: {…}, zh: {…} }` — **185
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
   width overflows.
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
3. **The switch states the state, twice.** `[data-theme-switch]` is an `aria-pressed`
   toggle *and* a labelled control: the glyph swaps sun↔moon, `[data-theme-label]` swaps
   `Light`↔`Dark` (浅色↔深色), and `aria-label` is rewritten to name the state one press
   *reaches* (`Switch to dark theme` / `切换到深色主题`), so a screen-reader user hears the
   action rather than only the state. `applyTheme()` remains the single writer of all four.
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
   renamed `taskpanel` and `data-theme="dark"` is unchanged, so the attribute contract
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
5. **The mark.** Signal Bars (`BRAND.md` §5) replaces the four-square glyph in
   `[data-brand]`, stands in the large empty state (32px, in `--color-td-ink-3` so the
   accent node stays the only lit element), and ships as `prototype/favicon.svg` with a
   `prefers-color-scheme` pair. The mark reads its fills from `--color-td-ink` and
   `--color-td-accent`, so there is one file for both themes, not two.
6. **The rename.** The product name is now `TaskPanel` across `prototype/**` and
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
| label filter | `dropdown` + `menu` + `badge` | filters bar, `.td-label-trigger` / `.td-label-menu` |
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
Assignee, Project, Status, Reporter — in the order the addendum lists them. The tracks are
equal above 760px (`minmax(0, 1fr)` twice, so a long value or the editor can never push the
dialog wider than its box) and stack at ≤760px, which is its own media query rather than
the shell's 759px one, because the dialog has to be single-column *at* 760. Labels are not
a field: the create form never had one, and the addendum lists them as optional.

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

Two **Optional** fields close B10's right column, after Reporter. They are B22's control
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
