# MeerkatTaskPanel prototype — Block inventory

The structural contract of `index.html`. Selectors are **`data-*` semantic hooks**;
Tailwind class names are never part of the contract, and no anchor is positional.

Counts in the current build, measured in the live DOM: **7 columns · 18 cards ·
18 detail templates** (`[data-slot]`: 18 description · 18 activity · 16 comments ·
15 agent-session · 11 attachments · 9 relations) · **626 `data-i18n*` hooks** in the
shipped document (522 `data-i18n` plus 104 `placeholder` / `aria-label` / `title`
variants) · **282 catalogue keys, `en` and `zh` in exact parity.**

**"35 blocks" means 35 *contract entries*, not 35 DOM blocks.** The DOM block
inventory is **B01–B25** (25 entries; B20/B21 are retired and kept only as
tombstones). The other ten are the cross-cutting **consistency items C01–C10** in
`test/web/blocks.contract.mjs` — assertions that span many blocks (colour maps,
layering, i18n parity) and therefore own no DOM element of their own. So
**35 = B01–B25 (25) + C01–C10 (10)**; only the B-series appears as section
headings below.

**R12x added two more — B26 (Activity) and B27 (Waiting)** — and both appear as sections
below. They are **not** in the contract's transcription yet: `test/web/blocks.contract.mjs`
still stops at B25, which is the same mirror cost this round's catalogue growth carries, and
`test/**` is not this round's write surface. Until that pass lands, this file carries **27
B-series headings against the contract's 25**; the body of this file is authoritative, and
the mismatch is stated here rather than left to be discovered.

---

## B01 · App shell

| | |
|---|---|
| Root | `[data-app-shell]` (`.td-shell`) |
| Attribute | theme is held on the document element: `html[data-theme="meerkat-taskpanel" \| "dark" \| "auto"]`, with the machine-checkable mode beside it in `html[data-theme-mode="light" \| "dark" \| "auto"]` (see B03) |
| Layout | `grid-template-areas: "topbar topbar" / "sidebar main"` |

## B02 · Top bar

| | |
|---|---|
| Root | `header[data-topbar]` |
| Brand | `[data-brand]` → `.td-logo` (**Sentinel Watch**, `BRAND.md` §5) + `[data-i18n="app.brand"]` + `[data-i18n="app.tagline"]` |
| Project switcher | `[data-project-switcher]` (`<details class="dropdown" data-dismiss-on-outside>`) · `[data-project-current]` · `[data-project-option="…"]` · `[data-project-new]` · `[data-project-switcher-icon]` |
| Search | `[data-search]` → `[data-search-input]` |
| Filters toggle | `[data-filter-toggle]` (`aria-pressed`, `aria-controls="td-filters"`) |
| View toggle | `[data-view-toggle]` → `[data-view="board" \| "list"]` (`aria-pressed`) |
| Revision | `[data-revision]` → `[data-revision-label]`, `[data-revision-value]`, `.td-live-dot` |
| Primary action | `[data-new-task]` |
| Right cluster | `.td-topbar-actions` — wraps Revision + Primary action; `margin-left: auto` pushes it to the header's right padding edge |

Right-end order is fixed: revision · primary action, grouped as one `.td-topbar-actions`
cluster. The cluster is **right-aligned — flush to the header's right padding edge** (R5):
the search grows to its 340px cap, then `margin-left: auto` on the cluster absorbs the rest,
so `[data-new-task]` hugs the right edge at 1512 / 1240 / 980 / 500 with no trailing gap.
The cluster is a single flex item, so the revision readout and the button never split across
the two rows the bar folds into at 760–779px — there the button sits flush right on its own
row. The `[data-new-task]` hook and its interaction are unchanged: a click still opens the
create dialog (**B10**). There is **no user, account or sign-in element** anywhere
in the bar.

The theme and language controls **left the bar in review round v1.2** and became three
direct controls in the sidebar footer in **v1.4** (B03 · three-state theme cycle / language
menu / B19). The bar holds no display-mode control of any kind — restated and re-checked in **R3**,
which changed the brand mark in this bar but touched no control in it.

**The brand glyph is the Sentinel Watch mark** (R3; geometry remastered in the v2 brand
round, face knocked out in the v2 logo-A round), not a generic icon: three upright
meerkats of a mob on one baseline at `y = 27`, rising left-low to right-high, the
tallest on duty and carrying the brand line, with one watch signal floating clear above
it. The eyes and mouth are cut as negative space by an inline `<mask>` (functional
greys, not brand colours), which is why the mark still restores to one colour and the
silhouette is unchanged; the watch signal sits outside the mask and is always solid.
It is drawn inline at
18px, `aria-hidden`, on a `0 0 32 32` viewBox, and its two fills are
`var(--color-td-ink)` and `var(--color-td-accent)` — so one element serves both themes.
Two `<mask>` ids are needed because both inline marks share one document
(`face-knockout-a-top`, `face-knockout-a-lg`).
`favicon.svg` is the same geometry with a `prefers-color-scheme` pair.

**R9 — the switcher gives way when the press lands elsewhere.** `[data-project-switcher]`
carries `data-dismiss-on-outside`, the one hook that means "a press outside me closes me"
(see *Floating controls* below). Before R9 it was a `<details class="dropdown">` with no
outside-press rule at all: once opened it stayed open until its own `<summary>` was pressed
again, and because its menu floats over the filters bar it also swallowed presses meant for
the controls underneath. It now closes on a press anywhere else, on `Esc`, and when the
label selector opens (one of the two is open at a time).

## B03 · Sidebar

| | |
|---|---|
| Root | `aside[data-sidebar]` |
| Nav | `[data-nav]` → `[data-nav-item="board" \| "list" \| "activity" \| "waiting"]` (`aria-current="page"`, exactly one at a time, and the scope is `[data-nav]` — the project rows below carry the same attribute for the current project) |
| Projects | `[data-project-list]` → `[data-project="…"]` (`aria-current="page"`) → `.td-side-icon` (prefix monogram, rail only) + `[data-project-count]`; each item carries `[data-order-score]` + `[data-order-rank]` (see below) |
| Agents | `[data-agents-presence]` → **one row per platform**: `[data-agent-platform="claude\|openclaw\|codex\|pi"]` + `[data-presence="running\|idle"]`; each name in the row is a **`[data-assignee-item]`** holding exactly one `[data-agent-assignee]` **button** (R11 — see below; R13 adds the item and the width-neutral selected capsule) |
| States preview | `[data-states-open]` — sidebar footer control, opens **B18** |
| Footer controls | `[data-access-status]` — **one row of three equal thirds at ≥1024px, three stacked full-width rows at ≤1023px** (R7, revised 2026-10-12 21:19): theme · language · settings. Each cell is a `[data-access-cell]` block button (`.td-access-cell`); in the row a vertical hairline on its **inline start** separates it from its neighbour (the first cell carries none), and in the stack a horizontal hairline on its **block start** separates it from the cell above (the first row carries none) |

> **项目短码（口径 = `design/contracts/side-rail-short-code.md`）**：`.td-side-icon` 的文本 =
> 该项目的**有效前缀**（= 卡号前缀，服务端一次派生：存储前缀非空，否则 `identifierPrefix(id)`），
> 经 projects wire 的**只读** `prefix` 字段下发，客户端**逐字**渲染。原型三行的 `ORC`/`TD`/`SR`
> 与 `app.js` 的 `PROJECT_PREFIX` 逐字一致（本行「prefix monogram」即此义）；实现侧
> `initialsOf(name)` 是偏离，另卡修正。

> **前缀蒙版的溢出（口径 = `design/contracts/rail-chip-overflow.md`）**：`.td-side-icon` 的文本 =
> 项目的**有效前缀**，逐字渲染；`24×24` 的盒装不下时，**行内自伤可接受、跨行他伤不可接受**——
> 绘制文本不得越出本行行盒、不得越出 rail 的 inline 盒；整串走 `title`。盒几何（24×24、rail only）
> 与「≥1024px 不显示」不动。实测依据、被排除的候选（clamp / `…` / 字符 slice）与留给实现卡的断言清单见该契约。

**R11 ② — a roster name is a route.** The `.td-agent-text` span used to hold the row's names
as one string of text; it now holds one `<button>` per name (`[data-agent-assignee="jobs"]`,
carrying `data-assignee` + `data-assignee-kind="agent"` as well), with the commas left as the
static text between them, so the row still reads as one sentence. The pressability hangs on
`[data-agent-assignee]`, never on a class — the hook is what binds and what a machine check
reads. A press switches to the **list** view (B08), writes `{"in_progress","in_review"}` into
the status filter (B04), and runs one filter pass. **It does not narrow by the name**: the
assignee filter's domain is `all | me | human | agent` and holds no given name, so extending
it is a separate requirement (`design/fidelity-r11.md` §边界). The face is the text it
replaced — no shell, no border, no padding — with the pointer and a hover underline as the
only affordance; `Enter`/`Space` and the `:focus-visible` ring come from it being a real
`<button>`. In the ≤1023px rail the whole `.td-agent-text` span is hidden, so the buttons go
with it.

**R13 — the name is a narrowing as well as a route, and the name in force wears a capsule.**
R11 wrote the name into no filter because the assignee control's domain held no given name
(B04); R13 extends that domain, so a press on a name narrows as well as routes.
**(R13 修订 · Terry 2026-10-13 · 决定甲 supersedes the route half: the press is now *only* the
name — one `writeAssigneeFilter()` and one `applyFilters()`, no `mirrorView("list")`, no status
set. See the paragraph after the capsule below.)** The roster's own structure
changes shape to carry the selected state: each name is now a **`[data-assignee-item]`**
wrapper holding **one** button — the name (`[data-agent-assignee]`, which also carries
`data-assignee` + `data-assignee-kind` and its own `aria-pressed`). The commas are still the
same static text between the items, so the row still reads as one sentence.

The item the control's value names takes **`data-assignee-active="true"`** and wears the
**capsule**, and the capsule is **width-neutral**: `padding: 0 6px` cancelled by an equal
`margin-inline: -6px`, so the item's advance along the row's one line is byte-for-byte what it
was at rest and **no name is ever elided** (measured 0 clipped pixels at all five tiers). The
bed is `border-radius: 999px` filled with `--color-td-accent-soft`, and the name inside it
takes `--color-td-accent`; there is **no border and no fixed height** — the item stays an
inline box on the row's line, so selecting a name moves no row (measured height delta 0 on all
four). The shell is on the **wrapper**, not on the name button: the face stays the text it was
and the press target stays the name. `renderAssigneeFilter()` is the single writer of the
capsule *and* the control's options — it reads the control's value and every item follows in
the same pass, so the roster and the control cannot contradict each other (B04; DESIGN.md
§31.2).

**What the press does is the assignee value and nothing else** (R13 修订 · Terry 2026-10-13 ·
决定甲): it is exactly the move of choosing that name in the bar's dropdown, so it writes the
name and runs one filter pass — the view is **not** switched to the list, no status set is
written, and **no removal control exists here or in the bar**. Pressing the name **already in
force** is a **no-op**: a dropdown does not close itself when the value it already states is
picked again, so R13 seg2's clear-the-name toggle is withdrawn with the `✕` and the one removal
path is the control's own `Assignee: All` row (B04).
The R11 face is otherwise unchanged — no shell, no border, no padding at rest — and the name
button takes its `:focus-visible` ring and answers `Enter`/`Space` by being a real button. In
the ≤1023px rail the whole `.td-agent-text` span is hidden, the items go with it, and that is
the round's narrow-tier contract (measured at 980 / 760 / 430: not visible).

**R12x ① — all four destinations route, and the count rides the one that has one.** Until
this round the nav's click handler answered `activity` and `waiting` with a revision toast
and switched no view, so two of the four names led nowhere — the defect Terry's 2026-10-13
request names. The handler now hands **every** `[data-nav-item]` to `mirrorView()`, which
toggles four view roots and writes `aria-current="page"` on the pressed one and nowhere else.
`[data-nav-item="activity"]` also carries **`[data-nav-count="activity"]`**, the unread
count in B03's existing `.badge.td-count` shell: the number is the feed's current visible
unread rows, so the pill, the feed's boundary and the boundary's own count read one value,
and at zero the pill goes away — the rule the `waiting` pill already follows. The top bar's
`[data-view-toggle] [data-view]` stays exactly `board | list` and is untouched: the two are
different controls, and only the sidebar's is a four-way destination list. The fourth view
(`waiting`, **B27**) landed in the round's third segment as a root and nothing else: the
routing was already here, so the view cost no branch. `waiting` carries **no**
`[data-nav-count]` — the count rides `activity` alone, because that view's number is not the
length of what is on screen (the feed filters and folds), while a queue's would merely
restate the tally its own header already carries (B27 / DESIGN.md §30.3).

**R16 — the same press now also writes the address.** The four destinations got URLs
(`/board`, `/list`, `/activity`, `/waiting`, with `/` normalised to `/board`), so the handler
above goes through `navigate()` rather than `mirrorView()`: one press changes the view **and**
pushes that view's address, which is what makes a deep link, a refresh and the back button mean
anything. Nothing structural moves — the hook, the four roots, the `aria-current` rule and the
top bar's two-value toggle are exactly as this entry describes; the address layer lives in the
product shell, and `design/prototype/` has none (measured: a prototype nav press leaves the
address untouched). The activity feed's filters move with it, from `#/activity?…` to
`/activity?…` — the old shape is still **read** and redirected to the new one, so an existing
link keeps working — leaving the fragment to the drawer's `#/task/<id>`. Narrative: DESIGN.md
**§32**; executable contract: `design/fidelity-r16.md`.

The three cells were **one row of three equal thirds** from v1.3 to R6; R7 (2026-10-12)
stacked them at every width, and the same evening's revision put the row back above the
breakpoint and kept the stack for the rail — where a third of 64px is far too narrow for a
label. In **both** bands the order is the same, and so is what each cell does:

| Cell | Hook | What the cell shows | Affordance |
|---|---|---|---|
| Theme | `[data-theme-switch]` → `[data-theme-icon="light" \| "dark" \| "auto"]` + `[data-theme-label]` | the theme in force — `Light`/`Dark`/`Auto` (浅色/深色/自动) | **three-state cycle** — one press walks Light → Dark → Auto → Light, no dialog |
| Language | `[data-lang-select]` + `[data-lang-label]` + `.td-caret` | the language in force — `EN`/`中文` | **dropdown menu** → `[data-lang-menu]` → `[data-lang-option="en" \| "zh"]` |
| Settings | `[data-access-open]` | nothing but the gear glyph | opens **B19** `[data-access-panel]` |

**A cell is one line inside at both bands; only the arrangement between cells changes.**
Each `[data-access-cell]` is `display: flex; flex-direction: row` — icon, label and (on the
language cell) the caret sit side by side, which is what R6 ⑦⑧ fixed. **≥1024px** the
container is `display: grid; grid-template-columns: repeat(3, minmax(0, 1fr))`, so the three
cells share one row (left→right); **≤1023px** it is `display: flex; flex-direction: column`,
so they follow one another down the rail (top→bottom). The two are orthogonal: a cell may
never wrap its own contents.

**The theme cell is a three-state cycle, not a switch.** One press walks the modes in
order — `light → dark → auto`, then back to `light` — and the machine-checkable state is
`data-theme-mode="light \| dark \| auto"`, written on `<html>` in the markup and mirrored
onto `[data-theme-switch]` by the same pass. `<html data-theme>` carries what the CSS
reads: `meerkat-taskpanel` (Light) · `dark` (Dark) · `auto` (Auto). **Light is the no-record
default**, which is why the static document ships `data-theme="meerkat-taskpanel"` +
`data-theme-mode="light"` + the sun glyph + the `Light` label — what a JavaScript-free
reader sees is the default state. Auto is resolved by CSS alone
(`html[data-theme="auto"]` under `@media (prefers-color-scheme: dark)` in
`src/input.css`); no script reads `matchMedia` and nothing is stored. The three state
names, the defaults and the "explicit light/dark leaves auto behind" rule are recorded in
`DESIGN.md` §7 and §21.

**The state is in the label.** `applyTheme()` is the single writer of `html[data-theme]`,
`html[data-theme-mode]`, the sun/moon/display `[data-theme-icon]`, `[data-theme-label]`
and the cell's `data-theme-mode` + `aria-label` (which names both the state in force and
the state one press reaches — `Theme: Light. Activate for Dark.`). A three-state cycle is
not a toggle, so the cell carries **no `aria-pressed`**; the state rides on
`data-theme-mode`. `applyLanguageOptions()` writes `[data-lang-label]` and the
`aria-pressed` of both `[data-lang-option]` rows. The theme cell and the language trigger
therefore state the current mode without anything being opened, and both are rewritten by
the same functions the press and the pick call, so cell and document cannot disagree. The
settings cell carries no visible text at all: the gear is named by
`data-i18n-aria-label="access.open"` alone. Cells carry `:focus-visible` rings and are
keyboard reachable. The v1.2 `[data-theme-toggle]` / `[data-lang-toggle]` controls stay
**gone**, and the v1.3 dialogs are gone with them — see "Retired" below.

**The language menu is a floating menu, not a panel.** Trigger and menu are two elements:
the cell in the footer, and `[data-lang-menu]` at the end of the document next to the
card's "Move to" list. The menu is positioned `position: fixed` above the cell
(`openLangMenu()`), because the sidebar is a scroll container and an absolutely positioned
menu would be clipped by it. Choosing an option switches the document
(`applyLang` → `setLang`) and closes the menu; `Esc` and a press outside both close it
too. The current language is marked with `aria-pressed="true"`, accent copy **and** a
tick. The list is data: a third language is one `<li>` plus its dictionary keys.

The footer carries *controls*, not *reachability*: the former `[data-user]` block
(avatar + name + role) was **removed** in review round v1.1, along with its `.td-user`,
`.td-user-text` and `.td-avatar-lg` styles, and the `Local · localhost` readout plus its
green status dot were **removed** in review round v1.2 (Terry, 2026-10-08 21:47) — no
bind-address status is shown anywhere in the chrome; the bind address is stated inside
B19 instead. The assignee model further down this file is a separate concern and is
unchanged.

At the ≤1023px rail the footer stops being a row and **becomes** the stack, each cell
narrowing to a **centred 14px glyph on a 24px line**: the labels drop out with the rest of
the sidebar text, so the three cells are three glyphs stacked in the 64px rail (56px under
560px) with no horizontal overflow. The `.td-caret` goes with the labels — 64px cannot hold
a globe and a disclosure arrow side by side — and the language menu still opens from the
remaining globe, floating over the board rather than inside the 64px column. Above the
breakpoint the thirds hold the labels, which is why the stack is the rail's alone.

**The `PROJECTS` list is ordered by activity, not alphabetically or by creation.** Items
render in the order the **server** computed — a weighted rank over 7-day and 30-day
activity plus creation recency (full rule in `DESIGN.md` §20), with
tie-breaks and archived-project exclusion applied there. The frontend **consumes the order
only** and does no computation. Each item exposes the decision for machine checks:
`[data-order-score]` (the composite, e.g. `0.867`) and `[data-order-rank]` (`1`…`N`). The
demo order is **Orchestrator → MeerkatTaskPanel → Site Refresh** (scores 0.867 / 0.667 / 0.467),
deliberately different from creation order so the weighting is visible. Consistency: ranks
are contiguous from `1` and scores are non-increasing down the list; `[data-project-count]`
(12 / 4 / 2) is independent of the ordering and unchanged.

**`[data-project-count]` is the project's task count**, served by `/projects` as `task_count`
(every status, archived included; a project with no tasks reports `0`). It is *not* the
`[data-order-score]` next to it and not the `order_debug` activity counts: those measure
events in a trailing window, which is a different question with a different answer. The
field is also independent of which project is open — it is per **row**, not per current
project, so every row is filled at all times.

## B04 · Filters bar

| | |
|---|---|
| Root | `section#td-filters[data-filters]` |
| Controls | `[data-filter-assignee]` (all/me/human/agent + a given name on demand, R13 — the removal path for the name is this control's own `all` row) · `[data-filter-priority]` (all/urgent/high/medium/low/none) · `[data-filter-status]` (all + the seven statuses, R11) · `[data-filter-label]` (all + 16 labels) — **all four are `dropdown` panels, R15 ②** |
| Assignee selector | `[data-filter-assignee]` on a `<details class="dropdown" data-dismiss-on-outside>`; the chosen value lives on `data-filter-assignee-value`, the trigger states it via `[data-filter-assignee-text]`, and the menu holds `[data-assignee-filter-option]` × 4 (all/me/human/agent) plus at most one given name (R13), `aria-current` on the chosen one |
| Priority selector | `[data-filter-priority]` on its own `<details class="dropdown" data-dismiss-on-outside>`; the chosen value lives on `data-filter-priority-value`, the trigger states it via `[data-filter-priority-text]`, and the menu holds `[data-filter-priority-option]` × 6 (all + the five priorities), each with `data-priority-value` and `data-priority` (the dot's own binding), `aria-current` on the chosen one |
| Label selector | `[data-filter-label]` on a `<details class="dropdown" data-dismiss-on-outside>`; the chosen value lives on `data-filter-label-value`, the trigger states it via `[data-filter-label-summary]`, and the menu holds `[data-filter-label-option]` × 17, each with `data-label-value` and `aria-current` on the chosen one |
| Status selector | `[data-filter-status]` on its own `<details class="dropdown" data-dismiss-on-outside>`; the chosen set lives on `data-filter-status-value` (`all`, or a comma-joined subset of the seven keys), the trigger states it via `[data-filter-status-summary]` → `[data-filter-status-text]`, and the menu holds `[data-filter-status-option]` × 8, each with `data-status-value` and its own `aria-pressed` (R11) |
| Actions | `[data-filter-clear]` · `[data-filter-count]` (`aria-live="polite"`) |

**The bar's order is the fields' order: Assignee · Priority · Status · Label · Clear ·
count.** Status sits immediately after Priority because the two are the card's own
first-class scalars; Label is the list-valued one and follows (R11).

**The label selector is a dropdown, not a `<select>`** (R3). Its hook name did not move:
`[data-filter-label]` is still the element the interaction layer reads, but it now reads
an attribute rather than a form value, because the addendum names this control
specifically — it is the one filter with seventeen choices and it has to show which one is
in force without being opened.

**R9 — one control family, one shell.** The trigger state `[data-filter-label-summary]` used
to be a label chip (`badge td-chip td-chip-label`: a bordered, accent-tinted pill) sitting
inside a 28px/500 shell. Since R9 it is **plain text at the field's metrics** — 30px tall,
12px/400 in `--color-td-ink`, with the 14px caret parked at `right 6px`. The `<details>`
takes `data-dismiss-on-outside`, the same hook B02's switcher takes. The scoping is
deliberate: `.td-chip-label` is untouched, so the label chips on cards, in the drawer and in
the dialogs are still pills — only this one trigger renders its value flat.
**R15 ② sharpened the reading of that rule**: when R9 was written the family was "this
trigger *and the two `<select>`s beside it*", and the trigger's metrics were justified as
"the `.td-select` metrics". With the last two `<select>`s converted (R15 ②), the family is
**seven triggers and no `<select>` at all**, so the shell is `.td-label-trigger`'s own: the
measurement that matters is no longer "the trigger matches the selects" but **"all seven
compute identically to each other"** (`design/fidelity-r15.md` §3 B2), and the bar is one
row of one component by construction rather than by agreement with a control of another kind.

**R11 ① — the status selector is the second dropdown, and the only multi-select.** It is the
same `<details class="dropdown">` family as the label control, wears the same `.td-label-menu`
shell and the same `.td-label-trigger` metrics (so the bar still computes to one control
height), and takes the same `data-dismiss-on-outside` rule. What it adds is a **set**:

| | |
|---|---|
| Value | `data-filter-status-value` — `"all"` (un-filtered, the resting value) **or** a comma-joined subset of the seven first-class keys, in `DESIGN.md` §2.3 order |
| Domain | the seven keys, **never anything else** — the script reads them out of `[data-filter-status-option]`, so the menu is the single source and an eighth status is one more row |
| Semantics | **OR** inside the field (a card passes when its status is any chosen one); **AND** against the other filters, like assignee/priority/label |
| Rows | `[data-filter-status-option]` × 8 — `all` first, then the seven keys; each row is the 8px status dot (`--status-color`, via the existing `[data-status="…"]` plumbing) plus the `status.<key>` label |
| Chosen row | `aria-pressed="true"` — every row writes it, chosen or not, because a set has no single active one; the chosen rows also take the accent copy |
| Trigger | `[data-filter-status-summary]` (the `<summary>`) → `[data-filter-status-text]` reads `Status: All` / `Status: <Label>` / `Status: <first> +<n-1>`, restated from the value on every filter pass |
| Pressing `all` | clears the set — the value returns to `"all"` and every row's `aria-pressed` follows in the same write |

**R15 ② — `status` was never the odd one out; it was the first.** The bar used to hold two
kinds of control — two native `<select>`s (`assignee`, `priority`) and two dropdowns
(`status`, `label`) — and the sentence that stood here read "`assignee` and `priority` are the
two native `<select>`s; `status` could not be one". The second half was right (`status` has
to hold more than one value at once — the set is the field's own multi-valued nature, and R11
also composed it with a roster press), and so was the label control's reason for not being a
`<select>` (seventeen choices and a chosen-value readout). What the round corrects is the
first half: `assignee` and `priority` had **no** reason to be `<select>`s, and being the only
two made the bar read as two components in one row. All four are `<details class="dropdown"
data-dismiss-on-outside">` now, with the chosen value on a `-value` attribute, the trigger
stating it through its own `-text`/`-summary` seat, and the rows carrying `aria-current` (the
single-choice controls) or `aria-pressed` (the status set).

`applyFilters()` reads the status set through one helper (`statusFilterValues()`), which is
also what `resetFilters()` writes back to `all`; the other three controls get the same
treatment (`assigneeFilterValue()`, `priorityFilterValue()`, `labelFilterValue()`), and
`resetFilters()` writes all four back to their `all` row in one pass.

**R13 — the assignee control's domain gains a given name, on demand.** The four values the
document ships (`all | me | human | agent`, the *kinds* and the un-filtered resting value) are
unchanged and still static; what the round adds is a fifth **class** of value: a given name
(`jobs`, `elon`, …). A name is not in the document, so it is written into the control **when
it is needed and taken out when the control leaves it**:

| | |
|---|---|
| Value | the control's own value attribute — `all` · `me` · `human` · `agent`, or a given name |
| Named row | **one at a time, at most** — `[data-filter-assignee] [data-assignee-filter-option="<name>"]`, hook value and copy both the name, generated by `renderAssigneeFilter()` and removed when the control's value is no longer that name |
| Static rows | the four above stay in the markup and are **never** removed (measured: 4 at rest, 4 while a name is in force; R15 ② kept both the hook and its value-in-the-attribute carrier, and moved the element from an `<option>` to a `menu` row `button`) |
| Semantics | `me` → `data-assignee` == the local human; `human`/`agent` → `data-assignee-kind`; a name → `data-assignee` — the attribute the card already carries and the drawer already shows, so the control adds no second source for who a card belongs to |
| Stacking | **AND** against the other filters, like assignee/priority/label |
| Capsule | **not here** — the control's trigger carries the value as plain text only; the selected state is drawn on the roster (B03) |
| Clear | **the control's own `all` row, and nothing else** (R13 修订 · 决定甲): a roster press *is* this control's own selection, so the row that selects a name and the row that leaves it are the same control and no second affordance is needed. R13 seg2's sibling `[data-assignee-clear]` — static markup, `hidden` at rest, shown only while the value is a given name — is **withdrawn** with its three rules, its delegated press handler and its key; no element, rule or handler in the shipped prototype carries the hook (it survives only in the comments and documents that record the withdrawal) |
| Single writer | `renderAssigneeFilter()` reads the control's value and derives the roster's capsules *and* the control's own options from it, so the two can never state different things |

The named option is **`[data-assignee-filter-option]`**, deliberately **not**
`[data-assignee-option]`: B22 (R3) already owns that hook on the dialogs' assignee menus (a
bare attribute, the name in `data-assignee-value`), and the roster control binds it
**document-wide** (`$(document).on("click", "[data-assignee-option]", …)`), so a seat of that
name would be answered by the wrong control instead of by nothing. R13 adds no seat to B22's
(measured 14 before and after, all of them inside `[data-assignee-menu]`).
`design/fidelity-r13.md` §2.9 and §8 R12 carry the rule for later rounds.

**R13 — the `✕` removes the assignee condition alone.** No view switch, no status change, no
priority/label/search change, no menu open or close, no toast; the event is stopped at the
button. A press on the name **already in force** is the same move. `design/fidelity-r13.md`
§2.4 is the contract.

**R12 补充 — one control family, one line, and the overflow lives in the bar.** The bar is
**one line at every tier by contract**: `[data-filters]` carries `flex-wrap: nowrap` and its
children do not shrink (`flex: 0 0 auto`). This is a **written deviation from the prototype**
(`design/fidelity-r12-supplement.md` §2.1), whose `.td-filters` is `flex-wrap: wrap` and
therefore folds onto a second line at 430 — measured, and measured as exactly two lines.
What holds the line instead is an **overflow strategy on the bar itself**: `overflow-x: auto`
plus `min-width: 0`, so a narrow tier scrolls **inside** the bar rather than wrapping or
pushing the document sideways. `[data-filter-count]` keeps `margin-left: auto`, so a tier
that is wide enough pins the count to the bar's content-box right edge while an overflowing
tier resolves the `auto` to zero and leaves the count in line after Clear — the prototype's
own ≤979 behaviour, arrived at by the same rule. Four alternatives were evaluated and not
adopted (keep `wrap`; let the controls shrink; hide the count on narrow tiers; `nowrap`
without a scroller) — §2.1 records why each fails.

The **metrics** stay the prototype's, measured at all six tiers and constant: the field
family is **30px** tall with `12px`/`400` text, `6px` corners and `padding: 0 26px 0 8px`,
including the caret (`14×14`, absolutely positioned, **7px** from the summary's border-box
right edge — the declaration's `right: 6px` is measured against the padding box); `Clear` is
a `btn-sm` at **28px**; the count is 18px of `12px` text. The gap between same-line controls
is **8px** and the bar's own padding is **0** — the prototype's bar carries no padding
because `.td-main` supplies it.

**The status control is on the register, and its delivery is pending.** `[data-filter-status]`
is the bar's third field control (R11 ①), so the family is four controls with one height —
and the **order stays Assignee · Priority · Status · Label · Clear · count**, the order R11 ①
fixed, stated in the machine-checkable form as **sibling combinators**
(`[data-filter-priority] ~ [data-filter-label]`, and so on) rather than as positions at either
end. The control's landing
belongs to the status-filter card, not to R12: the contract **enumerates** it (the family never
loses a member) while the machine checks that need it are marked `pending`, and the R12
assertions are written to hold **without** it — the closed set gives `[data-filter-status]` an
upper bound, so a bar that has not landed the third field control still passes.

## B05 · Board

| | |
|---|---|
| State root | `div[data-board-view][data-board-state="data" \| "empty"]` — the board view, and the parent of the two state blocks |
| Root | `div[data-board]` — a **direct child** of the state root, and its `data`-state member |
| Children | exactly 7 × `[data-column]`, in the fixed order `backlog, todo, in_progress, in_review, blocked, done, canceled` |
| Scroll | the only horizontal scroll container in the document |

**R10 ① — the board view is two states, one of them on screen.** The board's own emptiness
is a state of the **view**, not of a column: `[data-board-view]` owns `data-board-state`
(`data` at rest, `empty` when no card survives the filters) and the two members are its
direct children — `[data-board]` itself, and `[data-empty][data-empty-kind="no-results"]`
(B12). `setBoardState()` is the single writer and sets the attribute and both `hidden` props
in one call, so the attribute and the markup can never disagree; two rules in
`src/input.css` read the attribute, so the pair is mutually exclusive in the shipped document
with the script off. The contract is `design/fidelity-r10.md` §2.1, and the idiom is R9's
list state (B08/B13) applied to the board — same shape, different root, different values.

The state root is also a **flex pass-through** (`display: flex; flex-direction: column;
flex: 1 1 auto`), not a plain block: `[data-main]` is a column flex container and the board's
`flex: 1 1 auto` can only resolve against a flex parent. A block wrapper measures 331.56px for
a board that measures 812px on its own — see `design/fidelity-r10.md` §2.1.2.

Switching to the list (B08) hides the **state root**, not the board: the board-level empty is
the root's other child, so hiding only `[data-board]` would leave it above the list.

**R12 补充 — the seven columns are one height, and it is the board's height.** `[data-board]`
aligns its children on the cross axis with **`align-items: stretch`**, and the chain that
carries the height down is a pass-through at every link: the state root (`[data-board-view]`)
is a column flex box, the board takes `flex: 1 1 auto` with `min-height: 0; min-width: 0`,
and each `[data-column]` is a column flex box with `min-height: 0`. Nothing writes a height
in pixels. The measured result (`design/fidelity-r12-supplement.md` §3.2) is that at every
tier all seven columns share **one** height (spread 0px) and that height equals the board's
**content-box** height (difference 0px) — 808px at 1512×950, 758px at 1512/1240/980×900,
733px at 760, 695px at 430, and 558px at 1512×700. The height therefore **follows the
viewport**: 900 → 700 moves the columns 758 → 558, pixel for pixel.

The stretch is what makes them equal, which is why the contract also carries the **reverse**
assertions: the shortest column is far **taller** than its own natural content (758px of box
over 150px of header, progress and body at 1512×900), the column bodies are taller than
zero, and every column still draws its cards. A "single common height" written into the
stylesheet, or a set of columns allowed to collapse onto their content, would satisfy
"equal" while breaking the thing equal is for.

Scrolling stays exactly as the list of hooks above says it does: **`[data-column-body]` is
the only vertical scroll container inside a column** (`overflow-y: auto`, one per column),
and `[data-column]` itself must **not** scroll vertically (`overflow-y: visible`) — a column
that scrolled its own frame would put the scrollbar outside the cards it scrolls. The board
remains the document's only **horizontal** scroll container.

## B06 · Column

| | |
|---|---|
| Root | `section.td-col[data-column][data-status]` |
| Hooks | `[data-column-header]` · `[data-column-dot]` · `[data-column-name]` · `[data-column-count]` · `[data-column-add]` · `[data-column-body]` · `[data-column-progress]` |
| States | default · `data-drag-over="true"` · empty (`[data-empty]` inside the body) · live count badge |

`[data-column-progress]` (R3) is a daisyUI `progress` sitting directly under the header.
Its `value` is the column's visible count and its `max` is the board's total visible count,
so it reads that column's **share of the board** — the shape of the work before any card is
read. `refreshColumns()` is the only writer, and it never emits `max="0"`, since a progress
element with a zero maximum is a dividing error.

## B07 · Card — 18 instances

| | |
|---|---|
| Root | `article.td-card[data-card]`, `draggable="true"` |
| Scalars | `data-identifier` `data-id` `data-status` `data-priority` `data-project` `data-assignee` (role handle) `data-assignee-kind` (`human\|agent`) `data-reporter` `data-labels` `data-version` `data-comments` `data-attachments` `data-relations-parent` `data-relations-blocks` `data-relations-related` `data-done` `data-canceled` |
| Parts | `[data-card-stripe]` · `[data-card-identifier]` · `[data-card-title]` (a real `<button>`) · `[data-card-labels]` → `[data-label]` · `[data-card-priority]` · `[data-card-assignee]` (monogram avatar) · `[data-card-agent-badge]` (`data-agent-platform`) · `[data-card-agent-role]` · `[data-card-comment-count]` · `[data-card-attachment-count]` · `[data-card-relations]` → `[data-relation-parent \| blocks \| related]` · `[data-card-menu]` |
| Identity slot | human card → monogram avatar visible, badge and role empty+hidden. Agent card → avatar hidden but still carrying the monogram, `[data-card-agent-badge]` **and** `[data-card-agent-role]` visible, so every card states both the platform and the role name. |
| States | default · `:hover` · `:focus-within` · `aria-selected="true"` · `data-dragging="true"` · `data-done="true"` · `data-canceled="true"` |

**R8 — the identifier is capped.** `[data-card-identifier]` renders **at most ten
characters plus an ellipsis**: the display value is `len > 10 ? slice(0, 10) + "…" : id`,
computed by `identifierText()` in the render layer, and the element carries the **full**
id on `title` plus the shared `.td-id` class (single line: `nowrap` + overflow
ellipsis). The card root's `data-identifier` keeps the full id — never the display
value — so every lookup by attribute is unaffected. Same rule as B08, and the same rule
the create dialog's Parent/Depends rows and chips take from the one function
(`T-20261014-001418` moved the cap from eight to ten — see `DESIGN.md` §24.3).

**R12 leaves this card path alone.** The round that shows the whole id in the drawer's
head (see **B09**) explicitly does **not** touch B07: the static markup's own abbreviated
text, the generated card's `identifierText()` call, the `title` and the `.td-id` cap all
stay as R8 fixed them. `[data-card-identifier]` must never carry `.td-id-full`.

## B08 · List view

| | |
|---|---|
| Root | `section[data-list][data-list-state="loading" \| "data"]` — mutually exclusive with `[data-board]` |
| Hooks | `[data-list-rows]` (host) · `[data-list-row]` (`data-identifier`) |
| Row parts | `[data-list-identifier]` · `[data-list-title]` · `[data-list-status]` → `[data-list-status-label]` · `[data-list-assignee]` (role handle) · `[data-list-priority]` → `[data-list-priority-label]` · `[data-list-revision]` |
| Template | `template[data-list-row-template]` |

Rows are projected from the cards that survive the active filters, so board and
list can never disagree.

**R11 ② — this is where a roster name lands.** A press on `[data-agent-assignee]` (B03)
switches to this view and writes `{"in_progress","in_review"}` into the status filter, so the
rows that appear are the projection of the cards those filters leave — which is the same
projection as ever, only reached by a second route. Nothing here changes: `renderList()` is
still the only writer of `[data-list-rows]`, and the rows still carry `[data-list-status]`
with the card's own status. The `loading` → `data` timeline (B13) is unchanged and still runs
on entry; the filter pass that follows lands the rows in the same tick.

**R8 — the header names every column, and shares the row's template.** The header
(`.td-list-head`) is a **6-track grid** carrying the same column template, gap and
inline padding as `.td-list-row` — one shared declaration, so the header cannot drift
from the rows it labels. The six columns, in track order, are:

| # | Column | Header hook | Row cell | Track | ≤759px |
|---|---|---|---|---|---|
| 1 | ID | `list.columns.identifier` | `[data-list-identifier]` | `74px` | visible |
| 2 | Title | `list.columns.title` | `[data-list-title]` | `minmax(0, 1fr)` | visible |
| 3 | Status | `list.columns.status` | `[data-list-status]` | `108px` | hidden |
| 4 | Assignee | `list.columns.assignee` | `[data-list-assignee]` | `132px` | hidden |
| 5 | Priority | `list.columns.priority` | `[data-list-priority]` | `96px` | hidden |
| 6 | Revision | `list.columns.revision` | `[data-list-revision]` | `72px` | visible |

The middle three carry `td-hide-sm` **on both sides** — the same class, the same
`@media (max-width: 759px)` rule, which narrows header and row together to
`64px minmax(0, 1fr) 84px`. The loading header (B13) is **not** a column row: it keeps
its single caption span, which spans the whole template (`grid-column: 1 / -1`) so it
cannot be squeezed into the 74px first track.

The row's `[data-list-identifier]` carries the R8 cap too: display = ten characters
plus an ellipsis, `title` = the full id, and the row root's `data-identifier` = the
full id.

**R12 leaves this row path alone** — the same sentence B07 carries: `renderList()` is
unchanged, the row's identifier keeps the cap, and `[data-list-identifier]` must never
carry `.td-id-full`. Only B09's head identifier opts out.

**R9 — the list is in one of two states, and says which.** `data-list-state` on the root is
the single source of truth: `loading` shows B13's skeleton and an empty `[data-list-rows]`,
`data` shows the rows and hides the skeleton. The two are never on screen together, and the
rule is written on the attribute rather than swapped per element, so it holds for the markup
as shipped as well as after the interaction layer has run. `data` is the resting state in
the document (the skeleton ships `hidden`), and opening the view is a fetch: the skeleton
holds the row heights first, the rows replace it when the data lands. See **B13**.

## B13 note — the loading header

`[data-skeleton] .td-list-head` is a `.td-list-head` (so it is a 6-track grid under
R8's shared rule) with exactly **one** child, and that child spans all tracks. A header
with one cell is a caption, not a column row; anything that adds labels there breaks
the distinction.

## B09 · Task detail drawer

| | |
|---|---|
| Root | `aside[data-detail-drawer][data-state="closed\|open\|closing"]` (`role="dialog"`, `aria-modal="true"`) |
| Scrim | `[data-detail-overlay][data-state]` |
| Head | `[data-detail-identifier]` (**R12**: the whole id, carrying `.td-id-full`) · `[data-detail-title]` · `[data-detail-status-chip]` → `[data-detail-status-chip-label]` · `[data-detail-close]` |
| Save state (R10) | `[data-detail-save][data-save-state="idle \| saving \| saved \| error"]` (attribute carrier, `hidden`, no copy of its own) · `[data-detail-save-error][role="alert"]` (its only visible half) |
| Properties | `[data-detail-props]` → status `[data-detail-status]` / `[data-detail-status-label]` · priority `[data-detail-priority]` / `[data-detail-priority-label]` · assignee `[data-detail-assignee]` / `[data-detail-assignee-avatar]` / `[data-detail-assignee-label]` (**an input**, see B22) / `[data-detail-assignee-platform]` (platform badge, hidden for the human owner) · **reporter** `[data-detail-reporter]` / `[data-detail-reporter-avatar]` / `[data-detail-reporter-label]` (an editable control — see B22) · project `[data-detail-project]` / `[data-detail-project-label]` · **acceptance** `[data-detail-acceptance-mode]` (`data-acceptance-mode="off\|agent\|human"`, read-only — 0038: the card's acceptance mode, set at creation and changed only through the audited `--acceptance-mode` override) · **labels** `[data-detail-labels]` (editable label combo — see B25) · internal id `[data-detail-id]` + `[data-detail-id-copy]` (`data-copy-value`) · `[data-detail-version]` |
| Tabs | `[data-detail-tabs][role="tablist"]` → `[data-detail-tab]` ×6 (`details` · `activity` · `reports` · `acceptance` · `leftovers` · `sessions`) → `[data-detail-panel]` ×6. Details holds Properties / Description / Relations / Attachments; Activity holds Comments + Activity; Sessions holds the Agent-session trail; Reports / Acceptance / Leftovers read `task_reports`. `sessions` is hidden when the card has no session rows; the other five are always present |
| Body | `[data-detail-description]` (rendered GFM) · `[data-detail-relations]` → `[data-relation-link]` · `[data-detail-agent-session]` → `[data-detail-agent-session-body]` → `[data-agent-session]` (**inside the Sessions panel**) · `[data-detail-attachments]` · `[data-detail-comments]` · `[data-comment-form]` → `[data-comment-input]`, `[data-comment-submit]` · `[data-detail-activity]` |
| Source | `template[data-detail-for="TD-…"]` holds one `[data-slot="description \| relations \| agent-session \| attachments \| comments \| activity"]` per card, wrapped by `[data-detail-templates]` |

**Implementation width.** The shipped drawer opens at **780px** — a deliberate
product override of the prototype's 520px `--shell-drawer`. The `100vw` ceiling
keeps a narrow viewport full-width exactly as before; every other box in this
block follows the prototype.

**Implementation supplement — the Acceptance tab can act (M6).** 〔原型只读；这是
记录在案的扩展，不是原型被回改〕 The prototype's Acceptance panel is a read-only
list of verdicts; in the shipped board the card's own `acceptance_mode` is what
assigns the closing act to a person, so the tab is where that act belongs. A card
whose `acceptance_mode` is `human` and whose client twin of the board's gate
(`isAcceptanceWaiting(task, tasks)`, `web/src/lib/waiting-queue.js`) says the
decision is still owed leads with the **latest delivery's summary** —
`[data-detail-acceptance-summary]` → `[data-detail-acceptance-round]` ·
`[data-detail-acceptance-author]` · `[data-detail-acceptance-conclusion]` — above
the criteria list, then offers `[data-detail-acceptance-actions]` →
`[data-detail-accept]` (`in_review → done`) and `[data-detail-send-back]`. Send
back opens `[data-detail-send-back-panel]` → `[data-detail-send-back-note]`,
`[data-detail-send-back-confirm]`, `[data-detail-send-back-cancel]`; the note is
required and is written **before** the `in_review → in_progress` move, which
starts a new delivery round. The generic status menu is unchanged and remains the
other way to make both moves; the server gate stays the authority, and its
refusal renders through the ordinary `[data-detail-save-error]` + toast path.
Every hook here is pinned by `test/web/blocks.contract.mjs` §B09 in `states`
(they exist only on a waiting card), and both legs — accept and send back — are
driven in `web/scripts/dom-smoke.mjs` (run by `test/web/blocks.dom.test.mjs`).

**Implementation supplement — the panel opens before its card is read.** Opening a card
clears the detail and flips the drawer to `open` in one act, so the panel now slides in at
once with a skeleton head and body (`[data-detail-skeleton]`, daisyUI `skeleton` bars in
the drawer's own `.td-drawer-head` / `.td-drawer-body` shells) and the real branch replaces
it when the fan-out lands. The close button stays live throughout, the root carries
`aria-busy`, and the loading head keeps the `td-detail-title` seat so the dialog is named.
Skeleton, drawer state and the `detail === null` window are one fact; no timer is involved.

**R14 — the relations area names its three kinds.** `[data-detail-relations]` groups its
`[data-relation-link]`s by kind, each group led by that kind's own name, and the kind is
one of three — `parent` | `blocks` | `related`. Each names itself from the catalogue:
`relations.parent` (`Parent` / `父任务`) · `relations.blocks` (`Blocks` / `阻塞`) ·
`relations.related` (`Related` / `关联`). They are the same three the card's own counters
carry (`data-relations-parent` | `data-relations-blocks` | `data-relations-related`, B07),
so a card and the drawer it opens spell a kind identically; an area holding no relation
reads `relations.none` (`No relations` / `暂无关联`), which `app.js` injects rather than
the markup declaring it. 实测：`index.html` 里 `relations.parent` 有 4 座、`relations.blocks`
6 座，`relations.related` **0 座** —— 三处 `Related`（`[data-slot="relations"]` ×3：4793 /
4885 / 5253）仍是内联、无 `data-i18n` 的旧标记，本节先把第三个名字定在目录里，座位留给
后续实现卡。

**R12 — the head identifier is the whole id, uncapped.** `[data-detail-identifier]` shows
the card's **complete** identifier, verbatim: no character slice (the render path writes the
card's own `data-identifier`; `identifierText()` is **not** called for this element) and no
width limit — the span carries **`.td-id-full`** alongside `.td-id`, and that variant rule
lifts the cap (`max-width: none; overflow: visible; text-overflow: clip`) while `.td-id`
keeps the single line. `title` stays the full id. This is the **one** identifier render point
that is not capped: **B07**'s cards and **B08**'s rows keep R8's ten characters plus an
ellipsis, and neither may carry `.td-id-full`.

**R8's other half still stands — identity never lives in the text.** The drawer root carries
the full id on `data-identifier` (`aside[data-detail-drawer][data-identifier]`), and anything
that resolves the drawer's task must read that attribute rather than the span's `textContent`.
The rule does not lapse now that the text happens to be complete: the text is a display value,
the attribute is the identity. `[data-detail-id]` (the internal `td_…` id) is untouched.

**R10 ② — the three editable rows save as they change.** The drawer's Properties grid holds
the three fields Terry reported: assignee (B22), reporter (B22) and labels (B25). Each row
root carries `data-detail-save-field` (`assignee` / `reporter` / `labels`), and each commits
on the gesture it already had — focus leaving a single-valued field whose value moved, a
roster row accepted, a label chip added or dropped — into **one** state region for all three.

| | |
|---|---|
| State | `[data-detail-save]` · `data-save-state` ∈ `idle` \| `saving` \| `saved` \| `error` (`idle` at rest) |
| Feedback | `[data-detail-save-error]` — `role="alert"`, `hidden` in every state but `error` |
| Fields | `[data-detail-assignee][data-detail-save-field="assignee"]` · `[data-detail-reporter][data-detail-save-field="reporter"]` · `[data-detail-labels][data-detail-save-field="labels"]` |
| Commit points | `[data-detail-assignee-label]` / `[data-reporter-option]` … — the controls' **existing** hooks, unchanged |
| Failure | a single-valued field empty after trimming (the prototype's one deterministic failure; there is no backend) |

Three properties worth naming: **typing is not a commit** (a field whose value did not move
when focus left it is left alone — opening, reading and closing a card is not a write);
**one settle sequence serves all three** (a commit arriving mid-sequence folds into it), and
**opening a card resets it** (the baseline is that card's value at open, and the state returns
to `idle`, so a drawer never wears the previous card's verdict). `setDetailSaveState()` is the
single writer of both the attribute and the alert's `hidden`, so the two cannot disagree.
Contract: `design/fidelity-r10.md` §2.2.

The prototype's alert copy is **inlined**, with no `data-i18n` hook — `test/web/i18n.catalogue.mjs`
mirrors the prototype's `MESSAGES` byte for byte; see `design/fidelity-r10.md` §7. The
**implementation** carries the copy on its own seat, `data-i18n="detail.saveError"`
(`web/src/i18n/extra.mjs:detail.saveError`); the prototype's A12 is unchanged.

**Implementation-side test hooks (not prototype contracts).** 〔原型无此钩子；由
`test/web/blocks.contract.mjs` §B09 背书；实现保留〕 Two hook families are pinned by
`test/web/blocks.contract.mjs` §B09 — all six sit in the block's `required` list, and three carry a
driven `count … min: 1` rule under `when: "drawer open"` (`[data-attachment-row]` and
`[data-activity-row]` / `[data-activity-ts]`, scoped `within: "[data-detail-attachments]"` /
`within: "[data-detail-activity]"`) — but they are **not** part of the prototype's own drawer
markup: `[data-attachment-row]` / `[data-attachment-name]` / `[data-attachment-size]` (the
attachment rows) and `[data-activity-row]` / `[data-activity-actor]` / `[data-activity-ts]` (the
drawer's activity rows). 实测：原型 18 个 `template[data-detail-for]` 的 `[data-slot="attachments"]`
/ `[data-slot="activity"]` 内，六枚属性钩子计数**全为 0**；抽屉打开态（TD-125，3 附件）实读
`[data-detail-drawer] [data-attachment-row|name|size]` = 0、
`[data-detail-drawer] [data-activity-row|actor|ts]` = 0。原型这两个分区一律用 **class**：
`.td-file` / `.td-file-name` / `.td-file-size`（19 行）与 `.td-activity` / `.td-activity-ts`
（72 行）。The implementation keeps them; the prototype is **not** to be retro-fitted with them
(a contract is not rewritten from an implementation). Recorded here only so the two surfaces' hook
inventories can be compared.

**The drawer's attachment preview dialog (implementation-only).** 〔原型无此交互；由
`test/web/blocks.contract.mjs` 的 `AUXILIARY_HOOKS` 与 `design/contracts/attachment-preview.md`
背书〕 A row whose stored `content_type` is one of the four preview families carries an **eye**
button in its action cluster, before download (`[data-attachment-open]`, with
`aria-haspopup="dialog"`; the filename itself stays a plain `<span>`), and it opens a
**full-screen** `[data-attachment-preview]` dialog — teleported to `<body>`, because the drawer's
`transform` would otherwise become the containing block of a `position: fixed` child. The dialog
carries `data-attachment-preview-kind`, a `[data-attachment-preview-close]` button, and, while it
has no bytes to draw, one of `[data-attachment-preview-loading]` / `[data-attachment-preview-error]`.
The prototype has no preview arithmetic (its rows carry only download/remove), so these five hooks
are registered here as implementation-only and the prototype is **not** retro-fitted. The
deviation is the contract's, not an oversight — see `design/contracts/attachment-preview.md`.〕

⚠️ `[data-activity-row]` / `[data-activity-actor]` are **also** B26's feed hooks (see **B26.2**),
where the stamp is `[data-activity-at]` — 实测全文档 `[data-activity-row]` / `[data-activity-actor]`
/ `[data-activity-at]` 各 17 命中且**全部**落在 `[data-activity-feed]` 内（抽屉内 0）。抽屉族与 B26
**只在 `[data-activity-row]` / `[data-activity-actor]` 这两枚属性上同名**；抽屉族的
`[data-activity-ts]` 与 B26 的 `[data-activity-at]` 不同名，不冲突。

## B10 · Create-task modal — two columns

`dialog[data-create-task]` → `.td-modal-box` → `form[data-create-task-form]` →
`[data-create-two-col]`, which holds exactly two tracks:

| Column | Hook | Fields |
|---|---|---|
| Left — the work | `[data-create-left]` | `[data-create-task-title]` (+ hint) · `[data-create-task-description]`, which is `[data-md-source]` inside **B23** |
| Right — its routing | `[data-create-right]` | `[data-create-task-priority]` · **assignee** (**B22**) · `[data-create-task-project]` · `[data-create-task-status]` · **reporter** (**B22**) · **labels** (**B25**) · **parent** (**B24**) · **depends-on** (**B24**) |

> **No `kind` field — ruling C-KIND-1 (T-20261017-063826).** The routing column is exactly
> those eight fields, plus the card's acceptance-mode control (`data-create-task-acceptance`):
> the dialog files plain `task` cards, and the missing `kind` is a decision rather than a
> missing control. `deploy` is not a card kind at all (0039), and an `epic` made here would be
> born `todo` — the one state an epic provably cannot leave (T-20261017-063808). An `epic` comes from an agent promoting a card in place, which is what
> `skills/meerkat/SKILL.md` §"When the card is a container" already assumes. The
> machine face is `test/web/create-dialog-kind.test.mjs` (K1–K3) — adding the field is a design
> round, not a ninth `<select>`.

**R4 — the dialog grew and the left column leads.** `.td-modal-box` is
`min(1120px, 100vw − 32px)` tall to `100vh − 48px` with its own scroller (R3: 880px
wide, sized to its content). The two tracks are `minmax(0, 1.6fr)` / `minmax(0, 1fr)`,
so the description editor holds the wider and much taller pane the work deserves while the
routing column keeps a compact one. Both tracks stay `minmax(0, …)`, so neither a long
title nor the editor can push the dialog wider than its own box — no horizontal overflow
at 1512 / 1240 / 980 / 760 / 430.

At ≤760px the tracks stack (`.td-two-col` collapses to one column) and the dialog scrolls
internally, so every field stays reachable on a phone-width window.

`[data-modal-close]` closes it, and `resetCreateTask()` is the single writer of its opening
state — it also serves as the reset after a submit, so a second task starts exactly where
the first one did. R4 taught it two more things to clear: the relation controls' inputs,
and the depends-on chips, which a native form reset cannot reach. R5 taught it the same for
the label control — `[data-label-input]`, the `[data-label-chips]` chips and the generated
`[data-label-menu]`.

The assignee is no longer a `<select>`; see B22. Labels are a field as of R5 — the same
combo control, many per task — see **B25**. The two relation controls are marked
**Optional** and leave the task creatable when empty; see B24.

**R10 ③ — the left column is stretched, so the description fills it.** The description used
to stop at its own content height while the routing column ran on, leaving a band of empty
dialog under the editor. Five links carry the fill, and breaking any one of them puts the
band back:

| Link | Rule |
|---|---|
| 1 · the two tracks | `.td-two-col{align-items: stretch}` |
| 2 · the left column | `.td-col-left` is already a column flex container |
| 3 · the growing field | `.td-field-grow{display:flex; flex-direction:column; flex:1 1 auto; min-height:0}` |
| 4 · the editor | `.td-md-editor{flex: 1 1 auto}` |
| 5 · the panes | `.td-md-panes{flex: 1 1 auto; min-height: 200px}` — **no fixed height** |

Link 3 is the one the round's first draft missed: `.td-field-grow` was a **block** container,
so the editor's `flex: 1 1 auto` had no flex parent to resolve against and fell back to its
content height — which is why fixing only 1 / 4 / 5 still measured a 302px gap. Links 1 and 5
are equally load-bearing: `align-items: start` leaves the left column content-sized, and the
`clamp(280px, 46vh, 520px)` that R4 put on `.td-md-panes` is a **viewport** rule, so a taller
dialog could never give the editing area any of the difference.

`.td-modal-box` keeps R4's `max-height: calc(100vh - 48px)` and its own scroller — the dialog
still caps against the viewport and scrolls internally rather than running off the screen, and
at ≤760px the tracks stack so the panes are bounded rather than stretched. Measured at
1512×950: the editor's bottom edge lands on the column's (0px gap) and `.td-md-panes` is
502px; the board's own geometry and the box's 1120×800 overflow are both unchanged. Contract:
`design/fidelity-r10.md` §2.3.

**R8 — in the dark the dialog separates on all three layers.** On a `#0f1417` canvas
the panel (`bg .td-modal-box` = `--color-td-surface` `#161b1e`) is only marginally
lighter than the canvas, so the dialog read as part of its own backdrop. Three scoped
overrides fix it, and **only in the dark**:

| Layer | Light (unchanged) | Dark |
|---|---|---|
| Veil — the `dialog.modal` itself (`background-color: var(--scrim)`) | `rgba(15, 20, 23, 0.32)` | **`rgba(0, 0, 0, 0.55)`** |
| Panel edge — `.modal-box` `border-color` | `--color-td-line` `#e6e8eb` | **`--color-td-line-strong` `#313b41`** |
| Panel elevation — `.modal-box` `box-shadow` | `--shadow-pop` (canvas-tinted) | **`0 16px 40px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.5)`** |

The panel's own surface colour is **not** changed, and neither is anything in the
light. `.td-modal-box` inherits `.modal-box`, so **B11** (create-project) gets the same
treatment from the same rules. The drawer's `.td-scrim` reads the same `--scrim`, so the
drawer veil deepens with the modal's — one token, every veil.

> The implementation mirrors this with a `--brand-scrim` token; see `design/fidelity-r8.md`
> §2.1, which also records that the implementation's light veil is a *pre-existing*
> different value and must not be churned by this round.

## B11 · Create-project modal

`dialog[data-create-project]` → `form[data-create-project-form]` →
`[data-create-project-name]` · `[data-create-project-prefix]` ·
`[data-create-project-review-policy]` (auto / off / agent / human — the hook name predates the
one acceptance vocabulary) ·
`[data-create-project-reviewer]` (optional project override) · `[data-modal-close]`.

> **前缀绑定（口径 = `design/contracts/project-prefix-binding.md`）**：`[data-create-project-prefix]`
> 是**该项目卡号前缀**的 oracle——原型把它 `required` + `maxlength="4"`，提交时存入
> `PROJECT_PREFIX[name]`，`nextIdentifier()` 据此编号。服务端侧的唯一口径（`meta.prefix` 规范化后
> 存为项目前缀、铸号读它、缺省回退 `identifierPrefix(id)`）与机检断言清单见该契约。

## B12 · Empty states

`[data-empty]` with `data-empty-kind="column"` (one per column, revealed when the
column has no visible card) or `data-empty-kind="no-results"` (one per board,
revealed when a filter matches nothing).

**R10 ① — the two kinds are not states of the same thing.** `no-results` is the **empty
state of the board view**: it is a direct child of `[data-board-view]` (B05), revealed when
`[data-board-view]` reads `data-board-state="empty"`, which is exactly when no card survives
the filters. `column` says *that column is bare* and lives inside its `[data-column]` body;
there are seven of them and they are **never** counted in a board-level tally — a board-level
tally that counted both would count the same emptiness twice. The condition is now
`shown === 0`, which covers a genuinely empty project (`total === 0`) as well as a filter
that matches nothing; before R10 it was `total > 0 && shown === 0`, so a project with no
cards kept this block hidden and drew seven bare columns in its place.

**The large empty state carries the brand mark** (R3): the *large* variant is the class
`.td-empty-lg` on `[data-empty][data-empty-kind="no-results"]` — there is no `data-empty-lg`
attribute (the hook that names the state is the pair `[data-empty]` +
`data-empty-kind="no-results"`, and a class cannot be a contract selector; see
`test/web/blocks.contract.mjs` B12). The shipped markup is
`<div class="td-empty td-empty-lg" data-empty data-empty-kind="no-results" hidden>`. It opens
on a 28px Sentinel Watch mark, which replaced the
generic no-results glyph. Its two lead meerkats are `--color-td-ink-3` rather than
`--color-td-ink`, so on an empty board the on-duty sentinel is still the only lit element on
the surface.

**R17 — B12 is now the whole family's reference, not only the board's.** Terry's 2026-10-13
request (`T-20261013-184102-2`, 需求 E) was that the activity and waiting empty states read
the way the board's does. Every choice B12 already made is the choice the family now shares:
the brand mark first, the `.td-empty-lg` size, the block at the **top** of its container, and
the rule that a state offers only the buttons that do something in it. The states themselves
and their copy are B26.5 and B27.3's; the reading is this section's. See the R17 section at
the end of this file for the matrix and the reasons.

## B13 · Loading state

| | |
|---|---|
| Root | `[data-skeleton]` — a `.td-list-group` holding the caption row plus three shimmer rows |
| State | visible only while `[data-list]` reads `data-list-state="loading"`; `hidden` in the `data` state |
| Caption | `[data-i18n="list.loading"]` (`Loading tasks` / `正在加载任务`) over a one-cell `.td-list-head` |

**R9 ③ — the loading state and the data state are mutually exclusive.** `[data-list-rows]`
and `[data-skeleton]` are the two halves: exactly one of them is in the flow at any moment
(the rule is on `[data-list][data-list-state]`, so the states cannot share the screen even
if one of them is written to the DOM first). Before R9 they were both visible at once — the
skeleton was never taken down when `renderList()` filled the rows — which is the defect this
round's ③ named.

**Loading is a timeline here, not a still.** The prototype's list view enters `loading` when
the view is opened and settles to `data` a beat later, so both states are reachable from the
interface itself and a capture can catch either. A recapture of `06-list-view` must wait for
the settle (the probe in `design/fidelity-r9.md` §6 waits 900ms).

(The showcase in B18 has its own `[data-loading-state]` demo — a static, card-level copy
that is not this state and carries no `[data-skeleton]`.)

**Implementation supplement — the per-view skeletons.** The product asks every view to hold
a skeleton while **its own** data is being read, not only B13's list. They are resident
branches rather than new prototype pages, and the prototype is **not** retro-fitted with
them (it has no network; its B18 loading demo is where the card composition comes from):

| View | While the read is in flight | Carrier |
|---|---|---|
| Board (B05) | each of the seven columns keeps its header and shows the design's own `.td-skel-card` composition in its body; real cards, column counts and column empty states stand down | `[data-view-loading]` on `[data-board-view]`, skeletons under `[data-view-skeleton="board"]` |
| Activity (B26) | a day caption and six 30px row placeholders in the feed; day groups and both empty states stand down | `[data-view-skeleton="activity"]` |
| Waiting (B27) | four 30px row placeholders; the queue and its empty state stand down | `[data-view-skeleton="waiting"]` |
| Drawer (B09) | the panel slides in with a skeleton head and body, then the same shell renders the card | `[data-detail-skeleton]` |

`data-view-loading` is `true | false` and follows **a real read only** — a pure view switch
with nothing to fetch (board ↔ waiting on an already-read project) shows no skeleton. It is
not a third value of `data-board-state` or `data-list-state`: a loading board is still in
the `data` state, unread.

## B14 · Toast region

`div[data-toast-region]` (`role="status" aria-live="polite"`) plus
`template[data-toast-template]` → `[data-toast][data-toast-kind="info\|success\|danger"]`
→ `[data-toast-text]`. Auto-dismiss after 2.5s. The three kinds are also rendered
statically inside B18 (`data-state="static"`, never auto-dismissed).

## B15 · Legend

`div[data-legend]` → `[data-legend-status]` (7 status chips) ·
`[data-legend-priority]` (5 priority chips). Sits at the bottom of the sidebar so
every status and priority is visible in one screenshot.

## B16 · Agent session provenance

`[data-agent-session]` — one row per session inside `[data-detail-agent-session]`,
rendered from the card's session list (`GET /api/v1/tasks/:ref/sessions`), with
`[data-agent-platform]`, `[data-agent-platform-value]` (the card's **platform
id**, e.g. `claude` — `[data-agent-platform]` is the id's badge; the prototype's
static sample renders a CLI-style declaration there, a prototype-only expression
registered in `design/fidelity-r14.md` §8.3 `DF-4`), `[data-agent-session-id]`
and `[data-agent-resume]` (the running row only; the hook stays in the DOM,
hidden, when no row is running).

The trail is ordered **running first, then `ts` descending**. Visibility is
**data-driven** (`sessions.length > 0`): the section and the Sessions tab are
hidden together when the card has no session rows. The assignee kind is not the
switch — a human-assigned card can carry real session rows, and the server
enforces no assignee/session relationship. Historical rows name their own
`owner_kind` in a plain badge; the `data-agent-platform` seat states the card's own
platform.

## B17 · Error state

| | |
|---|---|
| Root | `[data-error-state]` (`role="alert"`), hidden by default |
| Parts | danger-coloured icon · `[data-i18n="error.title"]` · `[data-i18n="error.hint"]` · `[data-error-retry]` |
| Surface | `--color-td-danger-soft` background — the token the style guide reserves for error surfaces |
| Wiring | `Retry` re-runs the real render pass (`applyFilters`) and confirms with a success toast |

B17 is demonstrated inside the B18 gallery rather than on the board, because the board
only raises it when a load fails and this prototype performs no loads. It is therefore
hidden by default for the same reason the panel is, and it is reachable in one click
from the sidebar.

## B18 · States showcase

| | |
|---|---|
| Root | `[data-states-panel][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), hidden by default |
| Opener | `[data-states-open]` in the sidebar footer |
| Dismiss | `[data-states-close]` · `[data-states-overlay]` · `Esc` — same `data-state` + `hidden` pattern as the detail drawer |
| Demos | `[data-loading-state]` (skeleton cards) · `[data-empty-column]` · `[data-empty-results]` · **B17** `[data-error-state]` · `[data-toast-states]` → the three `[data-toast]` kinds |

The gallery is a prototype review surface: it puts every non-default state in one
frame so coverage can be checked in a single screenshot. It adds no framework — a
scrim, a panel and two jQuery handlers.

## B19 · Access & token settings

| | |
|---|---|
| Root | `[data-access-panel][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), **hidden by default** with the `hidden` attribute |
| Opener | `[data-access-open]` in the sidebar footer |
| Dismiss | `[data-access-close]` · `[data-access-overlay]` · `Esc` — same `data-state` + `hidden` pattern as the drawer and the states showcase; focus returns to the opener |
| Bind copy | `[data-i18n="access.model.bind"]` |
| CIDR whitelist | `[data-cidr-whitelist]` (`data-cidr-enabled="true\|false"`) → `[data-cidr-list]` → **n ×** `[data-cidr-row]` (`[data-cidr-value]` input + `[data-cidr-remove]`) · `[data-cidr-add]` |
| Allow-list switch | `[data-cidr-switch]` — a daisyUI `toggle` stating whether the list above is in force |
| CIDR copy | `[data-i18n="access.cidr.note"]` · `[data-i18n="access.cidr.add"]` · `[data-i18n="access.cidr.remove"]` · `[data-i18n="access.cidr.value"]` |
| Token rule | `[data-i18n="access.model.token"]` |
| Token block | `[data-token-block]` (`data-token-revealed="true\|false"`) → `[data-token-value]` · `[data-token-reveal]` (icons `[data-token-icon="hidden"\|"shown"]`) · `[data-token-copy]` · `[data-token-reset]` |
| Captions | `[data-i18n="access.token.generated"]` · `[data-i18n="access.token.private"]` |

The panel states the v1.2 access model: the board **binds to `0.0.0.0`** and is reachable
from other devices on the network; a **CIDR whitelist** restricts which source ranges may
reach it (`192.168.0.0/16`, `10.0.0.0/8`, `203.0.113.0/24` ship seeded, and rows can be
added or removed); and **requests from outside localhost must present the token**. The
v1.1 copy (`Local only by default — … listens on localhost.` / `Remote (public) access
requires a token.`) and the two Local/Remote scope rows it headed are gone.

The whitelist is a **front-end placeholder**: `[data-cidr-add]` appends one empty row and
focuses its input, `[data-cidr-list]` delegates every `[data-cidr-remove]` to its own
`[data-cidr-row]`. Rows live in the DOM only — nothing is validated, compared, stored or
sent.

**The allow-list switch (R3)** is a daisyUI `toggle`, and it is display only: the switch
moves, `[data-cidr-whitelist]` carries the state as `data-cidr-enabled`, the list dims to
45% when it is off, and a toast says which way it went. Nothing is written, sent or
enforced. Note the two names are deliberately different — `[data-cidr-switch]` is the
input, `data-cidr-enabled` is the section's state — because a hook and the state it
writes must not share one attribute name.

`[data-token-value]` renders the stand-in masked as `td_••••••••••••` (the `td_` prefix
stays visible); `Reveal` toggles the mask only, `Copy` reports a toast and touches no
clipboard, `Reset` mints a new value in memory and shows it. The value is produced by
`Math.random()` + `Date.now()`, held in `state.token`, and written to the DOM and
nowhere else — **no storage, no transport, no credential, nothing persisted.** See
DESIGN.md §12.

## B20 · Theme switch — retired in v1.4

**Removed, not hidden.** The v1.3 theme dialog (`[data-theme-modal]`,
`[data-theme-choice]`, `[data-theme-close]`, `[data-theme-overlay]`), its
`.td-choices` / `.td-choice` rows and its catalogue keys (`access.theme.open`,
`access.theme.title`, `access.theme.group`, `access.theme.close`) are **deleted** from
`index.html`, `app.js`, `src/input.css` and the built `tw.css` — no selector reaches them
and no `B20` hook exists in the document. What the left footer cell does now is the
**three-state cycle** in B03 above. The one part that survives is the vocabulary: the cell
still names the theme in force through `access.theme.light` / `access.theme.dark`, and
since the cycle gained its third state, `access.theme.auto`.

## B21 · Language menu — replaced in v1.4

**Removed, not hidden.** The v1.3 language dialog (`[data-lang-modal]`,
`[data-lang-choice]`, `[data-lang-close]`, `[data-lang-overlay]`), the same
`.td-choices` / `.td-choice` rows and the keys `access.lang.title` / `access.lang.close`
are **deleted**. The middle footer cell now opens the **dropdown menu** in B03 above, which
takes a new number: `[data-lang-option="en" | "zh"]` replaced `[data-lang-choice]`, and
`access.lang.en` / `access.lang.zh` now name the *options* (`English` / `中文`) while
`access.lang.short.en` / `access.lang.short.zh` name the *trigger* (`EN` / `中文`).

**Only one dialog is left.** B19 is the document's only `role="dialog"` panel; the theme
and language surfaces never had one and no longer have one. `Esc` still closes whatever is
open — the drawer, the states showcase, the access panel and now both floating menus.

---

## B22 · Assignee / Reporter control (R3)

One control, two rosters, four placements.

| | |
|---|---|
| Hooks | `[data-assignee-input]` · `[data-assignee-menu]` · `[data-assignee-option]` (`data-assignee-value`, `data-assignee-kind`, `data-agent-platform`) · `[data-reporter-input]` · `[data-reporter-menu]` · `[data-reporter-option]` (`data-reporter-value`) |
| Shell | `.td-combo` (positioned) → `input.input` + `ul.menu.td-combo-menu` (daisyUI `menu`) |
| Placements | create dialog — assignee and reporter (B10) · detail drawer — `[data-detail-assignee-label]` and `[data-detail-reporter-label]` are the inputs, inside `.td-prop-combo` |
| Options | generated from the roster on every keystroke; the static seven on the assignee menu and the one on the reporter menu are the no-JS floor |
| Keyboard | `↑`/`↓` move `aria-selected`, `Enter` accepts, `Esc` dismisses (`stopPropagation`, because the drawer also listens), `Tab` closes |
| **No management entry** | there is no control anywhere that adds, renames or removes a roster entry — the list grows only by being used |

The two rosters (DESIGN.md §18.3):

| roster | seeded from | grows when |
|---|---|---|
| assignee | the seven handles the board names, each with its kind and platform | a task is created or re-assigned with a name the roster does not hold |
| reporter | `data-reporter` across the 18 cards, read at first pass | a task is created with a new reporter |

Matching is a case-insensitive substring, ranked prefix → contains → subsequence; the
subsequence pass runs only when nothing contains the query. A name that is not in the
roster is offered as a `· new` row while you type and is added the moment it is used. An
unknown assignee defaults to `human`, because a handle the board has never seen carries no
platform to claim. Both rosters live in memory and are written to nothing.

## B23 · Markdown editor (R3)

| | |
|---|---|
| Root | `[data-md-editor]` |
| Mode | `[data-md-toggle="write \| preview \| split"]` (`aria-pressed`) sets `data-md-mode` on `.td-md-panes`; `setMarkdownMode()` is the only writer |
| Source | `[data-md-source]` — a `<textarea>`, also `[data-create-task-description]` |
| Highlight layer | `[data-md-highlight]` — a `<pre>` painted behind the textarea, `aria-hidden`, scrolled from it |
| Preview | `[data-md-preview]` — rendered HTML inside `.td-gfm` |
| Vendored | `vendor/markdown-lite.js` (`MarkdownLite.render`) · `vendor/highlight-lite.js` (`HighlightLite.markdown`, `HighlightLite.code`) |

The source pane is a **transparent textarea stacked on a highlighted `<pre>`**; both carry
`.td-md-text`, which owns every property that can move a glyph, so the painted layer and the
real input break lines in the same place. The `pre` and the textarea are the *only* two
elements in the editor whose geometry must agree — everything else follows from them.

**R4 — both panes scroll, and the highlight layer follows.** The edit side `.td-md-source`
carries an explicit `height: 100%` beside `overflow-y: auto`, so overflowing source scrolls
the way the preview always did; with scripting off the textarea keeps that native scroller
and the layout is unchanged. `.td-md-panes` was `clamp(280px, 46vh, 520px)` — a markedly
taller editing area than R3's fixed 230px.

**R10 ③ — the height is no longer a viewport rule.** That `clamp` was the block's second
half: a height written in `vh` cannot follow the *dialog's* growth, so a taller box left the
difference under the editor. `.td-md-panes` is now `flex: 1 1 auto` with `min-height: 200px`
— a floor, not a ceiling — and its parents (`.td-field-grow`, `.td-md-editor`) take
`flex: 1 1 auto` so the editor reaches the bottom of the column it sits in. `.td-md-source`
keeps `height: 100%` and its own scroller, so the writing hand feels exactly as it did.
Below 760px the tracks stack and the panes keep a bounded height under the same floor.
Measured at 1512×950: panes 437px → **502px**; see B10's R10 table for the five-link chain.

The scroll binding is **direct**, not delegated: `scroll` does not bubble, so R3's
`$(editor).on("scroll", "[data-md-source]", …)` never fired and the highlight `<pre>` stayed
put while the text scrolled under it — the "Write mode will not scroll" report. Binding the
handler to each source (`.on("scroll")` on the element, keyed off the same
`[data-md-source]` hook) puts the two back on one `scrollTop`.

Both vendored files are loaded with a plain `<script>` tag from `prototype/vendor/`, make
no network request, read no storage, and are first-party rather than downloaded (DESIGN.md
§18.4). Nothing is submitted, fetched or stored: the editor renders what is typed, in the
page.

---

## B24 · Parent / Depends-on control (R4)

Two optional relation fields in B10's right column. They are B22's control pointed at a
different source: the **current project's cards**, not a people roster.

| | Parent | Depends on |
|---|---|---|
| Root | `[data-create-task-parent]` (`.td-combo`) | `[data-create-task-depends]` (`.td-combo`) |
| Input | `[data-parent-input]` | `[data-depends-input]` |
| Menu | `[data-parent-menu]` → `[data-parent-option]` (`data-parent-value`) | `[data-depends-menu]` → `[data-depends-option]` (`data-depends-value`) |
| Selection | single — the input states the identifier, `[data-parent-clear]` empties it | multi — one `[data-depends-chips]` chip per task (`[data-depends-chip]`, each with `[data-depends-remove]`) |
| Semantics | `task_relations.type='parent'`, **one** parent | prerequisite DAG (no cycles) |

Both are labelled **Optional** and both leave the task creatable when empty.

| | |
|---|---|
| Options | read from `[data-card]` filtered to the project selected in `[data-create-task-project]` (default: the working project), as **identifier + title** — `identifier` is the value, the title is the row's trailing text and the chip's tooltip |
| Ranking | the same substring ranking as B22 (prefix → contains → subsequence), over identifier and title together |
| Free text | **off** (`freeText: false`): a relation can only point at a task that already exists, so there is no `· new` row and nothing is added to any roster |
| Dedupe | a chosen chip is dropped from the menu on the next render; choosing it twice is a no-op |
| Markup | the menus ship a 12-row inert seed (the working project's tasks) as the no-JS floor, redrawn from the live board the moment the control is focused |
| Keyboard | `↑`/`↓` move, `Enter` accepts (opens the menu when it is closed, so it can never submit the form from these inputs), `Esc` dismisses, `Tab` closes — the B22 loop, keyed off these hooks |

**Menus never tear the dialog.** `.td-combo-menu` is `flex-wrap: nowrap` with `flex: none`
rows, because daisyUI's `menu` is `column wrap` and turned a twelve-task list into two
narrow columns. Inside the dialog the menu is clipped by `.td-modal-box`'s own scroller, so
`positionComboMenu()` measures the row and flips the menu above its control (CSS
`.td-combo[data-drop="up"]`) when there is not room below — the depends-on field, last in
the column, opens upward.

**UI only.** No relation is written anywhere: no graph is built, no cycle is checked, and
the chips reach neither the created card nor any store. The plan's ≤8 chain length and ≤8
fan-in are noted in the spec, not enforced here.

---

## B25 · Label control (R5)

One field in B10's right column, between **Reporter** (B22) and **Parent** (B24), plus the
same control in the **B09** drawer's property grid. It is **B22's control used many times
at once**: free text over a fuzzy-matched list, and the multi/chips half of **B24**.
Authority: `ARCHITECTURE §4.4`; narrative: DESIGN.md **§22**.

| | |
|---|---|
| Root | `[data-create-task-labels]` (`.td-combo`) |
| Chips | `[data-label-chips]` → one `[data-label-chip]` per label (`data-label-value`), each with a `[data-label-remove]` |
| Input | `[data-label-input]` — `role="combobox"`, `aria-controls="td-label-menu-create"` |
| Menu | `[data-label-menu]` → `[data-label-option]` (`data-label-value`) |
| Drawer | `[data-detail-labels]` — the **same editable control** in the drawer's own hook family: root `[data-detail-label-chips]` — one `[data-detail-label-chip]` per label (`data-detail-label-value`), each with a `[data-detail-label-remove]` · input `[data-detail-label-input]` (`aria-controls="td-label-menu-detail"`) · menu `[data-detail-label-menu]` → `[data-detail-label-option]` (`data-detail-label-value`). `freeText: true`, `multi: true` — the B22 Assignee/Reporter paradigm; the card's `data-labels` fill its chips on open |
| Roster | read off the board's cards (`data-labels`) at first pass — **no preset list, no enum** |
| Free text | **on** (`freeText: true`): a name the roster does not hold is offered as a `· new` row and is created by being used |
| Multi | **on**: every accepted name becomes a removable chip; the menu drops what is already chosen, and choosing it twice is a no-op |
| Normalisation | case- and whitespace-insensitive (`bug` / `Bug` / `bug ` are one label); the entry keeps the **first spelling**, and that is what every surface shows |
| Keyboard | `↑`/`↓` move, `Enter` accepts (opens the menu when it is closed, so it can never submit the form from this input), `Esc` dismisses, `Tab` closes — the B22/B24 loop, keyed off these hooks |
| Markup | the menu ships an 11-row inert seed (the board's own labels) as the no-JS floor, redrawn from the live roster the moment the control is focused |

The two placements share one implementation (`COMBO.labels` in the dialog,
`COMBO.detailLabels` in the drawer) and one roster, and differ only in the hook family they
answer to — `data-label-*` in the dialog, `data-detail-label-*` in the drawer — so their
delegated selectors never collide in the single document. The drawer's chips are rendered
from the card's `data-labels` on open and are **editable**: type to fuzzy-match, accept to
add a chip, remove to drop one, exactly as in the dialog.

**No management entry** — the hard constraint, shared with B22. There is **no "manage
labels" / "label library" / "delete label" / "edit labels"** control anywhere in the
prototype, and no button that adds, renames, merges or expires a label. Auto-cleanup of
unused labels is a **backend** concern (DESIGN.md §22.4) and has no UI here.

**UI only.** Nothing is stored, sent or filtered: the chips reach the created card's
`data-labels` attribute and the drawer, and go no further.

---

## B26 · Activity view (R12x)

The sidebar's third destination, and the view it opens. Terry's 2026-10-13 request: the
`Activity` nav item was a **stand-in** — a press reported the revision in a toast and no
view existed — and the ask was to make the press enter the design `design/activity/`
already carried. Authority: `design/activity/DESIGN-activity.md` (the design's own contract,
§10 block list / §11 consistency items / §3 admission rules); narrative: DESIGN.md **§29**.
The structure below is that design's, moved in **verbatim** — same hooks, same order, same
copy. Its own page stays in the repository as the design source and as its own evidence.

| | |
|---|---|
| Root | `[data-activity-view]` — third child of `main.td-main`, beside `[data-board-view]` and `[data-list]`; ships **`hidden`**, because the no-script default view is the board |
| B26.1 header + controls | `[data-activity-title]` · `[data-activity-mark-read]` (the header's own title and subtitle carry `data-i18n` hooks only, no `data-activity-*` of their own) · `[data-activity-filters]` (a `section`, named `filters.label`, R15 ①) → `[data-activity-filter="actor" \| "event" \| "task"]` (**each a `<details class="dropdown" data-dismiss-on-outside>`**, R15 ①) + `[data-filter-clear]` (R15 ③) + `[data-activity-filter-count]` (`aria-live="polite"`) |
| B26.1a one activity control | `[data-activity-filter="…"]` on a `<details class="dropdown" data-dismiss-on-outside>`; the chosen value lives on `data-activity-filter-value`, the trigger states it via `[data-activity-filter-text]`, and the menu holds `[data-activity-filter-option]` × N, each with `data-activity-value` and `aria-current` on the chosen one |
| B26.2 feed | `[data-activity-feed]` → `[data-activity-day]` → `[data-activity-row]` → `[data-activity-actor]` / `[data-activity-sentence]` / `[data-activity-task]` / `[data-activity-at]` / `[data-activity-detail]` |
| B26.3 unread boundary | `[data-activity-unread-divider]` + `[data-activity-unread-count]`; the same press that clears it is `[data-activity-mark-read]` |
| B26.4 burst | `[data-activity-burst]` + `[data-activity-burst-count]` (`×N`) + one `[data-activity-burst-item]` per folded event |
| B26.5 empty states | `[data-activity-empty][data-activity-empty-kind="project" \| "filter"]`; the filter one holds `[data-activity-empty-reset]`, the project one holds no control at all. Both ship `hidden`, both open on the brand mark, and both are `td-empty-lg` (R17) |
| B26.6 Load older | `[data-activity-more]` — unfolds the next `[data-activity-day][data-activity-page]`, then retires |

**The feed is static markup, not a render.** 17 rows across 4 day groups, each row's
identifier, stamp and native `<details>` present in the document — 0 `<template>` inside the
view. With the script off the view is complete and merely `hidden`; the script is what
narrows, folds and counts. This is the property R-5 states and the check measures twice:
once against the source, once in a context with JavaScript disabled.

**One dictionary.** The view's copy lives in `app.js`'s `MESSAGES` like every other
surface's — `design/activity/prototype.html`'s page-local catalogue is **not** carried over
(R-3). 50 names are new to the catalogue (49 `activity.*` plus `time.minutesAgo`); the ones
the document already held — `nav.*`, `status.*`, `drawer.*`, `time.hoursAgo`/`time.daysAgo`
— are reused and not redefined. `activity.created` / `claimed` / `commented` stay as they
were: they serve B09's own stream and read as whole sentences.

**A row opens B09.** `[data-activity-line]` is the pointer affordance and
`[data-activity-open]` its keyboard twin, and both land on the board's own detail surface
for the task the row names — found by the internal id the row's own link carries, or by the
identifier when that id is not on this board. The `[data-activity-task]` anchor stays a real
link for a reader without the script; with it, the press opens the same detail surface in
place — the view stays the activity view. Neither path is B26's own shell — the design's
`design/activity/` page carries a stand-in drawer, and that stand-in is deliberately not
what the board gets.

**Zero new hues.** The view's rules moved from the design page's scoped `<style>` block into
`src/input.css` (R-7). They declare no custom property of their own and carry no colour
literal, and every `var(--…)` they read already resolves in `tw.css` — three properties the
check reads off the moved block rather than off this prose.

**R15 ① — B26's filter bar is B04's bar, control for control.** Terry's 2026-10-13 second
request (`T-20261013-165112`) was that the Activity page's three filters read as the
board/list bar's own control family, and the round's ruling (Elon, 口径 B) is that they
**are** it — the same component, not a lookalike. Measured on the prototype
(`design/fidelity-r15.md` §3): the bar is a **named `section.td-filters` landmark** — the
same element kind, the same `filters.label` accessible name, the same `flex` shell — whose
direct children are its control row and its tail; and each of the three controls is a
**`<details class="dropdown" data-dismiss-on-outside>`** whose `<summary class="btn btn-sm
td-label-trigger">` states the chosen value as plain text and whose `dropdown-content menu`
holds the rows — the four board controls' own shape, drawn by the same rules.

What the round changed, in full:

| | before | after |
|---|---|---|
| container | `div.td-filters` | `section.td-filters` + `filters.label` (the board's own landmark) |
| control | `select.select.select-sm.td-select` ×3 (with a `.td-sr` label sibling) | `details.dropdown[data-dismiss-on-outside]` ×3 (with a named `summary` trigger) |
| value | the form value (`$el.val()`) | `data-activity-filter-value` on the control |
| trigger copy | the browser's own selected option | `[data-activity-filter-text]`, restated from the chosen row |
| rows | the select's `<option>`s | `[data-activity-filter-option]` + `data-activity-value`, `aria-current` on the chosen one |
| clear | `[data-activity-filter-reset]` / `Reset` | `[data-filter-clear]` / `Clear` (R15 ③) |

The three domains are B26's own and unchanged (`actor` · `event` · `task`, with the same
row counts 3 / 4 / 10 and the same copy), the bar keeps its own count
(`[data-activity-filter-count]`, `aria-live="polite"`), and the feed's URL contract is
unchanged (`#/activity?actor=…`). The aux hook family grows by exactly two names — the
trigger seat and the row seat — and the round retires one (`[data-activity-filter-reset]`,
R15 ②). The implementation's divergence — each control wrapped in a `span.td-select-caret`
carrying an inline caret `svg`, invented because the app sheet may not carry the prototype's
caret data-URI, and with no counterpart on the board's controls — is registered in
`design/fidelity-r15.md` §4 as R15-B01, with the selector-level target for the
implementation card.

**R15 ③ — the bar's clear control is B04's Clear, hook and key.** `[data-activity-filter-reset]`
and `activity.filter.reset` are **withdrawn**: the bar carries `[data-filter-clear]` with
`data-i18n="filters.clear"`, the hook and the key the board/list bar's Clear has carried all
along, in the same tail position (Clear · count) and the same `btn btn-ghost btn-sm` shell.
The prototype tells the two presses apart **by the bar the press came from**
(`[data-activity-filters]` is the activity bar's own root), not by a second hook name — one
control family, two bars. The filter-empty state's own inline `[data-activity-empty-reset]`
(B26.5) is a different affordance in a different place and is **not** touched.

**Auxiliary hooks** (implementation detail, not part of the block contract), the full
`data-activity-*` set the document carries — **39 names, no more**, measured off the shipped
document (R15 ① added the five the dropdown conversion needs —
`[data-activity-filter-summary]` (the trigger seat), `[data-activity-filter-text]` (the
trigger's value seat, the board's `-text` shape), `[data-activity-filter-option]` (a menu
row), `[data-activity-filter-value]` (the control's value carrier, the board's
`-value` shape), and `[data-activity-value]` (a row's own value) — and R15 ③ retired one,
`[data-activity-filter-reset]`; `[data-filter-clear]` is B04's hook, not this family's):
`[data-activity-view]` · `[data-activity-title]` · `[data-activity-mark-read]` ·
`[data-activity-filters]` · `[data-activity-filter]` · `[data-activity-filter-summary]` ·
`[data-activity-filter-text]` · `[data-activity-filter-option]` · `[data-activity-filter-value]` ·
`[data-activity-value]` · `[data-activity-filter-count]` · `[data-activity-feed]` · `[data-activity-day]` ·
`[data-activity-day-label]` · `[data-activity-day-kind]` · `[data-activity-page]` ·
`[data-activity-row]` · `[data-activity-line]` · `[data-activity-actor]` ·
`[data-activity-sentence]` · `[data-activity-task]` · `[data-activity-task-id]` ·
`[data-activity-task-title]` · `[data-activity-at]` · `[data-activity-open]` ·
`[data-activity-detail]` · `[data-activity-change]` · `[data-activity-unread]` ·
`[data-activity-unread-divider]` · `[data-activity-unread-count]` · `[data-activity-burst]` ·
`[data-activity-burst-count]` · `[data-activity-burst-count-label]` ·
`[data-activity-burst-item]` · `[data-activity-group]` ·
`[data-activity-empty]` / `[data-activity-empty-kind]` / `[data-activity-empty-reset]` ·
`[data-activity-more]`.

---

## B27 · Waiting view (R12x)

The sidebar's fourth destination, and the view it opens. Terry's 2026-10-13 request named it
in the same breath as Activity — `修复 awaiting on me 的入口` — and it was the same defect: a
nav name that reported a number instead of opening a view. It is also the seam B26's round
left standing: from the moment routing landed, a press on `Waiting on me` moved the sidebar's
current-item mark and left the main column empty. Authority: the round's design ruling
(design-spec **R-4**, Jobs, 2026-10-13); narrative: DESIGN.md **§30**.

**It is not a second Activity.** Activity (B26) is the project's ledger — every admitted
event, newest first, everything. Waiting is the reader's own queue: only the items whose ball
is in *their* court, and only by how long they have been waiting. Two destinations, two
roots, two questions; the ruling that keeps them apart is Elon's (card comment, 2026-10-12
19:04) and the reasoning is DESIGN.md §30.1.

**Which filters narrow it — none of the board's.** The queue is derived from the whole board
reading, not from the board's visible set, and narrowed by exactly one condition: the sidebar's
assignee (whose queue is being read). The status / priority / label / search filters belong to
the board view and never reach the queue — the waiting view hides the filter bar, so a filter
narrowing it would hide an overdue item invisibly, the failure §30.6's rejected "give `waiting`
its own filter bar" alternative already names. Both halves of the one queue — awaiting questions
and waiting acceptances — apply that same assignee narrowing, and the header's tally reads the
same two derivations the rows do, so the count cannot disagree with what is on screen (TP-0021).

| | |
|---|---|
| Root | `[data-waiting-view]` — fourth child of `main.td-main`, beside `[data-board-view]`, `[data-list]` and `[data-activity-view]`; ships **`hidden`**, because the no-script default view is the board |
| B27.2 header | `[data-waiting-head]` → `[data-waiting-title]` (`waiting.title`, byte-identical to `nav.waiting`) + the description (`waiting.subtitle`, R15 ④ — a `data-i18n` seat only, no `data-waiting-*` of its own) + `[data-waiting-count]` (`waiting.count`, `%s` template) |
| B27.1 the queue | `[data-waiting-list]` → `[data-waiting-item]` → `[data-waiting-actor]` / `[data-waiting-reason]` (+ `[data-waiting-action]`) / `[data-waiting-task]` + `[data-waiting-task-title]` / `[data-waiting-preview]` / `[data-waiting-since]` / `[data-waiting-open]` |
| B27.3 empty state | `[data-waiting-empty]`; ships `hidden`. R17 gives it B12's reading — the brand mark first, `td-empty-lg`, top-aligned — and the second line the state was missing (`waiting.empty.hint`). No button: nothing in this view filters. Its R17 420px cap is withdrawn (2026-10-15): it is `width: 100%`, full-width like B12's |

**R15 ④ — the header states what the view is, not only its name.** Terry's 2026-10-13 third
request (`T-20261013-165112`) was that `Waiting on me` learn the two-line head B26 already
had. The header is now a **text block plus the tally**: `.td-waiting-head-text` holds the
title over a one-line description, and `[data-waiting-count]` keeps its `margin-left: auto`
seat at the far end. The description is the round's one new string — `waiting.subtitle`
(`"Everything waiting on your answer, oldest first."` / `"所有等你答复或验收的事项，最久的排在最前。"`)
— and it says the queue's own two properties and nothing else: whose court the ball is in,
and that the longest wait reads first (B27's ordering rule, restated in the header so a
reader knows it without counting rows). It carries a `data-i18n` hook **only**, no
`data-waiting-*` of its own, exactly as B26's own subtitle does (B26.1) — so the view's
auxiliary hook set stays at its 16 names. The block computes **identically** to B26's
(`design/fidelity-r15.md` §3: `12px`, `--color-td-ink-3`, `margin-top: 2px`, and the title
above it unchanged at `16px`/`600`), and it is spelled in this view's own family names
(`.td-waiting-head-text` / `.td-waiting-sub`) per B27's rule that either header may move
without dragging the other.

**Five rows, ordered by the wait.** The queue runs oldest first, so the top row is the item
that has waited longest and the list reads as an overdue-first inbox. B26's feed is the
reverse — a chronology — and the reversal is deliberate: a queue read newest-first hides the
item that has waited five days behind the one that arrived a minute ago, which is the failure
a queue exists to prevent. `[data-waiting-since]` carries the instant on `datetime`, the row
carries it again on `data-since`, and the visible text is that instant read the way the feed
reads one — the same three `time.*` keys, and in the shipped document the text already equals
what the page would compute.

**The queue is static markup, not a render.** 5 rows, each one's actor, act, identifier,
title, preview, stamp and opener present in the document — 0 `<template>` inside the view. With the
script off the queue is complete and merely `hidden`, and the header's tally is the static
sentence it ships. This is the property R-5 states and the check measures twice: once against
the source, once in a context with JavaScript disabled.

**The identifier rule is shared, not restated.** `[data-waiting-task]` renders at most ten
characters plus `…` with the whole value on `title` — R8 ③, the rule B07's cards and B08's
rows follow. Waiting is the first surface that *proves* it without a script: `PROJ-0007` is
the board's longest identifier at nine characters, so at the ten-character cap its cell
reads `PROJ-0007` in the markup itself, whole.

**The state is an attribute with three values; the act is the chip's copy.** `[data-waiting-reason]`
carries `data-waiting-reason-kind="question" | "blocked" | "acceptance"` — those three are the
whole domain (`acceptance` is M6's ruling change, recorded in `DESIGN.md` §30.3) — while its
visible text, `[data-waiting-action]`, names what the **human does** about it: Answer /
Unblock / Accept (`waiting.action.<kind>`). Naming the state alone was the defect TP-0019
closed: 「待回答」/「待你验收」 tells a reader what the card is, not what is owed. The dot is
coloured the way every other dot on this board is coloured — an attribute rule sets
`--status-color` (`[data-waiting-reason-kind]`, declared beside the `[data-status]` and
`[data-priority]` bindings in `src/input.css`) and the component reads the variable, so no
component names a colour. Every kind reads a status token, because the state *is* the task's
own: a block, a question, or a delivery waiting on acceptance.

**The ask gets a second line.** `[data-waiting-preview]` carries what the row is asking: the
triggering comment's first sentence for a question or a block (the comment is already read for
`since`, so this costs no request), or the delivery round and acceptance count for an
acceptance row (`第 N 轮 · M 条验收项`), drawn from `delivery_round` and the frozen acceptance
list already on the list wire. The row is therefore two lines — the act and the card on the
first, the ask beneath it — and `.td-waiting-item` grows by `min-height` rather than a fixed
height so the second line has somewhere to land.

**A row opens B09.** `[data-waiting-open]` is the keyboard affordance and the row body its
pointer twin, and both land on the board's own detail surface for the task the row names —
found by the identifier the row carries. The opener is not a bare glyph: it shows the action
word and names it in the accessible name (`Answer TD-13`, never `Open TD-13`), so the press
says what it does. The queue is a way *into* a task, never a second task page; there is no
second drawer, and no anchor back to the board.

**Zero new hues.** The view's rules live in `src/input.css` beside B26's. They declare no
custom property of their own, carry no colour literal, and every `var(--…)` they read already
resolves in `tw.css` — the token registry is byte-identical to the round's base.

**B27's own consistency items.**

1. **Every item carries the identical hook set** — actor, reason (+ kind), action, identifier,
   title, preview, stamp, opener — and nothing else: the queue has no filter, no paging and no
   folding, so a row is never a special case.
2. **A row states only the instant it carries**: `[data-waiting-since]`'s `datetime` equals
   the row's `data-since`, and its visible text is that same instant.
3. **One time vocabulary**: the stamp reads `time.minutesAgo` / `time.hoursAgo` /
   `time.daysAgo` — B26's three keys, reused, with no waiting-specific time copy.
4. **One name per destination**: `waiting.title` and `nav.waiting` are byte-identical, so the
   heading over the list and the name pressed in the sidebar cannot drift apart.
5. **Three reason kinds, all present**: the domain is `question | blocked | acceptance`; the
   shipped queue carries `question` and `acceptance`, and `blocked` is the prototype's third
   reading (no producer in the current data domain).

**Auxiliary hooks** (implementation detail, not part of the block contract), the full
`data-waiting-*` set the document carries — 16 names, no more:
`[data-waiting-view]` · `[data-waiting-head]` · `[data-waiting-title]` ·
`[data-waiting-count]` · `[data-waiting-list]` · `[data-waiting-item]` ·
`[data-waiting-actor]` · `[data-waiting-reason]` / `[data-waiting-reason-kind]` ·
`[data-waiting-action]` · `[data-waiting-task]` · `[data-waiting-task-title]` ·
`[data-waiting-preview]` · `[data-waiting-since]` ·
`[data-waiting-open]` · `[data-waiting-empty]`. Each row also carries two carriers outside
the family: `data-task` (the task's human identifier — the same name B26's rows use) and
`data-since` (the row's own instant), plus `data-assignee-kind` on the actor, which is the
board's one identity model (B03 / consistency item 7).

---

## Floating controls — the light-dismiss rule (R9)

Not a block: a rule two blocks share, so it sits here beside the other cross-cutting
sections rather than inside either. One attribute, one handler, one Escape branch — a
`<details class="dropdown">` that has to give way when the press lands somewhere else
carries **`data-dismiss-on-outside`**; nothing else about it is special, so a third
dropdown joins by carrying the attribute.

| | |
|---|---|
| Hook | `[data-dismiss-on-outside]` — no class name is part of this rule |
| Members | `[data-project-switcher]` (B02) · `[data-filter-label]` (B04) · `[data-filter-status]` (B04, R11) |
| Outside press | a press whose target is not a descendant closes every member that is `[open]` |
| `Esc` | closes every member that is `[open]`, alongside the drawer, the states showcase and the access panel |
| Single open | opening a member closes the other; the two menus never overlap |
| Untouched | the floating card menus (`[data-move-menu]`, `[data-card-menu]`), the language menu (B03), and the B22/B24/B25 roster menus keep their own dismiss rules — they float from a trigger that is not a `<details>`, so they are not members of this rule |

`<summary>` is the trigger: a press on it is *inside* its own `<details>`, which is what
keeps the toggle working while everything else closes.

---

## Assignee model

The board belongs to an AI-agent team, so the assignee pool is the six agent roles
plus the human owner. Nothing else appears as an assignee, comment author or activity
actor.

| Member | Kind | Platform | Cards |
|---|---|---|---|
| `elon` | agent | `openclaw` | TD-131, TD-124, TD-118 |
| `jobs` | agent | `claude` | TD-125, TD-121 |
| `linus` | agent | `claude` | TD-128, TD-123, TD-115 |
| `turing` | agent | `codex` | TD-129, TD-134, TD-127 |
| `simons` | agent | `claude` | TD-130, TD-117 |
| `assistant` | agent | `pi` | TD-133, TD-119 |
| `Terry` | human | — | TD-126, TD-112, TD-122 (owner, reporter of all 18) |

Every card carries `data-reporter="Terry"`: the owner files the task, an agent works
it. The drawer shows Assignee (with the platform badge for agents) and Reporter as
separate properties, and the lifecycle shows up again in the activity feed
(`Terry created this task`, `<role> claimed the task`).

**Since R3 this table is also the assignee roster's seed** (B22): the seven handles above
are what the autocomplete offers, with the same kinds and platforms. The reporter roster is
not declared — it is read off the cards' `data-reporter` at first pass, which today yields
`Terry` alone. Neither roster is editable from the interface; both grow by being used.

---

## Auxiliary hooks (implementation detail, not part of §4)

| Hook | Purpose |
|---|---|
| `[data-move-menu]` → `[data-move-to="status"]` | the single shared "Move to" menu reused by every card (I2 fallback for drag) |
| `[data-lang-menu]` → `[data-lang-option="en" \| "zh"]` | the language dropdown, floating at the end of the document for the same reason (the sidebar clips absolute children) |
| `[data-drop-placeholder]` | transient placeholder bar created during `dragover` |
| `[data-states-overlay]` / `[data-access-overlay]` | scrims behind B18 and B19 — the only two surfaces left that have one |
| `template[data-toast-template]` / `template[data-list-row-template]` / `template[data-detail-for]` | inert markup sources for the interaction layer |
| `[data-detail-slot-source]` | transient wrapper jQuery builds while copying a template into the drawer |
| `[data-label="…"]` | one chip per card label |
| `[data-filter-label-summary]` | the label dropdown's trigger text, restated from `data-filter-label-value`; rendered flat (R9 — see B04) |
| `data-filter-status-value` | on `[data-filter-status]`: `"all"` or a comma-joined subset of the seven first-class status keys — the one place the status selection is written (R11 — see B04) |
| `[data-filter-status-summary]` → `[data-filter-status-text]` | the status dropdown's trigger and its mutable text leaf; the text is restated from `data-filter-status-value` and reads `Status: All` / `Status: <Label>` / `Status: <first> +<n-1>` (R11 — see B04) |
| `[data-filter-status-option]` + `data-status-value` | one menu row per status (`all` first, then the seven keys); the rows are also the filter's value domain, which the script reads rather than restating (R11 — see B04) |
| `[data-agent-assignee]` | on each roster name's `<button>` in B03 (with `data-assignee` + `data-assignee-kind`): pressing it writes that name into `[data-filter-assignee]` and nothing else (R13 修订 — see B03) |
| `[data-dismiss-on-outside]` | on a `<details class="dropdown">`: a press outside it, or `Esc`, closes it (R9 — see *Floating controls*) |
| `data-list-state` | on `[data-list]`: `loading` \| `data`, the list's two mutually exclusive states (R9 — see B08/B13) |
| `data-board-state` | on `[data-board-view]`: `data` \| `empty`, the **board view's** two mutually exclusive states — the R9 list idiom applied to the board (R10 — see B05/B12) |
| `[data-detail-save]` · `data-save-state` | in the drawer: `idle` \| `saving` \| `saved` \| `error` for the three auto-saving fields; an attribute carrier with no copy of its own (R10 — see B09) |
| `[data-detail-save-error]` | the visible half of that state: `role="alert"`, `hidden` in every state but `error` (R10 — see B09) |
| `data-detail-save-field` | on each editable row root: `assignee` \| `reporter` \| `labels`, so a state can be attributed to a row without a second lookup (R10 — see B09) |
| `[data-column-progress]` | the occupancy bar under each column head |
| `[data-cidr-enabled]` | the allow-list section's on/off state, written by `[data-cidr-switch]` |
| `data-assignee-value` / `data-reporter-value` | the name a roster option carries, read by `comboAccept()` |
| `data-label-value` / `data-detail-label-value` | the name a label option **and** a label chip carry (B25), in the create dialog and the drawer respectively; `[data-label-remove]` / `[data-detail-label-remove]` drops the chip |
| `[data-combo-new]` | marks the generated row that offers a name the roster does not hold yet |
| `[data-activity-*]` | **B26**'s own family — its 35 hooks are listed in that block's section rather than repeated here |
| `[data-waiting-*]` | **B27**'s own family — its 16 hooks are listed in that block's section rather than repeated here |
| `[data-nav-count]` | on B03's `activity` nav item: the unread count, `hidden` at zero (R12x — see B03) |

---

## i18n hooks

English is the default language; the `中文` option in the **language menu** switches to
Chinese (DESIGN.md §13). Five attributes carry the keys, on every piece of user-visible
copy:

| Hook | Sets |
|---|---|
| `data-i18n` | the element's text |
| `data-i18n-placeholder` | `placeholder` |
| `data-i18n-aria-label` | `aria-label` |
| `data-i18n-title` | `title` |
| `data-i18n-arg` | the `%s` value for any of the four above; it is resolved as a key first, so `column.add` + `status.todo` reads `Add task to To Do` / `在待办中新建任务` |

The catalogue is the in-memory `MESSAGES` object at the top of `app.js` — **282 keys per
language, mirrored 1:1** (verified by set equality, not by eye), never an external file.
Copy `app.js` composes at runtime (toast sentences, list rows, card aria labels, the token
mask) is keyed there too.

**R17 spends exactly one key — `waiting.empty.hint`** (`280 → 281` in each language, `+1`
`data-i18n` seat in the document: `625 → 626`). It is the second line B27.3 was missing (see
B27.3 below); nothing else in the catalogue moves. The mirror copies in `test/**` and `web/**`
are the implementing card's, so at this build they lag the prototype by two names
(`waiting.subtitle` from R15 and this one) while still carrying the two the prototype has
retired (`assignee.clear`, `activity.filter.reset`) — the same intermediate state R15's own
U2 records, and the reason the design-side key count is the one this file states.

**R14 names the third relation kind — `relations.related`** (`281 → 282` in each language;
**no** `data-i18n` seat moves, because the drawer's three `Related` labels are inline and
unhooked — see B09). Unlike R17's round, this one syncs its mirrors **in the same commit**
(`test/web/i18n.catalogue.mjs`, `web/src/i18n/catalogue.mjs`, `STALE_PROSE_COUNTS`,
`design/prototype/README.md` all read 282), so the lag R17 records above is that round's
state, not this build's.

**B27 brought 6 more (R12x)** — `waiting.title` · `waiting.count` · `waiting.reason.question`
· `waiting.reason.blocked` · `waiting.open` · `waiting.empty` — and they are the whole of what
the waiting view reads, apart from the three `time.*` keys it reuses from B26's own round.
`waiting.title` is deliberately the same words as `nav.waiting`: one name for the destination
and the heading over the list.

**B26 brought 50 of those names in (R12x)** — 49 `activity.*` plus `time.minutesAgo` — and
they are the only catalogue the activity view reads: `design/activity/prototype.html`'s
page-local `<script type="application/json" data-activity-i18n>` carrier is **not** part of
the board's document (R-3 — one mechanism per document, or the two drift page by page).
Names the document already held (`nav.*`, `status.*`, `drawer.*`, `time.hoursAgo`,
`time.daysAgo`) are reused rather than restated. The three B09 keys that look adjacent —
`activity.created` / `activity.claimed` / `activity.commented` — keep their sentences: they
serve the drawer's own stream, and the feed reads its verbs from the new `activity.verb.*`
family instead.

Every string the v1.4 footer introduces is in that catalogue:

| Keys | Where |
|---|---|
| `access.theme.aria` | the theme cell's `aria-label` / `title`, one `%s`-template filling in the state in force and the state one press reaches (`applyTheme`) — `Theme: Light. Activate for Dark.` |
| `access.theme.light` · `access.theme.dark` · `access.theme.auto` | the current-value text in the theme cell, **and** the two state names the `access.theme.aria` template fills in (`applyTheme`) |
| `access.lang.open` · `access.lang.group` | the trigger's `aria-label` / `title` and the menu's own label |
| `access.lang.en` · `access.lang.zh` | the two `[data-lang-option]` rows — each language names itself (`English` / `中文`) in both catalogues |
| `access.lang.short.en` · `access.lang.short.zh` | the current-value text in the language trigger (`applyLanguageOptions`) — `EN` / `中文` |
| `toast.themeDark` · `toast.themeLight` · `toast.themeAuto` · `toast.langEn` · `toast.langZh` | what the theme cycle and the language menu report when they act — one toast per mode, plus one per language |

The settings cell needs no key for a label: it has none. Its accessible name is
`access.open`, the same key the panel's own opener always used.

The rewritten B19 carries `access.model.bind` · `access.cidr.note` · `access.cidr.add` ·
`access.cidr.remove` · `access.cidr.value` · `access.model.token`, and since R3 also
`access.cidr.enabled` / `access.cidr.disabled` for the allow-list switch. Rows the whitelist
adds at runtime are authored with the same `data-i18n-aria-label` / `data-i18n-title`
hooks, so the next language switch translates them like any seeded row.

The v1.2 keys the retired switches used (`access.theme` / `access.lang` as switch labels,
`access.lang.en` / `access.lang.zh` as segments, `theme.switchToDark` /
`theme.switchToLight`) are **gone from both dictionaries**, as are the v1.3 dialog keys
(`access.theme.open` · `access.theme.title` · `access.theme.group` · `access.theme.close` ·
`access.lang.title` · `access.lang.close` · `access.settings`) — nothing references any of
them, so the catalogue carries no copy for a surface that no longer exists.

`<html lang>` follows the pick (`en` / `zh-CN`), the `[data-lang-option]` rows move
their `aria-pressed`, and the drawer body — which arrives from an inert `<template>` that
the document-wide pass cannot reach — is translated again when it lands. A language
switch also re-derives everything `app.js` owns, so an open drawer, the list view, the
footer cell and the result counter all change language in place.

Per-column empty-state hints and add-button labels share **one** key pair each and take
their status name through `data-i18n-arg` (`status.backlog`, …) rather than fourteen
separate keys.

**R3 adds thirteen keys**, all mirrored:

| Keys | Where |
|---|---|
| `createTask.field.reporter` | the Reporter field label in B10 |
| `combo.assigneePlaceholder` · `combo.reporterPlaceholder` · `combo.hint` | the two roster controls' placeholder and `title` (B22) |
| `combo.empty` · `combo.new` | what the roster menu says when nothing matches, and the `· new` marker on a name the roster does not hold |
| `md.label` · `md.write` · `md.preview` · `md.split` · `md.hint` | the Markdown editor's mode tabs and its hint (B23) |
| `access.cidr.enabled` · `access.cidr.disabled` | the allow-list switch's two toasts (B19) |

**R4 adds nine keys**, all mirrored:

| Keys | Where |
|---|---|
| `createTask.field.parent` · `createTask.field.parentHint` | the Parent field's label and hint (B24) |
| `createTask.field.depends` · `createTask.field.dependsHint` | the Depends-on field's label and hint (B24) |
| `createTask.optional` | the `Optional` chip beside both relation labels (B10 / B24) |
| `combo.parentPlaceholder` · `combo.dependsPlaceholder` | the two relation inputs' placeholders (B24) |
| `combo.taskHint` · `combo.clear` | the relation inputs' `title`, and the parent clear button's label (B24) |
| `combo.noTasks` | what a relation menu says when the project has no matching task (B24) |

**R5 adds five keys**, all mirrored:

| Keys | Where |
|---|---|
| `createTask.field.labels` · `createTask.field.labelsHint` | the Labels field's label and hint (B25) |
| `combo.labelsPlaceholder` | the label input's placeholder (B25) |
| `combo.noLabels` | what the label menu says when every label it holds is already chosen (B25) |
| `prop.labels` | the drawer's Labels property name (B09 / B25) |

The label field reuses `createTask.optional` for its `Optional` chip and `combo.new` for
the `· new` marker, exactly as B22 and B24 do, so R5 introduces no copy for either.

**R8 adds five keys**, all mirrored:

| Keys | Where |
|---|---|
| `list.columns.title` · `list.columns.status` · `list.columns.assignee` · `list.columns.priority` · `list.columns.revision` | the list header's five new column labels (B08) — `Title` / `标题` · `Status` / `状态` · `Assignee` / `负责人` · `Priority` / `优先级` · `Revision` / `版本` — completing the set `list.columns.identifier` opened |

They name **columns**, so they live under the same `list.columns.*` family as the one
key the header already had; nothing else in the catalogue moves. The header reads them
with the ordinary `data-i18n` hook, so a language switch re-labels all six columns in
place like every other surface.

---

## Consistency items ("一致项")

1. **Every card** carries the identical hook set — a filter, drag or drawer code
   path never needs to special-case a card.
2. **Every column** carries the identical hook set and the identical empty-state block.
3. **Colour is never inline**: components read `--status-color` / `--pri-color`,
   which are set by `[data-status]` / `[data-priority]` attribute rules in
   `src/input.css`. Moving a card updates one attribute and the stripe, the dot and
   the chips follow.
4. **Mono discipline**: every identifier, internal id, session id, version, count,
   timestamp and agent role handle uses `.td-mono` with tabular numerals.
5. **Ids in the document** are unique and only used for `label[for]` /
   `aria-labelledby` / `aria-controls` — never as a styling hook.
6. **No block is hidden by the stylesheet**: `board ↔ list`, drawer, modals, the
   states gallery and the access panel are toggled by the `hidden` attribute or
   `data-state`, so the static document is readable with JavaScript disabled.
7. **One identity model** everywhere: `data-assignee` is always a role handle from
   the table above, `data-assignee-kind` always separates agent from human, and
   `data-agent-platform` always names one of claude / openclaw / codex / pi.
8. **No brand value is hard-coded.** Every component reads `--color-td-*` through
   `--status-color` / `--pri-color`, or takes its shell from daisyUI and its face
   from a token override. A scan for six-digit hex in `src/input.css` returns the
   token block and nothing else, and the only literals left in the markup are the
   two `--color-td-*` references inside the Sentinel Watch mark and its favicon.
9. **Every daisyUI component keeps its hook name.** An element may gain
   `badge` / `avatar` / `tabs` / `progress` / `toggle` / `select` classes, but the
   `data-*` attribute it answers to never moves — which is what let R3 re-shell
   eight components without touching one line of the interaction layer's bindings.
10. **The label control is the roster control, not a parallel one.** It shares
   `comboAccept()`/`makeRoster()` with assignee and reporter, so the `· new` row, the
   upsert-on-use behaviour and the case-insensitive normalisation are the *same code*
   — its hooks are its own (`data-label-*`, one set, no reuse of the assignee or
   relation hooks), and its roster is read off the cards rather than declared, so it
   cannot drift from what the board carries. No block, and no hook, offers to add,
   rename or delete a label.

---

## R17 · The empty-state family reads B12

Terry's 2026-10-13 request (`T-20261013-184102-2`, 需求 E). Measured before this round:
board B12's no-results state opened on the brand mark with a title, a hint and a **Clear
filters** button, while the activity view's two states and the waiting view's one had **no
mark** at all, the waiting state had **only a title**, and all three sat vertically centred
in their containers. This round makes them read the way B12 does, and decides — which none
of them had — *which* empty states carry a clear control.

### The matrix

| View | State | Reachable when | `title` | `hint` | Button |
|---|---|---|---|---|---|
| board (B12) | `no-results` | a filter is in force and nothing survives it | `noResults.title` | `noResults.hint` | `[data-filter-clear]` · `noResults.clear` |
| activity | `project` | the project has no entries and **no filter** is in force | `activity.empty.project.title` | `activity.empty.project.hint` | **none** |
| activity | `filter` | a filter is in force and nothing survives it | `activity.empty.filter.title` | `activity.empty.filter.hint` | `[data-activity-empty-reset]` · `activity.empty.filter.reset` |
| waiting | `queue-empty` | the queue is empty | `waiting.empty` | **`waiting.empty.hint`** (new, R17) | **none** |

### The three decisions, and why

- **The project state gets no button.** Its definition is "nothing has happened and no filter
  is narrowing anything". A *Clear filters* control there would point at a filter that is not
  in force — pressing it would do nothing, which is the definition of a dead control. B12
  earns its Clear because its state is the *other* one: a filter really is in force
  (`shown === 0` under a filter). So `project` = title + hint, and the pair is what tells the
  two states apart.
- **The filter state keeps the button it already had.** `[data-activity-empty-reset]` /
  `activity.empty.filter.reset` is the inline affordance R15 ③ explicitly left standing when
  the bar's own *Reset* became B04's Clear (`[data-filter-clear]` / `filters.clear`): one
  control family, two bars, and a second affordance in a second place. This round changes
  neither its hook nor its key — it only confirms the matrix line that says the filter state
  is the one that has a button.
- **The waiting state gets a second line.** It carried one line where the family carries two,
  so a reader learnt what was *not* there without learning what would be. `waiting.empty.hint`
  names the three reasons the queue collects (blocked / in review / handed off) and stops —
  this view has no filters, so it promises no control.

### What every state in the family now shares

- The brand mark first: `svg.td-logo.td-logo-lg` — 28×28, the two lead meerkats at
  `--color-td-ink-3` and the on-duty sentinel plus its watch signal at `--color-td-accent`.
  No new size and no new colour; the mark is the same one B12 draws.
- **Each mask id is unique in its own document** — the mark's face knockout is `<mask id>` and
  a repeated id silently re-points every reference at the last one declared. The four *large*
  marks are `face-knockout-a-lg` (B12) · `-b-lg` (activity project) · `-c-lg` (activity filter)
  · `-d-lg` (waiting), in the document each belongs to.
- The `.td-empty-lg` size, so the title and hint land at 14px / 12px and the gap at 12px on
  every one of them (B12's own copy is unchanged).
- The block stands at the **top** of its container. `.td-activity-empty` loses
  `margin: auto 12px` for `margin: 0 12px`, and `.td-waiting-empty` loses
  `align-self: center` + `margin: auto 0` for `margin: 0 auto` — R17 kept a 100% / 420px cap
  there, because it is the only box in the main area and a dashed rule stretched across
  1300px is the shape of a drop target, not of an answer. **That cap is withdrawn
  (2026-10-15):** the waiting block is `flex: none` + `width: 100%` like B12's, since the
  queue's own header and rows span the view and the box standing in for them has to span it
  too. Nothing else about either rule moves.

The activity view's own design page (`design/activity/`) carries the same two states and the
same rules in its scoped `<style>`; it is edited in step, and its machine check —
`node design/activity/check-activity.mjs`, 209 assertions — is the round's regression gate.
(R17 landed it at 194; T-20261013-184456 aligned the page's filter bar to R15 ①/③ and added
the family's 15 assertions — `S1.5`–`S1.8b`, `R7.0`, `R2.4a`–`R2.4c`, `R2.10a`–`R2.12`.)

**"At the top" is read after layout, not off the declaration.** R17's third decision is a
*layout* fact, and the check now measures it as one: `flow-gap` (the container is given 240px
more height and the block must not move — a device that splits free space, `margin: auto` or a
container's `justify-content: center`, moves it by half that) and `not-v-centred` (there must
be decisively more free space below the block than above it — the reading that catches a *fixed*
post-layout offset, which the flow-gap probe cannot see), plus `under-header` for B27.3's state,
whose flow's first stop is the queue's header. All three are read from `getBoundingClientRect`,
over all three states at all five widths, on the board document and once on the activity one.
The declaration guards (`S11.7`–`S11.9`) stay, but only as what they are: they read one rule
body's text, so they cannot see a centring that arrives from another rule. Why the declaration
could not carry this claim — `getComputedStyle` resolves an auto margin to its used px value, so
a re-centred block still reports `marginTop !== "auto"` — and the measured negative runs are in
`design/activity/DESIGN-activity.md` §11.1.
