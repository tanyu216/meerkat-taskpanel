# Create a role

Step 6. A role is a skill with a `role.json` marker; the supervisor discovers it and routes
by its `shapes`. Run this step only when the user asks for a new role; otherwise report the
installed roles and `skip`. This step interviews the role, renders it from
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

Report the installed roles, their ids, native agents and shapes as facts; the collision and
overlap checks above are facts, not questions. Ask only the fields that cannot be defaulted:

1. **id** — the skill directory and `role.json` id; `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
2. **agent** — the board assignee name (for example `Ops`).
3. **title**, **summary**.
4. **shapes** — one sentence per work shape the role owns. These are the routing table; a
   shape already owned by another role is a collision to resolve, not a second owner.

Offer the rest as defaults and ask the user to confirm or edit:

- **native_agent** — default the id.
- **lane** — default `worker`. Say what it changes: **worker** claims ordinary work;
  **reviewer** takes only review cards and never an ordinary card.
- **responsibilities** — at most 16; what the role does on a card, each line a positive action.
- **boundaries** — at most 16; where the role's ownership ends, each line a positive action
  (for example, "operations on a running system belong to the Worker role"). Always include:
  the independent reviewer accepts the role's own work; the supervisor's acceptance pass owns
  merge, rebase and push; and, for a reviewer, review cards only, end the turn with a verdict,
  and insufficient evidence is a REJECT.
- **system_prompt** — optional; the static half of the card session's system prompt
  (board operations and the read-the-card rule). The supervisor adds the runtime
  agent/card/plan/flags context at open time. Omitted means the default board text.
- **workflow** — the branches a session should read (plan, execute, self-check, deliver,
  plus any domain branch).
- **self_check** — the checks before delivery.

A reviewer-lane role does not automatically become the default reviewer. Set
`default_reviewer: true` only when the user explicitly chooses it, and only when no other
role already holds it; explain that it becomes the role the board routes review cards to. A
worker-lane role has `reviewer_handoff: null`. A reviewer-lane role's `reviewer_handoff`
names the bounded excerpt the supervisor may inline at the start of a review handoff; the
role's `SKILL.md` remains the full protocol. The retired `reviewer_prompt` key is not read;
a role.json that still carries it loads without the excerpt and the loader logs a rename
warning.

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
  "system_prompt": "Read the task card first; it is authoritative for this card. …",
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
`references/reviewer-handoff.md`. It validates:

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
taskctl loop --actor-kind <kind>
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
step.
