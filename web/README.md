# `web`

The board frontend: **Vue 3 + Vite**, built to `dist/web`.

Planned stack (decision 2026-10-08):

- **Vue 3 + Vite** (SPA)
- **Tailwind CSS + daisyUI** — same UI system as the design prototype
- `vue-router` (board / task / project routes)
- `pinia` (state)
- `vue-i18n` — **English is the default**, Chinese is supported
- `markdown-it` (GFM) + `dompurify` for task descriptions and comments
- `mermaid` for read-only diagrams
- a Gantt view is deferred (candidate: `dhtmlx-gantt`)

The design prototype at [`../design/prototype/`](../design/prototype/) — HTML + Tailwind/daisyUI +
jQuery — is the **visual baseline contract** (§⑨.1), not the implementation. It is framework-agnostic
and must not be copied into the app.

Not implemented yet — this directory is a placeholder created by the M0 scaffold. The
kanban board UI is implemented in a later card, once the M1 core and the M6 local API/SSE
surface exist.
