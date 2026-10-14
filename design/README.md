# `design`

Product design artifacts live here: the PRD, DESIGN and BLOCKS documents, the interactive
prototype, and the exported assets (screenshots, illustrations, logo).

```text
design/
├── PRD.md          # product requirements            (not present)
├── DESIGN.md       # design decisions
├── BLOCKS.md       # block inventory
├── contracts/      # standalone interface contracts (a topic's single source of truth)
├── prototype/      # interactive prototype
└── assets/         # screenshots / illustrations / logo
```

`contracts/` holds **topic-scoped** contracts that do not belong to a numbered fidelity
round — each is the single written source of truth for one interface question, written so
an implementation card can build it and an independent verification card can check it.
They are `contracts/project-prefix-binding.md` (the create-project prefix field and the
card-number prefix), `contracts/assignee-weight-order.md` (the assignee task weight
order: factors, weights, composite, tie-break, view interactions) and
`contracts/rail-chip-overflow.md` (how the sidebar rail's project chip behaves when the
effective prefix does not fit its 24×24 box).

## Status

**Migrated.** `DESIGN.md`, `BLOCKS.md` and the interactive prototype — with its
screenshots, vendored libraries and build entry — live here. The repository root no longer
holds a `prototype/`.

`PRD.md` is still absent: no product-requirements document has been authored, and the
repository does not fabricate one.

The prototype remains the read-only design baseline contract for the frontend. It is
verified against, and is never imported by or copied into, `web/`.

## Oracle exceptions（原型侧缺陷：这些座位的内容不得以原型当 oracle）

The prototype is the baseline for **structure, geometry and computed style**. It is *not*
an oracle for every piece of **content**: a seat can carry a mock default that the
runtime is expected to replace. Where the prototype's own reading at a seat is wrong,
the record lives in a fidelity contract's `PF` register and the implementation's
behaviour — not the prototype's — is the oracle.

| seat | why the prototype is not the oracle | record |
|---|---|---|
| 抽屉头状态徽 `[data-detail-status-chip] > [data-detail-status-chip-label]` | the card template ships the label with a static `data-i18n="status.todo"`, which the prototype's translation pass re-resolves *after* the per-card status is written there — every card read `To Do` whatever its status. Fixed in `design/prototype/app.js` (`T-20261014-154730-4`), but the static default is still not an oracle: a per-card status only exists at runtime | `design/fidelity-r14.md` §8.4 `PF-1` |

Review and machine checks must therefore take that seat's **content** from the
implementation's own ran state; its **class list, box metrics and `data-status`** remain
prototype-anchored as usual.
