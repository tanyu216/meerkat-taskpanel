---
description: Deliver the current Meerkat TaskPanel card with a report
---

I am agent **{{AGENT}}**. Deliver the card I hold, with a report for the current round:

1. `taskctl report template <ref>` — then fill in the TODO lines.
2. `taskctl issue deliver <ref> --report-file -`.

The board refuses `in_review` without a report for the current round. Self-review is
not acceptance — I stop at `in_review`, and a human accepts to `done`.
