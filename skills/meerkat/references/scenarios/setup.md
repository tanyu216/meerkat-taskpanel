# Project directory, session identity and the brief

This page is complete for the local setup around a card; do not read the other scenario
pages. Claiming, moving, commenting and delivering need no project directory.

## The project directory

**The board holds no directories.** The only answer is the machine-local map at the config
root (`<config root>/projects.json`), read with `taskctl project dir` and changed only with
`taskctl project map`. **Never read or edit `projects.json` by hand.** Schema and codes:
[`../projects-json.md#managed-by-taskctl`](../projects-json.md#managed-by-taskctl),
[`../projects-json.md#project--directory-what-is-checked`](../projects-json.md#project--directory-what-is-checked).

A project with **no directory** is an entry naming none: `project dir` says so and succeeds —
do not invent one. A project **absent** from the map has no registered directory; do not
guess. When a step needs it, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will register it with
`taskctl project map set <project> --local-path <dir>` — the board cannot supply one.
```

[`../projects-json.md#no-directory-is-an-answer`](../projects-json.md#no-directory-is-an-answer),
[`../projects-json.md#unregistered-no-fallback--ask`](../projects-json.md#unregistered-no-fallback--ask).

## Project-level rules

Once the directory resolves, the relevant rule files are fixed paths under
`<project-dir>/docs/agents/`: `create-card.md`, `decision-policy.md`, `worktrees.md`,
plus the tracker, domain and label files. Do not scan the directory, and a missing file
means the skill's built-in default.

## Session identity

Stamp every write with `--actor-kind <kind> --session-id <id>`. Derive the id with
`taskctl session id <ref> --seg <seg> --owner <name>`; offline,
[`../../scripts/session-id.mjs`](../../scripts/session-id.mjs) computes the same value from
the resolved task UUID.

A card you claimed yourself **registers** that identity as its session row with `--seg manual`
and closes it at delivery; the id derives from `(task, owner, seg)`, so the row survives across
rounds, and a dispatched card's row belongs to the loop
([`execute.md`](execute.md#the-cards-session-row-manual-claim)).

## Working outside a card

A live session doing parallel work in a project follows `<project-dir>/docs/agents/worktrees.md`
when the project has one. `taskctl worktree create <slug>` makes the session tree,
`status` / `leave` / `sweep` own its lifecycle, and `lane/` trees belong to the loop — a
session never creates, reuses or removes one. The loop's landing and cleanup never touch a
session tree; merge it yourself, then `leave --remove` (clean and merged only).

## Keeping the brief fresh

A card exported into a project directory is a **snapshot**. Register it once with the local
event hub — `export watch <ref> --dir <dir> --detach` — and check it with `--watch-status`;
`--stop` ends it, and the portable form is `--once`. Never use a plain `&`: the hub, not your
shell, owns the connection. It writes `.meerkat/<identifier>/card.md`, stops at `done` or
`canceled`, and is one-way — re-read the brief before a decision, and never hand-edit it.
**A supervisor-dispatched worker starts no watcher.**

<!-- read-next:begin -->
- [`../projects-json.md#managed-by-taskctl`](../projects-json.md#managed-by-taskctl)
<!-- read-next:end -->
