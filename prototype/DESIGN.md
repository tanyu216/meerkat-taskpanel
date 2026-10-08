# TaskDashboard — Design Specification (v1 prototype)

> Implemented from `design-style-guide.md` (visual tokens — single source of truth)
> and `design-spec.md` (structure, blocks, interactions, coverage), as amended by
> `design-spec-addendum-v1.1.md` (access model, top bar, i18n) and
> `design-spec-addendum-v1.2.md` (sidebar-footer switches, access-model rewrite).
> Every value below is copied from those documents. **Nothing here is invented**;
> §9 records every point where the two documents disagree and what was chosen,
> §14 records the judgement calls the v1.1 addendum left open, and §15 the v1.2 round.
> v1.2 changed no visual token: colour, type, spacing and radius are untouched, and the
> brand re-skin remains a separate card.

---

## 1. Style direction

**Quiet Precision** — a workhorse UI for an AI-agent team, not a marketing page.

- Information density serves "scan one project in one glance". 4px grid, tightened
  but not crowded.
- Hierarchy comes from spacing and section boundaries — never from stacked colour
  blocks or shadows.
- Exactly **one accent** (indigo). Every other colour is a semantic signal
  (status / priority / risk) and never decoration.
- Hairline 1px borders on white surfaces. **Cards carry zero shadow**; only
  overlays (dropdown, modal, drawer, toast) use the single `--shadow-pop`.
- Identifiers, times and counts are tabular monospace — vertical alignment is the
  "precision" cue.
- No gradients, no illustration-style empty states, no large radii, no emoji icons.
  Icons are inline SVG, linear stroke 1.5.
- Agents and humans are visually distinguishable without a second theme:
  dashed ring + semantic platform badge, same palette.

**Anti-patterns (a presence is a fail):** gradient buttons · full-screenshot pill
radii · coloured section blocks · multiple accents · shadow-floating cards ·
emoji as icons · high-saturation backgrounds.

---

## 2. Colour tokens

### 2.1 Neutral & surface

| Token | Value | Used for |
|---|---|---|
| `--color-td-bg` | `#FAFAFB` | application background |
| `--color-td-surface` | `#FFFFFF` | cards, panels, column containers, top bar |
| `--color-td-sunken` | `#F4F4F6` | sidebar, column slot, inline code |
| `--color-td-hover` | `#F6F6F8` | hover surface |
| `--color-td-active` | `#EDEDF1` | pressed / selected surface |
| `--color-td-line` | `#E6E6EA` | hairline border |
| `--color-td-line-strong` | `#D5D5DB` | emphasis border, drop target |
| `--color-td-ink` | `#16161A` | primary text |
| `--color-td-ink-2` | `#5B5B66` | secondary text |
| `--color-td-ink-3` | `#8E8E99` | tertiary / placeholder / meta |
| `--color-td-ink-4` | `#B4B4BE` | disabled / weakest |

### 2.2 Brand & semantic

| Token | Value | Used for |
|---|---|---|
| `--color-td-accent` | `#4F5BD5` | primary button, selection, links, focus |
| `--color-td-accent-hover` | `#4450C4` | accent hover |
| `--color-td-accent-soft` | `rgba(79,91,213,0.10)` | selected surface / tint |
| `--color-td-danger` | `#E5484D` | error / blocked |
| `--color-td-danger-soft` | `#FDECEC` | error surface |
| `--color-td-warning` | `#C99700` | warning text |
| `--color-td-success` | `#2E9E63` | success / done |
| `--color-td-focus` | `rgba(79,91,213,0.35)` | keyboard focus halo |

### 2.3 Status — 7 values, one mapping, never mixed

| status | token | value | label | expression |
|---|---|---|---|---|
| `backlog` | `--color-td-st-backlog` | `#8E8E99` | Backlog | 8px dot in the column head, 3px stripe on the card |
| `todo` | `--color-td-st-todo` | `#64748B` | To Do | ″ |
| `in_progress` | `--color-td-st-progress` | `#D9930D` | In Progress | ″ |
| `in_review` | `--color-td-st-review` | `#7C6BE8` | In Review | ″ |
| `blocked` | `--color-td-st-blocked` | `#E5484D` | Blocked | ″ |
| `done` | `--color-td-st-done` | `#2E9E63` | Done | ″ (title weakens to `--color-td-ink-3`) |
| `canceled` | `--color-td-st-canceled` | `#B4B4BE` | Canceled | ″ (title also struck through) |

### 2.4 Priority — 5 levels, colour **plus** shape

| priority | token | value | shape |
|---|---|---|---|
| `urgent` | `--color-td-pri-urgent` | `#E5484D` | solid square + colour |
| `high` | `--color-td-pri-high` | `#E8843D` | solid square + colour |
| `medium` | `--color-td-pri-medium` | `#D9A721` | outlined square + colour |
| `low` | `--color-td-pri-low` | `#5B8DEF` | outlined square + colour |
| `none` | `--color-td-pri-none` | `#B4B4BE` | grey dash, **no colour** (noise reduction) |

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

- Sans stack: `ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`.
- Mono stack: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`, with
  `font-variant-numeric: tabular-nums`.
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

Light is the default (`<html data-theme="taskdash">`). Dark is
`<html data-theme="dark">`, toggled from the top bar and driven entirely by
custom-property overrides — no component knows which theme is active.

Dark values come from `design-spec.md` §2.2, mapped onto the style-guide role
names (the style guide defines no dark palette). Status and priority keep their
single values in both themes, per `design-spec.md` §2.3.

---

## 8. daisyUI integration

daisyUI 5 emits its component CSS into **nested sub-layers of `@layer utilities`**.
A rule placed in `@layer components` would therefore always lose to daisyUI,
whatever its specificity. The app component layer in `src/input.css` is
consequently declared inside `@layer utilities` **after** the daisyUI plugin, so:

```
theme < base < components < utilities ┊ daisyui.* < app components < tailwind utilities
```

daisyUI components used: `btn`, `badge`, `dropdown` (`<details>` based), `menu`,
`modal` (`<dialog>`), `input`, `select`, `textarea`, `tooltip`, `avatar`,
`skeleton`. Everything board-specific (card, column, chip, drawer, legend, toast,
empty state) is a small app component built from the tokens above.

Two custom themes are registered: **`taskdash`** (light, default) and **`dark`**.

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
| 20 | daisyUI theme names | — | `taskdash` / `taskdash-dark` | `taskdash` / **`dark`** — the spec mandates the attribute `data-theme="dark"`, and daisyUI keys its dark theme off `data-theme`, so the palette is registered under the name `dark` |
| 21 | File layout | — | `assets/tw.css`, `assets/app.js`, `assets/vendor/…`, `src.css` | `tw.css`, `app.js`, `vendor/…`, `src/input.css` per the task card's deliverable list (see README "File map") |

Both naming generations are still live in the stylesheet: `src/input.css` exposes
the style-guide short names (`--bg`, `--surface`, `--accent`, `--st-progress`, …)
**and** the design-spec `--td-*` aliases, all pointing at the single set of
`--color-td-*` values. One palette, no duplicated literals.

---

## 10. Team & identity model

TaskDashboard is a board for an **AI-agent team**, so the people on it are the team
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

What replaced the sidebar identity block is a **display-switch cluster**, not a
reachability readout. Review round v1.2 moved the two display switches out of the bar and
into the footer, and removed the bind-address copy entirely:

| Surface | Content |
|---|---|
| Top bar, right end | `[data-revision]` · `[data-new-task]` |
| Sidebar footer `[data-access-status]` | `[data-theme-toggle]` · `[data-lang-toggle]` · `[data-access-open]` — one compact row |

The top-bar order is exactly the one the v1.2 addendum fixes; the primary action stays
last, and the bar holds **no display-mode control**. **Nothing in the chrome reports
`Local` or `localhost` any more** — the readout, its green status dot and the styles that
drew them are deleted outright, so the old model is not reachable from any selector. The
bind address is stated *inside* B19 instead, as prose, where it can name the value the
board actually binds.

The footer row stays a row down to 1024px; below that the sidebar is a rail, so the three
controls stack vertically and the `EN` / `中文` pair turns vertical to fit the 64px rail
(56px under 560px) with no horizontal overflow at any width.

**B19 · Access & token settings** — `[data-access-open]` opens `[data-access-panel]`,
hidden by default and dismissed with `Esc`, the scrim (`[data-access-overlay]`) or
`[data-access-close]`. It uses the same `data-state` + `hidden` overlay contract as the
drawer: `hidden` comes off first so the transition has a frame to start from, and the
panel is only hidden again once the close transition has finished.

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

**English is the default** (`<html lang="en">`). `[data-lang-toggle]` in the sidebar
footer (moved there in v1.2) switches to Chinese and back; the active option carries
`aria-pressed`, so the current language is always visible, and the group carries an
`aria-label` and `title` from the catalogue.

**One catalogue, in memory.** `app.js` holds `MESSAGES = { en: {…}, zh: {…} }` — **181
keys per language, mirrored 1:1** (a test asserts the two key sets are identical). No
external file, no fetch, no build step; `text()` resolves against the active language,
falls back to English and then to the key itself, so a missing translation shows up as
visible copy rather than an empty element.

**Hooks.** `data-i18n` sets text; `data-i18n-placeholder`, `data-i18n-aria-label` and
`data-i18n-title` set the three attributes; `data-i18n-arg` fills a `%s` in the string
and is itself resolved as a key first — so `column.add` + `status.todo` reads
`Add task to To Do` in English and `在待办中新建任务` in Chinese from **one** key pair
instead of fourteen.

**Coverage** (150 of the keys are on hooks in the markup): top bar (brand, switcher,
search, view, revision, theme, language, primary action) · sidebar nav, project list,
agent presence, legend, footer readout · the filter bar including **every** `<option>` ·
all seven column headers **and** their empty-column messages and add-button labels ·
the no-results empty state · the list view · the drawer (section titles, property
labels, relation labels, comment role chips, relative timestamps, session block,
buttons) · both modals · the error state · the states gallery · the token panel ·
every toast, including the ones `app.js` composes at runtime.

**Switching** rewrites the document in one pass (`translateTree`), then regenerates the
copy `app.js` owns — card aria/titles, the drawer's status and priority *values*, list
rows, the token mask, the theme button's label — and follows with `<html lang>`, a
filter pass (the result counter lives in the copy) and a toast **in the new language**.

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
