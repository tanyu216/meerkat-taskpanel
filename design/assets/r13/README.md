# R13 capture set — the roster name's selected capsule

The round's evidence that R13 (Active agents Assignee selected state) landed in
`design/prototype/index.html`. Captured at device-scale-factor 2, height 950, through the real
handlers (the state is reached by pressing the name and the `✕`, never by editing the DOM), and
no frame carries a transient toast — the language switch reports itself for 2.5 s and the shutter
waits it out. Renaming any file here is a change to the round's evidence; the contract that names
them is `design/fidelity-r13.md` and `design/DESIGN.md` §31.

| File | State |
|---|---|
| `proto-assignee-unselected-1512.png` | at rest — the board, Assignee: All, every roster name a flat text button, no capsule and no visible `✕` |
| `proto-assignee-selected-1512.png` | after pressing `jobs` — the list view, **Status: In Progress +1** *and* **Assignee: jobs**, one row (`TD-125`), and `jobs` in the roster wearing the selected capsule with its `✕` |
| `proto-assignee-cleared-1512.png` | after pressing that `✕` — the name is out of the assignee control, the roster is back to flat text, and **the status set and the list view are untouched** (the difference from the previous frame is the capsule and the assignee control, nothing else) |
| `proto-assignee-unselected-1240.png` | the same resting state at the 1240 tier (the sidebar still holds its labels at every width above 1023) |
| `proto-assignee-selected-zh-1512.png` | Chinese, after pressing `jobs` — the filter bar, the list header and the capsule's accessible state all re-worded |
| `proto-assignee-nojs-1512.png` | **scripting off**: six names, readable, comma-separated into one sentence per row, and **no** `✕` painted anywhere — the static floor the round's structure contract is written against |

**The selected frames carry a disclosed cost.** The capsule is 20px wider than the flat name it
replaces, and the row's single line does not grow with it, so at 1512 the claude row's tail name
(`simons`) is ellipsized by 19px in `proto-assignee-selected-1512.png` and
`proto-assignee-selected-zh-1512.png`. It is the round's one unadjudicated item — the row's
**height** is protected by contract and measured at zero movement, its **width** is not. The
measurement and the options are in `design/fidelity-r13.md` §8 U-3; the frames show it rather
than hide it.

The script-off frame is the shipped document served with scripting disabled, unmodified — unlike
the R12x sets, no attribute is moved to make it, because the round's own resting state *is* the
script-off state (the `✕` is static markup, hidden until a name is in force).
