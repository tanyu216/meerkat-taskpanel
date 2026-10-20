/**
 * The board's machine-checkable block contract.
 *
 * Transcribed **once, by hand** from `design/BLOCKS.md` (B01–B25 plus the ten
 * "consistency items" C01–C10). This file is the single source of assertion data for
 * the frontend; `design/BLOCKS.md` remains the design's prose authority, it is
 * never parsed, and `design/prototype/**` is never edited from here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS NEVER QUOTE THE PROSE COUNTS (the header-count discrepancy)
 * ---------------------------------------------------------------------------
 * The BLOCKS.md *header* is stale; the *body* is authoritative. Measured against
 * `design/prototype/index.html` and `design/prototype/app.js` (host-side static
 * counting — no browser, no network), re-measured 2026-10-12 after the prototype grew
 * its fourth nav item, the `nav.waiting` key and R8's six-column list header (five
 * `list.columns.*` keys, one `data-i18n` seat each):
 *
 *   header claims                             measured
 *   252 `data-i18n*` hooks in the document     612 (395 `data-i18n` + 144 `-arg`
 *                                                  + 47 `-aria-label` + 8 `-placeholder`
 *                                                  + 18 `-title`)
 *   198 catalogue keys                         en = 220, zh = 220 (exact parity;
 *                                              the body's "220 keys per language,
 *                                              mirrored 1:1" is the correct number)
 *   7 columns · 18 cards · 18 templates        7 / 18 / 18 — the one header line that
 *                                              does agree with the DOM
 *
 * So a rule that quoted "198" or "252" would be wrong on day one, and a rule that
 * quoted "18 cards" would encode a demo fixture as a contract. Every count/order in
 * this file is therefore either (a) a **domain-fixed multiplicity** that any correct
 * implementation has (7 statuses ⇒ 7 columns, 3 nav items, 2 views, 2 languages,
 * 3 editor modes), (b) a **relation between counts** captured by the rule kind itself
 * (never restated as a number here), or (c) deliberately **not asserted** and recorded
 * as a `manual` note. Fixture-derived multiplicities (how many cards, projects,
 * roster rows or inert seed rows the demo happens to ship) are never assertions.
 *
 * The stale claims are also exported as data (`STALE_PROSE_COUNTS`) so the test suite
 * can prove none of them leaked into a rule — and re-measures every recorded number
 * against the two documents rather than against a copy of itself.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 * Every block is `{ id, root, scope, status, required, states, rules }`:
 *
 *   id        `B01`…`B25`, `C01`…`C10` (unique, continuous within each series)
 *   root      the block's anchoring `data-*` hook selector, or `null` when the block
 *             has no element of its own (the retired B20/B21, and the C-items)
 *   scope     one of `SCOPES` — where the block lives
 *   status    `active` | `prototype-only` | `retired` — see below
 *   required  hooks the block owns; normally present in its markup. May be empty.
 *   states    hooks the block owns that are volatile (runtime-created or toggled), so
 *             they are part of the contract but may be absent at rest. May be empty.
 *   rules     the assertions, as data — see `RULE_KINDS` below. This is the ONLY
 *             place numbers live; nothing outside `rules` carries a count.
 *
 * ---------------------------------------------------------------------------
 * PROTOTYPE-ONLY BLOCKS (`prototype-only`)
 * ---------------------------------------------------------------------------
 * Three statuses, and the difference between the last two is the difference
 * between "the design shipped it and it left" and "the design showed it and the
 * product never wanted it":
 *
 *   active          part of the shipped implementation. Its hooks must exist in
 *                   the built app and its rules are evaluated against the page.
 *   prototype-only  transcribed from `design/BLOCKS.md` because the design
 *                   baseline still holds it, but deliberately **not** part of
 *                   the implementation. Its `root`/`required`/`states`/`rules`
 *                   stay declared — the transcription remains complete and
 *                   reviewable — but the implementation-side checks ignore the
 *                   block: `IMPLEMENTED_CONTRACT_ITEMS` and
 *                   `implementationSelectors()` are the views the trusted-bundle
 *                   literal scan (`blocks.bundle.test.mjs`) and the DOM harness
 *                   (`web/scripts/dom-smoke.mjs`) consume.
 *   retired         removed, and the contract asserts its *absence* (B20/B21).
 *
 * Today `prototype-only` is B15 (the sidebar legend) and B18 (the states
 * gallery): Terry's ruling of 2026-10-12 — both are product-design
 * demonstrations rather than functional requirements, so the shipped app renders
 * neither and `design/prototype/**` keeps both. B03's own surface drops the
 * `[data-states-open]` opener that belonged to B18, and B17 (the error state)
 * leaves B18 for the board's real error surface rather than being dropped.
 *
 * Selectors are **semantic `data-*` hooks, never Tailwind classes and never
 * positional anchors** — BLOCKS.md's own rule. `parseHookSelector()` enforces the
 * grammar: an optional bare tag followed by one or more `[attr]` / `[attr="value"]`
 * compounds, at least one of which is `data-*`. Class (`.`), id (`#`) and descendant
 * combinators therefore cannot be expressed at all. Containment is expressed with a
 * rule's `within` field (an ancestor hook) rather than a descendant combinator.
 *
 * This module is pure data + pure functions: no I/O, no DOM, no browser, no globals,
 * and importing it must print nothing (the suite checks that in a child process).
 * The DOM layer is a *separate* export — see `BROWSER_LAYER_RULES`.
 */

/** Provenance, for reports. */
export const CONTRACT_SOURCE = "design/BLOCKS.md";

/** Where a block lives. */
export const SCOPES = Object.freeze([
  "shell", // chrome that is always on screen: top bar, sidebar, toasts
  "board", // the kanban + list + their filters, empty/loading and error states
  "detail", // the task detail drawer
  "create", // the two creation dialogs and the controls they embed
  "review", // prototype review surfaces (states gallery, access panel)
  "global", // cross-cutting consistency items
  "retired", // removed blocks, kept in the inventory so their absence is asserted
]);

/**
 * A block that the design baseline keeps but the shipped implementation
 * deliberately does not render. Its metadata and rules stay declared (the
 * transcription of `design/BLOCKS.md` remains complete) while every
 * *implementation-side* check skips it — see the module header.
 */
export const PROTOTYPE_ONLY_STATUS = "prototype-only";

/** Enumerated value domains. Attribute values only — never multiplicities. */
export const DOMAINS = Object.freeze({
  /** The seven board statuses, in board order (B05). */
  STATUS: Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
  /** The five priorities (B04/B07). */
  PRIORITY: Object.freeze(["urgent", "high", "medium", "low", "none"]),
  /** Card identity model (B07/C07). */
  ASSIGNEE_KIND: Object.freeze(["human", "agent"]),
  /**
   * The agent platforms the board renders (B03/B07/B16/B22/C07). The original
   * four hosts plus the five the roster may name today; each carries an official
   * brand colour in the sidebar (`--brand-agent-*` in `tokens.css`).
   */
  PLATFORM: Object.freeze([
    "claude",
    "codex",
    "cursor",
    "opencode",
    "pi",
    "openclaw",
    "grok",
    "hermes",
    "gemini",
  ]),
  /**
   * Sidebar navigation (B03). M1 appends `waiting` — the one deliberate
   * extension of this frozen baseline, approved with B03's count together
   * (design §10-C6): the 「等你回复」view needs a native, countable, non-column
   * entry point, and the nav item is the only one there is.
   */
  NAV: Object.freeze(["board", "list", "activity", "waiting"]),
  /** Board / list view toggle (B02). */
  VIEW: Object.freeze(["board", "list"]),
  /** Language menu options (B03/B21). */
  LANG: Object.freeze(["en", "zh"]),
  /** `html[data-theme-mode]` and the theme cell's mirrored state (B01/B03). */
  THEME_MODE: Object.freeze(["light", "dark", "auto"]),
  /** B26 — the feed's three filter slots (§6). */
  ACTIVITY_FILTER: Object.freeze(["actor", "event", "task"]),
  /** B26 — a row's event bucket, as the **event** filter reads it (§3.4). */
  ACTIVITY_GROUP: Object.freeze(["status", "comment", "delivery", "meta"]),
  /** B26 — the two mutually exclusive empty states (§8). */
  ACTIVITY_EMPTY: Object.freeze(["project", "filter"]),
  /**
   * B27 — the waiting queue's reason kinds (§30).
   *
   * `acceptance` is M6's third kind: an `in_review` top-level card the board's
   * policy leaves to a human. The prototype predates it, and the contract's
   * `subset` direction is what lets the oracle stay a *sample* rather than a
   * closed list (the same reading `data-status` takes).
   */
  WAITING_REASON: Object.freeze(["question", "blocked", "acceptance"]),
  /** `html[data-theme]` — what the stylesheet reads. Note the different vocabulary. */
  THEME_DOC: Object.freeze(["meerkat-taskpanel", "dark", "auto"]),
  /** Toast kinds (B14). */
  TOAST_KIND: Object.freeze(["info", "success", "danger"]),
  /** Detail template slots (B09). */
  SLOT: Object.freeze(["description", "relations", "agent-session", "attachments", "comments", "activity"]),
  /** Markdown editor modes (B23). */
  MD_MODE: Object.freeze(["write", "preview", "split"]),
  /**
   * B09 · the drawer's Description section is one section with two faces, and
   * `data-detail-description-mode` names which is showing (T-20261014-212017-3
   * §4.2). Two values, and the stylesheet holds both readings.
   */
  DESCRIPTION_MODE: Object.freeze(["read", "edit"]),
  /** Agent presence rows (B03). */
  PRESENCE: Object.freeze(["running", "idle"]),
  /** Empty-state kinds (B12). */
  EMPTY_KIND: Object.freeze(["column", "no-results"]),
  /**
   * The board view's two states (B05/B12, R10 ①). Exactly two, and they are
   * mutually exclusive by rule: `data` shows the board, `empty` shows the
   * board-level no-results block. The attribute is the single source of truth —
   * both members' `hidden` follow from it in the same write, so they can never
   * disagree (contract §8 R1/R2). The vocabulary is deliberately not the list's:
   * a board has no `loading` state (F6), and a list has no `empty` one.
   */
  BOARD_STATE: Object.freeze(["data", "empty"]),
  /**
   * The detail drawer's save state (B09, R10 ②). Four values, one attribute:
   * `idle` is the resting state (opening a card resets to it), `saving` and
   * `saved` are the transient ones a commit passes through, and `error` is held
   * until the next commit. `[data-detail-save-error]` is visible in exactly one
   * of the four — written by the same act, never independently (contract §8 R5).
   */
  SAVE_STATE: Object.freeze(["idle", "saving", "saved", "error"]),
  /** The drawer fields that save as they change (B09, R10 ②). */
  // T-20261014-212017-4 — the drawer's own four edit surfaces joined R10's
  // three: the two property menus, the markdown description, the file list and
  // the dependency chips. The set is the prototype's, read off
  // `design/prototype/index.html` (`data-detail-save-field` appears exactly
  // eight times, once per value below).
  SAVE_FIELD: Object.freeze(["assignee", "reporter", "labels", "status", "priority", "description", "attachments", "depends"]),
  /**
   * The list view's two states (B08/B13, R9 ③). Exactly two, and they are
   * mutually exclusive by rule: `loading` shows the skeleton, `data` shows the
   * rows. The attribute is the single source of truth — the skeleton's `hidden`
   * is written in the same act, so the two can never disagree (contract §8 R5).
   */
  LIST_STATE: Object.freeze(["loading", "data"]),
  /** Detail drawer states (B09). */
  DRAWER_STATE: Object.freeze(["closed", "open", "closing"]),
  /** Overlay panel states (B18/B19). */
  PANEL_STATE: Object.freeze(["closed", "open"]),
  /** Token reveal icons (B19). */
  TOKEN_ICON: Object.freeze(["hidden", "shown"]),
  /** Boolean-valued state attributes (B19). */
  BOOLEAN: Object.freeze(["true", "false"]),
  /**
   * The live stream's state on the top bar's dot (B02). **Impl-only**: the
   * attribute has no prototype counterpart (the prototype has no network), so
   * this is the one domain whose authority is `web/src/services/events.js`
   * rather than the design. Approved as a written deviation
   * (`surface-disposition.md` #4): an attribute-level addition to an element the
   * prototype already has, never a new node.
   */
  CONNECTION: Object.freeze(["connecting", "open", "closed"]),
});

/**
 * The rule vocabulary. `layer` decides where the rule can be evaluated:
 *
 *   "dom"    needs a live DOM (browser layer — a Chromium-driven suite)
 *   "source" needs only the built artifacts / stylesheets (browser-free, in the container)
 *   "manual" is recorded for completeness and is human-reviewed — it is *not*
 *            machine-checked anywhere (the Jobs/UI review pass owns it)
 *
 * Payload semantics (the contract the DOM layer must implement):
 *
 *   count              `{selector, within?, when?, equals|min|max}`
 *                      Number of elements matching `selector`. With `within`, the
 *                      bound applies **per element matching `within`** (so
 *                      `{selector:"[data-empty]", within:"[data-column-body]", max:1}`
 *                      means "each column body holds at most one empty state").
 *   order              `{selector, attribute, equals, when?}`
 *                      The `attribute` values of the matches, in document order,
 *                      equal `equals` exactly.
 *   identical-hookset  `{selector, within?, when?}`
 *                      Every match carries the identical set of `data-*` attributes
 *                      (the filter/drag/drawer paths must never special-case one).
 *   domain             `{selector, attribute, subset, when?}`
 *                      Every match's `attribute` value is in `subset`.
 *   absent             `{selector, within?, when?}`
 *                      No match exists (retired hooks, forbidden controls).
 *   sequence           `{selector, attribute, from, step, when?}`
 *                      The numeric `attribute` values, in document order, are the
 *                      contiguous run `from, from+step, …`.
 *   monotonic          `{selector, attribute, direction, when?}`
 *                      The numeric values do not increase (`non-increasing`) /
 *                      decrease (`non-decreasing`) down the document.
 *   computed           `{probe, property?, comparators…, count?, visible?, when?}`
 *                      The **computed style** of what `probe` matches, read from a
 *                      live browser. This is the one kind whose selector is *not*
 *                      a contract hook — see `PROBE GRAMMAR` below — because a
 *                      computed value belongs to a rendered box (a chip's height,
 *                      a cell's row direction), and the design names some of
 *                      those boxes by class, not by attribute.
 *                      `equalsPx` / `minPx` / `maxPx` are **pixel lengths**: the
 *                      computed value must be spelled with a `px` unit, so a
 *                      rendered `width:auto` (`"auto"` → `NaN`) or a percentage
 *                      (`"100%"` → a fake `100`) **fails** rather than passing
 *                      vacuously. The one exception is an element with no layout
 *                      box at all (a closed subtree): there is nothing to
 *                      measure, so the rule degrades to the probe's existence
 *                      criterion and the harness reports it as not-measured
 *                      (T-20261016-130046-3, `web/scripts/px-assert.mjs`).
 *   classes            `{probe, includes, when?}`
 *                      Every match's class list contains all of `includes`.
 *   text               `{probe, equals|oneOf|matches, when?}`
 *                      Every match's trimmed text satisfies the comparator;
 *                      `oneOf` is a closed set (a label that may say one of N
 *                      things), `matches` is a RegExp source.
 *   source             `{check, scope?}`
 *                      A named stylesheet/artifact scan from `SOURCE_CHECKS`.
 *   manual             `{note}`
 *                      Recorded intent with no machine rule — see MANUAL_RULES.
 *
 * ---------------------------------------------------------------------------
 * PROBE GRAMMAR (the `probe` field only)
 * ---------------------------------------------------------------------------
 * A rule's `selector` is a **data-* hook** — that is the contract's whole point,
 * and `validateContract()` rejects anything else. The three browser-layer kinds
 * above take `probe` instead, and a probe may be:
 *
 *   * one hook selector (`[data-card-title]`),
 *   * a descendant chain of hook selectors (`[data-list-rows] [data-list-status]`),
 *   * or a class from the **design's own `td-` namespace** (`.td-list-group`,
 *     `.td-chip`), which `design/BLOCKS.md` uses for the sub-parts it does not
 *     give an attribute (the status dot, the list's group shell).
 *
 * A Tailwind utility is not expressible: the namespace is closed and the check
 * is mechanical. This keeps the hook discipline intact — `allSelectors()` and
 * the bundle's literal scan never see a probe, so nothing here widens the
 * declared hook surface.
 */
export const RULE_KINDS = Object.freeze({
  count: Object.freeze({ layer: "dom" }),
  computed: Object.freeze({ layer: "dom" }),
  classes: Object.freeze({ layer: "dom" }),
  text: Object.freeze({ layer: "dom" }),
  order: Object.freeze({ layer: "dom" }),
  "identical-hookset": Object.freeze({ layer: "dom" }),
  domain: Object.freeze({ layer: "dom" }),
  absent: Object.freeze({ layer: "dom" }),
  sequence: Object.freeze({ layer: "dom" }),
  monotonic: Object.freeze({ layer: "dom" }),
  source: Object.freeze({ layer: "source" }),
  manual: Object.freeze({ layer: "manual" }),
});

/**
 * Named browser-free scans. Each is implemented by the L1 suite against the built
 * artifacts (they do not exist yet — `web/` is the next stage); the contract only
 * declares which invariants must be checked and over what.
 */
export const SOURCE_CHECKS = Object.freeze({
  "css-status-priority-color-map": Object.freeze({
    intent:
      "The stylesheet maps [data-status] to --status-color (all of DOMAINS.STATUS) and " +
      "[data-priority] to --pri-color (all of DOMAINS.PRIORITY). C03: moving a card " +
      "updates one attribute and the stripe, dot and chips follow.",
  }),
  "css-mono-tabular-numerals": Object.freeze({
    intent: "`.td-mono` declares `font-variant-numeric: tabular-nums`. C04.",
  }),
  "css-no-id-selectors": Object.freeze({
    intent:
      "No stylesheet rule selects by `#id`. C05: ids exist only for label[for] / " +
      "aria-labelledby / aria-controls, never as a styling hook.",
  }),
  "css-no-hex-outside-tokens": Object.freeze({
    intent:
      "A six-digit hex scan of the stylesheet returns the token block and nothing " +
      "else. C08: no brand value is hard-coded outside the token definitions.",
  }),
  "selector-literal-present": Object.freeze({
    intent:
      "Every selector declared by this contract appears as a literal in the built " +
      "bundle (`web/dist/assets/*.js`), so the hook surface survives the framework " +
      "compile.",
  }),
});

/** The ten consistency items' invariants, reused where several blocks share one. */
const REQUIRED_BY_EVERY_CARD = Object.freeze([
  "[data-identifier]",
  "[data-id]",
  "[data-status]",
  "[data-priority]",
  "[data-project]",
  "[data-assignee]",
  "[data-assignee-kind]",
  "[data-reporter]",
  "[data-labels]",
  "[data-version]",
  "[data-comments]",
  "[data-attachments]",
  "[data-relations-parent]",
  "[data-relations-blocks]",
  "[data-relations-related]",
  "[data-done]",
  "[data-canceled]",
  "[data-card-stripe]",
  "[data-card-identifier]",
  "[data-card-title]",
  "[data-card-labels]",
  "[data-label]",
  "[data-card-priority]",
  "[data-card-assignee]",
  "[data-card-agent-badge]",
  "[data-card-agent-role]",
  "[data-card-comment-count]",
  "[data-card-attachment-count]",
  "[data-card-relations]",
  "[data-relation-parent]",
  "[data-relation-blocks]",
  "[data-relation-related]",
  "[data-card-menu]",
]);

/**
 * B01–B25, in order. Every entry is transcribed from the eponymous BLOCKS.md section.
 */
const BLOCKS = [
  {
    id: "B01",
    title: "App shell",
    root: "[data-app-shell]",
    scope: "shell",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "count", selector: "[data-app-shell]", equals: 1 },
      { kind: "count", selector: "html[data-theme]", equals: 1 },
      { kind: "count", selector: "html[data-theme-mode]", equals: 1 },
      { kind: "domain", selector: "html[data-theme]", attribute: "data-theme", subset: DOMAINS.THEME_DOC },
      { kind: "domain", selector: "html[data-theme-mode]", attribute: "data-theme-mode", subset: DOMAINS.THEME_MODE },
      {
        kind: "manual",
        note:
          "`.td-shell` layout is `grid-template-areas: \"topbar topbar\" / \"sidebar main\"` — " +
          "CSS geometry on a class, not a hook.",
      },
      {
        kind: "manual",
        note:
          "M2 wrote down the four surfaces the app carries and the prototype does not " +
          "(`surface-disposition.md`, approved as written deviations): the load-failure panel " +
          "(B17, relocated from the prototype's states gallery to the board's real error " +
          "surface), the optimistic-write conflict prompt (no prototype counterpart — the " +
          "prototype has no concurrent writers — now carrying `data-conflict` so it is at least " +
          "machine-visible), the live stream's state on the revision dot (B02's " +
          "`data-connection`, an attribute-level addition to an element the prototype has), and " +
          "the manual `?after=` resync, which left the board's main path for the access panel on " +
          "the same ruling and has since been removed from the panel as well (the transport's " +
          "automatic reconnect still uses `?after=`). None of the four is blessed as a block: " +
          "they are recorded, not asserted into existence.",
      },
    ],
  },

  {
    id: "B02",
    title: "Top bar",
    root: "[data-topbar]",
    scope: "shell",
    status: "active",
    required: [
      "[data-brand]",
      "[data-project-switcher]",
      "[data-project-current]",
      "[data-project-option]",
      "[data-project-new]",
      "[data-project-switcher-icon]",
      "[data-search]",
      "[data-search-input]",
      "[data-filter-toggle]",
      "[data-view-toggle]",
      "[data-view]",
      "[data-revision]",
      "[data-revision-label]",
      "[data-revision-value]",
      "[data-new-task]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-topbar]", equals: 1 },
      { kind: "count", selector: "[data-new-task]", equals: 1 },
      { kind: "count", selector: "[data-view]", equals: 2 },
      { kind: "domain", selector: "[data-view]", attribute: "data-view", subset: DOMAINS.VIEW },
      // M2 · the live stream's state rides `data-connection` on the revision
      // cluster's dot. Impl-only (the prototype has no network), approved as a
      // written deviation — see DOMAINS.CONNECTION and `surface-disposition.md` #4.
      { kind: "domain", selector: "[data-connection]", attribute: "data-connection", subset: DOMAINS.CONNECTION },
      // R6 ① — the segmented Board/List control must *show* which side is on.
      // daisyUI's `tabs` paints nothing for `aria-pressed` (its vocabulary is
      // `.tab-active` / `[aria-selected]` / `[aria-current]`), so the selected
      // tab is the implementation's own rule, and these four probes are what
      // hold it: the well is the brand's sunken surface, the pressed tab is
      // accent-on-surface, and pressed is distinguishable from unpressed by
      // more than a font weight. Values are read from the tokens, never from a
      // hex literal, so the same rule holds in both themes.
      { kind: "computed", probe: "[data-view-toggle]", property: "backgroundColor", equalsVar: "--brand-sunken", when: "board view" },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "color",
        equalsVar: "--brand-accent",
        when: "board view",
      },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "backgroundColor",
        equalsVar: "--brand-surface",
        when: "board view",
      },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "color",
        differsFrom: '[data-view-toggle] [data-view][aria-pressed="false"]',
        when: "board view",
      },
      // Exactly one side is on, whichever view is up — so this one carries no
      // precondition.
      { kind: "count", selector: '[data-view][aria-pressed="true"]', within: "[data-view-toggle]", equals: 1 },
      // R9 ① — the switcher joins the one light-dismiss rule by **carrying the
      // attribute**, not by being named in a handler. Membership is the attribute
      // and nothing else (no class name, no selector list), so the membership
      // count below is a *floor*: a third floating control joins by taking the
      // attribute, with no code change and no edit here
      // (`design/fidelity-r9.md` §2.1, §8 R1/R2).
      { kind: "count", selector: "[data-project-switcher][data-dismiss-on-outside]", equals: 1 },
      { kind: "count", selector: "[data-dismiss-on-outside]", min: 2 },
      { kind: "count", selector: "details[data-dismiss-on-outside]", min: 2 },
      // Every member is a daisyUI `dropdown` — the shell the floating panel and
      // its anchored placement come from. (That a member is a `<details>` is the
      // pair of counts above; the *trigger* being its `<summary>` is asserted by
      // the manifest's driver-free leg, since a combinator cannot be written as a
      // hook selector.)
      { kind: "classes", probe: "[data-dismiss-on-outside]", includes: ["dropdown"] },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "height",
        equalsPx: 26,
        when: "board view",
      },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      {
        kind: "manual",
        note:
          "The right cluster — Revision + primary action as one flex item, `margin-left:auto`, " +
          "flush to the header's right padding edge, never split across the folded rows — is " +
          "named in BLOCKS.md only by the class `.td-topbar-actions`. No `data-topbar-actions` " +
          "attribute exists in design/prototype/index.html, although the plan's geometry check assumes " +
          "one; the flush-right check is therefore a geometry assertion, not a hook assertion.",
      },
      {
        kind: "manual",
        note:
          "ARIA, which is not a `data-*` hook surface: [data-filter-toggle] carries " +
          "`aria-pressed` + `aria-controls=\"td-filters\"`, and [data-view] carries `aria-pressed`.",
      },
      {
        kind: "manual",
        note: "No user, account or sign-in element anywhere in the bar.",
      },
    ],
  },

  {
    id: "B03",
    title: "Sidebar",
    root: "[data-sidebar]",
    scope: "shell",
    status: "active",
    required: [
      "[data-nav]",
      "[data-nav-item]",
      "[data-project-list]",
      "[data-project]",
      "[data-project-count]",
      "[data-order-score]",
      "[data-order-rank]",
      "[data-agents-presence]",
      "[data-agent-platform]",
      "[data-presence]",
      "[data-access-status]",
      "[data-access-cell]",
      "[data-theme-switch]",
      "[data-theme-icon]",
      "[data-theme-label]",
      "[data-lang-select]",
      "[data-lang-label]",
      "[data-lang-menu]",
      "[data-lang-option]",
      "[data-access-open]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-sidebar]", equals: 1 },
      // M1: 4 — `board | list | activity | waiting` (approved with DOMAINS.NAV).
      { kind: "count", selector: "[data-nav-item]", equals: 4 },
      { kind: "count", selector: "[data-lang-option]", equals: 2 },
      { kind: "domain", selector: "[data-nav-item]", attribute: "data-nav-item", subset: DOMAINS.NAV },
      { kind: "domain", selector: "[data-presence]", attribute: "data-presence", subset: DOMAINS.PRESENCE },
      // T-20261017-021412 ① — the presence dot's **box**, which the domain rule
      // above cannot state: the prototype's `.td-presence` is 6×6
      // (`design/prototype/src/input.css`, `.td-presence`), while the
      // implementation wore Tailwind's `size-2` (8×8). Both axes are asserted
      // because `size-*` writes both, so a one-axis rule would leave half the
      // defect gate-invisible.
      { kind: "computed", probe: "[data-presence]", property: "width", equalsPx: 6 },
      { kind: "computed", probe: "[data-presence]", property: "height", equalsPx: 6 },
      { kind: "domain", selector: "[data-theme-icon]", attribute: "data-theme-icon", subset: DOMAINS.THEME_MODE },
      { kind: "domain", selector: "[data-lang-option]", attribute: "data-lang-option", subset: DOMAINS.LANG },
      {
        kind: "identical-hookset",
        selector: "[data-project]",
        within: "[data-project-list]",
      },
      // Every project row is filled: `[data-project-count]` is the project's task
      // count, served by `/projects` as `task_count` (BLOCKS.md §Projects), and
      // since R7 ② the hook names the **number** — the pill — rather than the row.
      // "Filled" is therefore no longer checkable as an empty-value `absent` (the
      // attribute is a count, never `""`); the invariant lives in the R7 ② group
      // below as "at most one pill per row" plus the probe rules, which fail if a
      // row's count does not render at all.
      { kind: "sequence", selector: "[data-order-rank]", attribute: "data-order-rank", from: 1, step: 1 },
      { kind: "monotonic", selector: "[data-order-score]", attribute: "data-order-score", direction: "non-increasing" },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      { kind: "absent", selector: "[data-theme-modal]" },
      { kind: "absent", selector: "[data-lang-modal]" },

      /* ---- R11 ② · R13 · the roster names (design/fidelity-r11.md §2.2,
         design/fidelity-r13.md §2.1, §10.1) --------------------------------
         Each name is a real `<button>` carrying `[data-agent-assignee]`, wrapped
         by exactly one `[data-assignee-item]` — the capsule's shell. A press
         **narrows and nothing else**: it writes the name into the assignee
         control the way the control's own row would (R13 修订 §10.1 row 1), so
         the press is a writer, and the button is the control: no `role`, no
         `tabindex`, no key handler. The item holds **no** second button; with the
         `x` withdrawn the document holds no `[data-assignee-clear]` at all (B04
         states that globally). The counts are data (how many agents the board's
         roster has), never a frozen number; only the one-name-button-per-item
         relation is stated.
         The capsule itself is **width-neutral** and only exists while a name is
         in force, so its geometry is measured live in `web/scripts/dom-smoke.mjs`
         (R13 §10.3 B1/B3) rather than as a resting computed rule. */
      { kind: "count", selector: "[data-agent-assignee]", min: 1 },
      { kind: "count", selector: "[data-agent-assignee]", within: "[data-agents-presence]", min: 1 },
      { kind: "count", selector: "[data-assignee-item]", within: "[data-agents-presence]", min: 1 },
      { kind: "count", selector: "[data-agent-assignee]", within: "[data-assignee-item]", min: 1 },
      { kind: "identical-hookset", selector: "[data-assignee-item]", within: "[data-agents-presence]" },
      { kind: "identical-hookset", selector: "[data-agent-assignee]", within: "[data-agents-presence]" },
      { kind: "domain", selector: "[data-agent-assignee]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      // The face is the text it replaces: no shell, no border, no padding.
      { kind: "computed", probe: "[data-agent-assignee]", property: "paddingLeft", equalsPx: 0 },
      { kind: "computed", probe: "[data-agent-assignee]", property: "borderTopWidth", equals: "0px" },
      { kind: "computed", probe: "[data-agent-assignee]", property: "backgroundColor", equals: "rgba(0, 0, 0, 0)" },
      // R13 §8 U-6 — the roster's text host clips nothing, so the width-neutral
      // capsule's 6px left bleed is not sheared off. The project row's own name
      // cell keeps its ellipsis; this correction is scoped to the agent row
      // (`app.css` `[data-agent-row] [data-agent-text]`), and `[data-agent-text]`
      // is the roster's host alone.
      { kind: "computed", probe: "[data-agent-text]", property: "overflowX", equals: "visible" },
      // T-20261017-021412 ③ — the row's type. The prototype states `font-size:
      // 12px` on `.td-agent-row`; the implementation carried no rule and
      // inherited the 14px `body` baseline, so every roster name was 2px larger
      // than the design's. `.td-agent-assignee` is `font-size: inherit`, so the
      // row rule is the one that decides the names as well as the row.
      { kind: "computed", probe: "[data-agent-row]", property: "fontSize", equalsPx: 12 },
      // R6 ② — the selected nav row: accent copy on the accent's 10% tint, and
      // *not* the grey `.td-brand-active` the implementation used to paint. The
      // base metrics (32px row, 6px radius) come with it, because a selected row
      // that is 16px tall in a 13px design is a different component.
      { kind: "count", selector: '[data-nav-item][aria-current="page"]', equals: 1 },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "color",
        equalsVar: "--brand-accent",
      },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "backgroundColor",
        notEqualsVar: "--brand-active",
      },
      { kind: "computed", probe: "[data-nav-item]", property: "height", equalsPx: 32 },
      { kind: "computed", probe: "[data-nav-item]", property: "borderRadius", equalsPx: 6 },
      // The project row is the same component (BLOCKS.md B03: the two share one
      // rule), so the same two values are asserted on it.
      {
        kind: "computed",
        probe: '[data-project][aria-current="page"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-project][aria-current="page"]',
        property: "color",
        equalsVar: "--brand-accent",
      },
      // R6 ⑦ — the theme cell holds **three** glyphs and shows **exactly one**,
      // the one its own `data-theme-mode` names. The count is the fix's contract:
      // the glyph in force carries no `hidden` attribute at all, so a literal
      // `hidden="false"` is forbidden (a `hidden` attribute hides whatever its
      // value — the negative rule below pins that against regression).
      { kind: "count", selector: "svg[data-theme-icon]", within: "[data-theme-switch]", equals: 3 },
      { kind: "computed", probe: "[data-theme-switch] svg[data-theme-icon]", visible: true, count: 1 },
      {
        kind: "count",
        selector: 'svg[data-theme-icon][hidden="false"]',
        within: "[data-theme-switch]",
        equals: 0,
      },
      { kind: "count", selector: "svg[data-theme-icon][hidden]", within: "[data-theme-switch]", equals: 2 },
      // R6 ⑦⑧ — the three footer cells are one row each: icon, name and (for
      // the language trigger) the caret sit side by side in a 28px cell, and the
      // label ellipsises rather than wrapping. The rail below 1024px drops the
      // caret and tightens the cell to 24px — the prototype's own rail block.
      { kind: "computed", probe: "[data-theme-switch]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-theme-switch]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-theme-switch]", property: "height", equalsPx: 28 },
      { kind: "computed", probe: "[data-lang-select]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-lang-select]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-lang-select]", property: "height", equalsPx: 28 },
      {
        kind: "computed",
        probe: "[data-lang-select] span[data-lang-label]",
        property: "textOverflow",
        equals: "ellipsis",
      },
      { kind: "text", probe: "[data-theme-label]", oneOf: ["Light", "Dark", "Auto", "浅色", "深色", "自动"] },
      { kind: "text", probe: "[data-lang-label]", oneOf: ["EN", "中文"] },
      { kind: "computed", probe: "[data-theme-switch]", property: "height", equalsPx: 24, when: "rail" },
      { kind: "computed", probe: "[data-theme-switch]", property: "gap", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-lang-select] svg.td-caret", property: "display", equals: "none", when: "rail" },
      // R6 ⑧ — the language menu marks the language in force the way the design
      // marks a chosen row: accent copy on the accent's tint.
      {
        kind: "computed",
        probe: '[data-lang-option][aria-pressed="true"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-lang-option][aria-pressed="true"]',
        property: "color",
        equalsVar: "--brand-accent",
      },

      /* ---- R7 ① · the nav glyphs (`design/fidelity-r7.md` §2.1) ------------
         `svg.td-icon` is both the probe and the assertion: drop the class and
         the probe matches nothing, so the count and every computed rule fail
         together. The glyph carries **no `data-side-icon`** — that hook is the
         project monogram's, and the rail's chip rule matched the nav glyphs
         because they wore it (a 24px bordered grey tile where the prototype
         draws a bare 16px stroke). N1/N4. */
      // A `count … equals: 0`, not an `absent`: the hook is *scoped* out, not
      // retired — the project monogram still carries `data-side-icon` — and the
      // bundle's retired-hook scan reads a valueless `absent` selector as "this
      // attribute must be gone from the app entirely".
      { kind: "count", selector: "[data-side-icon]", within: "[data-nav]", equals: 0 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", count: 4 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "fill", equals: "none" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeWidth", equals: "1.5px" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeLinecap", equals: "round" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeLinejoin", equals: "round" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "stroke", notEquals: "none" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "width", equalsPx: 16 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "height", equalsPx: 16 },
      // N2/N3 — the rail's chip face must not reach the nav glyph.
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "borderTopWidth",
        equals: "0px",
        when: "rail",
      },
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "backgroundImage",
        equals: "none",
        when: "rail",
      },
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "backgroundColor",
        equals: "rgba(0, 0, 0, 0)",
        when: "rail",
      },

      /* ---- R7 ② · the project count pill (§2.2) ---------------------------
         The hook names the **number element**, not the row: it sits on the pill
         (N5/N6), the pill wears the brand's `.td-count` face (N7) and the
         element in the DOM is the span (the `span[data-project-count]` count
         plus the one-pill-per-row cap make "the hook is a span" checkable
         without a tagName probe). `width` is a *min*: the pill is
         `min-width:20px` and a two-digit count is legitimately wider. */
      // Scoped to `button[data-project]`, not `[data-project]`: a *card* carries
      // `data-project` too (B07's scalar), so the bare hook is not the row. The
      // row is the button (BLOCKS.md B03), and the pill sits inside it.
      //
      // The two bounds below are the row's **floor and cap**, and both are the
      // row's to keep. The floor is the one R7's verification found missing: after
      // the retired assertion went, the family stated only "at most one pill per
      // row", so a row that lost its pill while its siblings kept theirs was
      // invisible — the list-level floor (one pill *somewhere* in the list) and
      // the probe rules both need only one row to be intact. The relation §7 A4
      // states is `count([data-project-count]) == count(button[data-project])`
      // modulo unknown rows, and a per-row `min` is how this contract expresses a
      // per-row floor.
      //
      // The `null` escape (R7 §2.2, "`0` renders, unknown does not") is discharged
      // **upstream, not in the DOM**, and that is the one thing to know about this
      // bound: a row whose count is unknown and a row that lost its pill are the
      // same document — `v-if` renders no element either way, so no selector can
      // tell them apart. What makes the floor safe is that the board cannot
      // produce the unknown case: `task_count` is always an integer (`projects.mjs`
      // answers `taskCounts.get(id) ?? 0`, and `/projects` is the only producer),
      // so every row the board renders is a row that must carry its number. The
      // *wire* still permits `null` (`shared/wire.mjs`), so if a null ever becomes
      // reachable the row will have to say so with a hook of its own before this
      // rule can be conditional again. Stated, not assumed.
      { kind: "count", selector: "button[data-project-count]", within: "[data-project-list]", equals: 0 },
      { kind: "count", selector: "[data-project-count]", within: "button[data-project]", max: 1 },
      { kind: "count", selector: "[data-project-count]", within: "button[data-project]", min: 1 },
      { kind: "count", selector: "span[data-project-count]", within: "[data-project-list]", min: 1 },
      { kind: "classes", probe: "[data-project] [data-project-count]", includes: ["badge", "badge-sm", "td-count"] },
      { kind: "text", probe: "[data-project] [data-project-count]", matches: "^\\d+$" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "minWidth", equalsPx: 20 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "width", minPx: 20 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "height", equalsPx: 18 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "borderRadius", equals: "999px" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "fontSize", equals: "11px" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "fontFamily", contains: "mono" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "borderTopWidth", equals: "1px" },
      {
        kind: "computed",
        probe: "[data-project] [data-project-count]",
        property: "backgroundColor",
        equalsVar: "--brand-surface",
      },
      // N8 — the rail hides the count (the `.td-count` hide rule, kept).
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "display", equals: "none", when: "rail" },

      /* ---- R7 ③ · the footer splits at 1024 (§2.3) ------------------------
         ≥1024: one row of three equal thirds (a grid with three tracks).
         ≤1023: three stacked rows — `display:flex` + `column`, so the
         *container* is what changes; the **cell** stays a single row (R6 ⑦⑧),
         which is why `flexDirection: row` is asserted on the cell in both
         bands. Per the contract, `grid-template-columns` is deliberately NOT
         asserted in the rail band (it returns the specified value on a
         non-grid box) — `display` and `flexDirection` are the signals. */
      { kind: "count", selector: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "button[data-access-cell]", within: "[data-access-status]", equals: 3 },
      { kind: "count", selector: "[data-theme-switch]", within: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "[data-lang-select]", within: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "[data-access-open]", within: "[data-access-status]", equals: 1 },
      { kind: "computed", probe: "[data-access-status]", property: "display", equals: "grid" },
      { kind: "computed", probe: "[data-access-status]", property: "gridTemplateColumns", tokens: 3 },
      { kind: "computed", probe: "[data-access-status]", property: "alignItems", equals: "stretch" },
      { kind: "computed", probe: "[data-access-cell]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-access-cell]", property: "justifyContent", equals: "center" },
      { kind: "computed", probe: "[data-access-cell]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-access-cell]", property: "height", equalsPx: 28 },
      { kind: "computed", probe: "[data-access-cell]", property: "paddingLeft", equalsPx: 2 },
      { kind: "computed", probe: "[data-access-cell]", property: "textAlign", equals: "center" },
      // The separator: a vertical hairline at ≥1024 (the first cell drops it),
      // turning into a horizontal one on the 2nd/3rd rail rows (N11/N12/N12b).
      { kind: "computed", probe: "[data-theme-switch]", property: "borderInlineStartWidth", equals: "0px" },
      { kind: "computed", probe: "[data-lang-select]", property: "borderInlineStartWidth", equals: "1px" },
      { kind: "computed", probe: "[data-access-open]", property: "borderInlineStartWidth", equals: "1px" },
      { kind: "computed", probe: "[data-access-cell]", property: "borderBlockStartWidth", equals: "0px" },
      { kind: "computed", probe: "[data-access-status]", property: "display", equals: "flex", when: "rail" },
      { kind: "computed", probe: "[data-access-status]", property: "flexDirection", equals: "column", when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "flexDirection", equals: "row", when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "gap", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "height", equalsPx: 24, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "paddingLeft", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "borderInlineStartWidth", equals: "0px", when: "rail" },
      { kind: "computed", probe: "[data-theme-switch]", property: "borderBlockStartWidth", equals: "0px", when: "rail" },
      { kind: "computed", probe: "[data-lang-select]", property: "borderBlockStartWidth", equals: "1px", when: "rail" },
      { kind: "computed", probe: "[data-access-open]", property: "borderBlockStartWidth", equals: "1px", when: "rail" },
      // N13/N13b — the caret is the first thing the rail drops, and it is on
      // screen at full width.
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "width", equalsPx: 14, visible: true },
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "height", equalsPx: 14, visible: true },
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "fill", equals: "none", visible: true },
      // The glyph is 14px in *both* bands — the rail's "24px" is its row height,
      // never the glyph.
      {
        kind: "computed",
        probe: "[data-access-cell] svg.td-icon",
        property: "width",
        equalsPx: 14,
        visible: true,
        when: "rail",
      },
      { kind: "computed", probe: "[data-lang-select] svg.td-caret", property: "display", notEquals: "none" },
      {
        kind: "manual",
        note:
          "Footer controls are three equal thirds at ≥1024px (`display:grid; " +
          "repeat(3, minmax(0,1fr))`) and three stacked rows at ≤1023px — each a " +
          "block button carrying the `[data-access-cell]` hook (R7 ③) and a " +
          "hairline that turns with the layout (inline start at full width, " +
          "block start on the 2nd/3rd rail rows); cells are keyboard reachable " +
          "with `:focus-visible` rings.",
      },
      {
        kind: "manual",
        note:
          "The theme cell is a three-state cycle, not a toggle: it states the mode in force " +
          "without being opened and therefore carries **no** `aria-pressed`; the state rides on " +
          "`data-theme-mode`, mirrored from <html> by the same writer.",
      },
      {
        kind: "manual",
        note:
          "[data-lang-menu] is `position:fixed` and sits at the end of the document rather than " +
          "inside the sidebar, because the sidebar is a scroll container and would clip it.",
      },
      {
        kind: "manual",
        note:
          "At the ≤1023px rail the row never wraps; labels (including `.td-caret`) drop out and " +
          "each cell becomes a centred 24px icon — three glyphs still fit the 64px (56px under " +
          "560px) rail with no horizontal overflow.",
      },
      {
        kind: "manual",
        note:
          "The project list renders the order the **server** computed and does no computation " +
          "itself. `[data-order-score]` is a diagnostic field the server only returns under " +
          "`?order_debug=1` (plan D4), so it is absent from a default `/projects` response.",
      },
    ],
  },

  {
    id: "B04",
    title: "Filters bar",
    root: "[data-filters]",
    scope: "board",
    status: "active",
    required: [
      "[data-filter-assignee]",
      "[data-filter-assignee-value]",
      "[data-filter-assignee-summary]",
      "[data-filter-assignee-text]",
      "[data-assignee-filter-option]",
      "[data-filter-priority]",
      "[data-filter-priority-value]",
      "[data-filter-priority-summary]",
      "[data-filter-priority-text]",
      "[data-filter-priority-option]",
      "[data-filter-label]",
      "[data-filter-label-value]",
      "[data-filter-label-summary]",
      "[data-filter-label-option]",
      "[data-filter-clear]",
      "[data-filter-count]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-filters]", equals: 1 },
      // R15 ② — `[data-filter-clear]` is no longer the document's only one: the
      // activity bar's tail carries B04's control too (B26), and the two are
      // told apart by **the bar the press came from** rather than by a second
      // hook name (`design/fidelity-r15.md` §2.4). So this rule is scoped to
      // this bar and B26 states its own.
      { kind: "count", selector: "[data-filter-clear]", within: "[data-filters]", equals: 1 },
      { kind: "identical-hookset", selector: "[data-filter-label-option]" },
      // R9 ② — the label control is the third member of the field family, not a
      // lookalike. `.td-label-trigger` wears the `.td-select` shell, so the three
      // controls in the bar compute to one height and one text treatment — the
      // half of Terry's finding a per-element rule can state. The *relation*
      // (`.td-label-trigger`, `[data-filter-assignee]` and `[data-filter-priority]`
      // at one height, and the caret centred on the trigger) is measured in the
      // driver layer, where two elements can be compared with each other.
      //
      // The height is stated as 32px, **not** the contract's 30px: that figure is
      // the *prototype's* platform value, and the implementation's field family is
      // 32px on the 4px grid (`.td-input` / `.td-select`, M2c ①). Writing 30 here
      // would leave the trigger 2px short of the two controls it is being aligned
      // with — the opposite of the finding. `design/fidelity-r9.md` §5 B1 is the
      // prototype's absolute; §5 B3, the relation, is the half that ports.
      { kind: "count", selector: "[data-filter-label][data-dismiss-on-outside]", equals: 1 },
      { kind: "computed", probe: ".td-label-trigger", property: "height", equalsPx: 32 },
      { kind: "computed", probe: ".td-label-trigger", property: "minHeight", equalsPx: 32 },
      { kind: "computed", probe: ".td-label-trigger", property: "fontSize", equalsPx: 12 },
      { kind: "computed", probe: ".td-label-trigger", property: "fontWeight", equals: "400" },
      { kind: "computed", probe: ".td-label-trigger", property: "color", equalsVar: "--brand-text" },
      { kind: "computed", probe: ".td-label-trigger", property: "paddingRight", equalsPx: 26 },
      { kind: "computed", probe: ".td-label-trigger", property: "paddingLeft", equalsPx: 8 },
      // The caret is the trigger's own glyph, absolutely positioned in the room
      // the right padding reserves. 14px is the design's small icon size; the
      // 6px offset is stated against the padding box here (the border box reads
      // 7px — contract §1, the R9-1 correction, so neither number alone is the
      // whole assertion).
      { kind: "computed", probe: ".td-label-trigger .td-icon-sm", property: "width", equalsPx: 14 },
      { kind: "computed", probe: ".td-label-trigger .td-icon-sm", property: "height", equalsPx: 14 },
      { kind: "computed", probe: ".td-label-trigger .td-icon-sm", property: "position", equals: "absolute" },
      { kind: "computed", probe: ".td-label-trigger .td-icon-sm", property: "display", equals: "block" },
      // The value renders as **flat text**: the hook name is unchanged and still
      // restates `data-filter-label-value`, but nothing decorates it into a chip
      // any more (R9 ②). The flattening is scoped to this trigger — the card's,
      // the drawer's and the dialogs' own label treatments are untouched.
      { kind: "computed", probe: "[data-filter-label-summary]", property: "borderTopWidth", equals: "0px" },
      { kind: "computed", probe: "[data-filter-label-summary]", property: "backgroundColor", equals: "rgba(0, 0, 0, 0)" },
      { kind: "computed", probe: "[data-filter-label-summary]", property: "borderRadius", notEquals: "999px" },
      { kind: "computed", probe: "[data-filter-label-summary]", property: "fontSize", equalsPx: 12 },
      { kind: "computed", probe: "[data-filter-label-summary]", property: "fontWeight", equals: "400" },
      // R12 — the bar is **one line, always** (design/fidelity-r12-supplement.md
      // §2, rulings R-2/R-9). `nowrap` is the direction the round approves as a
      // written deviation from the prototype (which wraps at 430); the overflow
      // policy beside it is what keeps that deviation from becoming a page-level
      // horizontal scrollbar — the same (d) alternative §2.1 rules out when it is
      // missing. The three values are read off one element, so a bar that went
      // back to `wrap`, or that was narrowed without its own scroller, cannot
      // pass on the half the other rule states.
      { kind: "computed", probe: "[data-filters]", property: "flexWrap", equals: "nowrap" },
      { kind: "computed", probe: "[data-filters]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-filters]", property: "alignItems", equals: "center" },
      { kind: "computed", probe: "[data-filters]", property: "overflowX", equals: "auto" },
      { kind: "computed", probe: "[data-filters]", property: "minWidth", equalsPx: 0 },
      // …and the family's rhythm, which the wrap direction does not touch: the
      // 8px gap and the bar's own *zero* padding. The prototype gives the bar no
      // padding at all (the content inset belongs to `.td-main`, and to `main`
      // here since T-20261013-015627), so the bar's box height is the tallest
      // control's — that relation is what a padded bar would break.
      { kind: "computed", probe: "[data-filters]", property: "gap", equalsPx: 8 },
      { kind: "computed", probe: "[data-filters]", property: "paddingTop", equalsPx: 0 },
      { kind: "computed", probe: "[data-filters]", property: "paddingRight", equalsPx: 0 },
      { kind: "computed", probe: "[data-filters]", property: "paddingBottom", equalsPx: 0 },
      { kind: "computed", probe: "[data-filters]", property: "paddingLeft", equalsPx: 0 },

      /* ---- R11 ① · the status filter (design/fidelity-r11.md §2.1) --------
         The control's value domain is the seven first-class statuses plus the
         resting `all`, and the menu is where that domain lives — the rule reads
         the rows rather than a second list in script, which is the contract's
         "no magic numbers" (R1). The order is the board's own (DESIGN.md §2.3),
         so the menu and the seven columns cannot disagree. The value attribute,
         the eight `aria-pressed` rows and the trigger's copy are one write in the
         implementation's single writer, so a document that states one set and
         paints another cannot pass. */
      { kind: "count", selector: "[data-filter-status]", equals: 1 },
      { kind: "count", selector: "[data-filter-status-option]", equals: 8 },
      {
        kind: "order",
        selector: "[data-filter-status-option][data-status]",
        attribute: "data-status-value",
        equals: DOMAINS.STATUS,
      },
      {
        kind: "domain",
        selector: "[data-filter-status-option][data-status]",
        attribute: "data-status-value",
        subset: DOMAINS.STATUS,
      },
      { kind: "count", selector: "[data-filter-status][data-dismiss-on-outside]", equals: 1 },
      { kind: "computed", probe: "[data-filter-status-summary]", property: "height", equalsPx: 32 },
      { kind: "text", probe: "[data-filter-status-text]", oneOf: ["Status: All", "状态：全部"] },

      /* ---- R15 ② · the assignee and priority controls are dropdowns --------
         The two controls that were native `<select>`s are daisyUI `dropdown`
         panels now, the same component the status and label controls beside them
         already wore (`design/fidelity-r15.md` §2.1/§2.2): a
         `<details data-dismiss-on-outside>` whose `<summary class="btn btn-sm
         td-label-trigger">` states the chosen row as plain text, whose rows are
         menu `button`s, and whose value rides the control's own `-value`
         attribute. The carrier matters as much as the shape — a `<details>` has
         no form value, which is why the hook's value moved off `.value` and onto
         the attribute the label and status controls already used. The rows' own
         `aria-current` is the single-choice reading (the label control's), and
         the four static assignee rows are the document's own domain. */
      { kind: "count", selector: "[data-filter-assignee][data-dismiss-on-outside]", equals: 1 },
      { kind: "count", selector: "[data-filter-priority][data-dismiss-on-outside]", equals: 1 },
      { kind: "count", selector: "[data-filter-assignee-value]", equals: 1 },
      { kind: "count", selector: "[data-filter-priority-value]", equals: 1 },
      { kind: "count", selector: "[data-filter-assignee-summary]", equals: 1 },
      { kind: "count", selector: "[data-filter-priority-summary]", equals: 1 },
      { kind: "count", selector: "[data-filter-assignee-text]", equals: 1 },
      { kind: "count", selector: "[data-filter-priority-text]", equals: 1 },
      { kind: "text", probe: "[data-filter-assignee-text]", oneOf: ["Assignee: All", "负责人：全部"] },
      { kind: "text", probe: "[data-filter-priority-text]", oneOf: ["Priority: All", "优先级：全部"] },
      { kind: "count", selector: "[data-assignee-filter-option]", equals: 4 },
      { kind: "count", selector: "[data-filter-priority-option]", equals: 6 },
      { kind: "count", selector: "[data-assignee-filter-option][aria-current=\"true\"]", equals: 1 },
      { kind: "count", selector: "[data-filter-priority-option][aria-current=\"true\"]", equals: 1 },

      /* ---- R13 · the named assignee, and no `x` --------------------------
         The control's four static rows are the document's (B04's own domain) and
         each carries `[data-assignee-filter-option]` with **its own value** —
         R15 ② moved those rows from `<option>`s to menu `button`s without moving
         the hook or its carrier. A *given name* is still written on demand and
         removed with the value, so at rest the menu holds the four and no more.
         The `x` that used to sit beside the control is **withdrawn** (R13 修订
         §10.1 row 4 / §10.2): no markup, no rule, no handler, no aria seat — the
         removal path is the control's own `Assignee: All` row. The rule is stated
         over the whole document, so the hook cannot survive anywhere the way a
         scoped zero would let it (the `absent` form is also what makes
         `web/blocks.bundle.test.mjs` require the name to be gone from the built
         bundle).
         The hook is **not** B22's `[data-assignee-option]` (14 bare seats in the
         dialogs) — R13 §2.9; the B22 block keeps its own rules over that name,
         and the named row's own count is state, not resting geometry, so it is
         measured live in `web/scripts/dom-smoke.mjs`. */
      { kind: "absent", selector: "[data-assignee-clear]" },
      { kind: "computed", probe: "[data-filter-assignee]", property: "height", equalsPx: 32 },
      {
        kind: "manual",
        note:
          "The assignee menu holds four static rows (`all | me | human | agent`) plus, on demand, " +
          "exactly one given name, every row carrying `[data-assignee-filter-option]` with its own " +
          "value — R15 ② kept R13's hook and carrier while moving the rows from `<option>`s to " +
          "menu `button`s. A named row's value is the name and its copy is the name — the roster's " +
          "own names are data, never catalogue keys. The named row is not a resting figure, so the " +
          "rules above pin the resting state; the live behaviour (writing the name, the capsule, " +
          "the removal via the control's own `all` row) is measured in " +
          "`web/scripts/dom-smoke.mjs`'s R11/R13 section (design/fidelity-r13.md §10.3 C1–C4).",
      },
      {
        kind: "manual",
        note:
          "The label selector is a `<details>` dropdown, not a `<select>`: the chosen value " +
          "lives on `data-filter-label-value` and is restated on [data-filter-label-summary]. " +
          "Its option count is roster-derived (every label plus one \"all\" row) and is not asserted. " +
          "R9 ② evaluated replacing it with a third `<select>` (design/fidelity-r9.md §2.2 fork B2) " +
          "and did not adopt it: the control's shape is seventeen choices plus a chosen-value readout.",
      },
      {
        kind: "manual",
        note:
          "R12 — the halves of the bar's contract a declaration cannot state live in " +
          "web/scripts/dom-smoke.mjs's R12 section: the row count (one line at every tier, " +
          "including 430), the four field controls' equal height, the count's geometric " +
          "right-edge pin, the closed set of painted controls, and — at 430 — that the bar " +
          "has scrollable slack of its own while the document still has none " +
          "(design/fidelity-r12-supplement.md §5.1 A2/A5/A7/A10/A11, §5.4).",
      },
      {
        kind: "manual",
        note:
          "R15 ② — the four field controls are one component family: the two `<select>`s are " +
          "`dropdown` panels now, so all seven filter triggers in the document (this bar's four " +
          "and B26's three) wear `.td-label-trigger` and compute to one shell. The *relation* " +
          "(seven equal heights, the caret centred on each trigger, each trigger's box the width " +
          "of the control it replaced) is measured live in `web/scripts/dom-smoke.mjs`, where two " +
          "elements can be compared with each other (design/fidelity-r15.md §3 B2). " +
          "[data-filter-count] carries `aria-live=\"polite\"`.",
      },
    ],
  },

  {
    id: "B05",
    title: "Board",
    root: "[data-board]",
    scope: "board",
    status: "active",
    required: ["[data-column]", "[data-board-view]", "[data-board-state]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-board]", equals: 1, when: "board view" },
      { kind: "count", selector: "[data-column]", equals: 7, when: "board view" },
      // R10 ① — the view holds one of two states and says which on its own root.
      // Its two members are its own direct children (the board, and the
      // board-level no-results block) and the exclusion is a rule on the
      // attribute (`app.css`), so the resting document is already consistent —
      // the same shape R9 ③ gave the list, for the same reason. The condition is
      // `shown === 0`, which covers the filtered-to-nothing case **and** the
      // genuinely empty project: the old `total > 0 && shown === 0` covered only
      // the first, so a board with no cards drew its seven bare columns with the
      // empty state hidden behind them (Terry's finding).
      //
      // `[data-empty][data-empty-kind="column"]` is **not** a member: it states
      // that one column is bare, and a board-level tally would count the same
      // fact twice. Direct parentage and the two-members-exactly-one-visible
      // relation are measured in `web/scripts/dom-smoke.mjs` — the hook grammar
      // has no child combinator.
      { kind: "count", selector: "[data-board-view]", equals: 1, when: "board view" },
      {
        kind: "domain",
        selector: "[data-board-view]",
        attribute: "data-board-state",
        subset: DOMAINS.BOARD_STATE,
        when: "board view",
      },
      { kind: "count", selector: "[data-board]", within: "[data-board-view]", equals: 1, when: "board view" },
      {
        kind: "count",
        selector: '[data-empty][data-empty-kind="no-results"]',
        within: "[data-board-view]",
        equals: 1,
        when: "board view",
      },
      // …the `data` half: the board is on, the empty member is off — attribute
      // and computed `display` read together, so a rule that said one and drew
      // the other could not pass.
      { kind: "count", selector: "[data-board-view][data-board-state]", equals: 1, when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "display", equals: "flex", when: "board view" },
      {
        kind: "computed",
        probe: '[data-empty][data-empty-kind="no-results"]',
        property: "display",
        equals: "none",
        when: "board view",
      },
      {
        kind: "order",
        selector: "[data-column][data-status]",
        attribute: "data-status",
        equals: DOMAINS.STATUS,
        when: "board view",
      },
      // R12 — the equal-height chain (design/fidelity-r12-supplement.md §3.1,
      // ruling R-4). `stretch` is the **explicit** declaration, not the initial
      // value left to `normal`: it is what makes seven columns take the board's
      // content height instead of their own, and it is the one thing an
      // `items-start` would silently reuse. Three of the four links are stated
      // here — the board's cross-axis alignment, the column as a column flex box,
      // and the column body as the column's only vertical scroller — because each
      // is a declaration on one element, which is all a computed probe can read.
      //
      // The *relations* the chain produces (seven equal heights, each equal to
      // the board's content box, both following the viewport) are two-element
      // comparisons with no rule of their own; they are measured in
      // `web/scripts/dom-smoke.mjs`'s R12 section (§5.2 B2/B3/B4).
      { kind: "computed", probe: "[data-board]", property: "alignItems", equals: "stretch", when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "gap", equalsPx: 16, when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "overflowX", equals: "auto", when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "overflowY", equals: "hidden", when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "minWidth", equalsPx: 0, when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "minHeight", equalsPx: 0, when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "paddingTop", equalsPx: 0, when: "board view" },
      { kind: "computed", probe: "[data-board]", property: "paddingBottom", equalsPx: 4, when: "board view" },
      { kind: "computed", probe: "[data-column]", property: "display", equals: "flex", when: "board view" },
      { kind: "computed", probe: "[data-column]", property: "flexDirection", equals: "column", when: "board view" },
      { kind: "computed", probe: "[data-column]", property: "minHeight", equalsPx: 0, when: "board view" },
      // B5/B9 — the column is **not** its own vertical scroller; the scrolling
      // happens inside it. A scrollbar on the column's own outer box is the
      // defect this pair pins, and it is stated from both ends: the column may
      // not compute to either scrolling value, and the body must compute to one.
      { kind: "computed", probe: "[data-column]", property: "overflowY", notEquals: "auto", when: "board view" },
      { kind: "computed", probe: "[data-column]", property: "overflowY", notEquals: "scroll", when: "board view" },
      { kind: "computed", probe: "[data-column-body]", property: "overflowY", equals: "auto", when: "board view" },
      { kind: "computed", probe: "[data-column-body]", property: "minHeight", equalsPx: 120, when: "board view" },
      {
        kind: "manual",
        note:
          "R12 — [data-board] is the **page-level** horizontal scroller: it is the box " +
          "whose 2196px row would otherwise widen the document, and the document stays " +
          "overflow-free at every tier because it scrolls instead. Since R12 the filters bar " +
          "carries a scroller of its own (one line, §2.1), but that one is contained in a " +
          "32px row and never reaches the page. Both facts are CSS, not hooks; the page-level " +
          "half is what `web/scripts/dom-smoke.mjs` asserts as `noHorizontalOverflow` on the " +
          "document element, at every tier.",
      },
    ],
  },

  {
    id: "B06",
    title: "Column",
    root: "[data-column]",
    scope: "board",
    status: "active",
    required: [
      "[data-column-header]",
      "[data-column-dot]",
      "[data-column-name]",
      "[data-column-count]",
      "[data-column-add]",
      "[data-column-body]",
      "[data-column-progress]",
    ],
    states: ["[data-drag-over=\"true\"]"],
    rules: [
      { kind: "identical-hookset", selector: "[data-column]", when: "board view" },
      {
        kind: "manual",
        note:
          "[data-column-progress] is a daisyUI progress element directly under the header: " +
          "`value` is the column's visible count and `max` is the board's total visible count, " +
          "so it reads that column's share of the board. The single writer never emits `max=\"0\"`.",
      },
    ],
  },

  {
    id: "B07",
    title: "Card",
    root: "[data-card]",
    scope: "board",
    status: "active",
    required: [...REQUIRED_BY_EVERY_CARD],
    states: ["[data-dragging=\"true\"]", "[data-done=\"true\"]", "[data-canceled=\"true\"]"],
    rules: [
      { kind: "identical-hookset", selector: "[data-card]", when: "board view" },
      { kind: "domain", selector: "[data-card]", attribute: "data-status", subset: DOMAINS.STATUS },
      { kind: "domain", selector: "[data-card]", attribute: "data-priority", subset: DOMAINS.PRIORITY },
      { kind: "domain", selector: "[data-card]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-card-agent-badge]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      // R6 ④ — the title is capped at **two lines**. `-webkit-line-clamp` is the
      // only mechanism that both clamps and ellipsises, and `overflow:hidden` is
      // what it needs to bite. `display` is deliberately **not** asserted: the
      // declaration is `-webkit-box`, which Chromium serialises as `flow-root`
      // (R3), so a check on it would be checking the serialisation.
      { kind: "computed", probe: "[data-card-title]", property: "webkitLineClamp", equals: "2" },
      { kind: "computed", probe: "[data-card-title]", property: "overflow", equals: "hidden" },
      // R8 ③ — the card's identifier wears the single-line guard. The cap itself
      // is a render-layer character slice (`web/src/lib/identifier.js`), so what
      // is declarable here is the guard's class and its one-line behaviour; the
      // text/title pair is a relation and is measured in `dom-smoke.mjs`.
      { kind: "classes", probe: "[data-card-identifier]", includes: ["td-id"] },
      { kind: "computed", probe: "[data-card-identifier]", property: "whiteSpace", equals: "nowrap" },
      { kind: "computed", probe: "[data-card-title]", property: "marginTop", equalsPx: 2 },
      { kind: "computed", probe: "[data-card-title]", property: "fontSize", equalsPx: 14 },
      // R6 ④ — the done/canceled title variants (the prototype states both).
      {
        kind: "computed",
        probe: '[data-card][data-done="true"] [data-card-title]',
        property: "color",
        equalsVar: "--brand-text-3",
      },
      {
        kind: "computed",
        probe: '[data-card][data-canceled="true"] [data-card-title]',
        property: "textDecorationLine",
        contains: "line-through",
      },
      {
        kind: "manual",
        note:
          "Identity slot: a human card shows the monogram avatar with the agent badge and role " +
          "empty and hidden; an agent card hides the avatar (which still carries the monogram) " +
          "and shows both [data-card-agent-badge] and [data-card-agent-role], so every card " +
          "states the platform *and* the role name. Visibility is CSS, hence manual.",
      },
      {
        kind: "manual",
        note:
          "Card count is fixture data (how many tasks exist), never asserted. States `:hover`, " +
          "`:focus-within` and `aria-selected=\"true\"` are ARIA/CSS, not hooks. The root carries " +
          "the HTML attribute `draggable=\"true\"`.",
      },
      // M2 · `aria-selected` used to be the literal `false` on every card. It now
      // reports the board's own selection, which is only observable with a card
      // open — hence the driven precondition, alongside the row rules in B09.
      {
        kind: "count",
        selector: "[data-card][aria-selected=\"true\"]",
        equals: 1,
        when: "drawer open",
      },
      {
        kind: "manual",
        note:
          "Hook-name overlap to keep in mind when writing selectors: `data-project` names both a " +
          "card scalar (here) and a sidebar project row (B03, scoped by `within:[data-project-list]`); " +
          "`data-agent-platform` names a card badge, a roster option and a session block. " +
          "Rules that would be ambiguous qualify with `within` or a compound selector.",
      },
    ],
  },

  {
    id: "B08",
    title: "List view",
    root: "[data-list]",
    scope: "board",
    status: "active",
    required: [
      "[data-list-rows]",
      "[data-list-row]",
      "[data-list-identifier]",
      "[data-list-title]",
      "[data-list-status]",
      "[data-list-status-label]",
      "[data-list-assignee]",
      "[data-list-priority]",
      "[data-list-priority-label]",
      "[data-list-revision]",
      "[data-list-row-template]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-list]", equals: 1, when: "list view" },
      { kind: "identical-hookset", selector: "[data-list-row]", within: "[data-list-rows]", when: "list view" },
      // R9 ③ — the list is in one of two states and says which, on its root. The
      // two halves are made mutually exclusive by a **rule on that attribute**
      // (`app.css`), not by swapping one element at a time, so the resting
      // document already satisfies it — with the script off, the skeleton is the
      // one that carries `hidden` and the rows are the visible half (contract
      // §2.3, §8 R5/R6). That the pair is never *both* visible is a relation
      // between two elements, so the driver layer counts it.
      { kind: "count", selector: "[data-list][data-list-state]", equals: 1, when: "list view" },
      { kind: "domain", selector: "[data-list]", attribute: "data-list-state", subset: DOMAINS.LIST_STATE, when: "list view" },
      // …the `data` half: the skeleton is the hidden one, and the rows are on.
      { kind: "count", selector: "[data-skeleton][hidden]", equals: 1, when: "list view" },
      { kind: "computed", probe: "[data-skeleton]", property: "display", equals: "none", when: "list view" },
      { kind: "computed", probe: "[data-list-rows]", property: "display", equals: "block", when: "list view" },
      // …and the `loading` half, evaluated while a read is in flight: the
      // skeleton is the only thing on, and the rows' host holds **no** row to
      // read. `when: "list loading"` is the driver layer holding the request
      // open — a probe cannot say "at that moment".
      { kind: "count", selector: "[data-skeleton][hidden]", equals: 0, when: "list loading" },
      // Scoped to the rows' host on purpose: the document also holds the row
      // *template* (`template[data-list-row-template]`), whose child carries the
      // hook and is a document match — a bare `[data-list-row]` count would be
      // reading the template, not the list.
      { kind: "count", selector: "[data-list-row]", within: "[data-list-rows]", equals: 0, when: "list loading" },
      { kind: "computed", probe: "[data-skeleton]", property: "display", equals: "block", when: "list loading" },
      { kind: "computed", probe: "[data-list-rows]", property: "display", equals: "none", when: "list loading" },
      // R6 ⑤ — the group shell, the head row and the six-track template. The
      // grid's **first and last** tracks are the ones the prototype pins (74px /
      // 72px) and the track count is six; the middle tracks are `minmax(0,1fr)`,
      // whose computed form is not a pixel value (R4), so only the ends and the
      // count are asserted. The head is the sundered 32px band with the uppercase
      // 11px label — the row the implementation used to be missing entirely.
      { kind: "computed", probe: ".td-list-group", property: "backgroundColor", equalsVar: "--brand-surface", when: "list view" },
      { kind: "computed", probe: ".td-list-group", property: "borderRadius", equalsPx: 8, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "height", equalsPx: 32, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "textTransform", equals: "uppercase", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "backgroundColor", equalsVar: "--brand-sunken", when: "list view" },
      // R8 ② — the head is the rows' template. It used to be a `flex` box with a
      // single label while the rows were a six-track grid, so five columns had no
      // heading and no width in the head could line up with a column. The head is
      // now a grid on the rows' own tracks (same ends, same track count, same
      // `gap`, same inline padding), and it names all six columns.
      //
      // Per the contract's own R8-1 correction, the template is never asserted as
      // the literal `74px minmax(0, 1fr) …`: the computed form resolves `minmax`
      // to pixels and moves with the viewport. The ends (74px / 72px), the track
      // count and `gap`/`padding` are what is checkable — and they are the same
      // three things the row's own rules above already pin, which is what makes
      // the two sides comparable.
      { kind: "computed", probe: ".td-list-head", property: "display", equals: "grid", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", startsWith: "74px", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", endsWith: "72px", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", tokens: 6, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gap", equalsPx: 12, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "paddingLeft", equalsPx: 12, when: "list view" },
      // A head per group — the resident skeleton group's and the data group's —
      // and exactly three of the six labels carry the hide class the row cells
      // carry, so the ≤759px rule reaches both sides of the same column.
      { kind: "computed", probe: ".td-list-head", count: 2, when: "list view" },
      { kind: "computed", probe: ".td-list-head .td-hide-sm", count: 3, when: "list view" },
      // The head's *text* is never its i18n key (the failure a "render the key"
      // regression would produce). Which key each of the six seats carries, in
      // order, and the loading caption's single span, are relations a probe
      // cannot index — `dom-smoke.mjs` reads them.
      { kind: "text", probe: ".td-list-head", matches: "^(?!list\\.)\\S", when: "list view" },
      // R8 ③ — the row's identifier wears the single-line guard too.
      { kind: "classes", probe: "[data-list-identifier]", includes: ["td-id"], when: "list view" },
      { kind: "computed", probe: "[data-list-identifier]", property: "whiteSpace", equals: "nowrap", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "display", equals: "grid", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", startsWith: "74px", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", endsWith: "72px", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", tokens: 6, when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "minHeight", equalsPx: 40, when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "paddingLeft", equalsPx: 12, when: "list view" },
      // The status cell is the same chip the drawer's head wears, and the
      // priority cell the same read-out the card wears — so a status and a
      // priority read identically in both views (R6 ⑤/⑥). The chip's dot is
      // 6px here, not the card dot's 8px.
      { kind: "classes", probe: "[data-list-status]", includes: ["badge-sm", "td-chip", "td-chip-status"], when: "list view" },
      { kind: "computed", probe: "[data-list-status] .td-status-dot", property: "width", equalsPx: 6, when: "list view" },
      { kind: "computed", probe: "[data-list-status] .td-status-dot", property: "height", equalsPx: 6, when: "list view" },
      { kind: "classes", probe: "[data-list-priority]", includes: ["td-pri"], when: "list view" },
      { kind: "computed", probe: "[data-list-priority]", property: "fontSize", equalsPx: 11, when: "list view" },
      {
        kind: "absent",
        selector: "[data-list][hidden]",
        when: "list view",
      },
      {
        kind: "manual",
        note:
          "[data-list] is mutually exclusive with [data-board] (toggled by the `hidden` " +
          "attribute), so the two can never be shown at once.",
      },
      {
        kind: "manual",
        note:
          "Rows are projected from the cards that survive the active filters, so board and list " +
          "can never disagree. This is a behavioural relation between two live counts — the " +
          "browser layer checks it with the list view active; no fixture count is asserted.",
      },
    ],
  },

  {
    id: "B09",
    title: "Task detail drawer",
    root: "[data-detail-drawer]",
    scope: "detail",
    status: "active",
    required: [
      "[data-detail-overlay]",
      "[data-detail-identifier]",
      "[data-detail-title]",
      "[data-detail-status-chip]",
      "[data-detail-status-chip-label]",
      "[data-detail-close]",
      "[data-detail-props]",
      "[data-detail-status]",
      "[data-detail-status-label]",
      "[data-detail-priority]",
      "[data-detail-priority-label]",
      "[data-detail-assignee]",
      "[data-detail-assignee-avatar]",
      "[data-detail-assignee-label]",
      "[data-detail-assignee-platform]",
      "[data-detail-reporter]",
      "[data-detail-reporter-avatar]",
      "[data-detail-reporter-label]",
      "[data-detail-project]",
      "[data-detail-project-label]",
      "[data-detail-labels]",
      "[data-detail-id]",
      "[data-detail-id-copy]",
      "[data-detail-version]",
      "[data-detail-tabs]",
      "[data-detail-tab]",
      "[data-detail-panel]",
      "[data-detail-description]",
      "[data-detail-relations]",
      "[data-relation-link]",
      "[data-detail-agent-session]",
      "[data-detail-agent-session-body]",
      "[data-agent-session]",
      "[data-detail-attachments]",
      "[data-detail-comments]",
      "[data-comment-form]",
      "[data-comment-input]",
      "[data-comment-submit]",
      "[data-detail-activity]",
      "[data-detail-templates]",
      "[data-detail-for]",
      "[data-slot]",
      "[data-detail-save]",
      "[data-detail-save-error]",
      "[data-detail-save-field]",
      // T-20261014-212017-4 — the drawer's four edit surfaces, whose shells are
      // in the document whether or not a card is open (like every other hook of
      // this block): the two property menus, the markdown editor's section, the
      // file section and the dependency chips' control.
      "[data-detail-status-combo]",
      "[data-detail-status-menu]",
      "[data-detail-status-option]",
      "[data-detail-priority-combo]",
      "[data-detail-priority-menu]",
      "[data-detail-priority-option]",
      "[data-detail-description-section]",
      "[data-detail-description-edit]",
      "[data-detail-description-save]",
      "[data-detail-description-cancel]",
      "[data-detail-attachments-section]",
      "[data-attachment-upload]",
      "[data-attachment-file]",
      "[data-detail-depends]",
      "[data-detail-depends-input]",
      "[data-detail-depends-menu]",
      "[data-detail-depends-chips]",
      "[data-detail-readonly]",
    ],
    states: [
      "[data-detail-drawer][data-state=\"open\"]",
      "[data-detail-drawer][data-state=\"closing\"]",
      // …and the four surfaces' *data-driven* hooks, which exist only while a
      // card is open (a row per file, a chip per dependency, a menu row per
      // candidate card).
      "[data-attachment-download]",
      "[data-attachment-remove]",
      "[data-detail-depends-chip]",
      "[data-detail-depends-remove]",
      "[data-detail-depends-option]",
      // M2 · data-driven rows. They exist only while a task is open, so they are
      // asserted in the driven pass (`when: "drawer open"`) below.
      "[data-attachment-row]",
      "[data-attachment-name]",
      "[data-attachment-size]",
      "[data-activity-row]",
      "[data-activity-actor]",
      "[data-activity-ts]",
    ],
    rules: [
      { kind: "count", selector: "[data-detail-drawer]", equals: 1 },
      { kind: "count", selector: "[data-detail-overlay]", equals: 1 },
      // R10 ② — the drawer's three editable fields save as they change, and the
      // one region above them says what the save is doing. `data-save-state` is
      // the source of truth (`idle` ships, as the resting state) and
      // `[data-detail-save-error]` is its only visible half — an attribute
      // carrier plus one `role="alert"` block, both written by the same act, so
      // "the state says `error`" and "the block is on screen" can never disagree
      // (contract §8 R5).
      //
      // What is *not* here: the triggers. Focus loss, a roster row being
      // accepted and a chip arriving or leaving are events, and the relation
      // "committing moves the attribute off `idle`" is measured between them in
      // `web/scripts/dom-smoke.mjs` — a probe reads a document, it cannot press
      // a key.
      { kind: "count", selector: "[data-detail-save]", equals: 1 },
      {
        kind: "domain",
        selector: "[data-detail-save]",
        attribute: "data-save-state",
        subset: DOMAINS.SAVE_STATE,
      },
      // …the resting state, before any card is even open: `idle`, with the
      // alert off. Opening a card resets to exactly this.
      { kind: "count", selector: "[data-detail-save][data-save-state=\"idle\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-save-error]", equals: 1 },
      { kind: "count", selector: "[data-detail-save-error][role=\"alert\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-save-error][hidden]", equals: 1 },
      { kind: "computed", probe: "[data-detail-save-error]", property: "display", equals: "none" },
      // T-20261014-212017-4 — R10's save region now covers **eight** fields: the
      // three M6b rows plus the four the drawer's edit surfaces added (status,
      // priority, description, attachments, depends). The number is the
      // prototype's own (`design/prototype/index.html` carries eight
      // `data-detail-save-field` hooks) and the domain below spells the values.
      { kind: "count", selector: "[data-detail-save-field]", equals: 8 },
      {
        kind: "domain",
        selector: "[data-detail-save-field]",
        attribute: "data-detail-save-field",
        subset: DOMAINS.SAVE_FIELD,
      },
      // The hook rides the three rows that already exist — that round added an
      // attribute, never a node (contract §4.3 note 2). The round after it put
      // the hook on the section/combo roots of its own four controls, which is
      // the same rule: one hook per editable field, on the field's own root.
      { kind: "count", selector: "[data-detail-assignee][data-detail-save-field=\"assignee\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-reporter][data-detail-save-field=\"reporter\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-labels][data-detail-save-field=\"labels\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-status-combo][data-detail-save-field=\"status\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-priority-combo][data-detail-save-field=\"priority\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-description-section][data-detail-save-field=\"description\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-attachments-section][data-detail-save-field=\"attachments\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-depends][data-detail-save-field=\"depends\"]", equals: 1 },
      // T-20261014-212017-4 · the four edit surfaces, block by block.
      //
      // ① status / priority — the prototype's `.td-combo` menus over fixed
      // enumerations (B22's menu shape). Seven status rows and five priority
      // rows, both value sets the domain's own; `data-status` stays on the status
      // option buttons (the existing `[data-status=…]` colour rules key on it),
      // while priority rides on each row's `.td-pri` **inside** the button so the
      // row's label keeps the ink colour.
      { kind: "count", selector: "[data-detail-status-option]", within: "[data-detail-status-menu]", equals: 7 },
      { kind: "domain", selector: "[data-detail-status-option]", attribute: "data-status-value", subset: DOMAINS.STATUS },
      { kind: "count", selector: "[data-detail-priority-option]", within: "[data-detail-priority-menu]", equals: 5 },
      { kind: "domain", selector: "[data-detail-priority-option]", attribute: "data-priority-value", subset: DOMAINS.PRIORITY },
      { kind: "count", selector: "button[data-detail-status]", within: "[data-detail-status-combo]", equals: 1 },
      { kind: "count", selector: "button[data-detail-priority]", within: "[data-detail-priority-combo]", equals: 1 },
      // Both menus ship closed — the resting document says so, and a menu that
      // started open would be an edit surface nobody asked for.
      { kind: "count", selector: "[data-detail-status-menu][hidden]", equals: 1 },
      { kind: "count", selector: "[data-detail-priority-menu][hidden]", equals: 1 },
      // ② description — one section, two faces, and the mode attribute is the
      // only switch. At rest it is `read`, with the editor present but out.
      { kind: "domain", selector: "[data-detail-description-section]", attribute: "data-detail-description-mode", subset: DOMAINS.DESCRIPTION_MODE },
      { kind: "count", selector: "[data-detail-description-section][data-detail-description-mode=\"read\"]", equals: 1 },
      { kind: "count", selector: "[data-md-editor]", within: "[data-detail-description-section]", equals: 1 },
      { kind: "count", selector: "[data-md-source]", within: "[data-detail-description-section]", equals: 1 },
      { kind: "count", selector: "[data-detail-description-save]", within: "[data-detail-description-section]", equals: 1 },
      { kind: "count", selector: "[data-detail-description-cancel]", within: "[data-detail-description-section]", equals: 1 },
      // The drawer's editor is **not** the create dialog's: the create hook is
      // the dialog's own seat and the drawer must not claim it (B10/§4.2).
      { kind: "count", selector: "[data-create-task-description]", within: "[data-detail-description-section]", equals: 0 },
      // ③ attachments — the section's upload control and its hidden picker. The
      // rows themselves are data-driven (`states` above) and are asserted in the
      // driven pass, where a card with files is actually open.
      { kind: "count", selector: "[data-attachment-upload]", within: "[data-detail-attachments-section]", equals: 1 },
      { kind: "count", selector: "[data-attachment-file]", within: "[data-detail-attachments-section]", equals: 1 },
      // ④ depends_on — one chip control over the `blocks` edge (PROTOCOL §①).
      { kind: "count", selector: "[data-detail-depends-input]", within: "[data-detail-depends]", equals: 1 },
      { kind: "count", selector: "[data-detail-depends-menu]", within: "[data-detail-depends]", equals: 1 },
      { kind: "count", selector: "[data-detail-depends-chips]", within: "[data-detail-depends]", equals: 1 },
      // E-2 — the read-only badge exists and is **off** at rest: the root carries
      // no `data-readonly` until a terminal card is opened, so a drawer that
      // leaked the attribute would red here rather than on the next card.
      { kind: "count", selector: "[data-detail-readonly][hidden]", equals: 1 },
      // A terminal card's one writable action exists in the document and is
      // hidden at rest; the reason panel is rendered only while the prompt is
      // open, so it is not counted here.
      { kind: "count", selector: "[data-detail-reopen][hidden]", equals: 1 },
      { kind: "count", selector: "[data-detail-drawer][data-readonly=\"true\"]", equals: 0 },
      // R8 ③ — the drawer's identifier wears the same single-line guard as the
      // card's and the list row's (the cap itself is the render-layer slice), and
      // the drawer **root** carries the full identifier. The root's attribute is
      // the only read-back of identity: the rendered text is a display value, so
      // nothing may resolve a task from it (`design/fidelity-r8.md` §9 R5).
      //
      // R12 — the drawer head is the one render point that shows the id **whole**
      // (`design/fidelity-r12.md` §2.1/§2.2): it keeps `.td-id` (the single-line
      // guard, whose box and baseline the two views still share) and **adds** the
      // variant `.td-id-full`, which withdraws the width cap. Both classes, on
      // this one element — the variant is an addition, never a replacement.
      { kind: "classes", probe: "[data-detail-identifier]", includes: ["td-id", "td-id-full"] },
      { kind: "computed", probe: "[data-detail-identifier]", property: "whiteSpace", equals: "nowrap" },
      // R12 — and the head's text carries no ellipsis, whatever card is open.
      // This is the **card-agnostic** half of "逐字完整显示": a rule cannot choose
      // which card the drawer pass opens (it must be the attachment-carrying one,
      // whose id is short), so the *specific* sample is measured where the press
      // can be aimed, in `web/scripts/dom-smoke.mjs`'s R12-id section. What this
      // rule adds is the negative that holds for every card: the head never
      // renders the truncation marker at all.
      //
      // Note (T-20261014-001418) — the cap is ten since 2026-10-14, so the
      // fixture's longest id (`PROJ-0007`, nine) is now **below** it: the head
      // and its own card render the same string, and the "the two disagree about
      // one id" half of R12's evidence is no longer constructible from the
      // fixture. The reverse anchor that survives is the width cap
      // (`.td-id` ≠ `.td-id-full`), asserted above and measured in dom-smoke.
      { kind: "text", probe: "[data-detail-identifier]", matches: "^[^…]+$", when: "drawer open" },
      // …and the variant is scoped to that one element. A probe can name the
      // `td-` class the design owns, so the absence is written as an exact count
      // rather than a valueless `absent` (which would demand the class be gone
      // from the whole bundle): one match in board view and one in list view is
      // the drawer head and nothing else — a card or a list row wearing it would
      // make two. This is contract §5 A6′ («不得外溢»), the reverse of A6 above.
      { kind: "computed", probe: ".td-id-full", count: 1 },
      { kind: "computed", probe: ".td-id-full", count: 1, when: "list view" },
      // The root carries the attribute (the value it carries *is* the assertion,
      // and a value is a relation — `dom-smoke.mjs` compares it against the head's
      // `title` and against the card's own `data-identifier`).
      { kind: "count", selector: "[data-detail-drawer][data-identifier]", equals: 1 },
      { kind: "domain", selector: "[data-detail-drawer]", attribute: "data-state", subset: DOMAINS.DRAWER_STATE },
      { kind: "domain", selector: "[data-slot]", attribute: "data-slot", subset: DOMAINS.SLOT },
      // R6 ⑥ — the head's status chip. The class set is the prototype's own, the
      // 18px height is the box both of the prototype's `.td-chip` declarations
      // agree on, and the dot is 6px (the chip overrides the card dot's 8px).
      // The chip's **background and radius are deliberately not asserted**: the
      // prototype declares `.td-chip` twice in one layer and the two disagree
      // (`accent-soft`/999px vs `surface`/4px), so the value is parked on the
      // design owner's ruling (F6) — the assertion lands with the ruling.
      { kind: "classes", probe: "[data-detail-status-chip]", includes: ["badge-sm", "td-chip", "td-chip-status"] },
      { kind: "computed", probe: "[data-detail-status-chip]", property: "height", equalsPx: 18, when: "drawer open" },
      {
        kind: "computed",
        probe: "[data-detail-status-chip] .td-status-dot",
        property: "width",
        equalsPx: 6,
        when: "drawer open",
      },
      {
        kind: "computed",
        probe: "[data-detail-status-chip] .td-status-dot",
        property: "height",
        equalsPx: 6,
        when: "drawer open",
      },
      // M2 · the drawer's two data-driven streams, asserted where they exist: an
      // open drawer on a task with attachments and history. The rest state cannot
      // show them (the body is empty without a task), which is why these carry a
      // driven precondition rather than riding the default pass.
      {
        kind: "count",
        selector: "[data-attachment-row]",
        within: "[data-detail-attachments]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-activity-row]",
        within: "[data-detail-activity]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-activity-ts]",
        within: "[data-detail-activity]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-i18n=\"attachments.none\"]",
        within: "[data-detail-attachments]",
        equals: 0,
        when: "drawer open",
      },
      {
        kind: "identical-hookset",
        selector: "[data-detail-for]",
        within: "[data-detail-templates]",
      },
      /* ---- R7 ④ · the close button lives in the head's top row (§2.4) -----
         The button shares its flex row with the identifier and the chip,
         levels with it and sits at that row's inline end. Its glyph is an
         `svg.td-icon` (✕), not a text character. The *relations* — same
         parent, centre lines level, flush with the row's right edge, above the
         title — need `parentElement`/`getBoundingClientRect` and are measured
         in `web/scripts/dom-smoke.mjs`; what is declarable here is the glyph
         and the pushed-right box. */
      { kind: "computed", probe: "[data-detail-close] svg.td-icon", count: 1, when: "drawer open" },
      {
        kind: "computed",
        probe: "[data-detail-close] svg.td-icon",
        property: "fill",
        equals: "none",
        when: "drawer open",
      },
      {
        kind: "computed",
        probe: "[data-detail-close] svg.td-icon",
        property: "strokeWidth",
        equals: "1.5px",
        when: "drawer open",
      },
      // `margin-inline-start` resolves `auto` to the used px value (R7-2), so
      // the declarable half of "pushed right" is "greater than zero".
      {
        kind: "computed",
        probe: "[data-detail-close]",
        property: "marginInlineStart",
        minPx: 1,
        when: "drawer open",
      },
      {
        kind: "manual",
        note:
          "[data-detail-close] shares its parent with [data-detail-identifier] " +
          "(same flex row, `flex-direction: row`), is level with it on the " +
          "centre line, sits flush with the row's inline end, and stands " +
          "**above** [data-detail-title] — the prototype's head order (R7 ④, " +
          "`design/fidelity-r7.md` §2.4).",
      },
      {
        kind: "manual",
        note:
          "`template[data-detail-for=\"TD-…\"]` holding one [data-slot] per card is the " +
          "prototype's jQuery mechanism (measure it per card: 18 templates, 18 description and " +
          "18 activity slots, 16 comments, 15 agent-session, 11 attachments, 9 relations). " +
          "A component-based implementation renders one drawer instead; the **hooks** are the " +
          "contract, the template multiplicity is not.",
      },
      /* ---- R14 §8.1 D01–D50 · the drawer's shell, head and body ------------
         The round's own decisions, each one a fact no earlier rule reached. The
         *values* of the prototype's visual spec (R14 §3) were measured bilaterally
         during the round, on the prototype; what a declaration can state is
         asserted here — which element is which, which attribute is the
         state source, and which of the two ends of a pair sits above the other.
         Everything below was first measured on the prototype in
         `design/fidelity-r14.md` §5 (69/69) and then on the shipped drawer. */
      // R14 §8 U4 — `data-state` is the drawer's **only** state source: the
      // `aside` carries no `hidden` at all (its closed face is the prototype's
      // `translateX(100%)` + `visibility: hidden`, stated in `.td-drawer`). The
      // scrim keeps its own `hidden`, asserted with the rest of the save state
      // above; this rule pins the half that changed. A valueless compound, so it
      // forbids the *combination* on that element and nothing else — the scrim,
      // the dialogs and every `[hidden]` in the shell are untouched by it.
      { kind: "absent", selector: "[data-detail-drawer][hidden]" },
      // R14 §2.1 / D20 (A7) — the accessible name's two seats.
      { kind: "count", selector: "[data-detail-drawer][aria-labelledby=\"td-detail-title\"]", equals: 1 },
      { kind: "count", selector: "[data-detail-title][id=\"td-detail-title\"]", equals: 1 },
      // R14 D05/D06 (A22) — the pair's two rungs: the veil one *under* the drawer.
      { kind: "computed", probe: "[data-detail-overlay]", property: "zIndex", equals: "40" },
      { kind: "computed", probe: "[data-detail-drawer]", property: "zIndex", equals: "50" },
      // R14 D01 (B1/B21) — the drawer's reading width. The prototype's
      // `--shell-drawer` is 520px; the implementation deliberately opens at
      // 780px (product override, registered in `design/BLOCKS.md` §B09). Stated
      // as a **px string** rather than with `equalsPx`, for the reason
      // `strokeWidth` above is: the stale-prose guard
      // (`web/blocks.contract.test.mjs`) forbids a *numeric* rule value that
      // could be mistaken for one of the recorded prose counts. The
      // `max-width: 100vw` companion keeps a narrow viewport full-width and is
      // not re-pinned here — a rule for it would be measuring the viewport, not
      // the drawer.
      { kind: "computed", probe: "[data-detail-drawer]", property: "width", equals: "780px" },
      // R14 D10/D12 (B4/B6) — the head and the scrolling host are the
      // prototype's own boxes, worn by their own classes.
      { kind: "computed", probe: ".td-drawer-head", count: 1 },
      { kind: "computed", probe: ".td-drawer-body", count: 1 },
      // R14 D26 (A16) — the three single-choice properties are **controls**: the
      // probe names the tag, so a `<div>` wearing the hook matches nothing and
      // the rule fails rather than passing vacuously.
      { kind: "computed", probe: "button[data-detail-status]", count: 1 },
      { kind: "computed", probe: "button[data-detail-priority]", count: 1 },
      { kind: "computed", probe: "button[data-detail-project]", count: 1 },
      // R14 D24 (A23) — the property grid's catalogue seats. It was "eight
      // `data-i18n` attributes, one per label row"; since T-20261014-212017-4 the
      // grid also *contains* the status and priority menus, whose option labels
      // are seats too, so the seat count is the grid's own arithmetic over the
      // design's own vocabulary: **8 property labels + 7 status options + 5
      // priority options = 20**. That is a domain-fixed multiplicity of the kind
      // this file's header allows (7 statuses ⇒ 7 columns, 3 editor modes), and
      // it is a stronger statement than the old one: the grid holds exactly
      // these seats and nothing else. A sixth priority or an eighth property row
      // reds here, which is what the row-per-label rule meant all along.
      { kind: "count", selector: "[data-i18n]", within: "[data-detail-props]", equals: 20 },
      // R14 D32/D37/D38 (A13/A14/A15) — *where* each body hook rides: the
      // description hook is on the content container (`div.td-gfm`), the four
      // stream hooks are on a `div`, and the session hook is on the `section`
      // itself. A tag in a probe is part of the grammar (PROBE GRAMMAR), so the
      // element kind is declarable even though the hook is not.
      // v4 — the six-tab shell. All six panels stay in the DOM (`hidden`, not
      // `v-if`), so the hook counts hold while the drawer is closed; the
      // Sessions tab itself is hidden by data, not removed.
      { kind: "computed", probe: "[data-detail-tabs]", count: 1 },
      { kind: "computed", probe: "[data-detail-tab]", count: 6 },
      { kind: "computed", probe: "[data-detail-panel]", count: 6 },
      { kind: "computed", probe: "div.td-gfm[data-detail-description]", count: 1 },
      { kind: "computed", probe: "div[data-detail-relations]", count: 1 },
      { kind: "computed", probe: "div[data-detail-attachments]", count: 1 },
      { kind: "computed", probe: "div[data-detail-comments]", count: 1 },
      { kind: "computed", probe: "div[data-detail-activity]", count: 1 },
      { kind: "computed", probe: "section[data-detail-agent-session]", count: 1 },
      // R14 D28 (A18) — the id copy control is the prototype's `.td-copy` box and
      // its glyph is an inline icon, not a text character.
      { kind: "classes", probe: "[data-detail-id-copy]", includes: ["td-copy"] },
      { kind: "computed", probe: "[data-detail-id-copy] .td-icon-sm", count: 1 },
      // R14 D50 (B14/B15) — the label chip is the prototype's `.badge.td-chip`
      // and its remove control is a real button holding `svg.td-icon-sm`. Chips
      // exist only while a task with labels is open, so these two carry the
      // driven precondition.
      { kind: "classes", probe: "[data-detail-label-chip]", includes: ["td-chip"], when: "drawer open" },
      { kind: "computed", probe: "[data-detail-label-remove] .td-icon-sm", count: 1, when: "drawer open" },
      {
        kind: "manual",
        note:
          "The root is `role=\"dialog\"` + `aria-modal=\"true\"`; [data-detail-id-copy] carries " +
          "`data-copy-value` and writes to the clipboard (a browser API); [data-detail-description] " +
          "renders sanitised GFM.",
      },
      {
        kind: "manual",
        note:
          "Implementation supplement: the panel opens before its card is read. `openDetail()` " +
          "clears the detail and sets `drawerState` to `open` in one act, so `data-state` is " +
          "`open` while the detail is null and the drawer renders `[data-detail-skeleton]` " +
          "(head + body, daisyUI `skeleton` bars in the drawer's own shells) instead of the " +
          "`[data-detail-*]` parts. The root carries `aria-busy`; the loading head keeps the " +
          "`#td-detail-title` seat, and `[data-detail-close]` is live throughout. This branch is " +
          "not resident at rest, so every count above is unchanged; measured in " +
          "`web/scripts/dom-smoke.mjs` (the skeleton section's S6).",
      },
    ],
  },

  {
    id: "B10",
    title: "Create-task modal",
    root: "[data-create-task]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-form]",
      "[data-create-two-col]",
      "[data-create-left]",
      "[data-create-right]",
      "[data-create-task-title]",
      "[data-create-task-description]",
      "[data-create-task-priority]",
      "[data-create-task-project]",
      "[data-create-task-status]",
      "[data-modal-close]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-create-task]", equals: 1 },
      // R8 ① — the panel has a hook of its own. Until this round the only way to
      // address it was a positional anchor (`[data-create-task] > div`), which the
      // contract's selector grammar forbids, so the dialog's edge, elevation and
      // surface could not be asserted at all (the contract's R8-3 correction).
      // Its dark edge (`--brand-border-strong`) and its scrim are measured in
      // `dom-smoke.mjs`, where the theme can actually be set.
      { kind: "count", selector: "[data-create-task-panel]", equals: 1 },
      { kind: "count", selector: "[data-create-two-col]", equals: 1 },
      { kind: "count", selector: "[data-create-left]", equals: 1 },
      { kind: "count", selector: "[data-create-right]", equals: 1 },
      // R10 ③ — the description fills the column it sits in, and the columns are
      // the height of the taller one. The left column is the short one (the
      // routing column carries eight fields), so it is the one that has to be
      // told to stretch: left to its own content height it ended 240px above the
      // dialog's last edge, with the editor stranded over a band of empty box.
      //
      // The stretch is declared, not inherited. A grid container's `align-items`
      // computes to `normal` when nothing says otherwise, and `normal` behaves
      // like `stretch` here — but "behaves like" is not "says", and the grid's
      // default is the one thing a later `items-start` would silently reuse.
      {
        kind: "computed",
        probe: "[data-create-two-col]",
        property: "alignItems",
        equals: "stretch",
      },
      { kind: "computed", probe: "[data-create-left]", property: "display", equals: "flex" },
      { kind: "computed", probe: "[data-create-left]", property: "flexDirection", equals: "column" },
      // The chain's next link: the field that fills the column is a column flex
      // box *itself*. As a block container it would hand the editor nothing but
      // its own line box, and the editor's `flex: 1 1 auto` would have no parent
      // to resolve against — the second break in the chain, measured at 302px.
      { kind: "computed", probe: ".td-field-grow", property: "display", equals: "flex" },
      { kind: "computed", probe: ".td-field-grow", property: "flexDirection", equals: "column" },
      {
        kind: "manual",
        note:
          "[data-create-two-col] holds exactly two tracks, `minmax(0,1.6fr)` / `minmax(0,1fr)`, " +
          "so neither a long title nor the editor can overflow the dialog; at ≤760px the tracks " +
          "stack and the dialog scrolls internally. The routing column carries the eight field " +
          "groups: priority, assignee (B22), project, status, reporter (B22), labels (B25), " +
          "parent (B24), depends-on (B24).",
      },
      {
        kind: "manual",
        note:
          "[data-modal-close] dismisses; the single writer also serves as the post-submit reset, " +
          "and must additionally clear the relation inputs, the parent chip, the depends-on chips " +
          "and the label control's input/chips/menu — none of which a native form reset reaches.",
      },
      {
        kind: "manual",
        note: "The two relation fields are marked Optional; both leave the task creatable when empty.",
      },
    ],
  },

  {
    id: "B11",
    title: "Create-project modal",
    root: "[data-create-project]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-project-form]",
      "[data-create-project-name]",
      "[data-create-project-prefix]",
      "[data-modal-close]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-create-project]", equals: 1 },
      // R8 ① — B11 rides B10's panel geometry, so it rides its hook too: the dark
      // edge rule in `app.css` names both panels, and the scrim token is shared.
      { kind: "count", selector: "[data-create-project-panel]", equals: 1 },
    ],
  },

  {
    id: "B12",
    title: "Empty states",
    root: "[data-empty]",
    scope: "board",
    status: "active",
    required: ["[data-empty]", "[data-empty-kind]", "[data-empty-kind=\"column\"]", "[data-empty-kind=\"no-results\"]"],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-empty]", attribute: "data-empty-kind", subset: DOMAINS.EMPTY_KIND },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"column\"]",
        within: "[data-column-body]",
        max: 1,
        when: "board view",
      },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"no-results\"]",
        max: 1,
        when: "board view",
      },
      // R10 ① — the two kinds are two different statements, and the board-level
      // one is never the column-level one: the no-results block lives at the
      // view level, outside the board's own horizontal scroller, so it is never
      // inside a column body. That is what keeps it out of a per-column count
      // and, in the other direction, keeps the seven "No tasks" blocks out of
      // the board's two-state tally.
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"no-results\"]",
        within: "[data-column-body]",
        equals: 0,
      },
      /* T-20261013-160505 — the family's own face, and the residency the design
       * states in markup. The six non-result surfaces (this block's two, B08's
       * no-rows row, B17's error, B26.5's two and B27.3's one) had grown into five
       * hand-rolled utility stacks that each drifted from the design's `.td-empty`
       * by the same four properties: `gap-1`'s 4px over 8px, `p-4`'s even 16px over
       * `16px 12px`, `rounded-lg`'s 8px over `--r-md`'s 6px, and a title/hint
       * whose sizes are the design's 12px/11px (or 14px/12px under `-lg`, a
       * parent→child relation no utility list can carry). The family now lives once
       * in `app.css`; these rules are what keeps it from being re-flattened into
       * utilities one surface at a time. A `computed` probe reads the *declared*
       * value, so it holds for a block that is `hidden` at rest — which every one
       * of the six is. */
      { kind: "classes", probe: "[data-empty][data-empty-kind=\"column\"]", includes: ["td-empty"] },
      { kind: "classes", probe: "[data-empty][data-empty-kind=\"no-results\"]", includes: ["td-empty", "td-empty-lg"] },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "gap", equalsPx: 8 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "paddingTop", equalsPx: 16 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "paddingRight", equalsPx: 12 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "borderRadius", equalsPx: 6 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "borderTopStyle", equals: "dashed" },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"]", property: "textAlign", equals: "center" },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"] .td-empty-title", property: "fontSize", equalsPx: 12 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"column\"] .td-empty-hint", property: "fontSize", equalsPx: 11 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"no-results\"]", property: "paddingTop", equalsPx: 40 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"no-results\"]", property: "paddingRight", equalsPx: 24 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"no-results\"] .td-empty-title", property: "fontSize", equalsPx: 14 },
      { kind: "computed", probe: "[data-empty][data-empty-kind=\"no-results\"] .td-empty-hint", property: "fontSize", equalsPx: 12 },
      /* The seven column-level empties are **resident** — one per column body,
       * `hidden` while the column has cards — exactly as the prototype ships them
       * (`design/prototype/index.html`, B12: seven, all `hidden` at rest) and as
       * every other state member of this app is (B26.5 asserts its own `count: 2`
       * for the same reason). A `v-if` made the block unobservable at rest, which
       * is what the two-state rounds settled *against* — and R10 ① is explicit
       * that these seven are **never** counted in the board-level tally, so their
       * presence costs the board-level pair nothing. */
      { kind: "count", selector: "[data-empty][data-empty-kind=\"column\"]", equals: 7 },
      /* T-20261014-100326 — the two seats of B12's state family.
       *
       * Both blocks put a `data-i18n` seat on every copy line they render *except*
       * their button, so dropping that one hook — or moving it onto a wrapper —
       * took the block's whole pressable copy out of the addressable surface while
       * every rule above stayed green. `web/scripts/dom-smoke.mjs`'s
       * `i18n.parity` leg cannot close this: it proves a *present* hook resolves
       * through the catalogue, and a removed hook leaves it nothing to resolve.
       * The two counts are domain-fixed, not fixture-derived: one board-level
       * empty state and one column-level empty state per column (7 columns, B05).
       *
       * Values from the design oracle, read statically on
       * `design/prototype/index.html` (the live 7-column board page): 1
       * `noResults.clear` seat in the sole `no-results` block, 7
       * `column.empty.add` seats, one per `column` block.
       *
       * Each seat appears one extra time in the prototype, inside B18's states
       * showcase (`:4174`, *hidden by default, opened from the sidebar*) —
       * `:4237` in the `data-empty-column` demo card (`:4230`), `:4253` in the
       * `data-empty-results` one (`:4243`). Three things, **not** a code fence,
       * exclude them: those blocks are prototype-only (B18, this file), they are
       * hooked `data-empty-column` / `data-empty-results` rather than
       * `data-empty` + `data-empty-kind` (so the seat's own block selector never
       * reaches them), and they sit outside `[data-board]`. An earlier revision
       * of this comment called them `<pre><code>` document fragments; that was
       * wrong — the code fences the `[data-column]` rows are scoped against are
       * at :2429/:3365 and are a different hook's problem entirely. */
      { kind: "count", selector: "[data-i18n=\"noResults.clear\"]", equals: 1 },
      {
        kind: "count",
        selector: "[data-i18n=\"noResults.clear\"]",
        within: "[data-empty][data-empty-kind=\"no-results\"]",
        equals: 1,
      },
      {
        kind: "count",
        selector: "button[data-i18n=\"noResults.clear\"]",
        within: "[data-empty][data-empty-kind=\"no-results\"]",
        equals: 1,
      },
      { kind: "count", selector: "[data-i18n=\"column.empty.add\"]", equals: 7 },
      {
        kind: "count",
        selector: "button[data-i18n=\"column.empty.add\"]",
        within: "[data-empty][data-empty-kind=\"column\"]",
        equals: 1,
      },
      {
        kind: "manual",
        note:
          "The large empty state is the class `.td-empty-lg` on " +
          "`[data-empty][data-empty-kind=\"no-results\"]` — there is no `data-empty-lg` " +
          "attribute, and a class cannot appear in this contract. The shipped markup is " +
          "`<div class=\"td-empty td-empty-lg\" data-empty data-empty-kind=\"no-results\" hidden>`. " +
          "(BLOCKS.md B12 used to write it as `[data-empty-lg]`; Elon's ruling ② held the doc " +
          "wrong rather than the DOM, and B12 was corrected to the markup above.) The " +
          "`classes` rule above now holds the shipped implementation to that exact pair — " +
          "until T-20261013-160505 it carried six utilities instead and the class never " +
          "appeared in the app at all.",
      },
      {
        kind: "manual",
        note:
          "The large empty state opens on a 28px Sentinel Watch mark whose two lead meerkats read " +
          "`--color-td-ink-3`, so on an empty board the on-duty sentinel is the only lit element.",
      },
    ],
  },

  {
    id: "B13",
    title: "Loading state",
    root: "[data-skeleton]",
    scope: "board",
    status: "active",
    required: [],
    states: ["[data-skeleton]"],
    rules: [
      // R9 ③ — the skeleton is the `loading` state's **only** carrier, and it is
      // resident: the group is not unmounted when the read returns, it is hidden
      // — by the `hidden` attribute the block's own state writes and by the rule
      // on `[data-list][data-list-state="data"]` in `app.css`. That is what makes
      // the two states exclusive even for a document that has not run a read.
      { kind: "count", selector: "[data-skeleton]", equals: 1 },
      {
        kind: "manual",
        note:
          "Three shimmer rows inside the skeleton group. The rows themselves carry no hooks, so " +
          "their count is not asserted; the group's *presence* and its single caption span are " +
          "(the caption's row-span rule is B08's `.td-list-head > :only-child`). The prototype's " +
          "own states gallery carried a second, static copy of this loading state " +
          "([data-loading-state]); that gallery is prototype-only and does not ship, which is why " +
          "the count above is one and not two.",
      },
      {
        kind: "manual",
        note:
          "Implementation supplement (product ruling, not a prototype page): the board, the " +
          "activity feed and the waiting queue hold their own skeletons while a real read is in " +
          "flight — `.td-skel-card` (the shape B18's loading demo draws) inside each of the seven " +
          "columns for B05, a day caption + six rows for B26, four rows for B27. The carriers are " +
          "`[data-view-loading]` on the view root and `[data-view-skeleton=\"board|activity|waiting\"]` " +
          "on the placeholder block; neither is a value of `data-board-state` or `data-list-state`, " +
          "and the activity placeholders add no `data-activity-*` name. The trigger is the read, " +
          "never a timer. Measured in `web/scripts/dom-smoke.mjs` (the skeleton section), not by a " +
          "resting-document count — the placeholders are rendered only in the loading branch.",
      },
    ],
  },

  {
    id: "B14",
    title: "Toast region",
    root: "[data-toast-region]",
    scope: "shell",
    status: "active",
    required: [
      "[data-toast-region]",
      "[data-toast-template]",
      "[data-toast]",
      "[data-toast-text]",
      "[data-toast-kind]",
    ],
    states: ["[data-toast]"],
    rules: [
      { kind: "count", selector: "[data-toast-region]", equals: 1 },
      { kind: "count", selector: "[data-toast-template]", equals: 1 },
      { kind: "domain", selector: "[data-toast]", attribute: "data-toast-kind", subset: DOMAINS.TOAST_KIND },
      {
        kind: "manual",
        note:
          "`role=\"status\"` + `aria-live=\"polite\"` on the region; auto-dismiss after 2.5s. The " +
          "prototype's states gallery also rendered the three kinds statically with " +
          "`data-state=\"static\"`, so they were never auto-dismissed there; that gallery (B18) is " +
          "prototype-only and does not ship.",
      },
    ],
  },

  {
    id: "B15",
    title: "Legend",
    root: "[data-legend]",
    scope: "shell",
    status: "prototype-only",
    required: ["[data-legend]", "[data-legend-status]", "[data-legend-priority]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-legend]", equals: 1 },
      {
        kind: "manual",
        note:
          "The legend shows one chip per status (7, i.e. every DOMAINS.STATUS value) and one per " +
          "priority (5, i.e. every DOMAINS.PRIORITY value). The chips carry no hooks — each " +
          "selector is a single host element — so this is a domain statement, not a countable " +
          "one. It sits at the bottom of the sidebar so every status and priority fits one " +
          "screenshot. **Prototype-only**: Terry's 2026-10-12 ruling — the legend was a " +
          "product-design demonstration rather than a requirement, so the shipped sidebar " +
          "carries no legend and this block is not asserted against the app.",
      },
    ],
  },

  {
    id: "B16",
    title: "Agent session provenance",
    root: "[data-agent-session]",
    scope: "detail",
    status: "active",
    required: [
      "[data-detail-agent-session]",
      "[data-detail-agent-session-body]",
      "[data-agent-session]",
      "[data-agent-platform]",
      "[data-agent-platform-value]",
      "[data-agent-session-id]",
      "[data-agent-resume]",
    ],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-agent-platform]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "The trail is ordered running first, then `ts` descending. Visibility is " +
          "**data-driven** (`sessions.length > 0`): the section and the Sessions tab hide " +
          "together when the card has no session rows; the assignee kind is not the switch " +
          "(a human-assigned card can carry sessions — the server enforces no " +
          "assignee/session relationship). The `data-agent-platform` seat states the card's " +
          "own platform; historical rows name their own `backend` in a plain badge. How many " +
          "cards carry sessions is fixture data. [data-agent-platform-value] seats the " +
          "session's **platform id** (e.g. `claude`) — the seat is the id, not a CLI flag, " +
          "and that is what the app renders there. The prototype's static sample reads " +
          "`--agent-platform claude`, but that CLI-style declaration is a prototype-only " +
          "expression: `--agent-platform` is neither this seat's content nor a CSS custom " +
          "property this repo defines or uses. Registered as the deviation " +
          "`design/fidelity-r14.md` §8.3 `DF-4`.",
      },
    ],
  },

  {
    id: "B17",
    title: "Error state",
    root: "[data-error-state]",
    scope: "board",
    status: "active",
    required: ["[data-error-state]", "[data-error-retry]", "[data-i18n=\"error.title\"]", "[data-i18n=\"error.hint\"]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-error-state]", min: 1, max: 1 },
      /* T-20261013-160505 — the surface's own face. The design puts the
       * danger-coloured glyph over a **centred** title/hint/Retry stack on one
       * hairline (`design/prototype/src/input.css` `.td-error`, and the B18 demo
       * the block was measured from). The shipped banner was a left-aligned,
       * border-less `m-4` box whose title and hint were 14px/12px — the *large*
       * empty state's type — so the surface the style guide reserves for a failure
       * read like a card of body copy. Its background stays this app's `bg-error/12`
       * (R10's registered deviation from the design's flat `--color-td-danger-soft`
       * — the `computed` leg names no colour, on purpose); the icon's colour is
       * daisyUI's `--color-error`, the identical `#c0392b` the prototype's glyph
       * reads, so no literal enters either stylesheet (C08). */
      { kind: "classes", probe: "[data-error-state]", includes: ["td-error"] },
      { kind: "computed", probe: "[data-error-state]", property: "alignItems", equals: "center" },
      { kind: "computed", probe: "[data-error-state]", property: "borderTopWidth", equalsPx: 1 },
      { kind: "computed", probe: "[data-error-state]", property: "borderRadius", equalsPx: 6 },
      { kind: "computed", probe: "[data-error-state] .td-empty-title", property: "fontSize", equalsPx: 12 },
      { kind: "computed", probe: "[data-error-state] .td-empty-hint", property: "fontSize", equalsPx: 11 },
      {
        kind: "computed",
        probe: "[data-error-state] svg.td-icon",
        property: "color",
        equalsVar: "--color-error",
        count: 1,
      },
      {
        kind: "manual",
        note:
          "`role=\"alert\"`, hidden by default, on the `--color-td-danger-soft` surface the style " +
          "guide reserves for errors; Retry re-runs the real render pass. The prototype " +
          "demonstrated it inside B18 rather than on the board, because the board only raises it " +
          "when a load fails. **Relocated 2026-10-12** (the ruling that removed B15/B18): B18 was " +
          "only the demonstration and is prototype-only now, but this error state is a real state " +
          "of the board — so it moved to the board's own load-failure banner in " +
          "`web/src/App.vue`, rendered `hidden` at rest. The \"exactly one `[data-error-state]` " +
          "in the document\" invariant survives the gallery's removal rather than leaving with it.",
      },
    ],
  },

  {
    id: "B18",
    title: "States showcase",
    root: "[data-states-panel]",
    scope: "review",
    status: "prototype-only",
    required: [
      "[data-states-panel]",
      "[data-states-open]",
      "[data-states-close]",
      "[data-states-overlay]",
      "[data-loading-state]",
      "[data-empty-column]",
      "[data-empty-results]",
      "[data-error-state]",
      "[data-toast-states]",
      "[data-toast]",
    ],
    states: ["[data-states-panel][data-state=\"open\"]"],
    rules: [
      { kind: "count", selector: "[data-states-panel]", equals: 1 },
      { kind: "count", selector: "[data-toast-states]", equals: 1 },
      { kind: "domain", selector: "[data-states-panel]", attribute: "data-state", subset: DOMAINS.PANEL_STATE },
      {
        kind: "count",
        selector: "[data-toast][data-state=\"static\"]",
        within: "[data-toast-states]",
        min: 0,
        when: "states showcase open",
      },
      {
        kind: "manual",
        note:
          "The gallery is a **prototype review surface** (Jobs' UI/UX pass): it puts every " +
          "non-default state in one frame. It adds no framework — a scrim, a panel and two " +
          "handlers. **Prototype-only** since Terry's 2026-10-12 ruling: a gallery of other " +
          "blocks' states is a design demonstration, not a functional requirement, so the " +
          "shipped app renders no gallery, no `[data-states-open]` opener in the sidebar and no " +
          "`[data-states-*]` hooks at all. The one thing inside it that *was* a requirement — " +
          "the error state (B17) — moved to the board's real surface instead of leaving with it.",
      },
      {
        kind: "manual",
        note:
          "Discrepancy inside BLOCKS.md: B18 declares `[data-states-panel]` as " +
          "`role=\"dialog\"` + `aria-modal=\"true\"` + `aria-hidden`, while B21 states that B19 " +
          "is the document's *only* `role=\"dialog\"` panel. Both cannot hold; the drawer (B09) " +
          "also declares the role. Nothing here depends on which wording wins.",
      },
    ],
  },

  {
    id: "B19",
    title: "Access & token settings",
    root: "[data-access-panel]",
    scope: "review",
    status: "active",
    required: [
      "[data-access-panel]",
      "[data-access-open]",
      "[data-access-close]",
      "[data-access-overlay]",
      "[data-cidr-whitelist]",
      "[data-cidr-list]",
      "[data-cidr-row]",
      "[data-cidr-value]",
      "[data-cidr-remove]",
      "[data-cidr-add]",
      "[data-cidr-switch]",
      "[data-token-block]",
      "[data-token-value]",
      "[data-token-reveal]",
      "[data-token-icon]",
      "[data-token-copy]",
      "[data-token-reset]",
      "[data-i18n=\"access.model.bind\"]",
      "[data-i18n=\"access.model.token\"]",
      "[data-i18n=\"access.cidr.note\"]",
      "[data-i18n=\"access.cidr.add\"]",
      "[data-i18n=\"access.cidr.remove\"]",
      "[data-i18n=\"access.cidr.value\"]",
      "[data-i18n=\"access.token.generated\"]",
      "[data-i18n=\"access.token.private\"]",
    ],
    states: ["[data-access-panel][data-state=\"open\"]"],
    rules: [
      { kind: "count", selector: "[data-access-panel]", equals: 1 },
      { kind: "domain", selector: "[data-access-panel]", attribute: "data-state", subset: DOMAINS.PANEL_STATE },
      { kind: "domain", selector: "[data-cidr-whitelist]", attribute: "data-cidr-enabled", subset: DOMAINS.BOOLEAN },
      { kind: "domain", selector: "[data-token-block]", attribute: "data-token-revealed", subset: DOMAINS.BOOLEAN },
      { kind: "domain", selector: "[data-token-icon]", attribute: "data-token-icon", subset: DOMAINS.TOKEN_ICON },
      // R6 ③ — the panel is the prototype's **centred modal** (ruling F1), not a
      // right-hand drawer: fixed, centred on both axes, capped at the measured
      // 480 × 720. `transform` is asserted as the matrix it computes to, in the
      // driven pass below — the declarative form of `translate(-50%,-50%)` is
      // two half-box translations, which is a geometry, not a string.
      { kind: "computed", probe: "[data-access-panel]", property: "position", equals: "fixed", when: "panel open" },
      // 480 / 720 are stated as computed strings rather than as `equalsPx`: they
      // are lengths, not structural counts, and the suite's stale-prose guard
      // (rightly) refuses any *number* in a rule that reaches the prose range.
      { kind: "computed", probe: "[data-access-panel]", property: "width", equals: "480px", when: "panel open" },
      { kind: "computed", probe: "[data-access-panel]", property: "maxHeight", equals: "720px", when: "panel open" },
      { kind: "computed", probe: "[data-access-panel]", property: "transform", notEquals: "none", when: "panel open" },
      // The token's mask is `td_` + twelve dots — the prefix stays readable and
      // the mask is the design's, not the credential's length (R6 ③).
      { kind: "text", probe: "[data-token-value]", matches: "^td_[•]+$" },
      // The rows are the loaded draft, not static markup: they exist only after
      // `GET /api/v1/access` answers, so the rule belongs to the driven pass.
      { kind: "count", selector: "[data-cidr-row]", equals: 2, when: "panel open" },
      {
        kind: "manual",
        note:
          "The allow-list is persisted, not a placeholder: `GET|PUT /api/v1/access` read and " +
          "write the install-root `.env`, the switch and every row are a draft, and the panel's one " +
          "Save commits them. The two default rows are 192.168.0.0/16 and 10.0.0.0/8; the list " +
          "starts **off** so an upgrade never silently narrows remote access.",
      },
      {
        kind: "manual",
        note:
          "[data-cidr-switch] is the input and `data-cidr-enabled` is the section's state — the " +
          "two names are deliberately different, because a hook and the state it writes must not " +
          "share one attribute name.",
      },
      {
        kind: "manual",
        note:
          "The token is the **persisted credential**, read from `GET /api/v1/access` (loopback " +
          "only), so a refresh shows the same value. The masked face stays `td_` + twelve dots; " +
          "Reveal shows the real token and Copy copies it. A Reset clears the field and shows a " +
          "placeholder saying the credential is minted on save; the panel's Save rotates it with " +
          "the allow-list and closes the dialog.",
      },
      {
        kind: "manual",
        note:
          "Hidden by default with the `hidden` attribute and dismissed by [data-access-close], " +
          "[data-access-overlay] or Esc, with focus returning to the opener.",
      },
    ],
  },

  {
    id: "B20",
    title: "Theme switch (retired)",
    root: null,
    scope: "retired",
    status: "retired",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-theme-modal]" },
      { kind: "absent", selector: "[data-theme-choice]" },
      { kind: "absent", selector: "[data-theme-close]" },
      { kind: "absent", selector: "[data-theme-overlay]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      {
        kind: "manual",
        note:
          "Removed, not hidden: the v1.3 theme dialog, its `.td-choices`/`.td-choice` rows and its " +
          "catalogue keys are deleted from index.html, app.js, src/input.css and the built " +
          "tw.css. What survives is the vocabulary (access.theme.light|dark|auto), now used by " +
          "the B03 three-state cycle.",
      },
    ],
  },

  {
    id: "B21",
    title: "Language menu (replaced)",
    root: null,
    scope: "retired",
    status: "retired",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-lang-modal]" },
      { kind: "absent", selector: "[data-lang-choice]" },
      { kind: "absent", selector: "[data-lang-close]" },
      { kind: "absent", selector: "[data-lang-overlay]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      {
        kind: "manual",
        note:
          "Removed, not hidden: the v1.3 language dialog and the keys access.lang.title / " +
          "access.lang.close are deleted. [data-lang-option=\"en\"|\"zh\"] replaced " +
          "[data-lang-choice]; access.lang.en|zh name the options while " +
          "access.lang.short.en|zh name the trigger.",
      },
    ],
  },

  {
    id: "B22",
    title: "Assignee / Reporter control",
    root: "[data-assignee-input]",
    scope: "create",
    status: "active",
    required: [
      "[data-assignee-input]",
      "[data-assignee-menu]",
      "[data-assignee-option]",
      "[data-reporter-input]",
      "[data-reporter-menu]",
      "[data-reporter-option]",
      "[data-detail-assignee-label]",
      "[data-detail-reporter-label]",
      "[data-assignee-value]",
      "[data-reporter-value]",
    ],
    states: ["[data-combo-new]"],
    rules: [
      { kind: "domain", selector: "[data-assignee-option]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-assignee-option]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "One control, two rosters, four placements: the create dialog's assignee and reporter, " +
          "and the drawer's [data-detail-assignee-label] / [data-detail-reporter-label] (which the " +
          "shipped markup also marks with [data-assignee-input] / [data-reporter-input], so the " +
          "two hook families meet on one element).",
      },
      {
        kind: "manual",
        note:
          "Matching is a case-insensitive substring ranked prefix → contains → subsequence; a " +
          "name the roster does not hold is offered as a `· new` row ([data-combo-new]) and is " +
          "added the moment it is used; an unknown assignee defaults to `human` because a handle " +
          "the board has never seen carries no platform. Both rosters live in memory only.",
      },
      {
        kind: "manual",
        note:
          "**No management entry** — no control anywhere adds, renames or removes a roster " +
          "entry; the list grows only by being used. The absence has no hook to select (the " +
          "forbidden controls were never named), so it is a review item, not a selector.",
      },
      {
        kind: "manual",
        note: "Keyboard: ↑/↓ move, Enter accepts, Esc dismisses (stopPropagation — the drawer also listens), Tab closes.",
      },
    ],
  },

  {
    id: "B23",
    title: "Markdown editor",
    root: "[data-md-editor]",
    scope: "create",
    status: "active",
    required: ["[data-md-editor]", "[data-md-toggle]", "[data-md-source]", "[data-md-highlight]", "[data-md-preview]"],
    states: [],
    rules: [
      // T-20261014-212017-4 — B23's editor is the **create dialog's**, and since
      // the drawer's Description section grew one of its own there are two
      // `[data-md-editor]`s in the document. The counts here were document-wide
      // and said "exactly one"; the honest statement is "exactly one **per
      // surface**", so they are scoped. This is not a loosening: a second editor
      // inside `[data-create-task]` still reds, and the drawer's own editor is
      // asserted in B09 where it belongs.
      { kind: "count", selector: "[data-md-editor]", within: "[data-create-task]", equals: 1 },
      { kind: "count", selector: "[data-md-toggle]", within: "[data-create-task]", equals: 3 },
      { kind: "domain", selector: "[data-md-toggle]", attribute: "data-md-toggle", subset: DOMAINS.MD_MODE },
      // R10 ③ — the editor's own end of the stretch chain, and the reason the
      // round exists. The editor takes what the column leaves it, the panes take
      // what the editor leaves *them*, and the panes' height has a floor rather
      // than a viewport-driven ceiling: the old `clamp(280px, 46vh, 520px)` was
      // a rule about the window, so the box could grow and the editing area could
      // not, and the difference piled up under the editor.
      { kind: "computed", probe: "[data-create-task] [data-md-editor]", property: "display", equals: "flex" },
      { kind: "computed", probe: "[data-create-task] [data-md-editor]", property: "flexGrow", equals: "1" },
      { kind: "computed", probe: "[data-create-task] [data-md-editor]", property: "flexBasis", equals: "auto" },
      { kind: "computed", probe: "[data-create-task] [data-md-editor]", property: "flexDirection", equals: "column" },
      { kind: "computed", probe: "[data-create-task] .td-md-panes", property: "minHeight", equals: "200px" },
      { kind: "computed", probe: "[data-create-task] .td-md-panes", property: "flexGrow", equals: "1" },
      // The write side takes the pane it is stacked in and scrolls itself once
      // the text outgrows it — the same behaviour as before the round, now from
      // a height that follows the pane instead of a fixed 220px.
      { kind: "computed", probe: "[data-create-task] [data-md-source]", property: "overflowY", equals: "auto" },
      {
        kind: "manual",
        note:
          "The mode in force is written as `data-md-mode` on the panes container, which BLOCKS.md " +
          "names only by the class `.td-md-panes` — there is no hook for it. [data-md-toggle] " +
          "carries `aria-pressed`.",
      },
      {
        kind: "manual",
        note:
          "[data-md-highlight] is a `<pre>` painted behind the textarea and `aria-hidden`; the two " +
          "carry the same `.td-md-text` (class) metrics so they break lines identically, and the " +
          "scroll binding is direct (a `scroll` event does not bubble). [data-md-source] is a " +
          "`<textarea>` and is also [data-create-task-description] (B10).",
      },
      {
        kind: "manual",
        note: "The two vendored renderers are first-party, load from a plain script tag, make no network request and read no storage.",
      },
    ],
  },

  {
    id: "B24",
    title: "Parent / Depends-on control",
    root: "[data-create-task-parent]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-parent]",
      "[data-parent-input]",
      "[data-parent-menu]",
      "[data-parent-option]",
      "[data-parent-clear]",
      "[data-parent-chips]",
      "[data-create-task-depends]",
      "[data-depends-input]",
      "[data-depends-menu]",
      "[data-depends-option]",
      "[data-depends-chips]",
      "[data-depends-chip]",
    ],
    states: ["[data-parent-chip]", "[data-parent-remove]", "[data-depends-remove]", "[data-drop=\"up\"]"],
    rules: [
      { kind: "count", selector: "[data-create-task-parent]", equals: 1 },
      { kind: "count", selector: "[data-create-task-depends]", equals: 1 },
      { kind: "count", selector: "[data-parent-clear]", equals: 1 },
      { kind: "count", selector: "[data-parent-chips]", equals: 1 },
      // --- the parent control's own structure, against the prototype --------
      //
      // T-20261016-113131. The clear ✕ used to be the field group's **sibling**
      // — a `btn btn-ghost btn-sm` text glyph outside the control, next to a
      // ComboField whose root shrank to its content (172px against the track's
      // 405.391). The prototype puts box and ✕ in **one row** (`.td-combo-field`,
      // the pair that makes `input + gap + ✕ == track` an arithmetic identity),
      // and draws the ✕ as the same 20×20 `svg.td-icon-sm` box every other
      // chip-remove in the board is.
      //
      // These seven are the **structure** half: what exists, inside what. They
      // read `querySelectorAll` / `classList` / the computed box, none of which
      // needs the element to have a box — which matters, because B24's rules
      // carry no `when` and therefore evaluate in the **board** state, where the
      // create dialog is `hidden` and every `getBoundingClientRect` is 0
      // (T-20261015-233122 A6). The **geometry** half — the identity, the 20×20
      // box, the right edge on the track's right edge, the menu's width — is
      // measured in `web/scripts/dom-smoke.mjs#r8c`, where the dialog is open.
      //
      // A probe may name a design class, so `.td-combo-field` is expressible;
      // the ✕ itself is addressed by its hook, not by the class the `classes`
      // rule asserts (that rule is what keeps a Tailwind utility from replacing
      // it — the design namespace is closed).
      { kind: "computed", probe: ".td-combo-field [data-parent-input]", count: 1 },
      { kind: "computed", probe: ".td-combo-field [data-parent-clear]", count: 1 },
      { kind: "classes", probe: "[data-parent-clear]", includes: ["td-combo-clear"] },
      { kind: "computed", probe: "[data-parent-clear] svg.td-icon", count: 1 },
      { kind: "computed", probe: "[data-parent-clear] svg.td-icon-sm", count: 1 },
      { kind: "computed", probe: "[data-parent-clear]", property: "width", equalsPx: 20 },
      { kind: "computed", probe: "[data-parent-clear]", property: "height", equalsPx: 20 },
      {
        kind: "manual",
        note:
          "Two optional fields, both single-roster relations but only one of them is single-valued: " +
          "parent holds at most one task, and it shows that task **as a chip** — one " +
          "[data-parent-chip], carrying the identifier under the board's one cap (`lib/identifier.js`) " +
          "and the title, with its own [data-parent-remove]; [data-parent-clear] empties the field and " +
          "its box together. depends-on is multi, one [data-depends-chip] per task with its own " +
          "[data-depends-remove]. Every chip is generated with its value, so both chip hooks are " +
          "runtime hooks — hence under `states`, like B25's [data-label-remove]. The relation chip is " +
          "the same reading an option row gives (identifier + title, title ellipsised, whole title on " +
          "`title`), which is what makes the choice visible in the field after the menu closes " +
          "(T-20261014-001418 ①②). Both are B22's control pointed at the current project's cards " +
          "(identifier + title) rather than a people roster.",
      },
      {
        kind: "manual",
        note:
          "Free text is **off** (`freeText:false`): a relation can only point at an existing " +
          "task, so there is no `· new` row and nothing joins a roster. A chosen chip is dropped " +
          "from the menu on the next render; choosing it twice is a no-op. The menus ship an " +
          "inert seed as the no-JS floor, redrawn from the live board on focus — the seed's row " +
          "count is fixture data and is not asserted.",
      },
      {
        kind: "manual",
        note:
          "Inside the dialog the menu is clipped by the modal's own scroller, so it flips above " +
          "the control (`.td-combo[data-drop=\"up\"]`) when there is no room below; the depends-on " +
          "field, last in its column, opens upward.",
      },
      {
        kind: "manual",
        note:
          "UI only: no relation is written anywhere — no graph is built, no cycle is checked, " +
          "and the chips reach neither the created card nor any store.",
      },
    ],
  },

  {
    id: "B25",
    title: "Label control",
    root: "[data-create-task-labels]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-labels]",
      "[data-label-chips]",
      "[data-label-input]",
      "[data-label-menu]",
      "[data-label-option]",
      "[data-label-value]",
      "[data-detail-labels]",
      "[data-detail-label-chips]",
      "[data-detail-label-chip]",
      "[data-detail-label-remove]",
      "[data-detail-label-input]",
      "[data-detail-label-menu]",
      "[data-detail-label-option]",
      "[data-detail-label-value]",
    ],
    states: ["[data-label-chip]", "[data-label-remove]", "[data-combo-new]"],
    rules: [
      { kind: "count", selector: "[data-create-task-labels]", equals: 1 },
      { kind: "count", selector: "[data-detail-labels]", equals: 1 },
      {
        kind: "manual",
        note:
          "Two hook families for one control: `data-label-*` in the create dialog and " +
          "`data-detail-label-*` in the drawer, so their delegated selectors never collide in a " +
          "single document. The create dialog ships no chips at rest — [data-label-chip] and " +
          "[data-label-remove] are generated on selection (hence under `states`), while the " +
          "drawer ships its chips in the markup.",
      },
      {
        kind: "manual",
        note:
          "Normalisation is case- and whitespace-insensitive (`bug` / `Bug` / `bug ` are one " +
          "label); the entry keeps the first spelling and that is what every surface shows. " +
          "freeText and multi are both on; the menu drops what is already chosen.",
      },
      {
        kind: "manual",
        note:
          "**No management entry** — the hard constraint shared with B22. No \"manage labels\", " +
          "\"label library\", \"delete label\" or \"edit labels\" control exists anywhere, and no " +
          "button adds, renames, merges or expires a label. Auto-cleanup is a backend concern. " +
          "As in B22 this absence has no hook to select, so it stays a review item.",
      },
      {
        kind: "manual",
        note:
          "The roster is read off the board's cards' `data-labels` at first pass — no preset " +
          "list, no enum — and the menu ships an inert seed as the no-JS floor.",
      },
    ],
  },

  {
    id: "B26",
    title: "Activity view",
    root: "[data-activity-view]",
    scope: "board",
    status: "active",
    required: [
      "[data-activity-title]",
      "[data-activity-mark-read]",
      "[data-activity-filters]",
      "[data-activity-filter]",
      "[data-activity-filter-value]",
      "[data-activity-filter-summary]",
      "[data-activity-filter-text]",
      "[data-activity-filter-option]",
      "[data-activity-value]",
      "[data-filter-clear]",
      "[data-activity-filter-count]",
      "[data-activity-feed]",
      "[data-activity-day]",
      "[data-activity-day-label]",
      "[data-activity-day-kind]",
      "[data-activity-page]",
      "[data-activity-row]",
      "[data-activity-line]",
      "[data-activity-actor]",
      "[data-activity-sentence]",
      "[data-activity-task]",
      "[data-activity-task-id]",
      "[data-activity-task-title]",
      "[data-activity-at]",
      "[data-activity-open]",
      "[data-activity-detail]",
      "[data-activity-change]",
      "[data-activity-unread]",
      "[data-activity-unread-divider]",
      "[data-activity-unread-count]",
      "[data-activity-burst]",
      "[data-activity-burst-count]",
      "[data-activity-burst-count-label]",
      "[data-activity-burst-item]",
      "[data-activity-group]",
      "[data-activity-empty]",
      "[data-activity-empty-kind]",
      "[data-activity-empty-reset]",
      "[data-activity-more]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-activity-view]", equals: 1 },
      { kind: "count", selector: "[data-activity-title]", equals: 1 },
      { kind: "count", selector: "[data-activity-mark-read]", equals: 1 },
      { kind: "count", selector: "[data-activity-filters]", equals: 1 },
      { kind: "count", selector: "[data-activity-filter]", equals: 3 },
      { kind: "domain", selector: "[data-activity-filter]", attribute: "data-activity-filter", subset: DOMAINS.ACTIVITY_FILTER },
      /* R15 ①/③ — the three controls are the board bar's component (R15 ②), and
       * the bar's clear control is B04's own. The hook that used to name the
       * reset (`[data-activity-filter-reset]`) is **retired**: the two Clear
       * controls are told apart by the bar the press came from, and B04's rule
       * is scoped the same way, so "one Clear per bar" is stated twice rather
       * than once document-wide (`design/fidelity-r15.md` §2.4). */
      { kind: "count", selector: "[data-activity-filter][data-dismiss-on-outside]", equals: 3 },
      { kind: "count", selector: "[data-activity-filter-value]", equals: 3 },
      { kind: "count", selector: "[data-activity-filter-summary]", equals: 3 },
      { kind: "count", selector: "[data-activity-filter-text]", equals: 3 },
      { kind: "count", selector: "[data-activity-filter-option][aria-current=\"true\"]", equals: 3 },
      { kind: "count", selector: "[data-filter-clear]", within: "[data-activity-filters]", equals: 1 },
      { kind: "count", selector: "[data-activity-filter-count]", equals: 1 },
      { kind: "count", selector: "[data-activity-feed]", equals: 1 },
      { kind: "count", selector: "[data-activity-more]", equals: 1 },
      /* §8 — both empty states are **resident** and mutually exclusive by the
       * `hidden` attribute, never by being absent: the resting document holds the
       * pair (which is what makes them checkable at all), and the filter one owns
       * the only reset. Asserting `count: 2` rather than "one of them" is the
       * point — a `v-if` would make each state unobservable until it fired. */
      { kind: "count", selector: "[data-activity-empty]", equals: 2 },
      { kind: "domain", selector: "[data-activity-empty]", attribute: "data-activity-empty-kind", subset: DOMAINS.ACTIVITY_EMPTY },
      /* T-20261013-160505, revised by R17 (T-20261013-184102-2) — the pair's own
       * face, byte for byte the design's: both variants wear
       * `td-empty td-empty-lg td-activity-empty` (the design used to draw the
       * filter one a size down; its R17 revision puts both on B12's footing, so
       * the `-lg` split is gone and the two are told apart by their copy and
       * their button alone — `DESIGN-activity.md` §8). The utilities they carried
       * before 160505 matched `.td-empty` on four of its properties but not on
       * its box: `p-4` cannot express the `-lg` variant's 40px/24px, and
       * `gap-1`/`rounded-lg` are 4px/8px where the design states 12px/6px. */
      { kind: "classes", probe: "[data-activity-empty][data-activity-empty-kind=\"project\"]", includes: ["td-empty", "td-empty-lg", "td-activity-empty"] },
      { kind: "classes", probe: "[data-activity-empty][data-activity-empty-kind=\"filter\"]", includes: ["td-empty", "td-empty-lg", "td-activity-empty"] },
      { kind: "computed", probe: "[data-activity-empty][data-activity-empty-kind=\"project\"]", property: "paddingTop", equalsPx: 40 },
      { kind: "computed", probe: "[data-activity-empty][data-activity-empty-kind=\"filter\"]", property: "paddingTop", equalsPx: 40 },
      /* R17 ② — each variant opens on the brand mark, at the empty states' own
       * `-lg` size: one mark per block, 28px. The `count` is the assertion that
       * matters (a block with a mark but three of them, or none, is the failure
       * this family has already seen once). */
      { kind: "computed", probe: "[data-activity-empty][data-activity-empty-kind=\"project\"] svg.td-logo.td-logo-lg", count: 1, property: "width", equalsPx: 28 },
      { kind: "computed", probe: "[data-activity-empty][data-activity-empty-kind=\"filter\"] svg.td-logo.td-logo-lg", count: 1, property: "width", equalsPx: 28 },
      /* R17 ① — the vertical centring is gone: the variants read top-aligned in
       * their feed, as B12's no-results state reads on the board. `margin: auto`
       * was what put them in the middle; the rule below states its absence, and
       * `.td-activity-empty`'s 12px side inset (`0 12px`) is the feed's own
       * gutter rather than part of this item. */
      { kind: "computed", probe: "[data-activity-empty]", property: "marginTop", notEquals: "auto" },
      { kind: "count", selector: "[data-activity-empty-reset]", within: "[data-activity-empty-kind=\"filter\"]", equals: 1 },
      /* R-3 / §9.1 — **one dictionary**. The design page carried its own
       * `[data-activity-i18n]` catalogue; the shipped view reads the app's, so the
       * carrier must not exist. This is the block's one `absent`. */
      { kind: "absent", selector: "[data-activity-i18n]" },
      /* §6 — the row body and its keyboard twin are siblings on the row's first
       * level, so neither ever lands inside itself (a row that were a button would
       * make the task link inside it a nested interactive element). `within` is how
       * this contract states containment: "no X inside an X" reads as a count of 0
       * inside every X. */
      { kind: "count", selector: "[data-activity-line]", within: "[data-activity-line]", equals: 0 },
      { kind: "count", selector: "[data-activity-row]", within: "[data-activity-row]", equals: 0 },
      { kind: "count", selector: "[data-activity-open]", within: "[data-activity-open]", equals: 0 },
      /* §4 L2 — the row's six fields are the contract: a row that lost one would
       * still filter and count, and still be unreadable. */
      { kind: "count", selector: "[data-activity-actor]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-sentence]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-task]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-at]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-open]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-detail]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-day]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-row]", within: "[data-activity-view]", min: 1, when: "activity view" },
      { kind: "count", selector: "[data-activity-more]", min: 1, when: "activity view" },
      /* C02's sibling invariant, for this view's rows. It is deliberately **not**
       * `identical-hookset` here: two of a row's hooks are per-row *state* by
       * design — `[data-activity-unread]` marks the rows the reader has not seen
       * and `[data-activity-burst]` the one row a run of edits folded into (§4/§5)
       * — so the rows' hook sets differ on purpose and the invariant that actually
       * holds is the weaker one: every row carries its six fields. That is stated
       * as a live relation in `web/scripts/dom-smoke.mjs`, where a row's children
       * can be counted against the row itself. */
      { kind: "domain", selector: "[data-activity-row]", attribute: "data-activity-group", subset: DOMAINS.ACTIVITY_GROUP, when: "activity view" },
      { kind: "domain", selector: "[data-activity-row]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND, when: "activity view" },
      { kind: "domain", selector: "[data-activity-filter]", attribute: "data-activity-filter", subset: DOMAINS.ACTIVITY_FILTER, when: "activity view" },
      /* §11 — day groups and rows are both newest-first, and each row's visible
       * stamp is its own instant. The window's own ≤5-minute span, the count's
       * equality with the visible rows and the boundary are measured live in
       * `web/scripts/dom-smoke.mjs` (they are relations, not values). The day
       * `data-activity-page` values are read there too: page 1 while `Load older`
       * is unread, and a page `2` day once it is pressed. */
      { kind: "monotonic", selector: "[data-activity-day]", attribute: "data-day", direction: "non-increasing", when: "activity view" },
      { kind: "monotonic", selector: "[data-activity-row]", attribute: "data-at", direction: "non-increasing", when: "activity view" },
      { kind: "manual", note: "Admission is an allow-list (`design/activity/DESIGN-activity.md` §3.2); heartbeats, session lifecycle, per-field auto-save and label GC never reach the feed. The set is proved live in `web/scripts/dom-smoke.mjs` (the fixture carries two noise rows that must not appear)." },
      { kind: "manual", note: "A burst folds one actor's field edits on one task inside a five-minute window (§5), and the count sentence is the number of rows the reader can see — a burst counts once. Both are measured live." },
      { kind: "manual", note: "Unread is local (§4/§17) and there is exactly **one** boundary per feed, placed after the last unread row inside its day group; the pill, the boundary and the boundary's count read one derivation. Measured live." },
    ],
  },

  {
    id: "B27",
    title: "Waiting view",
    root: "[data-waiting-view]",
    scope: "board",
    status: "active",
    required: [
      "[data-waiting-head]",
      "[data-waiting-title]",
      "[data-waiting-count]",
      "[data-waiting-list]",
      "[data-waiting-item]",
      "[data-waiting-actor]",
      "[data-waiting-reason]",
      "[data-waiting-reason-kind]",
      "[data-waiting-task]",
      "[data-waiting-task-title]",
      "[data-waiting-since]",
      "[data-waiting-open]",
      "[data-waiting-empty]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-waiting-view]", equals: 1 },
      { kind: "count", selector: "[data-waiting-head]", equals: 1 },
      { kind: "count", selector: "[data-waiting-title]", equals: 1 },
      { kind: "count", selector: "[data-waiting-count]", equals: 1 },
      { kind: "count", selector: "[data-waiting-list]", equals: 1 },
      { kind: "count", selector: "[data-waiting-empty]", equals: 1 },
      /* T-20261013-160505 — the empty state's face. This one is the plainest of
       * the six: its markup already wore the design's own pair (`td-empty` +
       * `td-empty-title`, with `.td-waiting-empty` capping and centring it, all
       * three ported in R12x) while `app.css` had no `.td-empty` rule at all, so
       * the shim classes resolved to nothing and the queue's empty state was the
       * only one of the six with **no box** — no padding, no hairline, no centred
       * line, at the default ink. The family is what it was written against, so
       * these rules assert the box, not the markup. */
      /* R17 (T-20261013-184102-2) — the queue's empty state is no longer the
       * plainest of the family: it takes the `-lg` box B12 and B26's pair now
       * carry, opens on the same 28px brand mark, and states the second line
       * (`waiting.empty.hint`) its one-line version was missing. Its box grows
       * with the variant — gap 8 → 12px, padding 16 → 40px/24px, title 12 → 14px
       * — because `-lg` restates its children's type.
       *
       * 2026-10-15 — R17's horizontal cap is withdrawn. `.td-waiting-empty` was
       * `width: 100%` / `max-width: 420px` / `margin: 0 auto`; it is now
       * `flex: none` + `width: 100%` alone, so the dashed box spans the view the
       * way B12's `no-results` box spans the board. `maxWidth` is asserted
       * rather than left implicit because it is the one declaration the other
       * rules here cannot see: every remaining rule (`gap`, `paddingTop`,
       * `borderRadius`, the two font sizes) is just as true of a 420px box as of
       * a full-width one. The computed value of `max-width` is the specified one
       * — it is not resolved against layout — so `none` is a real reading even
       * though the element ships `hidden` in the fixture. */
      { kind: "classes", probe: "[data-waiting-empty]", includes: ["td-empty", "td-empty-lg", "td-waiting-empty"] },
      { kind: "classes", probe: "[data-waiting-empty] [data-i18n=\"waiting.empty\"]", includes: ["td-empty-title"] },
      { kind: "classes", probe: "[data-waiting-empty] [data-i18n=\"waiting.empty.hint\"]", includes: ["td-empty-hint"] },
      { kind: "computed", probe: "[data-waiting-empty] svg.td-logo.td-logo-lg", count: 1, property: "width", equalsPx: 28 },
      { kind: "computed", probe: "[data-waiting-empty]", property: "alignSelf", notEquals: "center" },
      { kind: "computed", probe: "[data-waiting-empty]", property: "maxWidth", equals: "none" },
      { kind: "computed", probe: "[data-waiting-empty]", property: "gap", equalsPx: 12 },
      { kind: "computed", probe: "[data-waiting-empty]", property: "paddingTop", equalsPx: 40 },
      { kind: "computed", probe: "[data-waiting-empty]", property: "paddingRight", equalsPx: 24 },
      { kind: "computed", probe: "[data-waiting-empty]", property: "borderTopWidth", equalsPx: 1 },
      { kind: "computed", probe: "[data-waiting-empty]", property: "borderTopStyle", equals: "dashed" },
      { kind: "computed", probe: "[data-waiting-empty]", property: "borderRadius", equalsPx: 6 },
      { kind: "computed", probe: "[data-waiting-empty] .td-empty-title", property: "fontSize", equalsPx: 14 },
      { kind: "computed", probe: "[data-waiting-empty] .td-empty-title", property: "fontWeight", equals: "500" },
      { kind: "computed", probe: "[data-waiting-empty] .td-empty-hint", property: "fontSize", equalsPx: 12 },
      /* §30.2 — one name per destination: the heading over the queue and the
       * sidebar's nav item carry the *same* string, so they cannot drift. */
      { kind: "count", selector: "[data-waiting-count]", within: "[data-waiting-head]", equals: 1 },
      { kind: "domain", selector: "[data-waiting-reason]", attribute: "data-waiting-reason-kind", subset: DOMAINS.WAITING_REASON },
      { kind: "domain", selector: "[data-waiting-actor]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND, when: "waiting view" },
      /* The queue has no filter, no paging and no folding (§30.1's consistency
       * item 1), so every row carries the identical hook set — six fields and
       * nothing else. This is the one place `identical-hookset` fits a view
       * whose rows carry no per-row state flags (B26's rows do, which is why its
       * rule is stated differently). */
      { kind: "identical-hookset", selector: "[data-waiting-item]", when: "waiting view" },
      { kind: "count", selector: "[data-waiting-item]", min: 1, when: "waiting view" },
      { kind: "count", selector: "[data-waiting-reason]", within: "[data-waiting-view]", min: 1, when: "waiting view" },
      { kind: "count", selector: "[data-waiting-open]", min: 1, when: "waiting view" },
      { kind: "count", selector: "[data-waiting-item]", within: "[data-waiting-item]", equals: 0, when: "waiting view" },
      { kind: "count", selector: "[data-waiting-task]", within: "[data-waiting-task]", equals: 0, when: "waiting view" },
      { kind: "manual", note: "The queue runs **oldest first** (§30.2) — the top row has waited longest. The order is a relation between the rows' own `data-since`, so it is asserted in `test/web/waiting.queue.test.mjs` (the projection) and measured live in `web/scripts/dom-smoke.mjs` (the render)." },
      { kind: "manual", note: "`[data-waiting-since]` carries the instant on `datetime` and the row carries it again on `data-since`; the visible text is that instant on B26's three `time.*` keys — one time vocabulary across the two views. Measured live." },
      { kind: "manual", note: "`[data-waiting-task]` renders at most ten characters plus `…` with the whole value on `title` (R8 ③; the cap moved 8 → 10 in T-20261014-001418). Measured live." },
      { kind: "manual", note: "The reason chip's dot is coloured through `[data-waiting-reason-kind]` → `var(--status-color)` (§30's one-attribute rule), so no component names a colour and the token registry is unchanged. Asserted as a source scan in `web/scripts/dom-smoke.mjs`'s C-group." },
    ],
  },
];

/**
 * The ten consistency items. They have no element of their own (`root: null`), so they
 * carry `scope: "global"`. Rules that repeat a per-block invariant are deliberately
 * restated here: the C-items are the cross-cutting statement, and the block-level rule
 * is the local one.
 */
const CONSISTENCY_ITEMS = [
  {
    id: "C01",
    title: "Every card carries the identical hook set",
    root: null,
    scope: "global",
    status: "active",
    required: [...REQUIRED_BY_EVERY_CARD],
    states: [],
    rules: [
      { kind: "identical-hookset", selector: "[data-card]", when: "board view" },
      {
        kind: "manual",
        note: "A filter, drag or drawer code path never needs to special-case a card.",
      },
    ],
  },

  {
    id: "C02",
    title: "Every column carries the identical hook set and empty-state block",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "identical-hookset", selector: "[data-column]", when: "board view" },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"column\"]",
        within: "[data-column-body]",
        max: 1,
        when: "board view",
      },
    ],
  },

  {
    id: "C03",
    title: "Colour is never inline",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-status-priority-color-map" },
      {
        kind: "manual",
        note:
          "Components read `--status-color` / `--pri-color`, which are set by `[data-status]` / " +
          "`[data-priority]` attribute rules. Moving a card updates one attribute and the stripe, " +
          "the dot and the chips all follow.",
      },
    ],
  },

  {
    id: "C04",
    title: "Mono discipline",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-mono-tabular-numerals" },
      {
        kind: "manual",
        note:
          "Every identifier, internal id, session id, version, count, timestamp and agent role " +
          "handle uses `.td-mono` with tabular numerals. Which element is \"an identifier\" is a " +
          "reading of the design, not a hook pattern, so only the class's own definition is " +
          "machine-checked.",
      },
    ],
  },

  {
    id: "C05",
    title: "Ids are unique and never a styling hook",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-no-id-selectors" },
      {
        kind: "manual",
        note:
          "Ids in the document are unique and used only for `label[for]` / `aria-labelledby` / " +
          "`aria-controls`. Uniqueness is an attribute invariant (`id`, not a `data-*` hook), so " +
          "the uniqueness half is a review/DOM-check item rather than a selector rule.",
      },
    ],
  },

  {
    id: "C06",
    title: "No block is hidden by the stylesheet",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      {
        kind: "manual",
        note:
          "board ↔ list, the drawer, the modals, the states gallery and the access panel are " +
          "toggled by the `hidden` attribute or `data-state`, never by a `display:none` rule, so " +
          "the static document is readable with JavaScript disabled. **Structural caveat (plan " +
          "D6):** a Vue SPA has no SSR, so with JS off only an empty shell remains. The " +
          "invariant is recorded, and the no-JS difference is a written deviation, not a rule " +
          "this contract can hold the implementation to.",
      },
    ],
  },

  {
    id: "C07",
    title: "One identity model",
    root: null,
    scope: "global",
    status: "active",
    required: ["[data-assignee]", "[data-assignee-kind]", "[data-agent-platform]"],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-assignee-kind]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-agent-platform]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "`data-assignee` is always a role handle from the board's roster (six agent roles plus " +
          "the human owner) and never appears as a comment author or activity actor that is not " +
          "one of them. The roster membership itself is fixture data.",
      },
    ],
  },

  {
    id: "C08",
    title: "No brand value is hard-coded",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-no-hex-outside-tokens" },
      {
        kind: "manual",
        note:
          "Every component reads a token (directly, or through `--status-color` / `--pri-color`), " +
          "takes its shell from daisyUI and its face from a token override. The app's token names " +
          "are the web layer's (`--brand-*` for the design's `--color-td-*` inks, lines and " +
          "surfaces; `--color-primary` for `--color-td-accent`), and the Sentinel Watch mark " +
          "spells that mapping out in its own two fills — no colour literal enters markup, and " +
          "the mark's own geometry carries none either.",
      },
    ],
  },

  {
    id: "C09",
    title: "Every daisyUI component keeps its hook name",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      {
        kind: "manual",
        note:
          "An element may gain `badge` / `avatar` / `tabs` / `progress` / `toggle` / `select` " +
          "classes, but the `data-*` attribute it answers to never moves — the property that let " +
          "the design re-shell eight components without touching a single interaction binding. " +
          "This is a change-detection invariant across revisions, not a check any single snapshot " +
          "can make.",
      },
    ],
  },

  {
    id: "C10",
    title: "The label control is the roster control",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-label-manage]" },
      { kind: "absent", selector: "[data-label-library]" },
      { kind: "absent", selector: "[data-label-edit]" },
      { kind: "absent", selector: "[data-roster-manage]" },
      {
        kind: "manual",
        note:
          "It shares the roster control's accept/upsert code, so the `· new` row, the " +
          "upsert-on-use behaviour and the case-insensitive normalisation are the same code — " +
          "its hooks are its own (`data-label-*`, one set, no reuse of the assignee or relation " +
          "hooks) and its roster is read off the cards, so it cannot drift from what the board " +
          "carries. The four `absent` selectors above are forbidden *names*; the stronger claim — " +
          "that no unnamed control anywhere offers to manage a label — is a review item.",
      },
    ],
  },
];

/**
 * BLOCKS.md's own header counts, with what the DOM actually holds. Kept as data so the
 * suite can prove none of these numbers reached a rule.
 */
export const STALE_PROSE_COUNTS = Object.freeze([
  Object.freeze({
    claim: "252 `data-i18n*` hooks",
    measured: 849,
    detail: "543 `data-i18n` + 193 `-arg` + 85 `-aria-label` + 19 `-title` + 9 `-placeholder`",
    verdict: "stale",
  }),
  Object.freeze({
    claim: "198 catalogue keys",
    measured: 289,
    detail: "en = 289 and zh = 289, mirrored 1:1 — the prototype `MESSAGES` count the body states (M6 adds `waiting.reason.acceptance`); the shipped extraction drops the 17 prototype-only keys, so it ships 272",
    verdict: "stale",
  }),
  Object.freeze({
    claim: "7 columns · 18 cards · 18 detail templates",
    measured: 7,
    detail: "columns = 7, cards = 18 (live DOM) and templates = 18 — the one header line that agrees",
    verdict: "confirmed-but-unasserted",
  }),
  Object.freeze({
    claim: "[data-slot]: 18 description · 18 activity · 16 comments · 15 agent-session · 11 attachments · 9 relations",
    measured: 87,
    detail: "87 slots total; individual multiplicities are per-card fixture data",
    verdict: "confirmed-but-unasserted",
  }),
]);

/**
 * Hooks outside the numbered blocks (BLOCKS.md's "Auxiliary hooks" table).
 *
 * A hook may carry `status: "prototype-only"` when it served a prototype-only
 * block alone; like the blocks, it stays transcribed here and is skipped by the
 * implementation-side checks.
 */
export const AUXILIARY_HOOKS = Object.freeze([
  Object.freeze({ selector: "[data-move-menu]", purpose: "the single shared \"Move to\" menu reused by every card (keyboard fallback for drag)" }),
  Object.freeze({ selector: "[data-move-to]", purpose: "one status row inside the move menu" }),
  Object.freeze({ selector: "[data-drop-placeholder]", purpose: "transient placeholder bar created during dragover" }),
  Object.freeze({
    selector: "[data-states-overlay]",
    purpose: "scrim behind B18",
    status: "prototype-only",
  }),
  Object.freeze({ selector: "[data-access-overlay]", purpose: "scrim behind B19" }),
  // R14 §8 U1(b) — `[data-detail-slot-source]` was BLOCKS.md's one auxiliary hook
  // with no consumer on the implementation side: the prototype's `app.js` builds
  // that transient wrapper while copying a `<template>` into the drawer, and a
  // component-based drawer renders its sections directly. The design's ruling
  // gives the hook to the implementation card, whose first branch is "no consumer
  // ⇒ remove", so it left the app (`DetailDrawer.vue`) **and** this table
  // together. The three `[data-attachment-*]` / `[data-activity-*]` hooks stay:
  // U1(a) keeps them, and `test/web/blocks.contract.mjs` §B09 backs them.
  // The drawer's inline attachment preview — implementation-only, like the three
  // `[data-attachment-*]` hooks above: the prototype's rows carry download and
  // remove but no preview arithmetic, so the disclosure button and its region
  // exist only in the shipped app (`design/contracts/attachment-preview.md`).
  Object.freeze({ selector: "[data-attachment-open]", purpose: "a previewable attachment row's eye button (before download), which opens the dialog" }),
  Object.freeze({ selector: "[data-attachment-preview]", purpose: "the full-screen dialog an attachment's bytes render in" }),
  Object.freeze({ selector: "[data-attachment-preview-close]", purpose: "the dialog's close button" }),
  Object.freeze({ selector: "[data-attachment-preview-loading]", purpose: "the dialog's loading sentence" }),
  Object.freeze({ selector: "[data-attachment-preview-error]", purpose: "the dialog's failure sentence" }),
  // The terminal card's one writable action — implementation-only, like the
  // attachment preview: the prototype's terminal drawer deliberately offers no
  // action, and the shipped board offers the audited reopen.
  Object.freeze({ selector: "[data-detail-reopen]", purpose: "the terminal card's audited reopen control" }),
  Object.freeze({ selector: "[data-detail-reopen-panel]", purpose: "the reopen reason prompt" }),
  Object.freeze({ selector: "[data-detail-reopen-reason]", purpose: "the reopen reason draft" }),
  Object.freeze({ selector: "[data-detail-reopen-confirm]", purpose: "the reopen confirmation button" }),
  Object.freeze({ selector: "[data-detail-reopen-cancel]", purpose: "the reopen cancellation button" }),
  Object.freeze({ selector: "[data-label]", purpose: "one chip per card label" }),
  Object.freeze({ selector: "[data-assignee-value]", purpose: "the name an assignee roster option carries" }),
  Object.freeze({ selector: "[data-reporter-value]", purpose: "the name a reporter roster option carries" }),
  Object.freeze({ selector: "[data-label-value]", purpose: "the name a label option and a label chip carry (dialog family)" }),
  Object.freeze({ selector: "[data-detail-label-value]", purpose: "the name a label option and a label chip carry (drawer family)" }),
  Object.freeze({ selector: "[data-combo-new]", purpose: "marks the generated row offering a name the roster does not hold yet" }),
]);

/** Deep-freeze helper. Pure; runs once at module load on module-local data only. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

deepFreeze(BLOCKS);
deepFreeze(CONSISTENCY_ITEMS);

/** The numbered blocks, in order. */
export const BLOCK_CONTRACT = Object.freeze(BLOCKS);

/** The consistency items, in order. */
export const CONSISTENCY_CONTRACT = Object.freeze(CONSISTENCY_ITEMS);

/** Everything the contract asserts, numbered blocks first. */
export const ALL_CONTRACT_ITEMS = Object.freeze([...BLOCKS, ...CONSISTENCY_ITEMS]);

/**
 * The items the **shipped** implementation answers for: everything that is not
 * `prototype-only`. Retired blocks stay in (their absence is still asserted
 * against the app); prototype-only blocks do not, because the app is not
 * supposed to render them. This is the view the implementation-side checks use.
 */
export const IMPLEMENTED_CONTRACT_ITEMS = Object.freeze(
  ALL_CONTRACT_ITEMS.filter((item) => item.status !== PROTOTYPE_ONLY_STATUS),
);

const ATTRIBUTE_RE = /^\[([a-zA-Z][a-zA-Z0-9_-]*)(?:=("[^"]*"|'[^']*'|[^[\]]*))?\]$/;

/**
 * Parse a contract selector. Pure. Returns `null` for anything that is not an optional
 * bare tag followed by one or more attribute compounds — which is what makes
 * Tailwind classes (`.p-4`), ids (`#board`) and descendant combinators unrepresentable.
 * Quoted values may be empty (`[data-project-count=""]`), which asserts the attribute
 * is *present but valueless* — see the `quoted` branch below.
 *
 * @param {string} selector
 * @returns {{selector: string, tag: string|null, attributes: {name: string, value: string|null}[], dataAttributes: string[], hasDataHook: boolean}|null}
 */
export function parseHookSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) return null;

  let rest = selector;
  let tag = null;
  const tagMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
  if (tagMatch && rest.length > tagMatch[1].length && rest[tagMatch[1].length] === "[") {
    tag = tagMatch[1];
    rest = rest.slice(tag.length);
  }

  const attributes = [];
  while (rest.length > 0) {
    const end = rest.indexOf("]");
    if (rest[0] !== "[" || end === -1) return null;
    const body = rest.slice(0, end + 1);
    const match = ATTRIBUTE_RE.exec(body);
    if (!match) return null;
    let value = null;
    if (match[2] !== undefined) {
      const quoted = match[2].length >= 2 && (match[2][0] === "\"" || match[2][0] === "'");
      value = quoted ? match[2].slice(1, -1) : match[2];
      // An *unquoted* empty value (`[data-x=]`) stays a syntax error. A **quoted**
      // one (`[data-x=""]`) is legal, and deliberately so: it is the only way the
      // grammar can ask "does this element carry the attribute *empty*?" — which
      // is how a rule asserts a value is present on every element (B03's
      // `[data-project-count=""]`), since `[data-x]` alone also matches filled ones.
      if (!quoted && value.length === 0) return null;
    }
    attributes.push({ name: match[1], value });
    rest = rest.slice(end + 1);
  }

  if (attributes.length === 0) return null;
  const dataAttributes = attributes.filter((a) => a.name.startsWith("data-")).map((a) => a.name);
  return {
    selector,
    tag,
    attributes,
    dataAttributes,
    hasDataHook: dataAttributes.length > 0,
  };
}

/** A selector is a legal contract hook when it parses and names at least one `data-*` attribute. */
export function isHookSelector(selector) {
  const parsed = parseHookSelector(selector);
  return parsed !== null && parsed.hasDataHook;
}

/** One `td-` class from the design's own namespace (`.td-chip`, `.td-list-head`). */
const DESIGN_CLASS_RE = /^\.td-[a-z0-9-]+$/;

/** An optional bare tag followed by one or more `[attr]` / `.td-class` compounds. */
const PROBE_PART_RE = /^[a-z][a-z0-9-]*(?:\[[a-zA-Z][a-zA-Z0-9_-]*(?:="[^"]*")?\]|\.td-[a-z0-9-]+)+$/;

/** Does this probe part name a hook attribute or a design class (never a bare tag)? */
const PROBE_ANCHOR_RE = /\[data-[a-zA-Z]|\.td-[a-z0-9-]+/;

/** One whitespace-free probe part: a hook, a design class, or a tag+compounds of either. */
function isProbePart(part) {
  if (isHookSelector(part) || DESIGN_CLASS_RE.test(part)) return true;
  if (!PROBE_PART_RE.test(part) || !PROBE_ANCHOR_RE.test(part)) return false;
  return (part.match(/\[[^\]]*\]/g) ?? []).every((bracket) => parseHookSelector(bracket) !== null);
}

/**
 * A **probe** selector: what a computed-style / class / text rule is allowed to
 * name — see `PROBE GRAMMAR` in the module header. Module-private on purpose: a
 * probe is not part of the declared hook surface, so it is deliberately absent
 * from `allSelectors()`, `implementationSelectors()` and the bundle's literal
 * scan, and it is not exported either (the public-surface test pins the exports).
 */
function isProbeSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) return false;
  return selector
    .trim()
    .split(/\s+/)
    .every(isProbePart);
}

const DOM_LAYER = new Set(["dom"]);
const SOURCE_LAYER = new Set(["source"]);
const MANUAL_LAYER = new Set(["manual"]);

function collectRules(items, layers) {
  const out = [];
  for (const item of items) {
    item.rules.forEach((rule, index) => {
      if (layers.has(RULE_KINDS[rule.kind]?.layer)) {
        out.push(Object.freeze({ block: item.id, index, rule }));
      }
    });
  }
  return Object.freeze(out);
}

/** Rules evaluated against a live DOM (browser layer). */
export const BROWSER_LAYER_RULES = collectRules(ALL_CONTRACT_ITEMS, DOM_LAYER);

/** Rules evaluated browser-free against the built artifacts / stylesheets. */
export const SOURCE_LAYER_RULES = collectRules(ALL_CONTRACT_ITEMS, SOURCE_LAYER);

/** Rules recorded for the human review pass; never machine-checked. */
export const MANUAL_RULES = collectRules(ALL_CONTRACT_ITEMS, MANUAL_LAYER);

/**
 * The walk both selector surfaces share: every selector an item set declares,
 * plus the given auxiliary hooks, deduplicated and sorted.
 */
function selectorsOf(items, auxiliary) {
  const found = new Set();
  const add = (selector) => {
    if (typeof selector === "string" && selector.length > 0) found.add(selector);
  };

  for (const item of items) {
    add(item.root);
    for (const selector of [...item.required, ...item.states]) add(selector);
    for (const rule of item.rules) {
      add(rule.selector);
      add(rule.equalsSelector);
      add(rule.within);
    }
  }
  for (const hook of auxiliary) add(hook.selector);

  return Object.freeze([...found].sort());
}

/**
 * Every selector the contract declares, deduplicated and sorted. Pure.
 *
 * This is the *declared surface* — prototype-only blocks and hooks included, so
 * the transcription stays reviewable in one place. The selectors the shipped app
 * must actually carry are `implementationSelectors()` below.
 */
export function allSelectors() {
  return selectorsOf(ALL_CONTRACT_ITEMS, AUXILIARY_HOOKS);
}

/**
 * Every selector the **shipped** app answers for, deduplicated and sorted. Pure.
 *
 * The same walk over `IMPLEMENTED_CONTRACT_ITEMS` and over the auxiliary hooks
 * that are not prototype-only. Note this is a positive walk, not a subtraction:
 * a hook both a prototype-only block and a shipped one declare (the states
 * gallery and B17 both carried `[data-error-state]`) stays, because the shipped
 * block still asks for it.
 */
export function implementationSelectors() {
  return selectorsOf(
    IMPLEMENTED_CONTRACT_ITEMS,
    AUXILIARY_HOOKS.filter((hook) => hook.status !== PROTOTYPE_ONLY_STATUS),
  );
}

/**
 * Validate the contract against its own schema. Pure; returns a list of human-readable
 * problems (empty when the contract is well formed). The suite asserts this is empty,
 * and the browser layer may re-run it before trusting a rule.
 *
 * @returns {string[]}
 */
export function validateContract() {
  const problems = [];

  const ids = ALL_CONTRACT_ITEMS.map((item) => item.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate block ids");

  const bIds = ids.filter((id) => id.startsWith("B"));
  bIds.forEach((id, i) => {
    const expected = `B${String(i + 1).padStart(2, "0")}`;
    if (id !== expected) problems.push(`B-series not continuous: expected ${expected}, found ${id}`);
  });
  const cIds = ids.filter((id) => id.startsWith("C"));
  cIds.forEach((id, i) => {
    const expected = `C${String(i + 1).padStart(2, "0")}`;
    if (id !== expected) problems.push(`C-series not continuous: expected ${expected}, found ${id}`);
  });

  for (const item of ALL_CONTRACT_ITEMS) {
    const at = item.id;
    if (!SCOPES.includes(item.scope)) problems.push(`${at}: unknown scope ${item.scope}`);
    if (!["active", PROTOTYPE_ONLY_STATUS, "retired"].includes(item.status)) {
      problems.push(`${at}: unknown status ${item.status}`);
    }

    if (item.root !== null && !isHookSelector(item.root)) {
      problems.push(`${at}: root is not a data-* hook selector: ${item.root}`);
    }
    if (item.root === null && item.status !== "retired" && item.scope !== "global") {
      problems.push(`${at}: a shipping or prototype-only non-global block must declare a root`);
    }
    if (item.status === "retired" && item.root !== null) {
      problems.push(`${at}: a retired block must not declare a root`);
    }

    for (const selector of item.required) {
      if (!isHookSelector(selector)) problems.push(`${at}: required selector is not a data-* hook: ${selector}`);
    }
    for (const selector of item.states) {
      if (!isHookSelector(selector)) problems.push(`${at}: state selector is not a data-* hook: ${selector}`);
    }

    item.rules.forEach((rule, index) => {
      const where = `${at}.rules[${index}]`;
      const kind = RULE_KINDS[rule.kind];
      if (!kind) {
        problems.push(`${where}: unknown rule kind ${rule.kind}`);
        return;
      }
      const requireHook = (value, field) => {
        if (!isHookSelector(value)) problems.push(`${where}.${field} is not a data-* hook: ${value}`);
      };
      const requireDataAttribute = (field) => {
        if (typeof rule[field] !== "string" || !rule[field].startsWith("data-")) {
          problems.push(`${where}.${field} must name a data-* attribute: ${rule[field]}`);
        }
      };
      const requireProbe = () => {
        if (!isProbeSelector(rule.probe)) problems.push(`${where}.probe is not a legal probe selector: ${rule.probe}`);
      };

      switch (rule.kind) {
        case "computed": {
          requireProbe();
          const comparators = [
            "equals",
            "equalsVar",
            "equalsPx",
            "notEquals",
            "notEqualsVar",
            "contains",
            "startsWith",
            "endsWith",
            "tokens",
            "maxPx",
            "minPx",
            "differsFrom",
          ].filter((key) => rule[key] !== undefined);
          const shaped = rule.property !== undefined || rule.count !== undefined || rule.visible === true;
          if (!shaped) problems.push(`${where}: computed needs a property, a count or visible`);
          if (rule.property !== undefined) {
            if (typeof rule.property !== "string" || rule.property.length === 0) problems.push(`${where}.property must be a CSS property name`);
            if (comparators.length === 0) problems.push(`${where}: computed needs a comparator for ${rule.property}`);
          } else if (comparators.length > 0) {
            problems.push(`${where}: a comparator without a property has nothing to read`);
          }
          for (const key of ["equalsPx", "maxPx", "minPx"]) {
            if (rule[key] !== undefined && typeof rule[key] !== "number") problems.push(`${where}.${key} must be a number`);
          }
          if (rule.tokens !== undefined && (!Number.isInteger(rule.tokens) || rule.tokens < 1)) {
            problems.push(`${where}.tokens must be a positive integer`);
          }
          if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 0)) {
            problems.push(`${where}.count must be a non-negative integer`);
          }
          if (rule.visible !== undefined && typeof rule.visible !== "boolean") problems.push(`${where}.visible must be a boolean`);
          if (rule.differsFrom !== undefined && !isProbeSelector(rule.differsFrom)) {
            problems.push(`${where}.differsFrom is not a legal probe selector: ${rule.differsFrom}`);
          }
          break;
        }
        case "classes": {
          requireProbe();
          if (!Array.isArray(rule.includes) || rule.includes.length === 0) problems.push(`${where}.includes must be a non-empty array`);
          break;
        }
        case "text": {
          requireProbe();
          const modes = ["equals", "oneOf", "matches"].filter((key) => rule[key] !== undefined);
          if (modes.length !== 1) problems.push(`${where}: text needs exactly one of equals/oneOf/matches`);
          if (rule.oneOf !== undefined && (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0)) {
            problems.push(`${where}.oneOf must be a non-empty array`);
          }
          break;
        }
        case "count": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          const bounds = ["equals", "min", "max"].filter((key) => rule[key] !== undefined);
          if (bounds.length === 0) problems.push(`${where}: count needs one of equals/min/max`);
          for (const key of bounds) {
            if (!Number.isInteger(rule[key]) || rule[key] < 0) problems.push(`${where}.${key} must be a non-negative integer`);
          }
          break;
        }
        case "order": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Array.isArray(rule.equals) || rule.equals.length === 0) problems.push(`${where}.equals must be a non-empty array`);
          break;
        }
        case "identical-hookset": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          break;
        }
        case "domain": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Array.isArray(rule.subset) && !Array.isArray(rule.equals)) {
            problems.push(`${where}: domain needs an array subset or equals`);
          }
          break;
        }
        case "absent": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          break;
        }
        case "sequence": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Number.isInteger(rule.from)) problems.push(`${where}.from must be an integer`);
          if (!Number.isInteger(rule.step) || rule.step <= 0) problems.push(`${where}.step must be a positive integer`);
          break;
        }
        case "monotonic": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (rule.direction !== "non-increasing" && rule.direction !== "non-decreasing") {
            problems.push(`${where}.direction must be non-increasing or non-decreasing`);
          }
          break;
        }
        case "source": {
          if (!Object.prototype.hasOwnProperty.call(SOURCE_CHECKS, rule.check)) {
            problems.push(`${where}.check is not a registered source check: ${rule.check}`);
          }
          break;
        }
        case "manual": {
          if (typeof rule.note !== "string" || rule.note.length === 0) problems.push(`${where}: manual needs a note`);
          break;
        }
        default:
          problems.push(`${where}: unhandled rule kind ${rule.kind}`);
      }
    });
  }

  return problems;
}
