# Projects and the identifier prefix

A project is the board's grouping of tasks (a name, a label set, free-form meta and the
identifier counter). It carries **no working directory** — the local directory a project's
*workers* run in lives in one machine-local `projects.json` at the config root, maintained
with `taskctl project map`, never on the board; a
project need not have one at all (operations work, for instance), and where a project
keeps whatever its tasks produce is its own business. The loop does write its own process
data under that directory (`.meerkat/<identifier>/`: the exported `card.md` plus a
subagent's notes, evidence and downloaded attachments) — loop state, not a project-results
store, and worth ignoring in version control.

## A project's prefix names its cards

Every task identifier is `<PREFIX>-<serial>`. The prefix is the project's **identity
prefix**: it names every card that project issues, and it is fixed when the project is
created (see [The prefix is fixed at creation](#the-prefix-is-fixed-at-creation)).

A new project's prefix is 1–4 characters of `A`–`Z` and `0`–`9`, checked **after**
normalization. Normalization is `identifierPrefix` (`src/foundation/ids.mjs`), the one
function every path shares:

1. trim surrounding whitespace,
2. uppercase,
3. collapse every run of characters that is not `A`–`Z` or `0`–`9` into a single `-`,
4. strip leading and trailing `-`.

So `tp` and `TP` both become `TP`, and a one-letter or four-letter prefix (`A`, `ABCD`) is
just as valid as a two-letter one. The rule itself lives beside the normalizer:
`PROJECT_PREFIX_MAX` (`4`), `PROJECT_PREFIX_PATTERN` (`^[A-Z0-9]{1,4}$`) and
`isValidProjectPrefix`.

The normalizer is deliberately wider than the rule. It is what the **read** path uses, so a
row that already carries a longer or hyphenated token (`MEERKAT-TASKPANEL`, `DEMO-X`) still
reads and numbers cards exactly as before — those tokens survive only on legacy/imported
rows (see [The legacy and import seam](#the-legacy-and-import-seam-reads-stay-lenient)).

## Where a new project's prefix comes from

Creation resolves the prefix from exactly one of two sources, in this order:

1. **Declared** — `meta.prefix` on the create body. The CLI spelling is
   `taskctl project create --prefix <p>` (also accepted by `project ensure`), which folds
   the flag into that reserved key. The declared value is normalized and **stored**
   normalized, so what the allocator later reads is already the token the create was
   checked against. `tp` stores `TP` and numbers `TP-0001`.
2. **Id-derived** — with no declared prefix, the project id supplies it (`demo` → `DEMO`).
   Nothing is stored; identifier allocation falls back to `identifierPrefix(id)`, which is
   where projects created before the declared prefix existed get their token.

**A declared prefix wins** when both are present: `project create --id meerkat-taskpanel
--prefix MTP` creates that id and numbers it from `MTP`. With `--prefix` alone the id is
optional — the server mints an opaque project id (a UUID) that the prefix does not depend
on. `--prefix` is sugar for `meta.prefix`, the one reserved metadata key; passing both with
different values is a usage error (exit 2, `CLI_USAGE`), while the same value is accepted.

## Every create path holds the 1–4 `[A-Z0-9]` rule

The rule is applied to the winning source on **every** path that creates a project — the
CLI's `project create`, the HTTP `POST /api/v1/projects`, and `project ensure` when the
project does not exist yet. It runs inside the create transaction, after normalization and
before the insert, and the checks run in a fixed order: value type, then emptiness, then
shape — and only then the prefix-uniqueness check, so an out-of-shape prefix is never
reported as a collision.

A value outside the rule refuses the create with `VALIDATION_FAILED` (HTTP `400`), and
**no row lands**. The refusal shape is exact:

| What was sent | `details` | `hint` |
|---|---|---|
| A `meta.prefix` that is not a string | `{ field: "meta.prefix", received }` | — |
| A `meta.prefix` that normalizes to nothing (`####`, `"   "`, `---`) | `{ field: "meta.prefix", received }` | — |
| A `meta.prefix` that normalizes outside the rule (`abcde` → `ABCDE`, `or c` → `OR-C`) | `{ field: "meta.prefix", received, prefix, max: 4 }` | — |
| An explicit id with no declared prefix whose token is empty or outside the rule (`other` → `OTHER`, `demo-x` → `DEMO-X`, `###` → `""`) | `{ field: "id", projectId, prefix, max: 4 }` | `fix`: run `taskctl project create --prefix <p>` with 1–4 characters of `A`–`Z` and `0`–`9` |
| Neither an id nor a declared prefix | `{ field: "meta.prefix", max: 4 }` | the same `fix` |

The last two rows are what closed the old deferred failure. A create with no prefix source
no longer mints a UUID and derives a token from it, and an id whose token is unusable no
longer becomes a project that fails on its first card. A long id is refused at creation and
the error says what to do: declare a short prefix (for example `--prefix MTP`) rather than
shortening the id. The project id itself stays opaque; only the prefix has a shape.

The two pre-existing declared-prefix refusals keep their earlier shape deliberately: a
non-string or empty-normalizing `meta.prefix` reports `field` and `received` only, with no
`max` and no `hint`.

`project ensure <id>` is idempotent, and the rule respects that: an existing project —
including a legacy row with a long token — is read back **untouched**, and the check
applies only when the call actually creates the project.

## The prefix is unique across projects

Because two projects sharing a prefix hand out **the same** identifiers (`OPENCLAW-TEAM-0007`
from either would be indistinguishable on a card), creation refuses a prefix that is already
used by another project:

- it fails with `VALIDATION_FAILED` (HTTP `400`), and the error names the existing project id
  that owns the prefix (`details.conflictProjectId`; the conflicting id is also in the message),
  with `details.field` naming the source that supplied the candidate (`meta.prefix` or `id`);
- **nothing is written** — the refusal happens inside the create transaction, before the row
  (and its `project_created` activity) would be inserted;
- the attempt is deterministic: the same prefix is refused the same way every time.

The check compares **normalized** prefixes against **all** projects, archived included —
archiving a project does not retire its prefix, because the identifiers it already handed
out are still on cards. It runs on every create path, after the shape checks above.

An exact repeat of the same id is not a prefix collision; it is the same project, and the
primary key answers it with `ID_CONFLICT` (HTTP `409`).

## The prefix is fixed at creation

A project's prefix cannot be changed afterwards. An update never replaces a stored
`meta.prefix` and never introduces one: a project created from its id keeps deriving from
that id, and a project created with a declared prefix keeps the stored one even if the
update carries a different `meta.prefix`. There is no CLI flag or HTTP field that edits it —
the reserved key is the server's to write, at creation only.

## The legacy and import seam reads stay lenient

The 1–4 rule is a **creation gate**, not a storage constraint. Rows written before the rule
existed — or written straight through the storage layer, `repos.projects.create`, which is
the import/seed seam — may carry longer or hyphenated prefixes (`MEERKAT-TASKPANEL`,
`DEMO-X`). The board reads them normally: `projectPrefix` returns the stored token, and
identifier allocation keeps numbering their cards with it, exactly as before the rule.

The deferred failure still exists, but only for such rows: a legacy row whose effective
prefix is empty fails its first card allocation with `VALIDATION_FAILED … has no usable
identifier prefix` (`identifierForPrefix`). And since the normalizer has no length cap of its
own, a legacy prefix long enough to push the whole generated identifier past 128 characters
makes card creation fail `VALIDATION_FAILED`; no new project can reach either state, because
the create path refuses the prefix first.

## Pre-existing collisions are read, not repaired

A board can already contain projects that collide — data imported before this rule existed, or
written straight through the storage layer. The board **reads it normally**: nothing is renamed,
no command fails, and startup is not blocked. The rule applies to *new* creations only, so a new
id that joins an existing collision is refused and told which project it clashes with.

To resolve an existing collision, give one project a distinct id (for example `openclaw_team_2`)
rather than relying on the two being told apart on the board; archiving does not free a prefix.
