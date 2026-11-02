# The director's project rules

Round 3. The `meerkat-director` skill owns the decision policy. A project has exactly one
refinement hook: `docs/agents/decision-policy.md`, read before the default E1–E5 map is
applied.

## The interview

Ask each item, one at a time, with a recommended answer:

| Item | Default subject | The question |
|---|---|---|
| `E1` | scope | keep the default, change the subject, or make it director-decided? |
| `E2` | the acceptance baseline | same |
| `E3` | design / aesthetic direction | same |
| `E4` | security / data safety | same |
| `E5` | architecture direction | same |

Then ask whether the project has a reserved matter of its own that should join the human's
list, and whether any of the default reserved matters (public contracts, dependencies,
destructive operations, release, cross-team change, budget/time, team changes, conflicting
requirements, missing information) should move.

A project may change what an E-code means and may name `human` or `director` as the decider
for an item. It may not add a code, remove the ladder (`worker → director → human`), change
the round protocol or change the recording rules.

## What to write

Write **only the items the user changed** — never the full default table, and never a
wholesale copy. Each changed item is one line/entry:

```text
E1 — scope: <the project's subject>; decider: human
E4 — security / data safety: <the project's subject>; decider: director
<project matter> — <what it means>; decider: human|director
```

Items not written keep their default. A `decider: director` entry takes the matter out of
the human's list; `worker` is never a decider.

If `docs/agents/decision-policy.md` already exists, merge rather than replace. Equivalent
content is `unchanged`; different content is shown to the user, backed up as
`<file>.bak-<timestamp>`, and merged only with consent. Never copy the installed
`references/decision-policy.md` into the project; this file is the project's refinement, not
a second copy of the policy.

## What not to do

- Do not add a new E-code, a new ladder or a new decision kind.
- Do not write the default table into the project to "be explicit".
- Do not record a human decision as the director's, here or anywhere.
- Do not create another project hook: the director reads only this file.
