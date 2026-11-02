# The card wire object

> The JSON read, `--include`, the task object and the data-reading table. The exported
> markdown fields and record formats are `records.md`.

## Reading a card as JSON

`taskctl issue get <ref> --json` answers `{ok:true,data:{…}}`. Without `--include` the payload
is exactly the three members below. `token_source` rides on `data` for every board-backed
command; it says where the token came from and is not part of the card.

<!-- wire-payload-fields:begin -->
| Member | What it is |
|---|---|
| `task` | The card object — the 45 fields in the next table. |
| `report_waivers[]` | Every waiver ever recorded, read from the audit trail: `round`, `reason`, `waived_at`, `actor_id`. |
| `attachments[]` | `id`, `task_id`, `comment_id`, `filename`, `content_type`, `size`, `kind`, `created_at`. The bytes are not in the payload. |
<!-- wire-payload-fields:end -->

`issue list` answers `data.tasks[]` — the same `task` object per card, plus `order_debug[]` with
`--order-debug`. `issue candidates` answers a leaner tuple: `id`, `identifier`, `title`,
`status`, `priority`, `project`, `created`, `sort`, `target`, `meta`, `reason`, `review_of`,
`review_round` (`capabilities.md` §3).

### `--include` adds the trail, the reports, the edges and the sessions

One read can carry what used to need three commands. Each section lands under its own name and
is **equal to what the standalone command returns** — there is no second projection:

<!-- wire-include-fields:begin -->
| `--include` section | Payload key | Equal to |
|---|---|---|
| `comments` | `data.comments[]` | `comment list <ref> --json` → `data.comments` (newest first; `--limit <n>` caps it, default 50, `0` = no cap) |
| `reports` | `data.reports[]` | `report list <ref> --json` → `data.reports` (every round) |
| `relations` | `data.relations{relations,children,ancestors,blocked_by,blocks,parent_chain}` | `relation list <ref> --json` → `data`, minus `task_id` |
| `sessions` | `data.sessions[]` | `session list <ref> --json` → `data.sessions` |
<!-- wire-include-fields:end -->

An unknown section, or `--limit` without the `comments` section, is a usage error (exit 2).
Without `--include` the payload is byte-identical to what it always was.

### The `task` object

<!-- wire-card-fields:begin -->
| Field | Type | Source |
|---|---|---|
| `id` | string | copied — the internal UUID, not the identifier |
| `identifier` | string | copied — `PROJ-0007`, unique per project |
| `project_id` | string | copied |
| `title` | string | copied |
| `description` | string | copied — opaque markdown; the export writes it under `## Background` |
| `status` | string | copied — the eight lifecycle words |
| `priority` | string | copied — `low` · `medium` · `high` · `urgent` |
| `kind` | string | copied — `task` · `epic`; a review card is still `task` |
| `sort_order` | number | copied — the repository's stored order key (always `0` in practice) |
| `assignee_id` | string \| null | copied |
| `assignee_kind` | string \| null | copied — the kind recorded with the reference |
| `reporter_id` | string \| null | copied |
| `reporter_kind` | string \| null | copied |
| `agent_session` | string \| null | copied — legacy session id |
| `thread_id` | string \| null | copied — legacy thread id |
| `thread_source` | string \| null | copied — legacy thread source |
| `claimed_by` | string \| null | copied — the claim holder's actor **id** |
| `claimed_kind` | string \| null | copied |
| `claimed_at` | string \| null | copied |
| `heartbeat_at` | string \| null | copied |
| `blocked_at` | string \| null | copied |
| `status_changed_at` | string | copied |
| `archived_at` | string \| null | copied |
| `source_path` | string \| null | copied — import provenance |
| `report_latest_id` | number \| null | copied |
| `delivery_round` | number | copied |
| `version` | number | copied — the CAS value a write sends back as `--if-version` |
| `created_at` | string | copied |
| `updated_at` | string | copied |
| `awaiting_reason` | string \| null | copied — `E1`–`E5` while `awaiting` |
| `blocked_reason` | string \| null | copied — one of the eight literals |
| `review_of_id` | string \| null | copied — the audited card's UUID; structural authority |
| `review_round` | number \| null | copied — the audited delivery round; `null` = legacy round-agnostic |
| `labels` | string[] | derived — always an array |
| `meta` | object | derived — always an object; carries `target` and a team's own keys |
| `role` | string | derived — `task` · `epic` · `review`; read this, not `kind`, to ask what a card is for |
| `review_of` | string \| null | derived — the audited card's **identifier** |
| `acceptance` | string[] | derived — the **frozen baseline**, the delivery contract |
| `acceptance_revision` | number | derived — the baseline's revision (the prune's CAS) |
| `acceptance_mode` | string | derived — `off` · `auto` · `human` |
| `assignee` | object \| null | derived — `{id, display_name, kind}` |
| `reporter` | object \| null | derived — `{id, display_name, kind}` |
| `claimed_by_actor` | object \| null | derived — `{id, display_name, kind}` beside `claimed_by` |
| `report_waiver` | object \| null | derived — the newest waiver as `{round, reason, waived_at}` |
| `parent_id` | string \| null | derived — the parent's **UUID**; the edge is a relation, not a column |
<!-- wire-card-fields:end -->

Five things this table is easy to get wrong about:

- **`id` is not the identifier.** `id` is a UUID; `identifier` is `PROJ-0007`. The export's
  `id` key is the identifier — the two shapes use the word differently.
- **`parent_id` is a UUID, and parenthood lives in relations.** The export writes `parent` as
  the parent's identifier. Read children, ancestors and blockers with `relation list`, or
  `issue get --include relations`.
- **The actor fields come in pairs.** `assignee` / `reporter` / `claimed_by_actor` are refs
  (`{id, display_name, kind}`); `assignee_id` / `reporter_id` / `claimed_by` are ids.
- **`acceptance[]` is the contract; `meta.acceptance` is only its seed.** A card whose snapshot
  was never seeded may still show the seed, but the gate and the report read `acceptance[]`.
- **One waiver, two shapes.** `report_waiver` is the newest waiver on the row;
  `report_waivers[]` is the whole history from the audit trail.

### Reading a card's data

| You need | Read |
|---|---|
| the acceptance criteria | `data.task.acceptance[]` — never `meta.acceptance` |
| the description | `data.task.description` |
| the blockers and children | `issue get --include relations` → `data.relations.blocked_by[]` / `.children[]`, or `relation list` |
| the delivery evidence | `issue get --include reports` → `data.reports[]`, or `report list <ref>`; `issue get` alone has no reports |
| the discussion and decisions | `issue get --include comments` → `data.comments[]`, or `comment list <ref>` |
| who worked on it | `issue get --include sessions` → `data.sessions[]`, or `session list <ref>` |
| the `--if-version` a write needs | `data.task.version` |
