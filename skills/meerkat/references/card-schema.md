# Card schema — the wire object and the markdown card

A card has two shapes, and they answer different questions:

| Shape | Produced by | Read it when |
|---|---|---|
| **The wire object** — `data.task`, 45 fields | `issue get --json`; every command that returns a task carries the same object | you need the card's data: status, description, acceptance, meta, the claim |
| **The markdown card** — frontmatter + sections | `taskctl export md` | you are reading a file: the loop's brief, a store mirror, a CI check |

This page documents **any file `taskctl export md` writes, wherever it lands** — `--out` may
name one file or a directory, and the loop's brief at `.meerkat/<id>/card.md` is one such
location, not the format's definition. `cli.md` is the command surface;
`status-lifecycle.md` is the state model.

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
| `sort_order` | number | copied — board order |
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
| `acceptance_mode` | string | derived — `off` · `agent` · `human`; never `auto` |
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

## Field reference

The rest of this page is the **markdown card**. A card begins with `---` … `---` frontmatter.
The exporter emits only this subset — **no type guessing**:

```yaml
key: plain scalar          # everything is a string
key: [a, b]                # inline array (closed on one line)
key: "quoted"              # JSON string — the only way to write an escaped value
key: |                     # literal block — newlines kept
```

`id` and `title` are always present and non-empty.

These 41 keys are the card's own. The exporter's fixed order is `CARD_KEY_ORDER`, which also
reserves a slot for `target`: that one is card **metadata**, written from `meta.target` when
set, so it is not counted here. Anything else resides in `meta_json.legacy` — see
§Unknown keys are preserved. The table groups the keys for reading. The workflow group at the
end (delivery/review/acceptance facts) is written **only when it carries something**, so a
plain card does not grow a line.

| Key | Meaning | Values & rules |
|---|---|---|
| `id` | The card's board identifier. | Non-empty; stored verbatim as `tasks.identifier`. |
| `title` | One-line summary. | Non-empty string. |
| `status` | Where the card sits in the lifecycle. | One of the canonical words (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`, plus the `awaiting` overlay). |
| `priority` | Urgency. | `low` · `medium` · `high` · `urgent`. |
| `kind` | The card's role. | `task` · `epic`. |
| `acceptance_mode` | Who closes the card. | `off` · `agent` · `human`; a created card always carries a concrete resolved value (`agent` when nothing was declared — task or epic). **Absent** is only the storage default on a raw write, and reads as `off`. `human` is top-level only: a card with a parent is never human-accepted. A review card (flow B) is always `off`. |
| `labels` | Free-form tags, shown in order. | Inline array. |
| `project` | The board project. | Its id. |
| `assignee` | Who is on the hook. | A dictionary name; empty ⇒ unassigned. |
| `assignee_kind` | The kind a **new** name becomes. | `agent` · `human`; written only when it differs from the default (`agent`). |
| `created_by` | Who created the card. | A name. |
| `created_by_kind` | What that provenance key is. | `human` · a platform (`claude`, `codex`, …) · `taskd`; written only when not the default. |
| `created_at` | When the card was created. | ISO 8601, normalised to ms-Z. |
| `updated_at` | Last content change. | Same coercion. |
| `status_changed_at` | When `status` last changed. | Same coercion. |
| `claimed_by` | Who holds the claim. | A name; empty ⇒ `NULL`. |
| `claimed_kind` | What kind of actor holds it. | `agent` · `human` · a platform; written only when set. |
| `claimed_at` | When the claim was taken. | Timestamp; travels with `claimed_by`. |
| `heartbeat_at` | Last liveness signal from the holder. | Timestamp. |
| `blocked_at` | When the card entered `blocked`. | Timestamp. |
| `blocked_reason` | **Why** the card is blocked. | One of the eight literals below, or absent. |
| `delivery_round` | The card's current delivery round. | Integer; written only when greater than `1`. |
| `awaiting_reason` | **Which** kind of question is pending. | `E1`–`E5`; written only while `awaiting`. |
| `review_of` | The reviewed card. | Its identifier; review cards only. |
| `review_round` | The delivery round this review audits. | Integer; a review card only, absent for a round-agnostic review. |
| `acceptance_revision` | Revision of the frozen acceptance baseline. | Integer; written only when greater than `0`. |
| `report_waiver_round` | The round whose delivery gate was waived. | Integer; written only when a waiver is on record. |
| `report_waiver_reason` | Why the report was waived. | The audited reason. |
| `report_waived_at` | When the waiver was granted. | Timestamp. |
| `archived_at` | When the card was archived. | Timestamp; written only when archived. |
| `acceptance_derived` | The acceptance list was derived by the worker. | `yes`; a review prompt to audit coverage, not a rule. |
| `accepted_by` | Who accepted the card automatically. | `loop-auto` (no review was required) or `loop-review` (after an `approve`). |
| `accepted_round` | The round that acceptance names. | Integer. |
| `auto_accepted` | The acceptance was automated. | `1`. |
| `review_verdict` | The applied review verdict on a card its mode leaves for a person. | `approve`; written by the loop's `record_verdict` action on a `human` card, and the workflow planner compares the lowercase word. A card the loop closes itself carries `accepted_by` instead. |
| `review_verdict_round` | The round that verdict applied to. | Integer; written with `review_verdict`. |
| `rework_round` | The original round a rework child targets. | Integer. |
| `flow` | The workflow lane the card belongs to. | `A` (dispatch/review) · `B`; passed through, not validated, so a team may write its own word. |
| `depends_on` | Blockers that must finish first. | Inline array of card ids; direction is `blocks` with **source = the blocker**. |
| `parent` | This card's parent. | A single card id; the parent is an `epic`. |
| `notify_leader` | Tell the leader this card needs attention. | Kept verbatim in `meta_json`; the board preserves it and does not act on it. |

### Relation caps

`depends_on` is not a column: it is a `blocks` relation whose **source is the blocker**. The
parent/child graph is bounded — a card has at most one parent, a parent holds at most **8**
children (`RELATION_FANIN_MAX`), and a parent/child chain is at most **8** deep
(`RELATION_CHAIN_MAX`). Cycles are refused, and an ancestor and its descendant may not also
carry a `blocks` edge. A `blocks` edge itself has **no degree cap**.

## blocked_reason — what a blocked card is waiting for

`blocked_at` says *when* a card started waiting; `blocked_reason` says **what** for.

| Value | The card is waiting on |
|---|---|
| `clarify` | an answer to an ambiguous requirement |
| `decision` | a decision fork, or a gate sign-off |
| `dependency` | a predecessor card, or an upstream artifact |
| `out_of_bounds` | a hand-back: the work is outside the worker's duties |
| `defect` | the defect loop |
| `external` | something outside the team — a third party, an operator input |
| `resource` | capacity — host, model, concurrency limits |
| `unknown` | present, but not classified |

1. **Absent is legal, and is not `unknown`.** An absent value reads like `clarify`.
2. **Absent means the key is missing, not empty.** `blocked_reason: ""` is not written back.
3. **A supplied value must be one of the literals.** Nothing is folded or lower-cased;
   surrounding whitespace is trimmed, and that is the only exception.
4. **It follows the status.** Set by the move into `blocked`, cleared by the move out;
   `blocked_at` is kept, because it dates the last blockage.
5. **An unrecognised value is refused on write.** `normalizeBlockedReason` answers
   `VALIDATION_FAILED` with the allowed list — nothing is folded, lower-cased or stored. A
   *legacy* value already sitting in `meta_json.legacy` is a different matter: the exporter
   re-emits it verbatim and the column stays empty.

## Unknown keys are preserved

Any key outside these 41 that a card carries in `meta_json.legacy` is kept verbatim, in the
card's own order, and re-emitted on export. Current writes do not create such keys — there is
no import path any more — so this is how **legacy** data survives a rewrite: `target` (an
opaque per-card value, read from `meta.target` first and then from the legacy slot), `goal`, and
a team's own bookkeeping (`git_rules`, `subsession_ids`, …). **Do not delete a key you do not
recognise.**

## Identifier syntax

A card has two identifier notions, and they answer different questions.

**What the board will store** (`isValidIdentifier`): 1–128 characters; the first character is
`A`–`Z`, `a`–`z` or `0`–`9`; every later character is one of those or `.`, `_`, `-`. No
spaces, slashes, or leading punctuation. Case is preserved, and identifiers are compared
case-sensitively. This check is deliberately permissive: hand-written legacy cards
(`T-20261008-230500-…`) import unchanged, so it accepts far more than the board itself mints.

The executable storable pattern is:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
```

**What the board mints** for a new card: `<PREFIX>-<serial>`.

- `serial` starts at 1 for each project and is left-padded with zeroes to **at least** four
  digits. The width is a minimum, not a cap: serial `12345` yields `DEMO-12345`. There is no
  overflow refusal.
- The prefix is the project's declared `meta.prefix`, normalized, when it has one; otherwise
  it is derived from the project id. Normalization is: trim surrounding whitespace, uppercase,
  collapse every run of characters outside `A`–`Z` and `0`–`9` into a single `-`, then strip
  leading and trailing `-`. A prefix may therefore contain digits and multiple `-` segments,
  and it may start with a digit.
- Unique per project, case-sensitively; not unique across projects. A bare identifier that
  exists in more than one project is refused as ambiguous rather than guessed.

A generated identifier matches this pattern (the serial is four or more digits):

```text
^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4,}$
```

Use that pattern only to recognize identifiers the board **generated**. Stored identifiers may
be legacy or custom and still pass `isValidIdentifier` without matching it; a parser that must
read every card should accept the wider storable pattern.

Length edge: the prefix normalizer has no length cap. A prefix long enough to push the whole
generated identifier past 128 characters makes card creation fail `VALIDATION_FAILED`; not
every prefix a project could ask for yields a valid generated identifier.

Examples (the test suite re-derives each line):

<!-- identifier-examples:begin -->
valid DEMO-0001
valid MEERKAT-TASKPANEL-0007
valid DEMO-12345
valid A.b_c-d
valid T-20261008-230500-meerkat-taskpanel-m1
invalid -leading-dash
invalid .leading-dot
invalid with space
invalid with/slash
<!-- identifier-examples:end -->

Generated form:

<!-- identifier-generated:begin -->
demo => 1 => DEMO-0001
demo => 12345 => DEMO-12345
meerkat-taskpanel => 7 => MEERKAT-TASKPANEL-0007
demo_x => 2 => DEMO-X-0002
<!-- identifier-generated:end -->

Prefix fold:

<!-- identifier-prefix:begin -->
meerkat-taskpanel => MEERKAT-TASKPANEL
demo_x => DEMO-X
--w_ -- => W
<!-- identifier-prefix:end -->

Published generated-form pattern:

<!-- identifier-generated-regex:begin -->
^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4,}$
<!-- identifier-generated-regex:end -->

## Body sections

The body is `##` sections, canonical order **Background · Acceptance · Comments · Sessions ·
Attachments (only when the card has files) · Report**. The exporter always writes the other
five; `## Attachments` appears only when the card carries attachments. Prose in
`## Background` becomes the card's description. The card does **not** carry the activity
trail: the full audit trail is a separate board read (`GET /api/v1/tasks/:ref/activities`
for one card, `GET /api/v1/activities` across the board).

```
## Acceptance
- <text>
```
The list is the card's **frozen baseline** (`tasks.acceptance_json` — the same array as
`acceptance[]` on the wire), one plain bullet per criterion. `issue create --acceptance` seeds
it; `issue update --acceptance` appends. `meta.acceptance` is only the seed it was copied from,
used as a visible fallback for a grandfathered card whose snapshot is still empty (the renderer
adds `(seed; no frozen baseline)`). An imported card's `meta.acceptance_legacy` keeps its
checkbox form (`- [ ] <text>` / `- [x] <text>`); when both exist, the frozen list wins and the
legacy list is not merged. A checked box records what the importer's author intended, not what a
delivery achieved.

```
## Comments
- <ts> · <kind> · <author> — <body>
```
<!-- comment-kinds:begin -->
`<kind>` is a closed enum: `discuss` · `decision` · `confirm` · `confirm_request` · `change` · `note` · `defect` · `question`.
<!-- comment-kinds:end -->
`question` is a worker's question to a human — the payload of an `awaiting` card; there is no
separate questions table. Newlines in `<body>` are escaped as `\n`.

```
## Sessions
- seg:<name> · owner:<agent> · owner_kind:<platform> · id:<uuid> · goal:<one sentence> · phase:<p> · status:<s> · pid:<n> · <ts>
```
`status` ∈ `running` · `closed` · `failed`. `goal` is optional; a card without one
carries an empty value. Inside `goal`, a backslash is doubled, a newline becomes
`\n`, a carriage return `\r`, and `·` becomes its Unicode escape (backslash-u00b7)
— so the sentence can contain ` · ` without splitting the record.

```
## Attachments
- id:<uuid> · filename:<name> · type:<mime> · size:<bytes> · created_at:<ts>
```
One line per file, written only when the card has at least one. `comment_id:<id>` is appended
when the file belongs to a comment. The filename and type are escaped the same way as a
session's `goal` (backslash, newline, carriage return, `·`), so a hand-named file cannot
inject a heading or split the record. The bytes are **not** in the card; they live on the
board (`GET /api/v1/attachments/:id/content`).

```
## Report
### R2 · 2026-10-08T15:31:25.161Z · linus

<conclusion — free prose>

acceptance:
- [met] <item text> — <optional note>
- [partial] <item text>

evidence:
- commit <sha>
- path <path>
- command exit <0> · <command line>
- coverage <lines> · <scope>

leftovers: <what is still open>
```
Acceptance status is `met` · `partial` · `not_met` · `not_applicable`. Evidence is a **closed**
set. For a task, any report for the card's current delivery round satisfies the gate, whoever
wrote it — the board **does** record the author (`author_kind` / `author_id`), but the gate does
not filter on it. For an **epic** the report must be its rollup: the renderer writes
`rollup: yes`, each acceptance item carries `· ref: <child identifier>`, and a plain report — or
a waiver — is refused (`ROLLUP_REQUIRED` / `ROLLUP_STALE`).

## The process directory

The loop exports each card to `.meerkat/<identifier>/card.md` (read-only) and puts the worker's
process files beside it. The file has two writers, both machine-only: `export md` writes the
snapshot, and `export watch` keeps it fresh from the event stream (unique temp file plus an
atomic rename, skipping a byte-identical render). With `--detach`, `export watch` registers
the card with the local event hub, which performs the same writes; the hub's pointer, log
and registration state live in the per-user runtime directory (not in any project's
`.meerkat/`). Workers maintain
`.meerkat/<identifier>/plan.md` — goals, non-goals, steps, risks, and the requirement →
acceptance mapping — and update it as they learn. The reviewer reads it and treats an
unexplained deviation as grounds for `VERDICT: REJECT`; a missing plan is not itself a
failure (the reviewer falls back to the description and the frozen acceptance snapshot). The
board holds no directory (O3): this is a loop convention under the project's own working
directory.

## Export rules

| Rule | Consequence |
|---|---|
| Fixed key order and section order | An exported card is byte-identical however the input was written. |
| Unknown keys re-emitted in place | A rewrite does not lose a team's own fields. |
| A known key's unrecognised value re-emitted in place | Recognising a key never costs a card its wording. |
| Optional keys written only when set | An existing card is not grown by a key it never had. |
| Attachments section written only when present | A card without files keeps its five-section shape. |
| Growth guard | An `export md` rewrite that would grow a card past the guard factor refuses. `export watch` (standalone or through the hub) is exempt: its temp+rename refresh legitimately grows a brief when comments or a report land. |

Asymmetries: `assignee_kind` is re-exported only when it differs from the default `agent`;
`meta_json` holds both `notify_leader` and every legacy key; `acceptance_derived` is written when
set — it is a review prompt, not a rule.
