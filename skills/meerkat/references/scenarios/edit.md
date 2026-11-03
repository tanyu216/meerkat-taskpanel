# Editing an existing card

This page is complete for one operation: a human — or the director recording the human's
words — adds or changes requirements on a card that already exists. Do not read the other
scenario pages. The baseline's universal rules are
[`../lifecycle/delivery.md#4a-the-acceptance-baseline`](../lifecycle/delivery.md#4a-the-acceptance-baseline).

## The one read

```bash
taskctl issue get <ref> --include comments
```

`issue get` — there is no `issue show`. Read `data.task.acceptance[]` (the contract), the
current `description`, `acceptance_revision`, `status` and the comment trail. `meta.acceptance`
is only the seed; never treat it as the baseline.

## Add acceptance criteria

A requirement the human states becomes an acceptance item. Append them in one call:

```bash
taskctl --as-human issue update <ref> \
  --acceptance "<criterion 1>" --acceptance "<criterion 2>"
```

- `--as-human` records the human as the writer. Use it when the human in this conversation
  gave the instruction; the board allows an agent-authored append, but that records the wrong
  author.
- `--acceptance` is repeatable and appends; duplicates by normalized text are ignored. A real
  append bumps `acceptance_revision` once and `version` once.
- Allowed while the card is `backlog`, `todo`, `in_progress`, `blocked` or `awaiting`.
  `in_review`, `done` and `canceled` refuse with `ACCEPTANCE_LOCKED`: rework first; a
  `done`/`canceled` reopen does not change the baseline.
- Do **not** pass `--description` when only the acceptance changed. Omitting it leaves the
  description byte-for-byte untouched.

Record the human's words in the trail in the same turn:

```bash
taskctl --as-human comment add <ref> --kind change --body "<the human's words>"
```

## Change the description

The description is opaque markdown and `--description` **replaces the whole field**; there is
no append form and no `--file`. When the requirement changes the description:

1. read the current text with the one read above;
2. send the complete new text, not just the changed paragraph:

```bash
taskctl issue update <ref> --description "$(cat new-description.md)"
taskctl issue update <ref> --description ""        # clears the field
```

Omit `--description` to preserve it.

## Remove an acceptance item

Only a human may prune, and the prune is audited:

```bash
taskctl --as-human issue update <ref> --drop-acceptance "<text>" \
  --reason "<why>" --acceptance-revision <n>
```

`--reason` is at least 8 characters; `--acceptance-revision` is the value the read returned
(`ACCEPTANCE_STALE_REVISION` if another writer moved it). Never use `--drop-acceptance` to
"replace" an item — append the corrected item and, if the old one is wrong, prune it in the
same human-authorized change.

## Do not

- Do not move the card's status to edit its requirements. `in_progress` is a valid state to
  append in; `in_review`/terminal is not, and that is a rework, not a status edit.
- Do not use `issue update --assignee`: `issue update` has no assignee flag. Reassignment is
  `taskctl issue assign <ref> --assignee <role>`.
- Do not hand-edit `.meerkat/<id>/card.md`; the hub re-exports it from the board.
- Do not record a human decision as your own. If the instruction did not come from the human,
  write an agent `question` comment and hold.

## Authority for role agents

A role skill's "do not change scope or acceptance" means do not widen the card on your own.
An explicit human instruction to add a criterion is E2 and is applied, not refused; the
`--as-human` write above is how it is recorded.

<!-- read-next:begin -->
- [`../lifecycle/delivery.md#4a-the-acceptance-baseline`](../lifecycle/delivery.md#4a-the-acceptance-baseline)
<!-- read-next:end -->
