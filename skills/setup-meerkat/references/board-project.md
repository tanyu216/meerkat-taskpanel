# The board skill's project rules

Round 4. The `meerkat` skill reads a project's own rules from `docs/agents/`. Write them
once there; they are project content, shared by every agent platform that works in this
project.

## The documents

Create `docs/agents/` when it is missing. Every document is optional and skippable; ask
before writing, and never replace a user's rule wholesale.

### `docs/agents/create-card.md`

The project's three choices, in one page: **what work becomes a card**, **how its creators
choose an acceptance mode**, and **where the epic-splitting boundary is**. Read the installed
`meerkat` skill's `references/create-card.md` first — it holds the full manual and is what this
page overrides. The installed copy is
`<home>/<agent-dir>/skills/meerkat/references/create-card.md`; when several kinds are installed
and their copies differ, say so before choosing one. Then ask the user the three questions and
write **only their answers**. Do not copy the manual, its commands or its epic patterns; a page
that restates them drifts from them.

- **Card scope.** The recommended answer is **the work a role owns** — product design,
  development and architecture, bug fixes and refactors, test design, regression, performance,
  independent review. **Outside the roles is outside the board**: a question, a lookup, a
  one-off command, a scratch experiment, the change being made in this conversation, or work
  the human is doing themselves has no owner and does not become a card. A narrower answer
  ("only work that crosses sessions") or a wider one ("every change") is valid; record it once.
- **Acceptance mode.** There is **no project default**; the card's `acceptance_mode` is the
  authority; an explicit instruction from the human wins over this page; omitted resolves to
  `auto`. Record the project's reasons for choosing `off` or `human` where it does. Do not
  invent a default and do not claim the board reads this page.
- **Epic boundary.** The general epic mechanics stay in the `meerkat` skill; this page records
  only the project's splitting choice. The worker never splits; the director owns the scope
  decision.

Link only to installed material (the `meerkat` skill) or project pages the user has. Do not
link to a repository-only design page.

### `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`

The tracker integration's per-repository outputs. Follow `references/matt-pocock.md`: if the
Matt skill is available, it writes its own outputs; if not, write project-neutral versions
that point at the installed `meerkat`/`taskctl` surface. Never create board labels — the
label registry grows when a card first names a label.

### `docs/agents/worktrees.md`

The project's **worktree and branch rules**: the page a human session and a card worker both
read. It is also the guard's opt-in marker (see `references/worktree-guard.md`). It states the
rules, never copies the ref values:

1. Parallel work never happens in the primary checkout; it happens under `.worktrees/`.
2. Ownership partition: `lane/<ref>[-r<round>]` belongs to the loop. A session never creates,
   reuses, commits to or deletes a lane worktree. Human work uses `<type>/<slug>`; never name
   a session worktree after a card id.
3. Cards branch from the project's declared `base_ref` and land on `merge_ref`; read both with
   `taskctl project map show <id> --json`. Keep the primary checkout on `merge_ref`; the loop
   refuses to land anywhere else.
4. Landing order: merge first, then `git worktree remove`, then `git branch -d`. A worktree
   with uncommitted changes is never removed.
5. `.worktrees/` and `.claude/worktrees/` belong in `.gitignore` and `.dockerignore`; a
   session worktree is never registered in the loop's `workspaces.json`.
6. **Off switch:** deleting this file removes the project from the guard's protected set;
   existing worktrees are never deleted by that act.

Do not repeat the branch names in prose. The map is the value; this page is the rule.

## The loop-only rules in `projects.json`

The loop reads `base_ref` / `merge_ref` from the project map. They are **project rules**, not
directory facts, and `project map set` is their only writer:

```bash
taskctl project map show <id> --json          # read the entry and its refs
taskctl project map set <id> --local-path <dir> --base-ref <ref> --merge-ref <ref>
```

Recommend `base_ref = merge_ref =` the branch the project checkout is on (its integration
branch). Both are probed in the registered directory; a value that does not resolve is
`PROJECT_REF_UNRESOLVED`, and `--no-dir` is refused while a rule is declared. A `merge_ref`
that is not currently checked out is written with a warning — landing will refuse until the
checkout is on it. If the installed CLI predates these flags, go back to round 1 and upgrade;
never hand-edit `projects.json`.

## The instruction entry

Call the `init` skill for the project's agent-instruction entry, and require it to point card
work at the `/meerkat` skill and board rules at `docs/agents/` (`create-card.md`,
`worktrees.md`, `issue-tracker.md`, `triage-labels.md`, `domain.md`, and
`decision-policy.md` when present),
and to state this round's card scope. The entry and the
rules are project content shared by every platform: call `init` once, write the rules once
under `docs/agents/`, never copy them per platform, and never write an entry yourself.

- Show the brief before calling `init`.
- An existing entry that differs is a separate yes; `--yes` does not authorize replacing it.
- If the host has no `init` skill, report `skip` with the reason; never fall back to writing
  the entry by hand.
- A second run reports `unchanged` when the entry already states the same pointers and the
  same scope.

## An earlier round's documents

A project set up by an earlier round has `docs/agents/acceptance-mode.md` and
`docs/agents/epic-cards.md`. When those exist and `docs/agents/create-card.md` does not, read
them, carry over **only what differs from the manual** as the user's starting answers, and
offer the single page. Back the old files up as `<file>.bak-<timestamp>`; remove them only with
consent. The `meerkat` skill reads `create-card.md` only, so leaving the old pair in place would
silently retire its rules.

## Missed items

If a document already exists with different content, show it, back it up as
`<file>.bak-<timestamp>`, and merge only with consent. Report each action as
`written` / `unchanged` / `skip` / `conflict`.
