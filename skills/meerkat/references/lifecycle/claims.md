# Claims and heartbeats

> Section 5. Containers are `containers.md`.

## 5. Claims and heartbeats

- **Only `todo` is claimable.** `todo → in_progress` and `issue claim` are the same path;
  `issue claim` accepts only `todo`/`in_progress`.
- **An `epic` is never claimable** (`not_claimable`), and every `issue candidates` pool
  withholds it.
- **A rework is not a claim.** `in_review → in_progress` and `blocked → in_progress` keep the
  claim and skip the routing lock.
- **Held** in `in_progress`, `awaiting`, `in_review` and `blocked`; the write reaching
  `todo`, `backlog`, `done` or `canceled` releases it. No unclaim command.
- **Heartbeat only in `in_progress`, only from the holder.** It refreshes `heartbeat_at` and
  nothing else.

| Question | Threshold |
|---|---|
| The holder may re-claim with `issue claim` | heartbeat **older than 10 minutes** |
| `issue candidates --stale` offers `stale_same` | heartbeat **older than 30 minutes** |
| The claim has rotted: its assignee recovers it | heartbeat **older than 6 hours**, or none usable |
| Any other actor takes a rotted claim over | `issue claim --allow-steal --reason "<why>"` |

Another actor's fresh claim is `EXECUTION_ACTIVE`. Past six hours the lock has rotted but the
**route has not**: the card's assignee re-claims it as an audited takeover, and anybody else
needs the same explicit `--allow-steal --reason` a first claim does. Both write a `change`
comment. Scanning order never selects the executor (ADR 0014).

**The `depends_on` read rule.** `issue candidates` withholds a card whose `blocks` predecessor
is not `done` — literally `status !== "done"`, so a `canceled` predecessor withholds too.
`issue claim`/`issue move` do not re-check blockers: treat the candidates read as the rule.
