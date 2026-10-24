# Card schema — frontmatter & sections

The markdown card `taskctl export md` writes. This is the *file* format; `cli.md` is the
command surface and `status-lifecycle.md` is the state model.

> Paths written as `src/…` or `docs/…` name the taskpanel **source repository**. This skill
> ships only `SKILL.md`, `references/` and `scripts/`; the conformance command below needs a
> checkout.

A card begins with `---` … `---` frontmatter. The exporter emits only this subset — **no
type guessing**:

```yaml
key: plain scalar          # everything is a string
key: [a, b]                # inline array (closed on one line)
key: "quoted"              # JSON string — the only way to write an escaped value
key: |                     # literal block — newlines kept
```

`id` and `title` are always present and non-empty.

## Field reference

Exactly these 41 keys. Anything else rides in `meta_json.legacy` — see
§Unknown keys are preserved. The exporter's fixed order is `CARD_KEY_ORDER`; the table below
groups the keys for reading. The workflow group at the end (delivery/review/acceptance facts)
is written **only when it carries something**, so a plain card does not grow a line.

| Key | Meaning | Values & rules |
|---|---|---|
| `id` | The card's board identifier. | Non-empty; stored verbatim as `tasks.identifier`. |
| `title` | One-line summary. | Non-empty string. |
| `status` | Where the card sits in the lifecycle. | One of the canonical words (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`, plus the `awaiting` overlay). |
| `priority` | Urgency. | `low` · `medium` · `high` · `urgent`. |
| `kind` | The card's role. | `task` · `epic` · `deploy`. |
| `review_required` | Whether this card needs an independent review before `done`. | `yes`; **absent** means it does not. A review card (flow B) never carries it. |
| `labels` | Free-form tags, shown in order. | Inline array. |
| `project` | The board project. | Its id. |
| `assignee` | Who is on the hook. | A dictionary name; empty ⇒ unassigned. |
| `assignee_kind` | The kind a **new** name becomes. | `agent` · `human`; not re-emitted on export. |
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
| `accepted_by` | Who accepted the card automatically. | The loop's marker (`loop-auto`). |
| `accepted_round` | The round that acceptance names. | Integer. |
| `auto_accepted` | The acceptance was automated. | `yes`. |
| `review_verdict` | The applied review verdict. | `APPROVE` · `REJECT`. |
| `review_verdict_round` | The round that verdict applied to. | Integer. |
| `rework_round` | The original round a rework child targets. | Integer. |
| `flow` | The workflow lane the card belongs to. | `A` (dispatch/review) · `B`. |
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
5. **An unrecognised value is preserved, not lost.** It keeps its text and slot in
   `meta_json.legacy`, goes back out on export, and the column stays empty.

## Unknown keys are preserved

Any key outside these 41 is kept verbatim in `meta_json.legacy`, in the card's own order, and
re-emitted on export. Keys riding this path today: `target` (an opaque per-card value — the
export reads `meta.target` first and falls back to the legacy slot), `goal`, and a team's own
bookkeeping (`git_rules`, `subsession_ids`, …). **Do not delete a key you do not recognise.**

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
trail: the full audit trail is a separate board read (`GET /api/v1/tasks/:ref/activities`).

```
## Acceptance
- <text>
```
The modern list (`meta.acceptance`, written by `issue create/update --acceptance`) is one plain
bullet per criterion. An imported card's `meta.acceptance_legacy` keeps its checkbox form
(`- [ ] <text>` / `- [x] <text>`); when both exist, the modern list wins and the legacy list is
not merged. A checked box records what the importer's author intended, not what a delivery
achieved.

```
## Comments
- <ts> · <kind> · <author> — <body>
```
`<kind>` is a closed enum: `discuss` · `decision` · `confirm` · `confirm_request` · `change` · `note` · `defect`.
Newlines in `<body>` are escaped as `\n`.

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
set. Any report for the card's current delivery round satisfies the gate; the board does not
record who wrote it.

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

Asymmetries: `assignee_kind` is not re-exported (it lives on the actor row); `meta_json` holds
both `notify_leader` and every unknown key under `legacy`; `acceptance_derived` is board meta,
not a card key, and is not re-emitted.
