# R12x capture set — the Activity view inside the board

The round's evidence that the design's Activity view landed in `design/prototype/index.html`.
Captured at device-scale-factor 2 through the real handlers, transitions off, and no frame
carries a transient toast — the language switch reports itself for 2.5 s and the shutter waits
it out. Renaming any file here is a change to the round's evidence; the contract that names
them is `design/DESIGN.md` §29.

| File | State |
|---|---|
| `proto-activity-1512.png` | the view at 1512 — the sidebar's Activity item current with its unread pill, the board's own filter bar stood down, the feed with its boundary and its folded burst |
| `proto-activity-1240.png` / `proto-activity-980.png` | the same view at the two mid bands (the rail is an icon rail from 1023px down) |
| `proto-activity-760.png` / `proto-activity-430.png` | the narrow bands: the row gives up its single 30px line and stacks the task under the sentence, with no page-level sideways scroll |
| `proto-activity-zh.png` | Chinese — the day headings, the entry count, the boundary, the row verbs and the absolute date are all re-worded, and the sidebar pill follows |
| `proto-activity-nojs-board.png` | **scripting off**: the document's own default view, the board — what a reader without the script gets on open |
| `proto-activity-nojs.png` | **scripting off**: the same document, served with the activity root's `hidden` attribute flipped so the feed is what is on screen. Every row, day group, identifier, stamp and `<details>` in this frame is static markup — 0 templates, 0 script. This file is the round's no-script proof, and it is the one frame taken from a copy of `index.html` rather than from `index.html` itself |

The two `nojs` frames are a pair on purpose: the first is the shipped state, the second is the
same bytes with one attribute moved. Nothing else differs between them.

The round's **second half** — the Waiting view, B27 — has its own set beside this one, at
`design/assets/r12x-waiting/`. It is the same round and the same geometry; it is a separate
directory only so that each set's README keeps describing exactly the frames it names.
