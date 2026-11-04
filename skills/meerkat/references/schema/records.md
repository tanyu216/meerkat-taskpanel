# Card fields, records and export

> The field reference, relations, body sections, record formats and export rules. The wire
> object is `wire.md`; identifiers are `identifiers.md`; blocked reasons are
> `blocked-reason.md`.

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
| `kind` | The card's stored type. | `task` · `epic` · `review`; `review` requires `review_of_id` (the database CHECK ties the two). |
| `acceptance_mode` | Who closes the card. | `off` · `auto` · `human`; a created card always carries a concrete value (`auto` when nothing was declared — task or epic). A raw write that omits it takes the column default, `auto`, and the wire always carries the column value. Any card, at any depth, may be `human`; there is no project default. A review card (flow B) is always `off`. |
| `labels` | Free-form tags, shown in order. | Inline array. |
| `project` | The board project. | Its id. |
| `assignee` | Who is on the hook. | A dictionary name; empty ⇒ unassigned. |
| `assignee_kind` | The kind a **new** name becomes. | `agent` · `human`; written only when it differs from the default (`agent`). |
| `created_by` | Who created the card. | A name. |
| `created_by_kind` | What that provenance key is. | `human` · a platform (`claude`, `codex`, …) · `system`; written only when not the default. |
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
| `landed_sha` | The commit the acceptance merged into the project's current branch. | A commit sha, written by the loop's `approve` / `auto_accept` when it landed a registered lane. **Absent means unknown**, not "not landed": a card worked in a tree the loop did not create has no lane to merge. `loop doctor` reports the ones git still finds outside the branch. |
| `landed_at` | When that merge ran. | Timestamp; written with `landed_sha`. |
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


## Unknown keys are preserved

Any key outside these 41 that a card carries in `meta_json.legacy` is kept verbatim, in the
card's own order, and re-emitted on export. Current writes do not create such keys — there is
no import path any more — so this is how **legacy** data survives a rewrite: `target` (an
opaque per-card value, read from `meta.target` first and then from the legacy slot), `goal`, and
a team's own bookkeeping (`git_rules`, `subsession_ids`, …). **Do not delete a key you do not
recognise.**


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
