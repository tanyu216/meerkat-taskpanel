# Create a role

Round 6. A role is a skill with a `role.json` marker; the supervisor discovers it and routes
by its `shapes`. This round interviews the role, renders it from
`assets/role-template/`, and validates it against the same contract the supervisor reads.

## Before the interview

Read every installed `role.json`. The new `id`, `agent` and `native_agent` must not collide
with an existing role. Compare the proposed `shapes` with every existing role's `shapes`:

- a shape has **exactly one accountable role**;
- overlap means one of them must change or the boundary must be stated so the two do not
  claim the same card;
- a shape no role describes goes to **Worker**;
- the reviewer must be independent of the producer.

The target kind must already carry the `meerkat` board skill. If it does not, install the
board skill first; a role without it has no board contract.

## The interview

Ask in this order, with a recommended answer where one exists:

1. **id** — the skill directory and `role.json` id; `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
2. **agent** — the board assignee name (for example `Ops`).
3. **native_agent** — the native definition stem; default the id.
4. **lane** — `worker` or `reviewer`. Only a reviewer-lane role may hold review cards.
5. **title**, **summary**.
6. **shapes** — one sentence per work shape the role owns. These are the routing table.
7. **responsibilities** — at most 16; what the role does on a card.
8. **boundaries** — at most 16; what it must not do. Always include: do not accept your own
   work, do not merge/rebase/push from the card, and (for a reviewer) never claim an ordinary
   card / never enter `awaiting` / insufficient evidence is a REJECT.
9. **workflow** — the branches a session should read (plan, execute, self-check, deliver,
   plus any domain branch).
10. **self_check** — the checks before delivery.

A reviewer-lane role does not automatically become the default reviewer. Set
`default_reviewer: true` only when the user explicitly chooses it, and only when no other
role already holds it. A worker-lane role has `reviewer_prompt: null`.

## The spec

Write the answers as one JSON object:

```json
{
  "id": "ops",
  "agent": "Ops",
  "native_agent": "ops",
  "lane": "worker",
  "title": "Operations",
  "summary": "One sentence on what this role owns.",
  "shapes": ["operations on a running system", "release execution after a human decision"],
  "responsibilities": ["..."],
  "boundaries": ["..."],
  "workflow": [{"title": "Prepare", "body": "..."}],
  "self_check": ["..."]
}
```

Then render and validate:

```bash
node <skill-dir>/scripts/scaffold-role.mjs --spec <spec.json> \
  --skills-dir <home>/<agent-dir>/skills --dry-run --json
# then without --dry-run, after showing the paths
```

The script writes `<skills-dir>/<id>/SKILL.md`, `role.json`,
`references/workflow.md`, `references/self-check.md` and, for a reviewer lane,
`references/reviewer-prompt.md`. It validates:

- `schema: "meerkat-role"`, the id grammar, a non-empty `agent`, lanes in
  `worker|reviewer`, at least one shape, at most 16 shapes/responsibilities/boundaries;
- `self_check` points at an existing `references/*.md`;
- `SKILL.md` carries `name: <id>`, no `disable-model-invocation`, and a description of at
  least 20 characters naming the role's shapes.

The script uses the symlink-safe entry guard and writes **only into an installed kind's skills tree** — never the repository's `skills/`. It refuses `..`, an absolute id, a symlink escape, and an existing different directory without `--force`.

## The template's prose

The generated `SKILL.md` must say:

- board operations are the `meerkat` skill's contract;
- decisions are the `meerkat-director`'s `references/decision-policy.md`;
- the session takes the card's plan, executes the smallest correct change, runs the
  self-check and delivers at `in_review`;
- never accept your own work, merge, rebase or push from the card.

It must not cite a repository-only design page, and it must not be command-only.

## After writing

The role is installed in an agent kind's skills tree, which is the routing. Let the
supervisor rebuild the catalog:

```bash
taskctl loop status --actor-kind <kind>
taskctl role list --json
```

The new role must appear in `role list` before a card can name it as the assignee; the
catalog is written by `role sync`, never by this skill. `roles.json` is not hand-edited.

An installed-tree-only role is not part of the repository's release manifest and is **not
refreshed or deleted** by a later `install.sh` run (the installer's role loop reads the
checkout's `skills/`). It also gets no native agent definition, because the generator reads
the checkout; the supervisor still injects the skill through the handoff. Say both plainly.

Re-running the same spec is `unchanged`; different content is a `conflict` until `--force`,
and `--force` is shown as a diff first. Editing or deleting an existing role is outside this
round.
