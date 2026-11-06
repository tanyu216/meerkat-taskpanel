# The human decides — E1-E5

The table and the reserved matters below are the **default** decision map for every project.
A project may refine them with its own policy file. The ladder, the worker/director boundary,
the round protocol and the recording rules stay fixed for every project file, role skill,
handoff and card.

## The project's policy file

Before applying the defaults to a decision, resolve the project the card belongs to from the
project map the `meerkat` board skill owns, the directory's only source, and read
`<project directory>/docs/agents/decision-policy.md`.

No such file: the defaults apply unchanged and silently. The file may be a short
pointer to the project's real rules; follow it. A file that exists but is unreadable, states
no recognizable rule, or contradicts itself: apply the default for each affected item and
record that the project policy was unusable, with the reason.

The project file refines the defaults **item by item**:

- An entry keyed by an E-code replaces that code's subject and, optionally, its decider
  (`human` by default; `director` makes the code director-decided instead of escalated).
- An entry keyed by a matter replaces that matter and names `human` or `director` as the
  decider. `director` takes the matter out of the human's list; the decider is `human` or `director`.
- A matter the file adds joins the human's list unless its entry names `director`.
- Every unnamed item keeps its default.
- The codes stay `E1`–`E5`: the project may change what a code means, and the code set itself
  stays fixed; only a human-decided item enters `awaiting`.
- The project file wins for the item it names. Only the project file changes the director's
  reading of the defaults.

Record which source decided: the default, or the project policy and its path. A reserved
matter with no code of its own takes the code the project file assigns it; otherwise the
closest default code.

| Code | Question is about (default) |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

**Default reserved matters.** The director escalates anything beyond its authority, plus public
contracts/API/CLI/schema/migrations, dependencies/licenses, destructive or irreversible
operations, release/deploy, cross-project/cross-team changes, budget/time/concurrency policy,
team/role changes, conflicting requirements, or missing information. When in doubt, escalate.
