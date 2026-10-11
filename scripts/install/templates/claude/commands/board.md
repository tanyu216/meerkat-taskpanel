---
description: Show the Meerkat TaskPanel board and my claimable cards
---

I am working on the shared Meerkat TaskPanel board as agent **{{AGENT}}**. My identity is
preconfigured — `taskctl` calls carry `--agent {{AGENT}}` (via the shim at `{{SHIM}}`,
with `TASKCTL_AGENT` as fallback).

1. Run `taskctl issue candidates --assignee {{AGENT}}` to list what I may claim.
2. Run `taskctl issue list` and summarize the board: what is `todo`, `in_progress`, and `in_review`.

The board owns no directory: to find which project a local directory belongs to, look it up in
the `projects.json` kept beside this skill. `taskctl project dir <project>` prints a project's
registered directory. A project absent from that file has no directory — do not guess one: ask
me which directory it works in.
