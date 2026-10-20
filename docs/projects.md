# Projects and the identifier prefix

A project is the board's grouping of tasks (a name, a label set, free-form meta and the
identifier counter). It carries **no working directory** — the local directory a project's
*workers* run in is decided on the agent side, in `projects.json`, never on the board; a
project need not have one at all (operations work, for instance), and where a project
keeps whatever its tasks produce is its own business.

## The id is also the identifier prefix

Every task identifier is `<PREFIX>-<serial>`. The prefix is **derived from the project id** by
`identifierPrefix` (`src/foundation/ids.mjs`):

1. trim surrounding whitespace,
2. uppercase,
3. collapse every run of characters that is not `A`–`Z` or `0`–`9` into a single `-`,
4. strip leading and trailing `-`.

The derivation is many-to-one — a whole family of ids lands on one prefix:

| project id | identifier prefix |
|---|---|
| `meerkat-taskpanel` | `MEERKAT-TASKPANEL` |
| `demo_x`, `demo-x`, `demo.x`, `demo  x` | `DEMO-X` |
| `openclaw-team`, `openclaw_team`, `openclaw.team` | `OPENCLAW-TEAM` |
| `Demo`, `demo` | `DEMO` |

## The prefix is unique across projects

Because two projects sharing a prefix hand out **the same** identifiers (`OPENCLAW-TEAM-0007`
from either would be indistinguishable on a card), `project create` refuses an id whose prefix
is already used by another project:

- it fails with `VALIDATION_FAILED` (HTTP `400`), and the error names the existing project id
  that owns the prefix (`details.conflictProjectId`; the conflicting id is also in the message);
- **nothing is written** — the refusal happens inside the create transaction, before the row
  (and its `project_created` activity) would be inserted;
- the attempt is deterministic: the same id is refused the same way every time.

The check runs against **all** projects, archived included — archiving a project does not retire
its prefix, because the identifiers it already handed out are still on cards.

A couple of deliberate non-refusals:

- **An exact repeat of the same id** is not a prefix collision; it is the same project, and the
  primary key answers it with `ID_CONFLICT` (HTTP `409`).
- **An id with no usable prefix** (e.g. `###`, `***`) is *not* rejected at creation. That guard is
  unchanged and lives downstream: the first attempt to allocate an identifier for such a project
  fails with `VALIDATION_FAILED … has no usable identifier prefix` (`identifierFor`). This rule is
  about collisions, not emptiness.

## Pre-existing collisions are read, not repaired

A board can already contain projects that collide — data imported before this rule existed, or
written straight through the storage layer. The board **reads it normally**: nothing is renamed,
no command fails, and startup is not blocked. The rule applies to *new* creations only, so a new
id that joins an existing collision is refused and told which project it clashes with.

To resolve an existing collision, give one project a distinct id (for example `openclaw_team_2`)
rather than relying on the two being told apart on the board; archiving does not free a prefix.
