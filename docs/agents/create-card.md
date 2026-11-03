# Creating a card in this project

The full rules — scope, the epic decision and its patterns, the acceptance modes, routing and
attachments — are the installed `meerkat` skill's `references/create-card.md`. This page records
**only this project's choices**. What it states wins over that manual; a topic it does not state
falls back to the manual. It is guidance, not board data: nothing stores it, `taskd` never reads
it, and no card inherits it. An explicit instruction from the human wins over this page.

## What becomes a card here

Adopt the default: **the work a role owns** — product design, development and architecture, bug
fixes and refactors, test design, regression, performance, independent review.

**Outside the roles is outside the board**: a question, a lookup, a one-off command, a scratch
experiment, the change being made in this conversation, or work the human is doing themselves.
This project adds neither a wider scope nor a narrower one.

## When this project uses an epic

Adopt the default boundary: an epic holds **several deliverables that can each land alone**; a
single change is not an epic however many layers it touches, and the layers of one change are the
card's scope, not children.

The four child questions and the three epic patterns are the manual's. This project adds no
splitting rule of its own: when the pieces are uncertain, the `meerkat-director` owns the split
and a worker holds with a question.

## Choosing the acceptance mode here

There is **no project default.** State the mode explicitly when the card's context calls for
`off` or `human` — they are opt-outs from the default review-and-loop-close path. When the card's
context does not call for either, omit the mode and let the `auto` fallback apply.

A review card is always `off`. Do not add project-specific acceptance criteria anywhere else —
not to a project row, a configuration key, or a second local convention. If this project needs a
rule, write it here and keep it to the three words above.
