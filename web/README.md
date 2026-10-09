# `web`

The board frontend: **Vue 3 + Vite + Tailwind CSS + daisyUI**, built to `web/dist`
— the directory `taskd` serves as its hosted root (`STATIC_DIR_REL`). The shipped
artefact is static; nothing here reaches the runtime image except `web/dist`.

This is a real implementation, not a placeholder. What it ships:

- **The board** (B01–B19, B22–B25 of the block contract): seven status columns,
  cards with drag-to-change-status plus a shared keyboard "Move to" menu, a task
  detail drawer with sanitised Markdown and comments, filters/search, a two-column
  create-task dialog (Markdown editor on the left, eight routing fields on the
  right), comboboxes with prefix → contains → subsequence matching and a `· new`
  row, and label chips.
- **Live updates (SSE)**: one `EventSource` on `/api/v1/events`, keyed by
  `global_revision`; incremental per-task refresh; reconnect with `Last-Event-ID`
  and a manual `?after=` resync. Optimistic moves carry `if_version`, and a
  `409 VERSION_CONFLICT` reverts the change and shows a **visible** conflict
  panel — never a silent overwrite, never an automatic retry.
- **Theme + language**: `localStorage` keys `meerkat-taskpanel.theme` (`light` default,
  three-state cycle light → dark → auto) and `meerkat-taskpanel.lang` (`en` default).
  `auto` is resolved entirely in CSS (`@media (prefers-color-scheme: dark)`);
  no script reads `matchMedia`.
- **i18n**: the prototype catalogue (`src/i18n/catalogue.mjs`), plus a small
  `extra.mjs` for the states the prototype has no copy for (conflict, reconnect).

## Stack, honestly

The planned stack listed `vue-router`, `pinia`, `vue-i18n`, `markdown-it`,
`dompurify` and `mermaid`. The landed app uses **Vue + Vite + Tailwind + daisyUI
only**, because every additional dependency would have to enter the committed
offline cache and the container build (M6b O1). The equivalents are hand-rolled
and small: module-scope reactive stores instead of Pinia, a `<details>`/state
switch instead of a router, a tiny reactive `t()` over the catalogue instead of
`vue-i18n`, and the prototype's own first-party `markdown-lite` / `highlight-lite`
(`src/lib/`) instead of `markdown-it` + `dompurify` — both escape their own input,
so no sanitiser library is needed. `mermaid` is not implemented.

## Commands

```
npm -w web run dev      # Vite dev server; proxies /api and /health to 127.0.0.1:9527
npm -w web run build    # -> web/dist (what taskd hosts)
npm -w web run preview  # serve the built artefact
```

## Verification

- `node --test test/web/*.test.mjs` — the browser-free layers: the block contract
  module, i18n parity, the theme/SSE/combo pure logic, and the selector-literal +
  CSS source checks against `web/dist`.
- `node web/scripts/dom-smoke.mjs` — the **browser layer** (host-only; Playwright
  is resolved from an already-installed location, never added here). It serves the
  built app against a fixture API, runs every `BROWSER_LAYER_RULES` assertion
  against the live DOM, checks console/page errors are zero, and checks the five
  viewports for horizontal overflow. It exits 2 ("skip") when no browser is
  available — which is the container's normal state.

The design prototype under `../prototype/` is the **read-only visual baseline
contract**; it is never imported by, or copied into, this app.
