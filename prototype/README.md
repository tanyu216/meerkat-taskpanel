# TaskDashboard — v1 high-fidelity prototype

A static, self-contained HTML prototype of the TaskDashboard board for an AI-agent
team. It is the executable design baseline: tokens, block structure and interaction
behaviour all come from `design-style-guide.md` + `design-spec.md`, with every
disagreement between the two recorded in [DESIGN.md §9](DESIGN.md#9-reconciliation--where-the-two-source-documents-disagree).

**Stack is closed: Tailwind CSS + daisyUI + jQuery (slim). No other CSS/UI/JS library,
no CDN, no webfont, no network call, no storage.**

---

## Open it

```sh
open prototype/index.html      # plain file:// — no server, no build step needed
```

`index.html` is complete without JavaScript: the top bar, sidebar, filters, all seven
columns, all eighteen cards and the legend are static markup. The drawer and the two
modals are secondary surfaces and stay hidden until opened.

---

## File map

| Path | What it is |
|---|---|
| `index.html` | the prototype — every block as static HTML with `data-*` hooks |
| `tw.css` | **build output** (Tailwind + daisyUI compiled). Do not edit by hand. |
| `src/input.css` | the Tailwind build entry: `@theme` tokens, daisyUI themes, app components |
| `app.js` | the jQuery (slim) interaction layer — interactions I1–I12 |
| `vendor/jquery.slim.min.js` | jQuery 3.7.1 **slim** build, vendored locally |
| `DESIGN.md` | the design specification: tokens, type, spacing, states, a11y, reconciliation |
| `BLOCKS.md` | the block inventory B01–B16 with every `data-*` hook |
| `screenshots/` | capture set (board, wide board, drawer, dark, list, menu, filters, empty, modal, 5 viewports) |
| `package.json` | declared devDependencies + `build:css` script |
| `.gitignore` | keeps `node_modules/` out of the repository |

`design-spec.md` §0 names these files `assets/tw.css`, `assets/app.js`,
`assets/vendor/jquery.min.js` and `src.css`. The task card for this build fixed a
flatter layout (`tw.css`, `app.js`, `vendor/…`, `src/input.css`), which is what is
shipped; the contents are the same. `index.html` references every asset by relative
path, so the directory stays portable.

---

## Build

`tw.css` is generated from `src/input.css`. **`node_modules` must never live inside
`prototype/`** — install the toolchain in the temporary build directory instead and
expose it to Tailwind only for the duration of the build:

```sh
BUILD=/Users/tanyu/.openclaw/team/workspace/T-20261008-200429-taskboardproto/twbuild
PROTO=/Users/tanyu/Documents/task-dashboard/prototype

cd "$BUILD" && npm install            # tailwindcss, @tailwindcss/cli, daisyui, jquery

# Tailwind resolves `@import "tailwindcss"` relative to the input CSS file, so the
# toolchain is bridged with a transient symlink that is removed again right after.
ln -sfn "$BUILD/node_modules" "$PROTO/node_modules"
cd "$PROTO" && "$BUILD/node_modules/.bin/tailwindcss" -i src/input.css -o tw.css
rm -f "$PROTO/node_modules"
```

`prototype/package.json` also carries the canonical `npm run build:css` for a normal
checkout where `node_modules` is allowed to sit next to the sources.

Two `@source` directives limit class scanning to `index.html` and `app.js`
(`@import "tailwindcss" source(none)` disables auto-detection, so nothing else on
disk can leak classes into the bundle). Current output: **123 KB**.

### One cascade detail worth knowing

daisyUI 5 emits its component CSS into nested sub-layers of `@layer utilities`, and
the style guide's token blocks in `src/input.css` are unlayered. Two consequences:

- app components are declared **directly** in `@layer utilities` (after the daisyUI
  plugin), so they outrank daisyUI components even at lower specificity — this is what
  makes `.btn { height: 32px }` and `.modal { background-color: var(--scrim) }` win;
- token overrides that must beat the unlayered `:root` block (the `≤559px` rail width)
  are themselves declared unlayered. Moving them into a layer silently breaks them.

---

## Interaction map (all jQuery, all `data-*` hooks)

| # | Interaction | Trigger | Hook |
|---|---|---|---|
| I1 | Drag a card to change status | `dragstart` / `dragover` / `dragleave` / `drop` | `[data-card]`, `[data-column-body]` |
| I2 | Card menu → "Move to" (keyboard/no-mouse fallback) | click on the kebab | `[data-card-menu]` → `[data-move-menu]` → `[data-move-to]` |
| I3 | Open the detail drawer | click anywhere on a card, or `Enter` on its title | `[data-card]` → `[data-detail-drawer]` |
| I4 | Close the drawer | close button / scrim / `Esc` | `[data-detail-close]`, `[data-detail-overlay]` |
| I5 | Post a comment | form submit | `[data-comment-form]`, `[data-comment-input]` |
| I6 | Filter + search (150 ms debounce) | input / change / clear | `[data-search-input]`, `[data-filter-*]`, `[data-filter-clear]` |
| I7 | Board ↔ list view | segmented control and sidebar nav | `[data-view-toggle]` → `[data-view]` |
| I8 | Switch project | project switcher or sidebar list | `[data-project-option]`, `[data-project]` |
| I9 | Create a task | `New task` or a column `+` (prefills that status) | `[data-new-task]`, `[data-column-add]` |
| I10 | Create a project | switcher → `New project…` | `[data-project-new]` |
| I11 | Light/dark theme | theme button | `[data-theme-toggle]` |
| I12 | Toast feedback | every mutation | `[data-toast-region]`, `[data-toast]` |

Mutations that change board state (move, comment, create) also advance the
`rev` counter in the top bar — the prototype's stand-in for the concurrent-write
revision stream.

**jQuery discipline.** Every event is bound with `$(...).on(...)` against a `data-*`
hook. There is no `document.querySelector` and no `addEventListener` anywhere. Four
native calls remain because jQuery cannot express them; each carries an inline
comment explaining why:

- `el.showModal()` / `el.close()` — the native `<dialog>` API;
- `document.createElement` + `select()` + `document.execCommand("copy")` — clipboard writes need the Selection API;
- `$form[0].reset()` — jQuery can dispatch a `reset` event but cannot perform one.

---

## Purity

The prototype is inert: it performs no network I/O of any kind — no transport call,
no HTTP client wrapper, no REST endpoint path — and it reads and writes no device
storage, carries no id or access tokens, holds no backend logic, and loads nothing
from a CDN, an external font or a remote image. Every asset is a relative path next
to `index.html`.

jQuery is the **slim** build precisely so the transport layer is absent from the
bundle: the vendored file contains **zero** transport references, and a vendored
`$.ajax`, `$.get` or `$.post` therefore does not exist to call. The interaction layer
can only ever touch the DOM it was given.

The same rule holds for the *words*, not just the code: the prose above is written
without the banned identifiers so that a plain text scan of `prototype/**` comes back
empty on every one of them, including these documents.

---

## Coverage (design-spec §7)

| Dimension | Where |
|---|---|
| 7 statuses | 7 columns, ≥1 card each, plus the legend |
| 5 priorities | every level appears on a card, plus the legend |
| Ownership | 11 human cards + 7 agent cards across claude / openclaw / codex / pi |
| Dual id | human identifier on the card (mono) + internal `td_…` id in the drawer (copyable) |
| Concurrency | `v3`-style version in the drawer + `rev 128` with a live pulse in the top bar |
| Relations | `↑` parent / `→|` blocks / `🔗`-shaped related counters on cards, spelled out in the drawer |
| Comments | human author, agent author and a `decision`-styled comment |
| Activity | 4+ entries per task (created / claimed / status change / commented) |
| Attachments | ≥2 per sampled task |
| Empty states | empty column + no-results |
| Loading | 3 shimmer rows in the list view |
| Themes | light (default) and dark |
| Viewports | 1512 / 1240 / 980 / 760 / 500 — no page-level horizontal overflow |

The board is the only horizontal scroll container; `html`, `body` and `main` never
scroll sideways. Below 1023px the sidebar collapses to an icon rail, below 760px the
top bar wraps and the drawer goes full width.

---

## Screenshots

| File | State |
|---|---|
| `01-board-1512.png` | default board (TaskDashboard project, 12 of 18 cards) |
| `02-board-wide.png` | full 7-column board at 2600px — status coverage proof |
| `03-drawer-agent.png` | drawer for an agent task: session block + GFM description |
| `04-drawer-human.png` | drawer for a human task |
| `05-dark-theme.png` | dark theme |
| `06-list-view.png` | list view with the skeleton rows |
| `07-move-menu.png` | the shared "Move to" menu |
| `08-filters-agent.png` | assignee filter = Agent |
| `09-no-results.png` | no-results empty state |
| `10-create-task-modal.png` | create-task modal |
| `11…14-viewport-*.png` | 1240 / 980 / 760 / 500 |
| `15-no-javascript.png` | the same document with both `<script>` tags removed — proof that the core structure survives without JavaScript (all 18 cards visible, because the project filter is the only thing JS removes) |

Captured with headless Chrome at device-scale-factor 1 with transitions disabled so
the frames are deterministic; `index.html` itself is untouched.

The state shots are driven through the real handlers — the capture page appends a
line that triggers the same `data-*` hooks a click would, so what is captured is
what the prototype actually does, not a hand-styled mock. (Those one-line capture
scripts live in the temporary build directory, never in `prototype/`.)

**On the 430px case:** headless Chrome refuses a window narrower than ~500px, so the
narrowest capture is 500px. That is the same CSS path — everything below 559px
collapses the rail to 56px, keeps the board as the only horizontal scroller and makes
the drawer full width — and the assertion for the 430px column of the §7 matrix is
that no *page-level* horizontal overflow exists, which `hOverflow=false` confirms at
every width tested.

---

## Notes and known limits

- **Project scoping.** The switcher and the sidebar filter the board by
  `data-project`; TaskDashboard (12 cards) is the default, so the default board shows
  12 of the 18 cards. All 18 are in the document, and `02-board-wide-2400.png` shows
  the full set — switch to a project with no cards to see the empty-column states.
- **Comment lists are representative.** A card's `data-comments` number is the total
  count; the drawer renders a sample of the thread rather than the whole count.
- **The drawer's session block is read-only.** `Resume` is wired to a toast — the
  prototype has no transport to resume anything with, by design.
- **The activity nav item** reports the current revision and task count instead of
  opening a fifth surface, which the block inventory does not define.
- **Dark theme values** come from `design-spec.md` §2.2 because the style guide
  defines no dark palette; status and priority keep one value in both themes.
