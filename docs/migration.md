# Migrating the team's markdown cards

The team's cards live as markdown files under `~/.openclaw/team/tasks/*.md`, with a
project registry at `~/.openclaw/team/projects.json`. This document covers the
**dry run** that proves TaskPanel can take them over losslessly, the **shadow
(read-only) mode** that can run indefinitely next to them, the **single-point
switch** that would make the board authoritative, and the **rollback** that keeps
markdown the authority until that switch is deliberate.

> **Status: this is a rehearsal, not a switch.** The real cutover is a separate,
> approved change. Nothing in this repository flips an authoritative source —
> `scripts/migrate/reconcile.mjs` only ever *reads* the cards directory.

The field-by-field mapping contract this drill checks against is
`ARCHITECTURE.md` **§4.8** (Schema 映射) and the container-verification rule is
**§9.1**. Both are referenced by name + section below, never by line number.

## What the drill actually does

`scripts/migrate/reconcile.mjs` runs the whole shadow pass against a directory of
cards and writes a machine-readable report:

1. **import** every card into a throwaway SQLite board (with `project` name → id
   resolution through the registry);
2. **export** that board back to markdown, and **re-import** it into a *second*
   throwaway board (the round trip);
3. **import the same cards a second time** into the first board (idempotency);
4. **diff** the source cards against the round-tripped ones, field by field,
   section by section, relation by relation.

Every write happens inside one temporary workdir. The cards directory is opened
read-only and never modified. The report contains **statistics, hashes and
identifiers only** — never a card title or body (see *Privacy* below).

```bash
node scripts/migrate/reconcile.mjs \
  --dir ~/.openclaw/team/tasks \
  --projects ~/.openclaw/team/projects.json \
  --out .data/migrate-out/reconcile-report.json
```

Exit codes: **0** no differences · **3** differences found · **2** bad usage ·
**1** the run could not start. Warnings — a card with no `## Report`, a skipped
non-epic parent — do **not** by themselves make a difference; they are listed in
the report's `unmappable` and `warnings` lists instead.

## Shadow / read-only parallel mode

This is the recommended steady state *before* any switch. Markdown stays the
authority; the TaskPanel board is a **read-only replica** kept honest by running
the drill on a schedule (or on demand):

| | |
|---|---|
| **Authority** | `~/.openclaw/team/tasks/*.md` + `projects.json` — only these are written by the team |
| **Replica** | a TaskPanel board rebuilt by the drill; nobody writes to it |
| **Compared** | the §4.8 fields (per-field parity), the five sections (`comments`, `sessions`, `reports`, `progress`, `acceptance`), `## Background` content, `parent` and `depends_on` edges, labels, and the project-level diff (`name`/`id`, `workspace_path`, git rules) |
| **"Zero diff"** | `differences: []` — every field survived the round trip, every section count matched, every relation and label matched, the second import changed no rows (`idempotent: true`), and the report's `ok` is `true` (exit 0) |

**Zero diff does not mean zero *unmappable* items.** Some items are *expected*
and are reported, not hidden: a historical status word (`ready`, `failed`) is
stored canonically and kept verbatim in `meta_json.legacy_status` for a reversible
export; a card that says `in_review`/`done` with no `## Report` is imported with a
warning. These appear under `unmappable` with the card's identifier and a `kind`.
Read the report as: `ok` = "nothing was lost", `unmappable` = "here is exactly
what was, by design, not a byte-for-byte column".

The drill is **idempotent**: running it twice against the same directory produces
the same stats and the same aggregate hash (only `generatedAt` moves). The
report's `hashes.aggregate` is a single SHA-256 over `"<identifier> <sha256>"`
lines, so it is the cheap fingerprint of "the team's cards have not changed".

### What the drill tends to find

The dry run is deliberately unforgiving, and the shapes it flags are worth
knowing before reading its output as a verdict:

- **`## Acceptance` is tolerant.** A real section carries prose, a `>`
  annotation or an indented sub-bullet next to its checkboxes. Any non-checkbox,
  non-blank line — in `## Acceptance`, in a `## Report` acceptance sub-block, or
  in a `>`-prefixed note — is recorded as a **notice** and skipped; the
  checkboxes that are there are still read, and the card is **not** aborted. A
  `## Comments` line with no ` — ` separator (or a continuation line that is not
  its own comment) is likewise skipped with a notice. A card lands under
  `unparsable` only when it truly cannot be parsed: no `---` fence, no `id` or
  `title`, or an unknown `status`.
- **A historical `## Report` may be a free-form narrative.** The delivery gate
  (`normalizeReportCreate`) requires a non-empty acceptance list and at least one
  evidence anchor and **stays strict** — it governs delivery, not reading.
  Importing is a separate, relaxed path: a narrative with neither is stored
  conclusion-only (acceptance and evidence stay `[]`; nothing is fabricated), the
  task carries `import_warnings: ["report_narrative"]`, and the reconcile lists
  it as an informational `report-narrative` item — not a difference. A report
  *malformed in a non-narrative way* (an acceptance list but an unreadable
  evidence anchor, oversized, a round mismatch) is still reported as
  `report-invalid` and not written.
- **Cards may name an unregistered project.** A card's `project:` is a registry
  name; a name the registry lacks is warned and skipped (`project-unresolved`),
  never silently created. The reserved team-internal project `__team__` is the
  exception — it is **buildin** (see *The reserved `__team__` project* below).
- **Everything else, where a card does import, round-trips.** Field, section,
  relation and label parity, plus idempotency, are the properties the drill
  actually measures — and they are what "zero diff" means.

None of these are fatal to the drill: it reports them and exits 3. They *are*
fatal to the claim "the card set is ready to switch", so treat a non-zero diff
list as the work queue, not as a failure of the tool.

### The reserved `__team__` project

`__team__` is the reserved **team-internal** project (PROTOCOL §②): a team chore
that is not a repository. It is intentionally absent from `projects.json`, so the
parser treats it as a **buildin** entry rather than an unregistered name:

- it resolves in `parseProjectRegistry` (and, in `import.mjs`, even when no
  `--projects` registry is given at all) without appearing in the team file;
- a file entry named `__team__` still wins — the file is the authority;
- its `workspace_path` is the **synthetic absolute anchor `/__team__`**, which
  satisfies the `projects.workspace_path` NOT NULL / `LIKE '/%'` / UNIQUE
  constraints without hardcoding any real home path (this repository is public);
- its cards migrate as **ordinary tasks under the `__team__` project**. A
  `__team__` card's `target` is a per-card artifact path, not a project-level
  workspace path, so the "two different targets" warning is deliberately not
  raised for a buildin project — every `__team__` card would otherwise produce
  one. That difference is recorded in the report's `field-drift` list (the
  project-level `target` cannot equal every card's task-level path).

### Privacy: what the report may contain

The report is safe to keep in the public repo and to paste into a card comment:

- **allowed**: card identifiers (`T-…`), SHA-256 hashes, counts, booleans,
  project ids/names, the legacy status *word* (`ready`/`failed`), and paths
  relative to the mount (`/cards`, `/projects.json`);
- **never present**: card titles, `## Background` bodies, comment bodies, report
  conclusions/evidence, or any other prose from a card.

This is enforced structurally — not just by convention: `buildReport` in
`scripts/migrate/reconcile.mjs` only ever writes counts, identifiers and hashes
into the report object, and `test/migrate/reconcile.test.mjs` asserts the report
can be searched for card text and finds none. The container drill goes further:
the cards are bind-mounted **read-only** (`:ro`) and the report is the only thing
that leaves the container.

## What a real switch would be

A switch makes the TaskPanel `projects`/`tasks` tables the **single source of
truth** and freezes the markdown as a read-only snapshot. It is a **single-point
cutover window**: everything below happens once, while no agent is writing cards.

**Pre-conditions (all must be true):**

- the drill reports **`ok: true`** (exit 0) on the frozen card set, or every
  remaining `unmappable` item has been reviewed and accepted;
- the board has been backed up (`.data/board.sqlite` copied aside);
- a **cutover window** is agreed and announced; no agent is editing
  `~/.openclaw/team/tasks/*.md` or `projects.json`;
- `docs/install.md` and `README.md` have been followed so `taskd` runs and
  `taskctl` can reach it (`taskctl` auto-starts `taskd`; `TASKD_NO_AUTOSTART=1`
  disables that).

**The window:**

```bash
# 1. Freeze the markdown — make the cards directory read-only for the duration.
chmod -R a-w ~/.openclaw/team/tasks

# 2. Import the frozen cards and the registry into the live board.
node src/core/storage/md/migrate-cli.mjs import \
  --dir ~/.openclaw/team/tasks \
  --projects ~/.openclaw/team/projects.json \
  --resume
#    (taskctl export --md is the reverse; see Rollback.)

# 3. Re-run the drill against the *live* board's own export to confirm parity.
node scripts/migrate/reconcile.mjs \
  --dir ~/.openclaw/team/tasks \
  --projects ~/.openclaw/team/projects.json \
  --out .data/migrate-out/post-switch.json

# 4. Freeze projects.json as a read-only snapshot (see below).
cp ~/.openclaw/team/projects.json ~/.openclaw/team/projects.json.frozen-$(date +%F)
chmod a-w ~/.openclaw/team/projects.json

# 5. Point the team at the board: agents now use `taskctl` / the MCP server,
#    never the markdown files.
```

**Freezing the registry.** `~/.openclaw/team/projects.json` is the *current*
authority for project metadata (root/`workspace_path`, git rules, repos, guides).
After the import, that metadata lives in the TaskPanel `projects` table
(`workspace_path` + `meta_json`, per `ARCHITECTURE.md` §4.8 ④). Copy the file to a
timestamped, read-only snapshot — it is the audit trail of where the metadata came
from — and stop treating it as authoritative. From then on, **the `projects`
table is the single source of truth**; the snapshot is kept only so the mapping
can be reconstructed if anyone asks.

## Rollback plan

Markdown remains the authority until the switch is deliberately approved, so a
rollback is always available and is a data *export*, never a rewrite of history:

- **If the switch is called off before anyone depends on the board** — nothing to
  undo. The markdown was never modified; `reconcile.mjs` read it read-only.
- **If the board has taken live changes that must go back to markdown** — export
  the board and let the team diff/pick up from there:

  ```bash
  node src/core/storage/md/migrate-cli.mjs export --out /tmp/cards-from-board
  # or, once the CLI is built: taskctl export --md --out /tmp/cards-from-board
  ```

  The export is **reversible**: unrecognised frontmatter keys come back in their
  original order (`meta_json.legacy`) and a historical status word is re-emitted
  verbatim (§4.8 ①), so an exported card is the card the team wrote.

- **Forward-edit discipline.** Never rewrite the markdown from the board with a
  destructive git operation. Export to a *new* directory and review the diff; the
  repository's rules forbid destructive git (`git commit -- <explicit paths>`,
  never `git commit -a`; no `reset --hard`, no `clean -f`). If a card must be
  corrected, correct it forward in the authority that is live.

## Risks & checklist

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Field drift the export cannot carry back** | `assignee_kind` has no export home in the card key order, so a card whose `assignee_kind` is not the default drifts on the round trip | Reported as `unmappable[kind=field-drift]`. Decide per §4.8 ① whether to add it to the export order or accept the drift before the switch |
| **Status aliases** (`ready`→`todo`, `failed`→`canceled`) | the board stores the canonical word, so a raw byte comparison differs | Kept in `meta_json.legacy_status` and re-emitted on export; reported as `unmappable[kind=status-alias]` |
| **Cards missing `## Report`** | a delivery gate needs a report for the current round; historical cards predate the gate | Importer warns (`unmappable[kind=missing-report]`) and still imports; `in_review`/`done` cards without a report are flagged, never silently blessed |
| **A `## Report` that predates the structured schema** | a free-form narrative has no acceptance list and no evidence anchor, so the strict report validator cannot accept it verbatim | The narrative is imported conclusion-only (acceptance/evidence empty, nothing fabricated) and listed (`unmappable[kind=report-narrative]`); a *non-narrative* malformation is still `unmappable[kind=report-invalid]`. The gate is not weakened — only the read path |
| **A card the parser cannot read** | a real card can carry prose, a `>` note or a sub-bullet where a checkbox is expected | Those lines are recorded as notices and skipped; the card still parses. A genuinely unreadable card is reported under `unparsable` and as a `parse:` difference |
| **Non-epic parent** | only an `epic` may be a parent (§4.8 ③) | The link is **skipped with a warning** and listed (`unmappable[kind=non-epic-parent]`) — never silently dropped |
| **Invariant violations** (cycle / chain > 8 / fan-in > 8 / cross-project) | the DB triggers would refuse the edge | Refusals are caught per-edge, listed as `unmappable[kind=invariant-violation]`, and not lost |
| **Unregistered project name** | a card's `project:` is a registry *name*, not an id | Resolved name → id; an unresolved name is **warned and skipped** — a project is created only with an explicit `--create-project`. The reserved `__team__` is buildin and resolves without a registry entry |
| **`target` used task-level when it is project-level** | two different `target`s for one project is ambiguous | The first value wins and a warning is raised; reported in the project-level diff |
| **`notices` vs `warnings`** | an auto-created project is informational; a skipped card is a problem | Both are reported separately: `notices` never block, `warnings` are what a reviewer reads |

**Notices vs warnings (the split).** The importer keeps two lists apart on
purpose. A **notice** is "the run did something you might like to know" (a project
was created, legacy id = name behaviour was used). A **warning** is "something
could not be mapped faithfully". The reconcile report surfaces both, and
`warnings` is the one to read before a switch.

**Checklist**

*Pre-switch*
- [ ] drill reports `ok: true` (or every `unmappable` item reviewed and accepted)
- [ ] board backed up; card set and registry frozen for the window
- [ ] `taskd` reachable; `taskctl` installed; agents know the new commands

*Switch*
- [ ] cards directory made read-only for the window
- [ ] `import --dir … --projects … --resume` run once
- [ ] post-switch drill re-run and compared
- [ ] `projects.json` copied to a read-only, timestamped snapshot
- [ ] team told the board is now authoritative

*Post-switch*
- [ ] one working day with no agent reaching for the markdown files
- [ ] board export spot-checked against the frozen cards
- [ ] `assignee_kind` drift decision recorded per §4.8 ①

*Rollback*
- [ ] `export --out <new dir>` run and reviewed
- [ ] markdown re-instated as authority (if the switch is reversed)
- [ ] any board-only work reconciled forward, never via destructive git

## Running the drill in a container

Per `ARCHITECTURE.md` §9.1, verification runs in the container, never on the host.
The drill has an in-container script and a host wrapper:

```bash
# host: build + run, cards mounted read-only, report written to .data/migrate-out
npm run verify:migrate:container

# or by hand
docker build -f docker/Dockerfile -t task-panel:verify .
docker run --rm \
  -v "$HOME/.openclaw/team/tasks:/cards:ro" \
  -v "$HOME/.openclaw/team/projects.json:/projects.json:ro" \
  -v "$PWD/.data/migrate-out:/out" \
  task-panel:verify bash docker/migrate-in-container.sh
```

See `docs/docker.md` for the image and the full in-container suite
(`docker/verify-in-container.sh`).
