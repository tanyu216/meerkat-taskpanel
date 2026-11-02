# Project-level rules for agents

`docs/agents/` is the **project-discovery surface**: the installed Meerkat skills read these
files at runtime, from the project's own working directory. They are project documentation,
not board data and not this repository's design record.

## How discovery works

A skill resolves the project directory once:

```bash
taskctl project dir <project> --json     # data.dir
```

Then it reads the one named file below when it exists. Discovery is **fixed paths**, not a
directory scan and not a manifest: deterministic, one tool call, and no guessing which file
is relevant. A missing file is not an error — the skill's built-in default applies.

## The fixed set

| File | Read when | If absent |
|---|---|---|
| `acceptance-mode.md` | creating any card | the three built-in meanings; an explicit human instruction wins; fallback `auto` |
| `epic-cards.md` | creating or splitting an epic | the skill's general four sizing questions |
| `decision-policy.md` | the director makes a decision | the default E1–E5 map |
| `issue-tracker.md` | a role or reviewer needs the project's tracker | the canonical tracker is this board |
| `domain.md` | an engineering skill explores the codebase | `GLOSSARY.md` and `docs/adr/` where present |
| `triage-labels.md` | a role applies a triage label | the five canonical label strings |

## Precedence, per file

- **acceptance-mode** — an explicit instruction from the human > this project's file > the
  built-in meanings.
- **epic-cards** — this project's file refines the skill's general sizing rule; it does not
  replace the board's epic mechanics.
- **decision-policy** — this project's file refines the default E1–E5 map item by item; the
  ladder, the worker/director boundary and the recording rules are fixed.
- The tracker, domain and label files are facts about this project; they do not override a
  skill's contract.

An installed skill may name these paths; it must not name a page that exists only in the
Meerkat source repository.
