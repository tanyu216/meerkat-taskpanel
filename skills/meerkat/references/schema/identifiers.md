# Identifier syntax

> The storable pattern, the generated form and the prefix folding. The card fields are
> `records.md`.

## Identifier syntax

A card has two identifier notions, and they answer different questions.

**What the board will store** (`isValidIdentifier`): 1–128 characters; the first character is
`A`–`Z`, `a`–`z` or `0`–`9`; every later character is one of those or `.`, `_`, `-`. No
spaces, slashes, or leading punctuation. Case is preserved, and identifiers are compared
case-sensitively. This check is deliberately permissive: hand-written legacy cards
(`T-20261008-230500-…`) import unchanged, so it accepts far more than the board itself mints.

The executable storable pattern is:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
```

**What the board mints** for a new card: `<PREFIX>-<serial>`.

- `serial` starts at 1 for each project and is left-padded with zeroes to **at least** four
  digits. The width is a minimum, not a cap: serial `12345` yields `DEMO-12345`. There is no
  overflow refusal.
- The prefix is the project's declared `meta.prefix`, normalized, when it has one (a declared
  prefix wins over an id); otherwise it is derived from the project id. A create must carry one
  of those two sources — with neither it is refused, and the server no longer mints a UUID and
  derives a token from it. Normalization is: trim surrounding whitespace, uppercase, collapse
  every run of characters outside `A`–`Z` and `0`–`9` into a single `-`, then strip leading and
  trailing `-`.
- **Every create path then holds the result to 1–4 characters of `A`–`Z` and `0`–`9`**
  (`PROJECT_PREFIX_MAX`, `PROJECT_PREFIX_PATTERN`, `isValidProjectPrefix`). Digits and a
  leading digit are fine (`A0B9`); a hyphenated or longer token refuses the create with
  `VALIDATION_FAILED` (HTTP `400`), writing no row. Multiple `-` segments and tokens longer
  than four characters exist only on legacy/imported rows, whose stored prefix is read
  unchanged (see the length note below).
- Unique per project, case-sensitively; not unique across projects. A bare identifier that
  exists in more than one project is refused as ambiguous rather than guessed.

A generated identifier matches this pattern (the serial is four or more digits):

```text
^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4,}$
```

Use that pattern only to recognize identifiers the board **generated**. Stored identifiers may
be legacy or custom and still pass `isValidIdentifier` without matching it; a parser that must
read every card should accept the wider storable pattern.

Length edge: the prefix normalizer itself still has no length cap, which is what lets legacy
rows keep reading and minting the token they stored. A **new** project cannot carry such a
prefix: creation refuses a normalized token outside 1–4 characters before the row lands. Only
a legacy row can carry a prefix long enough to push the whole generated identifier past 128
characters, and card creation for that row then fails `VALIDATION_FAILED`.

Examples (the test suite re-derives each line):

<!-- identifier-examples:begin -->
valid DEMO-0001
valid MEERKAT-TASKPANEL-0007
valid DEMO-12345
valid A.b_c-d
valid T-20261008-230500-meerkat-taskpanel-m1
invalid -leading-dash
invalid .leading-dot
invalid with space
invalid with/slash
<!-- identifier-examples:end -->

Generated form (the allocator's derivation; the `meerkat-taskpanel` and `demo_x` rows are
legacy/read-path tokens, not prefixes a new project may declare):

<!-- identifier-generated:begin -->
demo => 1 => DEMO-0001
demo => 12345 => DEMO-12345
meerkat-taskpanel => 7 => MEERKAT-TASKPANEL-0007
demo_x => 2 => DEMO-X-0002
<!-- identifier-generated:end -->

Prefix fold:

<!-- identifier-prefix:begin -->
meerkat-taskpanel => MEERKAT-TASKPANEL
demo_x => DEMO-X
--w_ -- => W
<!-- identifier-prefix:end -->

Published generated-form pattern:

<!-- identifier-generated-regex:begin -->
^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4,}$
<!-- identifier-generated-regex:end -->
