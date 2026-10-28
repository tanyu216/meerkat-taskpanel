# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the canonical vocabulary, the words to avoid, and the
  terms that are *not* in the model.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in. (`GLOSSARY-MAP.md`
  does not exist here: this is a single-context repo.)
- **`design/DESIGN.md` §20** for the project's ordering, and `design/` for the live design
  oracle the tests read.

If any of these files do not exist, **proceed silently**. Do not flag their absence and do not
suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get
resolved.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md
├── docs/adr/          ← created lazily by /domain-modeling
└── src/
```

The `web/` workspace is a build package (the hosted board's frontend), not a second domain
context, so there is no `GLOSSARY-MAP.md` and no per-context glossary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis,
a test name), use the term as defined in `GLOSSARY.md`. Do not drift to the synonyms it
explicitly avoids. `README.zh-CN.md` is the Chinese pairing of `README.md`; it is not a second
vocabulary.

If the concept you need is not in the glossary yet, that is a signal: either you are inventing
language the project does not use (reconsider), or there is a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
