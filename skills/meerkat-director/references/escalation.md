# The human decides — E1-E5

The table and the reserved matters below are the **default** decision map for every project.
A project may refine them with its own policy file. The ladder, the worker/director boundary,
the round protocol and the recording rules are fixed: no project file, role skill, handoff or
card may change them.

## The project's policy file

Before applying the defaults to a decision, resolve the project the card belongs to through
the project map the `meerkat` board skill owns — never guess a directory — and read
`<project directory>/docs/agents/decision-policy.md`.

No such file: the defaults apply unchanged, and nothing is reported. The file may be a short
pointer to the project's real rules; follow it. A file that exists but is unreadable, states
no recognizable rule, or contradicts itself: apply the default for each affected item and
record that the project policy was unusable, with the reason.

The project file refines the defaults **item by item**, never wholesale:

- An entry keyed by an E-code replaces that code's subject and, optionally, its decider
  (`human` by default; `director` makes the code director-decided instead of escalated).
- An entry keyed by a matter replaces that matter and names `human` or `director` as the
  decider. `director` takes the matter out of the human's list; `worker` is never a decider.
- A matter the file adds joins the human's list unless its entry names `director`.
- Every item the file does not mention keeps its default.
- The codes stay `E1`–`E5`: the project may change what a code means, but it cannot add a code,
  and only a human-decided item enters `awaiting`.
- The project file wins for the item it names. No other document's summary of the defaults
  changes the director's reading; the project file is the one that does.

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

**Default reserved matters.** The director escalates anything it cannot decide, plus public
contracts/API/CLI/schema/migrations, dependencies/licenses, destructive or irreversible
operations, release/deploy, cross-project/cross-team changes, budget/time/concurrency policy,
team/role changes, conflicting requirements, or missing information. When in doubt, escalate.
