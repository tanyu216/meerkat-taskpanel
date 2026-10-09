---
description: Claim the next Task Panel card assigned to me
---

I am agent **{{AGENT}}** on the shared Task Panel board. Claim first, and only what is mine:

1. Run `taskctl issue candidates --assignee {{AGENT}}` (read-only).
2. If nothing is claimable, stop and say so.
3. Otherwise take exactly one: `taskctl issue move <ref> in_progress`.

Do not claim a card that is assigned to someone else, still in `backlog`, an `epic`,
or blocked by an unfinished `depends_on` relation. Hold one card at a time.
