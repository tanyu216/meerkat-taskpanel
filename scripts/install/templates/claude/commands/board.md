---
description: Show the Task Panel board and my claimable cards
---

I am working on the shared Task Panel board as agent **{{AGENT}}**. My identity is
preconfigured — `taskctl` calls carry `--agent {{AGENT}}` (via the shim at `{{SHIM}}`,
with `TASKCTL_AGENT` as fallback).

1. Run `taskctl context current` to confirm which project owns this directory.
2. Run `taskctl issue candidates --assignee {{AGENT}}` to list what I may claim.
3. Run `taskctl issue list` and summarize the board: what is `todo`, `in_progress`, and `in_review`.
