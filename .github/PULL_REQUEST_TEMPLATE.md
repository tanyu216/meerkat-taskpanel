## What this changes

<!-- One or two sentences. Link the issue or card if there is one. -->

## Checks

Tick what applies. Anything left unticked should say why in the notes below.

- [ ] `npm run check` passes
- [ ] `npm run verify:docker` passes **on the committed tree** (the image bakes the SHA at
      build time, so an uncommitted change is not what CI will see)
- [ ] If a route, error code or wire field moved: the contract snapshot was refreshed with
      `node scripts/verify/contract.mjs --update` and the diff was read, not rubber-stamped
- [ ] If anything under `skills/` was edited: `node scripts/sync-skills.mjs` was run and
      `npm run check:skills` is green
- [ ] If a `src/core/storage/migrations/*.sql` file was added: it is a **new** numbered file
      and no committed migration was edited or deleted
- [ ] If behaviour changed: a `## [Unreleased]` entry was added to `CHANGELOG.md`

## Notes

<!-- Anything a reviewer should know: a deliberate trade-off, a follow-up card, a
     verification you could not run. -->
