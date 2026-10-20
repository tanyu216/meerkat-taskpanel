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
| `status` | Where the card sits in the lifecycle. | One of the seven canonical words, or the author's legacy word for that state (`ready`, `failed`, `cancelled`, `in-review`, `in-progress`). |
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

- **The card carries the stored status**, except that a legacy word (`ready` / `failed`) is
  written back when the card originally used one.
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

## Body sections

The body is `##` sections, canonical order **Background · Acceptance · Progress · Comments ·
Sessions · Report**. The exporter writes exactly these six. Prose in `## Background` becomes
the card's description.

```
## Comments
- <ts> · <kind> · <author> — <body>
```
`<kind>` is a closed enum: `discuss` · `decision` · `confirm` · `change` · `note` · `defect`.
Newlines in `<body>` are escaped as `\n`.

```
## Sessions
- seg:<name> · owner:<agent> · backend:<cli> · id:<uuid> · phase:<p> · status:<s> · pid:<n> · <ts>
```
`status` ∈ `running` · `closed` · `failed`.

```
## Progress
- <ts> <text>
```
One line per progress note, order preserved; the timestamp is optional.

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
| Legacy status word restored | A card that said `ready` exports `ready`. |
| Optional keys written only when set | An existing card is not grown by a key it never had. |
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
