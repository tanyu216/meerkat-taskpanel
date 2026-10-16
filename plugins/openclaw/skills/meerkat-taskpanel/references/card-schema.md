# Card schema — frontmatter & sections

> **What this covers.** The **card**: the markdown file Meerkat TaskPanel reads and writes.
> Every frontmatter key, every body section, and the rules that make a rewrite safe. This is
> the *file format*; `docs/contract.md` is the *wire* format (HTTP routes and JSON DTOs), and
> `cli.md` is the command surface. A card is what `taskctl export md --out <dir>` writes and
> what the md migrator reads back —
> `node src/core/storage/md/migrate-cli.mjs import --dir <cards>`, run **in the taskpanel
> repository** (see `docs/migration.md`), because the migrator is source code and this skill
> does not ship `src/`.
>
> **A `src/…` path is provenance, not a location in this skill.** Every `src/…` and
> `docs/…` path in this page names a file in the **taskpanel source repository** — where a
> fact is *defined*. This skill distributes only `SKILL.md`, `references/` and `scripts/`, so
> none of those paths exists beside this page and none of them can be opened or run from an
> installed copy. The single command below that must run in the checkout says so (§Conformance);
> everything else you *run* goes through `taskctl`.

**The product owns this schema.** A card is not a private convention of one team's framework:
the keys below are declared in code — `KNOWN_CARD_KEYS` in the source repository's
`src/core/storage/md/import.mjs` — and the importer and the exporter are built around that one
list. §Conformance is the command that keeps this document and that list honest.

---

## Where the schema lives

| Layer | Owns | File (in the source repository) |
|---|---|---|
| **Card (this doc)** | frontmatter keys, section shapes | `src/core/storage/md/{import,export,sections,frontmatter}.mjs` |
| Board / wire | task DTOs, routes, error codes | `docs/contract.md` |
| Storage | SQLite columns, triggers | `src/core/storage/migrations/*.sql` |

The card is the **authoring** surface: hand-write one, or let `taskctl export md` produce a
canonical one. An exported card is byte-stable — fixed key order, fixed section order — so
`import → export` of the same board always yields the same bytes.

---

## Frontmatter syntax

The card begins with `---` … `---`. The accepted subset is deliberately small — **no type
guessing**, because guessing is what turns a migrator into a data-corruption engine
(`src/core/storage/md/frontmatter.mjs`):

```yaml
key: plain scalar          # everything is a string; read back verbatim
key: [a, b]                # inline array (closed on one line)
key: "quoted"              # JSON string — the only way to write an escaped value
key: |                     # literal block — newlines kept
key: >                     # folded block — newlines become spaces
```

Everything else is a **hard error naming its line**: an indented mapping, a value on the next
line without a `|` or `>` marker, tab indentation, an unclosed array, an unparsable quoted
value. Multi-line strings are written as block scalars, which is what keeps a rewrite from
growing a file without bound.

Two keys are **required**: `id` and `title`. A card missing either is refused
(`MD_PARSE_ERROR`), per card — one unparsable file is skipped and reported, never a batch abort.

---

## Field reference

Exactly the 21 keys of `KNOWN_CARD_KEYS`, in that order. Anything else is preserved, not
mapped — see §Unknown keys are preserved.

| Key | Meaning | Values & rules |
|---|---|---|
| `id` | **Required.** The card's board identifier. | Any non-empty string, but it is the card's permanent handle: the importer stores it **verbatim** as `tasks.identifier` (it does not re-mint it). The board mints `PREFIX-NNNN` for cards created through the CLI/UI — see `cli.md` §`project` for the identifier-prefix convention. A duplicate within a project is refused. |
| `title` | **Required.** One-line summary. | Non-empty string. |
| `status` | Where the card sits in the lifecycle. | `backlog` · `todo` · `in_progress` · `in_review` · `blocked` · `done` · `canceled`, plus the overlay `awaiting`. Absent ⇒ `todo`. The seven stage statuses are the board's columns; `awaiting` is an **attention overlay**, not an eighth column. Read aliases (never stored): `ready`→`todo`, `failed`→`canceled`, `cancelled`→`canceled`, `in-review`→`in_review`, `in-progress`→`in_progress`. See §The status machine. |
| `priority` | Urgency. | `low` · `medium` · `high` · `urgent`, case-insensitive. Absent/empty ⇒ `medium`. Anything else is refused (`VALIDATION_FAILED`). |
| `kind` | The card's role. | `task` · `epic` · `deploy`. Anything the vocabulary does not name is read as `task`. **Only an `epic` may be a parent** (`parent:` and `relation add --type parent`); a `deploy` card is a work card no automatic read may offer. |
| `labels` | Free-form tags, shown in order. | Inline array `[a, b]` (or a comma-separated scalar). Trimmed, de-duplicated, order kept. Each label ≤ 64 chars, at most 32 labels. Labels register in the project's label registry, so an imported card ends up with the same first-seen spelling a CLI write would produce. |
| `project` | **Required** — which board project the card belongs to. | The project's **registered name** (a key in `projects.json`) or its id; resolved to the project id. May be supplied by `--project` instead. An unresolvable name is a warning + skip, never a silently created project. |
| `assignee` | Who is on the hook. | A dictionary name. Empty ⇒ unassigned. |
| `assignee_kind` | The kind of the actor a **new** name becomes (the dictionary is one table; `agent` · `human`). Ignored on an exact reuse — the stored kind wins. | `agent` · `human`. Absent ⇒ `agent`. **Not re-emitted on export** (see §Round-trip rules). |
| `created_by` | Who created the card. | A name → the `actors` registry + `tasks.reporter_id` (the provenance key: `0019` collapsed the card's creator into its reporter). The kind recorded is `human` unless `created_by_kind` says otherwise — the role's own definition, since a card's provenance key is who filed it. |
| `created_by_kind` | What that provenance key is. | `human` · a platform (`claude`, `codex`, `pi`, …) · `taskd` · whatever a host calls itself. Absent ⇒ `human`. Fills `reporter_kind`. Written back on export only when it is **not** the default, so a card that never carried one does not grow a line. |
| `created_at` | When the card was created. | ISO 8601. Absent ⇒ the import clock. Always normalised to the canonical ms-Z form (`2026-10-08T15:31:25.161Z`) — `2026-10-08T14:03Z` and `…+08:00` are coerced, and the coercion is recorded as a notice, not silently swallowed. |
| `updated_at` | Last content change. | Same coercion. Absent ⇒ `created_at`. |
| `status_changed_at` | When `status` last changed. | Same coercion. Absent ⇒ `created_at`, else the import clock. |
| `claimed_by` | Who holds the claim. | A name. Empty ⇒ `NULL` — an empty frontmatter value **never** becomes an empty string in a column, or a real invariant (e.g. "a backlog card is not claimed") would trip on it. |
| `claimed_at` | When the claim was taken. | Timestamp, same coercion. `claimed_by`/`claimed_at` travel as a pair. |
| `heartbeat_at` | Last liveness signal from the holder. | Timestamp, same coercion. This is what separates a live worker from an abandoned card. |
| `blocked_at` | When the card entered `blocked`. | Timestamp, same coercion. Absent while `status: blocked` ⇒ `status_changed_at`. |
| `blocked_reason` | **Why** the card is blocked — what it is waiting for. | One of `clarify` · `decision` · `dependency` · `out_of_bounds` · `defect` · `external` · `resource` · `unknown`, or absent. Trims surrounding whitespace and nothing else; an absent value is *not* written back as an empty key. See §`blocked_reason`. |
| `depends_on` | Blockers: these must finish **before** this card. | Inline array of card **ids**, e.g. `[PROJ-0007]`. The direction is `blocks` with **source = the blocker**, target = this card. An unresolvable id is a warning + skip (the card still imports). |
| `parent` | This card's parent. | A single card id. The parent must exist **and be an `epic`**; a non-epic parent is a warning + skip, never a silent link. |
| `notify_leader` | Tell the leader this card needs attention. | A scalar flag, kept **verbatim** in `meta_json.notify_leader` and readable as the task DTO's `meta.notify_leader`. The board preserves it; it does not itself act on it. The legacy spelling `notify_elon` is accepted as a read alias — the canonical key always wins when both are present. |

### The status machine

The whitelist in `src/core/domain/status.mjs` is the only fact source, and the database
re-encodes the same table as a trigger — the two are tested against each other.

```
backlog      → todo | canceled
todo         → backlog | in_progress | blocked | canceled
in_progress  → in_review | blocked | todo | canceled | awaiting
awaiting     → in_progress | canceled
in_review    → done | in_progress | blocked
blocked      → todo | in_progress | in_review | canceled
done         → (terminal — I3)
canceled     → (terminal — I3)
```

Three properties are load-bearing:

- **`done` is reachable only from `in_review`** — no delivery without review.
- **Leaving `in_review`** (to `in_progress` or `blocked`) **starts a new delivery round**; the
  previous round's report stops counting. `awaiting → in_progress` is *not* such an exit: it
  resumes the same attempt, round untouched.
- **`awaiting` is the overlay.** `in_progress → awaiting` is the only way in — the move must
  carry one of the reason codes `E1`…`E5` (a task attribute, not a frontmatter key) — and
  `awaiting` cannot reach `in_review` directly: that would be a delivery-gate bypass.

A card may not enter `in_review` without a report **for the current round**. That is the
delivery gate; `cli.md` §`report` has the command surface and the audited waiver.

---

## `blocked_reason` — what a blocked card is waiting for

`blocked_at` says *when* a card started waiting; it cannot say **what** it is waiting for. Two
cards in `blocked` — "the leader owes an answer" and "the predecessor has not landed" — look
identical on the board without it, and a reader (a person, or a process inspecting the board)
has to open the comment trail and guess. `blocked_reason` is that missing half: a
single-value enum naming **who or what** the card waits for.

It is deliberately **not a severity and not an explanation** — prose belongs in the comment
trail, which is where a reader looks for it.

| Value | The card is waiting on |
|---|---|
| `clarify` | an answer from the leader to an ambiguous requirement |
| `decision` | a decision fork, or a gate sign-off |
| `dependency` | a predecessor card, or an upstream artifact that has not landed |
| `out_of_bounds` | a hand-back: the card is outside the worker's duties |
| `defect` | the defect loop |
| `external` | something outside the team — a third-party service, an operator input, a host resource |
| `resource` | capacity — host, model, concurrency limits |
| `unknown` | present, but not classified |

Five rules go with it:

1. **Absent is legal, and is not `unknown`.** A `blocked` card with no reason is valid — a
   reader treats it exactly as it treats `clarify`. `unknown` is a writer saying *"there is a
   block and I cannot classify it"*, which is a different statement from saying nothing.
2. **Absent means the key is missing, not empty.** A card that never carried a reason exports
   without the line, byte-identical to how it always did. There is no empty form of the field:
   `blocked_reason: ""` is read as *unset* (the same column value as an absent key), and it is
   **not** written back — a rewrite of such a card drops the line.
3. **A supplied value must be one of the literals.** Nothing is folded, repaired or
   lower-cased into place: `Dependency` and `deps` are both refused, naming the field and the
   allowed set. Accepting a near-miss is how one state ends up with two spellings.
   **Whitespace is the one exception**: a value is trimmed before it is tested, so
   `"  dependency  "` is accepted *as* `dependency`. Space around a word is not a second
   spelling of it; a different word is. The trim is not remembered, so a card written with the
   spaces comes back without them.
4. **It follows the status.** The value is written in the same update that moves the card into
   `blocked`, and cleared by the update that moves it out — the field describes the *current*
   block, so a card that has moved on must not go on claiming it is waiting. (History is not
   lost: the reason is recorded on the card's activity trail.) `blocked_at` is deliberately
   the opposite and is *kept* on the way out, because it dates the last blockage.
5. **A value the vocabulary does not name is preserved, not lost.** A card is written by a
   provider the board does not control, and before the key was recognised such a card rode
   through `meta_json.legacy` untouched. Recognising the key may not turn it into a lost card:
   an unrecognised value keeps its original text, in its original slot, still goes back out on
   export word for word, and the *column* stays empty. The import reports it as a warning, and
   the card carries `blocked_reason_unrecognized` among its `meta_json.import_warnings`. This
   leniency belongs to the import edge only — a value supplied to the board itself (a move, a
   create) is refused outright. And it lasts exactly as long as the column is empty: once the
   board is the one that wrote a reason, the card exports the board's value, as it does for
   every other field.

---

## Unknown keys are preserved

**Any frontmatter key outside the 21 above is kept verbatim** in `meta_json.legacy` — in the
card's own order — and **re-emitted on export**, in its original position. Nothing is dropped
because this document does not happen to name it; that round-trip is the property the whole
migrator is built on.

Keys that ride this path today, all deliberate:

| Key | Why it is not a mapped field |
|---|---|
| `target` | **O3: the board owns no project directory.** A card's `target` is an opaque per-card value — never derived from, or reconciled against, a project. |
| `goal`, `review_of` | Named as "kept verbatim" fields, but mapping them nowhere is worse than not recognising them at all: listed as known, they were *recognised and then dropped* — the exact loss the M5 drill exists to catch. Unknown means round-tripped. |
| `git_rules`, `subsession_ids`, `active_session_id` | A team's own bookkeeping. The board neither reads nor validates them. |

So: **do not delete a key you do not recognise.** Removing it from the file removes it from the
board's copy too; leaving it costs nothing.

---

## Body sections

The body is `##` sections. Canonical order — what `taskctl export md` writes — is
**Background · Acceptance · Progress · Comments · Sessions · Report**, and that set is the
**whole** body vocabulary: the importer reads exactly these six. Note the asymmetry with
frontmatter — an unknown `##` section is **not** carried onto the board, so a team-only section
belongs in frontmatter (where unknown keys round-trip) or in `meta`. Prose before the first
heading is kept and treated as the background.

`## Background` is free prose and becomes the card's description.

### `## Comments`

```
- <ts> · <kind> · <author> — <body>
```

| Part | Values |
|---|---|
| `<ts>` | ISO 8601; coerced to ms-Z like the frontmatter timestamps. |
| `<kind>` | `discuss` · `decision` · `confirm` · `change` · `note` · `defect` — a **closed enum**. A human `decision` / `confirm` / `change` is a decision on the record (I5); a `change` is also how an earlier decision is superseded. |
| `<author>` | The actor's name. The kind is inferred as for `created_by`. |
| `<body>` | One line: newlines are escaped as `\n`, backslashes as `\\`. |

The **shape** is tolerated, the **enum** is not. A line that is not a comment (a wrapped
continuation, a stray bullet, a table row) is recorded as a notice and skipped, so a
hand-written card still parses. But a well-formed line naming an unknown `<kind>` is a hard
`VALIDATION_FAILED` from the domain — the comment vocabulary is not open.

Comments are **append-only** (I4): there is no edit and no delete, on the card or in the
database. A correction is a new `change` comment.

### `## Sessions`

```
- seg:<name> · owner:<agent> · backend:<cli> · id:<uuid> · phase:<p> · status:<s> · pid:<n> · <ts>
```

One line per agent session that worked the card. `status` ∈ `running` · `closed` · `failed`;
a value outside that set degrades to `running`. Every one of the seven `name:value` fields and
the trailing timestamp is expected — the importer defaults the missing ones to empty, and a
line carrying a field name it does not know is a notice + skip. Sessions are keyed naturally
(seg/owner/backend/id), so re-importing the same card does not duplicate them. An HTML comment
(the unedited template placeholder) is not a session record and is skipped as a notice.

### `## Progress`

```
- <ts> <text>
```

One line per progress note, order preserved. The timestamp is optional: only a timestamp-shaped
first token is read as one, so a note that starts with a word keeps all of its text. Each line
becomes a `progress` activity on the card's timeline.

### `## Report`

The delivery history. Either the single legacy body (round 1) or one block per round:

```
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

| Part | Values |
|---|---|
| Heading | `### R<n> · <ts> · <author>`. Round numbers are the delivery round. |
| Conclusion | Free prose — the narrative a human reads. |
| `acceptance:` | `- [<status>] <text>` with status `met` · `partial` · `not_met` · `not_applicable`, and an optional ` — <note>`. The checkbox spelling `- [x] …` is read as `met`. |
| `evidence:` | Structured anchors only — a **closed** set: `commit`, `path`, `command` (with an exit code), `coverage` (with a scope). Anything else is a notice + skip; the point is that evidence is checkable, not that it is expressive. |
| `leftovers:` | One line naming what is still open. |

A round whose block carries **no** acceptance items and **no** evidence anchors is a
**narrative** — a historical, free-form report. It imports (conclusion only) with a warning
tag rather than being rejected, because the migrator's job is to read the cards a team actually
wrote. Every imported report carries `origin='import'`: it is **history**, and it never
satisfies the delivery gate, which counts only reports delivered in the current round.

---

## Round-trip rules

Properties `import → export` guarantees, and the reason to trust a rewrite:

| Rule | Consequence |
|---|---|
| Fixed key order and fixed section order | An exported card is byte-identical regardless of how the input was written. |
| Unknown keys re-emitted in place | A rewrite does not lose a team's own fields. |
| A known key's unrecognised value re-emitted in place | A card whose `blocked_reason` is not one of the literals keeps its own wording: the value is preserved under `meta_json.legacy` and the column stays empty, so recognising the key never costs a card. |
| Legacy status word restored | A card that said `ready` exports saying `ready`, not `todo`. |
| Empty values become `NULL`, never `""` | A real invariant can never trip on a frontmatter artefact. |
| Optional keys are written only when set | `blocked_reason` — like `labels`, `depends_on`, `parent` and `notify_leader` — writes no line when it is unset, so an existing card is not grown by a key it never had. `blocked_at`, `claimed_by` and the other always-written keys are the deliberate opposite. |
| A card that cannot be parsed is skipped and reported | One bad file never sinks a board's migration. |
| Growth guard | If a rewrite would grow a card beyond the guard factor, the export **refuses** rather than write. |

Two asymmetries worth knowing, both deliberate:

- **`assignee_kind` is not re-exported.** The assignee's kind lives on the actor row,
  not on every card, so an exported card omits the key.
- **`meta_json` is where the non-column values live**: `notify_leader` is a *known* key with
  its own meta slot (it has no column), while every unknown key — `target`, `goal`, … — lives
  under `meta_json.legacy`.

---

## Conformance

This document is hand-maintained; the code is not. The field table above is asserted against
`KNOWN_CARD_KEYS` — the code's own list.

> **This one needs the checkout.** There is no installed-copy form of this check, and none can
> be manufactured: the check *is* the agreement between this page and that code, and this skill
> does not ship `src/`. With no checkout present there is no `KNOWN_CARD_KEYS` to agree with,
> so the honest instruction is "run it in a checkout" rather than a substitute that would only
> look like a check. (Every other command this skill asks you to run goes through `taskctl`,
> which does work from an installed copy — see `SKILL.md` §Running the CLI.)

Run this from the **repository root**; it exits `0` when the two agree, printing
`{"doc":21,"code":21,"same":true}`, and `1` when they disagree:

```bash
node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
const code = "./src/core/storage/md/import.mjs";
if (!existsSync(code)) {
  console.error(`card-schema conformance: needs the taskpanel checkout — ${code} is not here.`);
  console.error("Run this from the repository root, or skip it: an installed copy of this skill carries no `src/`.");
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

The exit codes are three distinct answers: `0` the page and the code agree, `1` they disagree
(the page owes an update), `2` this is not a checkout so the question could not be asked — a
module-not-found stack is deliberately not one of them.

If it prints `false`, the code has moved and this page owes an update — not the other way round:
**`KNOWN_CARD_KEYS` is the source of truth, this table is its documentation.**
