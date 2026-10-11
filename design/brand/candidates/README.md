# Sentinel Watch V2 — face candidates

**Candidates only. Nothing here is on the main line.** The adopted V2 mark
(`../logo.svg`, `../logo-dark.svg`, `../logo-mono.svg`, `../tokens.css`) is
untouched by this round; this directory holds three proposals for giving the mob
**eyes and a mouth**, produced for Terry to pick from. Landing the chosen one —
into the main-line SVGs, the prototype's inline geometry, and a fresh 48-frame
recapture — is a separate, later card.

Round: `T-20261011-234725` (design candidates) · spec: `image-brief.md` ·
base commit `0eb8480`.

## The three candidates

The face is **negative-space knockout** only: the eyes and mouth are holes cut
out of the existing ink mass with an SVG `<mask>`. No second colour draws the
face, the mark still restores to a single colour, and the outer silhouette does
not move. The five frozen V2 parameters (ear `r1.2`, ear `cx ±2.4`, ear
`cy top+1.7`, watch dot `r2.1 / cy 3.4`, ground `y27`, viewBox `0 0 32 32`) are
carried over unchanged, and the watch signal stays outside the mask.

| | directory | eyes | mouth | reading | role |
|---|---|---|---|---|---|
| **A** | `A-pin/` | dot `r0.42`, `cx ∓0.80`, `cy −0.20` | rounded rect `0.72 × 0.20`, `rx0.10`, `cy +0.95` | pin-dot eyes, neutral line mouth | **the restrained solve — recommended first release** |
| **B** | `B-snout/` | dot `r0.50`, `cx ∓0.86`, `cy −0.32` | rounded rect `1.32 × 0.88`, `rx0.44`, `cy +0.92` | larger eye, rounded snout — the most meerkat | mid density; optional upgrade |
| **C** | `C-wake/` | dot `r0.60`, `cx ∓0.90`, `cy −0.28` | rounded rect `1.10 × 0.28`, `rx0.14`, `cy +1.05` | widest mouth, reads most cartoon | tension upper bound — **not recommended first** |

Offsets are relative to the head circle (`r2.6`, `cy = top + 2.6`), baked from
the spec's formulas rather than hand-typed. All six eyes and three mouths per
candidate sit strictly inside the head circle / body capsule, and clear the ear
band.

Each candidate ships three states:

- `logo.svg` — light: ink `#14181B`, on-duty sentinel + watch signal `#0F7A73`
- `logo-dark.svg` — dark: ink `#E6EDF0`, on-duty sentinel + watch signal `#2AA79B`
- `logo-mono.svg` — monotone: every shape `currentColor` (no literal colour)

and `png/logo-{16,32,48,128,512}.png` + `png/logo-{16,32,48,128,512}-dark.png`
(transparent ground, rasterised with scripting disabled).

## Size behaviour

The face is deliberately sub-pixel at icon sizes; the silhouette carries those.

| | 16 px | 32 px | 48 px | 128 px | 512 px |
|---|---|---|---|---|---|
| A eye `r0.42` | 0.21 | 0.42 | 0.63 | 1.68 | 6.72 |
| B eye `r0.50` | 0.25 | 0.50 | 0.75 | 2.00 | 8.00 |
| C eye `r0.60` | 0.30 | 0.60 | 0.90 | 2.40 | 9.60 |

*(px radius; 1 viewBox unit = size/32 px)*

- **≥128 px** — eyes and mouth read clearly.
- **48–96 px** — just perceptible, near the limit (earlier than the ears' own
  48 px floor, so the mark is still face-less at the ear threshold).
- **≤32 px** — the knockout is sub-pixel and the mark **degenerates to exactly
  the plain V2 silhouette**. This is expected and legal, not a defect; the face
  is declared stable **from 128 px up**.

## How to look at it

- **`index.html`** — open it directly in a browser (offline, single file, no
  script, no external reference). It shows all three candidates in the two real
  contexts — a 20 px top-bar slot and the 512 px empty state — in light and
  dark.
- **`compare.png`** — the one-sheet contact sheet (1600 × 2000): rows are the
  adopted V2 mark (no face), A, B and C; columns are 16/32/48/128/512 px ×
  light/dark, the lower strip showing each raster at nearest-neighbour zoom so
  the real pixel behaviour at 16/32 is visible rather than smoothed away.
- Per-candidate PNGs live in `<candidate>/png/`.

Machine check: `gen/verify-faces.mjs` in the card workspace re-derives the face
and silhouette geometry from the frozen constants and asserts the shipped SVGs
against it (including that the main line's hashes are unchanged). It exits 0.
