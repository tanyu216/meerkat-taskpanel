# 0012 — The role kind order comes from the install

## Status

Accepted — 2026-11-03.

## Context

ADR 0007 made installation location the routing, but fixed the order: when several kinds carry
the same role the primary kind wins, then `claude → codex → pi`. The install already knows a
better answer: the `--target` order names which kinds the operator chose and in what order, and
`--supervisor-actor-kinds` names the primary. That order was discarded, so a team that installed
`pi` first still preferred `claude`, and `setup-meerkat` could not express a preference.
Separately, the installer still copied a hand-written list of five role names while the runtime
had already moved to discovering `skills/*/role.json`.

## Decision

- The install-time order is persisted as `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` in each loop
  kind's per-kind config. `install.sh` writes the normalized `--target` order, keeping only
  `claude|codex|pi` and moving the selected primary kind first; a direct per-kind installer run
  defaults to `<that kind>,<the rest>`. A kind the order omits is **appended** at discovery
  time, never excluded.
- `loadRoles` scans **every** loop kind in the effective order `[primary, …configured order]`;
  merge-by-id prefers the first hit, and `installedOn` / `variants` record the order. The running
  supervisor's primary kind is always first, which is also the first installed element in the
  normal case.
- `platformChain` uses the same order. Availability remains the CLI probe, not the directory: a
  role falls back only to another kind that also carries it.
- Role installation and packaging are data-driven: the installer copies whatever
  `skills/*/role.json` declares (not a five-name list), and the release manifest requires each
  role's `role.json` beside its `SKILL.md`.
- A session dispatched on a fallback kind loads **that kind's** copy of the skill
  (`roleVariant`), for both the opener and the inline forms.

## Why

- The operator's `--target` order is the only available statement of preference; ignoring it
  made "install it on pi" silently mean "prefer claude anyway".
- A full permutation keeps discovery from losing a role moved to a kind the order did not name:
  omission is a preference, not an exclusion.
- A data-driven installer cannot drift from the runtime's discovery rule, and adding a role no
  longer needs an installer edit.

## Consequences

- Changing `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` moves the fallback preference. Changing the
  **primary** kind still requires re-running `install.sh … --supervisor=enable`, because the
  primary is the unit's `--actor-kind`.
- `taskctl loop status --json` reports `kindOrder` for observability; there is no new flag.
- The five standard roles remain a product assertion in the tests, not a hard-coded installer
  list: a sixth discovered role is packaged and installed without an installer change.
