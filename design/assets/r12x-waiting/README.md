# R12x capture set — the Waiting view inside the board

The round's second half: the evidence that **B27** (`[data-waiting-view]`) landed in
`design/prototype/index.html`. Same geometry as the sibling `design/assets/r12x/` set —
device-scale-factor 2, transitions reduced, and no frame carrying a transient toast (the
language switch reports itself for 2.5 s and the shutter waits it out). The contract that names
these files is `design/DESIGN.md` **§30**; the block is `design/BLOCKS.md` **B27**.

| File | State |
|---|---|
| `proto-waiting-1512.png` | the view at 1512 — the sidebar's `Waiting on me` item current, the board's own filter bar stood down, the queue running oldest wait first with both reason kinds, and the identifier rule visible on the last row (`PROJ-000…`) |
| `proto-waiting-1240.png` / `proto-waiting-980.png` | the same view at the two mid bands (the sidebar is an icon rail from 1023px down) |
| `proto-waiting-760.png` / `proto-waiting-430.png` | the narrow bands: the row keeps its first line and moves the identifier and its title to a second one, with no page-level sideways scroll |
| `proto-waiting-zh.png` | Chinese — the heading, the tally, both reason chips and every wait stamp are re-worded (`等你回复` / `5 项等你回复` / `已阻塞` / `5 天前`) |
| `proto-waiting-empty.png` | **an attribute-moved frame**: the queue and the header's tally stood down, `[data-waiting-empty]` shown. No control in the prototype reaches this state — nothing in this queue filters and the seeded board has five items — so the capture script moves the attribute. DESIGN.md §30.4 |
| `proto-waiting-nojs.png` | **scripting off**, and an attribute-moved frame of the other kind: the same document served with the view root's `hidden` attribute flipped. Every row, actor, chip, identifier, title, stamp and opener in this frame is static markup — 0 templates, 0 script |

The last two frames are the round's disclosures: each is one attribute away from the shipped
document, and neither is reachable by pressing anything. The set's shipped-state no-script frame
(the board, the document's own default view) is identical to `proto-activity-nojs-board.png` in
the sibling set and is not duplicated here.
