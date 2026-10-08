# `design`

Product design artifacts live here: the PRD, DESIGN and BLOCKS documents, the interactive
prototype, and the exported assets (screenshots, illustrations, logo).

```text
design/
├── PRD.md          # product requirements            (not yet migrated)
├── DESIGN.md       # design decisions                (not yet migrated)
├── BLOCKS.md       # block inventory                 (not yet migrated)
├── prototype/      # interactive prototype           (migration pending)
└── assets/         # screenshots / illustrations / logo
```

## Status

**Structural placeholder — content migration is pending.**

The prototype currently lives at the repository root (`prototype/`, HTML + jQuery) and is
the design baseline contract. Moving it here — together with the DESIGN / BLOCKS documents,
the screenshot paths and the `prototype-guard` invocation paths — is a separate card and
**must not be done as part of the scaffold**. Until that card lands, `prototype/` stays
where it is and `design/prototype/` holds only a placeholder.
