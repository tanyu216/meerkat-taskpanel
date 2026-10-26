## What this changes

<!-- One or two sentences. Link the issue or card if there is one. -->

## Checks

Tick what applies. Anything left unticked should say why in the notes below.

- [ ] `npm run check` passes
- [ ] `npm run verify:docker` passes **on the committed tree** — normally run for you by
      `.githooks/pre-push` when the branch is pushed (the image bakes the working tree, so an
      uncommitted change is not what CI will see; `SKIP_CONTAINER_VERIFY=1` skips it)
- [ ] If a route, error code or wire field moved: the contract snapshot was refreshed with
      `node scripts/verify/contract.mjs --update` and the diff was read, not rubber-stamped
- [ ] If anything under `skills/` was edited: the prose still matches `taskctl` (the skills
      carry decisions; the loop runs as `taskctl loop …`, so there is no payload to regenerate)
- [ ] If a `src/core/storage/migrations/*.sql` file was added: it is a **new** numbered file
      and no committed migration was edited or deleted
- [ ] No `CHANGELOG.md` edit: entries are written only when `dev` merges into `main`

## Notes

<!-- Anything a reviewer should know: a deliberate trade-off, a follow-up card, a
     verification you could not run. -->
