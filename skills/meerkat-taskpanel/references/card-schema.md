# Card schema — frontmatter & sections

The markdown card: what `taskctl export md` writes and the md migrator reads back. This is the
*file* format; `cli.md` is the command surface and `status-lifecycle.md` is the state model.

A card begins with `---` … `---` frontmatter. The accepted subset is deliberately small — **no
type guessing**:

```yaml
key: plain scalar          # everything is a string; read back verbatim
key: [a, b]                # inline array (closed on one line)
key: "quoted"              # JSON string — the only way to write an escaped value
key: |                     # literal block — newlines kept
key: >                     # folded block — newlines become spaces
```

Anything else is a **hard error naming its line** (an indented mapping, a value on the next
line without a block marker, tab indentation, an unclosed array). `id` and `title` are
required; a card missing either is refused (`MD_PARSE_ERROR`) and skipped per card, never as a
batch abort.

## Field reference

Exactly the 23 keys of `KNOWN_CARD_KEYS`, in that order. Anything else is preserved — see
§Unknown keys are preserved.

| Key | Meaning | Values & rules |
|---|---|---|
| `id` | **Required.** The card's board identifier. | Non-empty; stored verbatim as `tasks.identifier` (never re-minted). Duplicate within a project is refused. |
| `title` | **Required.** One-line summary. | Non-empty string. |
| `status` | Where the card sits in the lifecycle. | The seven stages plus the `awaiting` overlay; absent ⇒ `todo`. Read aliases (never stored): `ready`, `failed`, `cancelled`, `in-review`, `in-progress`. |
| `priority` | Urgency. | `low` · `medium` · `high` · `urgent`, case-insensitive; absent/empty ⇒ `medium`. |
| `kind` | The card's role. | `task` · `epic` · `deploy`; anything else reads as `task`. Only an `epic` may be a parent; `kind` is patchable, but an epic with children cannot be downgraded. |
| `labels` | Free-form tags, shown in order. | Inline array (or comma-separated scalar); trimmed, de-duplicated; each ≤ 64 chars, at most 32. |
| `project` | **Required.** The board project. | Its id or registered name; an unresolvable name is a warning + skip, never a silently created project. |
| `assignee` | Who is on the hook. | A dictionary name; empty ⇒ unassigned. |
| `assignee_kind` | The kind a **new** name becomes. | `agent` · `human`; absent ⇒ `agent`; ignored on an exact reuse. Not re-emitted on export. |
| `created_by` | Who created the card. | A name → the actor registry + `tasks.reporter_id`; kind is `human` unless `created_by_kind` says otherwise. |
| `created_by_kind` | What that provenance key is. | `human` · a platform (`claude`, `codex`, …) · `taskd`; absent ⇒ `human`. Written back only when not the default. |
| `created_at` | When the card was created. | ISO 8601, normalised to ms-Z; absent ⇒ the import clock. |
| `updated_at` | Last content change. | Same coercion; absent ⇒ `created_at`. |
| `status_changed_at` | When `status` last changed. | Same coercion; absent ⇒ `created_at`, else the import clock. |
| `claimed_by` | Who holds the claim. | A name; empty ⇒ `NULL`. |
| `claimed_kind` | What kind of actor holds it. | `agent` · `human` · a platform; absent ⇒ `NULL` ("not recorded"). Written on export only when set. |
| `claimed_at` | When the claim was taken. | Timestamp, same coercion; travels with `claimed_by`. |
| `heartbeat_at` | Last liveness signal from the holder. | Timestamp, same coercion. |
| `blocked_at` | When the card entered `blocked`. | Timestamp; absent while blocked ⇒ `status_changed_at`. |
| `blocked_reason` | **Why** the card is blocked. | One of the eight literals below, or absent. |
| `depends_on` | Blockers that must finish first. | Inline array of card ids; direction is `blocks` with **source = the blocker**. An unresolvable id is a warning + skip. |
| `parent` | This card's parent. | A single card id; the parent must exist **and be an `epic`** (otherwise warning + skip). |
| `notify_leader` | Tell the leader this card needs attention. | Kept verbatim in `meta_json`; the board preserves it and does not act on it. Legacy alias `notify_elon`. |

### The status machine

- **A card's `status` is read, not replayed.** The importer writes history; it does not perform
  moves. A card saying `in_review`/`done` imports with `origin: "import"` and does not satisfy a
  later delivery gate.
- **Aliases are read, never written.** An exported card writes the canonical word.
- **Status is input, not permission.** A hand-written card may name any status; `issue move`
  still refuses an illegal move.

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
2. **Absent means the key is missing, not empty.** `blocked_reason: ""` reads as unset and is
   not written back.
3. **A supplied value must be one of the literals.** Nothing is folded or lower-cased;
   surrounding whitespace is trimmed, and that is the only exception.
4. **It follows the status.** Written with the move into `blocked`, cleared by the move out;
   `blocked_at` is kept, because it dates the last blockage.
5. **An unrecognised value is preserved, not lost.** It keeps its text and slot, goes back out
   on export, and the column stays empty; the import warns. Import-edge only — a value supplied
   to the board is refused outright.

## Unknown keys are preserved

Any key outside the 23 is kept verbatim in `meta_json.legacy`, in the card's own order, and
re-emitted on export. That round-trip is what the migrator is built on. Keys riding this path
today: `target` (an opaque per-card value), `goal`, `review_of`, and a team's own bookkeeping
(`git_rules`, `subsession_ids`, …). **Do not delete a key you do not recognise.**

## Body sections

The body is `##` sections, canonical order **Background · Acceptance · Progress · Comments ·
Sessions · Report** — the importer reads exactly these six. An unknown `##` section is **not**
carried onto the board; a team-only section belongs in frontmatter or `meta`. Prose before the
first heading is kept as the background. `## Background` becomes the card's description.

```
## Comments
- <ts> · <kind> · <author> — <body>
```
`<kind>` is a closed enum: `discuss` · `decision` · `confirm` · `change` · `note` · `defect`.
The shape is tolerated (a non-comment line is a notice and is skipped), the enum is not — an
unknown kind is `VALIDATION_FAILED`. Newlines in `<body>` are escaped as `\n`. Append-only: a
correction is a new `change` comment.

```
## Sessions
- seg:<name> · owner:<agent> · backend:<cli> · id:<uuid> · phase:<p> · status:<s> · pid:<n> · <ts>
```
`status` ∈ `running` · `closed` · `failed` (anything else degrades to `running`). Sessions are
keyed naturally (`seg/owner/backend/id`), so a re-import does not duplicate them.

```
## Progress
- <ts> <text>
```
One line per progress note, order preserved; the timestamp is optional. Each becomes a
`progress` activity.

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
Acceptance status is `met` · `partial` · `not_met` · `not_applicable`; the checkbox `- [x]` reads
as `met`. Evidence is a **closed** set — anything else is a notice + skip. A round with no
acceptance items and no evidence is a **narrative**: it imports (conclusion only) with a
warning. Every imported report carries `origin='import'` and never satisfies the delivery gate.

## Round-trip rules

| Rule | Consequence |
|---|---|
| Fixed key order and section order | An exported card is byte-identical however the input was written. |
| Unknown keys re-emitted in place | A rewrite does not lose a team's own fields. |
| A known key's unrecognised value re-emitted in place | Recognising a key never costs a card its wording. |
| Legacy status word restored | A card that said `ready` exports `ready`. |
| Empty values become `NULL`, never `""` | An invariant can never trip on a frontmatter artefact. |
| Optional keys written only when set | An existing card is not grown by a key it never had. |
| An unparsable card is skipped and reported | One bad file never sinks a migration. |
| Growth guard | A rewrite that would grow a card past the guard factor refuses. |

Asymmetries: `assignee_kind` is not re-exported (it lives on the actor row); `meta_json` holds
both `notify_leader` and every unknown key under `legacy`; `acceptance_derived` is board meta,
not a card key, and is not re-emitted.

## Conformance

This page is hand-maintained; the code is not. The field table is asserted against
`KNOWN_CARD_KEYS` in the source repository's `src/core/storage/md/import.mjs`. Run this **from
the repository root**; it exits `0` when they agree, `1` when they disagree, `2` when no
checkout is present:

```bash
node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
const code = "./src/core/storage/md/import.mjs";
if (!existsSync(code)) {
  console.error(`card-schema conformance: needs the taskpanel checkout — ${code} is not here.`);
  process.exit(2);
}
const { KNOWN_CARD_KEYS } = await import(code);
const md = readFileSync("skills/meerkat-taskpanel/references/card-schema.md", "utf8");
const table = md.split("## Field reference")[1].split("\n## ")[0];
const keys = [...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
const same = keys.length === KNOWN_CARD_KEYS.length && keys.every((k, i) => k === KNOWN_CARD_KEYS[i]);
console.log(JSON.stringify({ doc: keys.length, code: KNOWN_CARD_KEYS.length, same }));
process.exit(same ? 0 : 1);
'
```

If it prints `false`, the code moved and this page owes an update: **`KNOWN_CARD_KEYS` is the
source of truth.**
