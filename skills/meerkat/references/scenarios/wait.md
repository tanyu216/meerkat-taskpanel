# Waiting: the director, a human, or blocked

This page is complete for the waiting branches; do not read the other scenario pages.

## A question for the director

A question for the **director** is an agent `question` comment plus a bounded hold:
`issue wait <ref> --question <id>`. `answered` continues in the same turn (re-claim if the
card is back in `todo`); `escalated`, `moved`, `timeout` and `error` end the turn, and the
loop resumes the session when the answer lands.

## A question for a person

A question for a person is **`awaiting`**, not `blocked` and not a chat message:
`issue move <ref> awaiting --awaiting-reason E3 --question "…"`. The reason is one of
`E1`–`E5`:

| Code | The matter |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

**Any human comment** re-queues the card to `todo`; `awaiting → in_progress` resumes the same
attempt without a new delivery round.

## Blocked

`blocked` is for everything else; `--blocked-reason` is optional. The literals are
[`../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for`](../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for).

<!-- read-next:begin -->
- [`../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for`](../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for)
- [`../lifecycle/transitions.md#1-the-vocabulary`](../lifecycle/transitions.md#1-the-vocabulary)
<!-- read-next:end -->
