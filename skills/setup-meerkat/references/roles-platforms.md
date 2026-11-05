# Roles across agent platforms

Step 5. A role is a standalone skill; **installation location is the routing**. There is no
roles root, no manifest and no platform-mapping config key.

## What detection reports

`detect.mjs --actor-kind all --json` reports, for every discovered role (the standard five
and any custom one), `installedOn`, `effective` and `fallback`. Per platform it reports the
installed skill names, the roles the kind carries, the loop state and whether the kind is
`available` (it has the director skill). Installation location is the answer; nothing here
is a write.

## The choice

Show each kind's facts. If every role already sits on one available kind and the user asked
for no move, report that placement as `unchanged` and ask nothing. Otherwise recommend **one
kind for all roles** — one supervisor per machine, chosen as the kind whose capabilities best
cover the team. Explain the two options: **one kind for all roles (recommended)** means one
supervisor and every role claims there; if that kind is unavailable, nothing is claimed.
**Split across kinds** needs the explicit `--supervisor-actor-kinds`, and more than one
supervisor risks racing for the same cards; it never happens by default.

Ask **which kinds carry which role skills**. The user may accept the recommendation, name a
move, or decline and keep one platform. Never assign a role to a platform the user did not
approve, and say the cost plainly: a role installed on no available kind is **not claimed at
all**. A kind reported `available: false` has no director skill, so it must not receive a
role until the team skills are installed.

`meerkat-director`, `meerkat-chat` and `setup-meerkat` follow the primary kind. Do not move
them; `route-role.mjs` handles role skills only.

## Moving a role

```bash
node <skill-dir>/scripts/route-role.mjs --role turing --to codex --home <home> --dry-run
# then without --dry-run, after showing the copy
```

- With more than one carrying kind, name the source with `--from <kind>`; never guess.
- Show the copy before writing. The source is removed only with `--confirm-remove` and an
  explicit yes; a role the user did not name is never deleted.
- A target that already holds a different copy is a `conflict`; `--force` needs a separate
  yes.
- A re-run of an identical copy is `unchanged`.
- After a move, run `install.sh --target <kind>` to refresh the kind's native definitions.

An `available: false` kind (no director skill or no CLI) must not receive a role. A role
with no carrier will never be claimed; report it and ask whether to place it on an approved
kind.

## After the move

Read `taskctl loop status --actor-kind <kind>`. The `scan set:` must name Worker and every
role whose cards are created, and its role lines must show the effective platform. A name the
loop does not scan can never claim its cards; that is a finding to report, never "ready".

## Retired structures

A `meerkat-loop` skill, a `meerkat-loop/roles/` tree, or a project `.meerkat/roles/` is
reported as deprecated and never read or deleted. `MEERKAT_TASKPANEL_ROLES_DIR` is different:
pointing at a directory of directories that each carry `role.json` is still a valid
discovery override; only a tree without those markers is retired.

## The team contract

The project's roles are the installed `skills/<role>/SKILL.md` files. The supervisor injects
the handoff; the installed copy is authoritative. The compact index — not a copy of the
workflows — is:

- each role and the shapes it owns, read from its `role.json`; the Reviewer is never routed
  an ordinary card;
- who lands and cleans up: the supervisor's acceptance pass merges the lane and removes the
  worktree; the card's `acceptance_mode` names who may close it; no role creates a downstream
  or fix card — the director does;
- the handoff markers and their writers: `stage_handoff=required` (the producer role), the
  project's `review_gate` (Linus), and `handoff_consumed_round` / `handoff_declined_round`
  (the director's triage). A card's design/verification shape comes from the project's
  `docs/agents/epic-graphs.md` and the role skills, never from a classification meta.

Point at the installed role skills and the director's `references/decision-policy.md` for the
detail. This index is not a second copy of their prose.
