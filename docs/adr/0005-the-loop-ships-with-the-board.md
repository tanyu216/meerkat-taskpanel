# 0005 — The loop ships with the board, so there is no board-interface gate

## Status

Accepted — 2026-10-30.

## Context

The loop used to declare a foreign *board interface generation* and a minimum board release, and
checked it with a read-only verb: `taskctl loop compat` asked a board's own `--version --json` and
answered 0 compatible / 2 usage / 3 no verdict. `taskctl loop doctor` reused the same check for a
`compat` line in its report. The rule was written down twice — `skills/meerkat-loop/SKILL.md`
§ "Required board interface" and `skills/meerkat-loop/references/operation.md` § Compatibility.

That gate dates from when the loop was a separate body distributed apart from the board. It is not
true any more. The loop's passes live in `src/orchestrator/`, and the loop ships **in the board's own
package**: one tarball, one `VERSION`, one tree, installed by `install.sh` from `skills/meerkat-loop/`
rather than as a plugin. The installed loop always drives the `taskctl` beside it, named through
`MEERKAT_TASKPANEL_REPO` — so the skew the gate existed to catch cannot arise from an installation.

What the gate actually proved was that the board answers `--version`. `loop doctor` already proves
the board is reachable, through the one board read it performs for the stuck-card and `in_review`
lists; a board that cannot answer surfaces there as `board.error`. Nothing automatic — no supervisor,
patrol, queue or installer unit — consumed the verdict.

## Decision

Remove the gate, and the term with it:

- the `taskctl loop compat` verb, and both modules behind it (`src/foundation/board-compat.mjs`,
  `src/orchestrator/compat.mjs`), together with the `--quiet` flag it was the only user of;
- `loop doctor`'s `compat` section: the import, the injected `boardRun` seam, the report field, the
  `compat:` attention reason and the human-readable line;
- the declared generation and release floor from both loop-skill documents, and every prose use of
  the term on a current surface (source comments, README, `docs/`, tests, the design records).

`test/fixtures/contract/cli.snapshot.json` is regenerated: the command surface loses one verb. No
API route, error code or wire field changes, so `api.snapshot.json` does not move.

## Considered options

- **Keep the version floor, drop only the name.** Rejected: the floor is the whole mechanism. With
  the loop in the board's package, `>= 0.1.0` compares a tree against itself.
- **Keep the check as a doctor-only report.** Rejected: it reports a number nothing acts on, while
  the doctor's board read already reports the fact that matters (can the board be reached).

## Consequences

- **What replaces the enforcement:** nothing, deliberately. There is no cross-repository boundary
  left to enforce inside one artifact — the loop and the board move together. A genuinely foreign
  board is out of scope: this repository does not claim to drive one.
- The CLI surface is one verb smaller, and the skill docs no longer send an operator to a gate.
  `docs/tech-spec.md` is unchanged: it never named the gate.
- The naming-boundary contract (`design/contracts/naming-boundary.md`) permitted the term **only**
  as a compatibility declaration. That declaration is gone, so the record now refers to it
  descriptively; its §7.2 prohibitions are untouched and remain the enforced part.
- If the loop is ever distributed separately again, the forcing function returns and so must a
  version handshake — recorded as an ADR, not re-invented as a flag.
