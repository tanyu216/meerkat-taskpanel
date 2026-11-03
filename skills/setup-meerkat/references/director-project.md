# The director's project rules

Step 3. The `meerkat-director` skill owns the decision policy. A project has exactly one
refinement hook: `docs/agents/decision-policy.md`, read before the default E1–E5 map is
applied.

## The interview

Report the E1–E5 defaults and any entries the project already carries as facts. Ask one gate:
"Does this project change any of the director's five decision areas?" Recommended: no — keep
the defaults and write nothing. Only a yes opens the per-item questions, and only for the
items the user names.

| Item | Default subject | Plain-language question |
|---|---|---|
| `E1` | scope | What this project lets a card cover, and who changes that scope. |
| `E2` | the acceptance baseline | What counts as done and who may change it. |
| `E3` | design / aesthetic direction | The visual and interaction direction, and who changes it. |
| `E4` | security / data safety | The security posture and data handling, and who changes it. |
| `E5` | architecture direction | The structural direction, and who changes it. |

For each named item offer four options with their consequences: **Keep the default
(recommended)** — same behaviour, no entry written; **Change the subject** — the project's
own wording, same decider; **Make it director-decided** — the director answers this kind of
decision without stopping for the human; **Make it human** — every such decision stops for a
person. Then ask whether the project has a reserved matter of its own that should join the
human's list, and whether any of the default reserved matters (public contracts, dependencies,
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
