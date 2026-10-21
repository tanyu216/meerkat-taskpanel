# Card schema — frontmatter & sections

The markdown card `taskctl export md` writes. This is the *file* format; `cli.md` is the
command surface and `status-lifecycle.md` is the state model.

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

Exactly these 23 keys, in this order. Anything else rides in `meta_json.legacy` — see
§Unknown keys are preserved.

| Key | Meaning | Values & rules |
|---|---|---|
| `id` | The card's board identifier. | Non-empty; stored verbatim as `tasks.identifier`. |
| `title` | One-line summary. | Non-empty string. |
| `status` | Where the card sits in the lifecycle. | One of the canonical words (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`, plus the `awaiting` overlay). The old v1 words (`ready`, `failed`, and their spelling variants) are not accepted. |
| `priority` | Urgency. | `low` · `medium` · `high` · `urgent`. |
| `kind` | The card's role. | `task` · `epic` · `deploy`. |
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
| `depends_on` | Blockers that must finish first. | Inline array of card ids; direction is `blocks` with **source = the blocker**. |
| `parent` | This card's parent. | A single card id; the parent is an `epic`. |
| `notify_leader` | Tell the leader this card needs attention. | Kept verbatim in `meta_json`; the board preserves it and does not act on it. |

### The status machine

- **The card carries the stored status**, always in its canonical spelling.
- The card's status is data, not permission: `issue move` still enforces the transitions.

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

Any key outside the 23 is kept verbatim in `meta_json.legacy`, in the card's own order, and
re-emitted on export. Keys riding this path today: `target` (an opaque per-card value),
`goal`, `review_of`, and a team's own bookkeeping (`git_rules`, `subsession_ids`, …).
**Do not delete a key you do not recognise.**

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
`## Background` becomes the card's description.

The card does **not** carry the activity trail. The old `## Progress` section rendered the
imported `progress` activity event, which has had no writer since the markdown importer was
removed; it is gone. The full audit trail is a separate board read
(`GET /api/v1/tasks/:ref/activities`), not part of the card file.

```
## Comments
- <ts> · <kind> · <author> — <body>
```
`<kind>` is a closed enum: `discuss` · `decision` · `confirm` · `change` · `note` · `defect`.
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
set. A report that satisfies the delivery gate is `origin='delivery'`; an imported historical
report is `origin='import'` and never satisfies it.

## Export rules

| Rule | Consequence |
|---|---|
| Fixed key order and section order | An exported card is byte-identical however the input was written. |
| Unknown keys re-emitted in place | A rewrite does not lose a team's own fields. |
| A known key's unrecognised value re-emitted in place | Recognising a key never costs a card its wording. |
| Optional keys written only when set | An existing card is not grown by a key it never had. |
| Attachments section written only when present | A card without files keeps its five-section shape. |
| Growth guard | A rewrite that would grow a card past the guard factor refuses. |

Asymmetries: `assignee_kind` is not re-exported (it lives on the actor row); `meta_json` holds
both `notify_leader` and every unknown key under `legacy`; `acceptance_derived` is board meta,
not a card key, and is not re-emitted.

## Conformance

This page is hand-maintained; the code is not. The field table is asserted against
`CARD_KEY_ORDER` in the source repository's `src/core/storage/md/export.mjs`. Run this **from
the repository root**; it exits `0` when they agree, `1` when they disagree, `2` when no
checkout is present:

```bash
node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
const code = "./src/core/storage/md/export.mjs";
if (!existsSync(code)) {
  console.error(`card-schema conformance: needs the taskpanel checkout — ${code} is not here.`);
  process.exit(2);
}
const { CARD_KEY_ORDER } = await import(code);
const md = readFileSync("skills/meerkat-taskpanel/references/card-schema.md", "utf8");
const table = md.split("## Field reference")[1].split("\n## ")[0];
const keys = [...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
const same = keys.length === CARD_KEY_ORDER.length && keys.every((k, i) => k === CARD_KEY_ORDER[i]);
console.log(JSON.stringify({ doc: keys.length, code: CARD_KEY_ORDER.length, same }));
process.exit(same ? 0 : 1);
'
```

If it prints `false`, the code moved and this page owes an update: **`CARD_KEY_ORDER` is the
source of truth.**
