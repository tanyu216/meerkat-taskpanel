# R13 capture set — the roster name's selected capsule

The round's evidence that R13 (Active agents Assignee selected state) landed in
`design/prototype/index.html`. Captured at device-scale-factor 2, height 950, through the real
handlers (the state is reached by pressing the name and the `✕`, never by editing the DOM), and
no frame carries a transient toast — the language switch reports itself for 2.5 s and the shutter
waits it out. Renaming any file here is a change to the round's evidence; the contract that names
them is `design/fidelity-r13.md` and `design/DESIGN.md` §31.

**Re-shot for the round's revision.** The capsule is now width-neutral (a `--color-td-accent-soft`
bed with an accent name, no border, `padding: 0 6px` cancelled by `margin-inline: -6px`) and the
single removal affordance is the `✕` beside the Assignee control, not one inside each roster
capsule. All six frames were re-taken from the revised build; the file names are unchanged.

| File | State |
|---|---|
| `proto-assignee-unselected-1512.png` | at rest — the board, Assignee: All, every roster name a flat text button, no capsule and no `✕` beside the control |
| `proto-assignee-selected-1512.png` | after pressing `jobs` — the list view, **Status: In Progress +1** *and* **Assignee: jobs**, one row (`TD-125`), `jobs` in the roster wearing the width-neutral accent capsule, and the `✕` shown beside the Assignee control |
| `proto-assignee-cleared-1512.png` | after pressing that `✕` — the name is out of the assignee control, the roster is back to flat text, the `✕` is gone again, and **the status set and the list view are untouched** (the difference from the previous frame is the capsule, the assignee control and the `✕`, nothing else) |
| `proto-assignee-unselected-1240.png` | the same resting state at the 1240 tier (the sidebar still holds its labels at every width above 1023) |
| `proto-assignee-selected-zh-1512.png` | Chinese, after pressing `jobs` — the filter bar, the list header and the capsule's accessible state all re-worded |
| `proto-assignee-nojs-1512.png` | **scripting off**: six names, readable, comma-separated into one sentence per row, and **no** `✕` painted — the static floor the round's structure contract is written against |

**No frame ellipsizes a name.** The capsule's padding is cancelled by an equal negative inline
margin, so the claude row's single line measures what it measured at rest. That is the round's
own indicator — `clippedPx == 0` at all five tiers — and it is what the two selected frames show:
`jobs, linus, simons` reads whole with the capsule on `jobs`.

**The selected frames carry a disclosed cost.** The bed is 6px wider than the text on each side,
and the roster row's host (`.td-side-name`) carries `overflow: hidden` — the rule R8's ellipsis is
built on. So a name that **begins** its host shows a bed with a flat outer edge, while a name in
the middle or at the end shows both round caps. In `proto-assignee-selected-1512.png` the capsule
on `jobs` (first in its row) shows the cut edge. Nothing about the text moves and nothing is
hidden; the measurement and the options are in `design/fidelity-r13.md` §8 U-6. The frames show
it rather than hide it.

The script-off frame is the shipped document served with scripting disabled, unmodified — unlike
the R12x sets, no attribute is moved to make it, because the round's own resting state *is* the
script-off state (the `✕` is static markup, hidden until a name is in force).
