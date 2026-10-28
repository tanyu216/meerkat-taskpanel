# Issue tracker — the local task board

Work for this repository is tracked as **cards** on a Meerkat TaskPanel board, reached through
the `taskctl` CLI. An "issue" in the engineering skills is a card; an "issue id" is a card
identifier such as `PROJ-0007`. The board is local-first (`http://localhost:9527` by default),
single-writer, and needs no external service.

The workflow, in one paragraph: read the claimable set with
`taskctl issue candidates --assignee <me> --json`, take exactly one card with
`taskctl issue move <ref> in_progress`, keep it fresh with `taskctl issue heartbeat <ref>`, and
read it with `taskctl issue get <ref> --json` — the frozen `acceptance[]` is the contract, and
`--include comments --include reports` carries the trail and the deliveries. Record decisions
as comments (`taskctl comment add <ref> --kind decision|note|question --body …`); a question
for a person is `taskctl issue move <ref> awaiting --awaiting-reason E1..E5 --question …`.
Finish by delivering a report for the current round —
`taskctl issue deliver <ref> --report-file -` — which moves the card to `in_review`.
Acceptance is somebody else's act: a human, or the loop when the card's `acceptance_mode` is
`agent`/`off`. Never write the board's SQLite file or its HTTP API directly, and never edit an
exported brief.

## Commands the skills may expect

| The skills say | Do this here |
|---|---|
| create an issue | when you are in a conversation with the human or the create carries their explicit instruction: `taskctl --as-human issue create --project <id> --title … --acceptance "…"`; otherwise drop `--as-human` |
| list open issues | `taskctl issue list --status todo --status in_progress --json` |
| read an issue | `taskctl issue get <ref> --json` |
| comment on an issue | `taskctl comment add <ref> --kind note --body …` |
| close an issue | deliver a report (`issue deliver`), then acceptance moves it to `done` |
| label an issue | `taskctl issue update <ref> --label <name>` (repeatable) |

## Conventions that differ from a hosted tracker

- **No separate label-creation step.** `taskctl labels list` is read-only; the registry grows
  when a card names a label. Do not try to create labels up front.
- **PRs are not a request surface.** A pull request is delivery evidence on a card, not a
  queue item.
- **One card at a time.** A worker holds at most one claimed card and pulses it every
  ≤ 10 minutes.
- **Exports are snapshots.** A card can be exported as markdown (`export md`), and the loop
  keeps its brief fresh; the board is the authority, never the file.

The card vocabulary — statuses, transitions, the acceptance baseline, the wire fields — is the
`meerkat` skill (`skills/meerkat/SKILL.md` and its `references/`).
