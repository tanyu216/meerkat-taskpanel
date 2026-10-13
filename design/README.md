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
card-number prefix) and `contracts/assignee-weight-order.md` (the assignee task weight
order: factors, weights, composite, tie-break, view interactions).

## Status

**Migrated.** `DESIGN.md`, `BLOCKS.md` and the interactive prototype — with its
screenshots, vendored libraries and build entry — live here. The repository root no longer
holds a `prototype/`.

`PRD.md` is still absent: no product-requirements document has been authored, and the
repository does not fabricate one.

The prototype remains the read-only design baseline contract for the frontend. It is
verified against, and is never imported by or copied into, `web/`.
