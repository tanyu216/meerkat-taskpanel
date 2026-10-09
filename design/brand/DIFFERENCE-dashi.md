# MeerkatTaskPanel brand vs. dashi-taskboard — separation statement

Reference palette: `refs/dashi-taskboard/web/src/styles.css` (its `:root` and
`:root[data-theme="dark"]` blocks, read directly).

MeerkatTaskPanel ships its own brand layer. It is not a reskin of dashi-taskboard
and shares no tokens with it. The two systems are distinguished on six
independent axes — hue family, neutral cast, warm ramp, type strategy, token
carrier and brand mark — so no single substitution can turn one into the other.

## Side-by-side

| # | Dimension | dashi-taskboard | MeerkatTaskPanel | Verdict |
|---|---|---|---|---|
| 1 | **Primary hue family** | `--accent: #317cff` — azure, **≈218°**, HSL saturation **100%**. A vivid, fully saturated blue. | `--color-primary: #0F7A73` — teal, **≈176°**, HSL saturation **78%**. (Brief notes ~178°; both sit inside the 165–185° teal band.) | Different hue family *and* lower saturation. Ours is a darker, calmer signal that reads as an instrument rather than a link. |
| 2 | **Neutral cast** | Cool-but-neutral greys with no hue bias: `#fcfcfd` (bg), `#f3f3f4` (sidebar), `#171719` (dark bg), `#222225` (dark surface). | Green-cyan cast throughout: `#F5F6F7` / `#FFFFFF` (bg), `#E6E8EB` (partition), `#0F1417` (dark bg), `#161B1E` (dark surface). | The dashi neutrals are hue-free; ours are deliberately pulled toward the teal line, so the whole surface sits in one temperature. |
| 3 | **Warning / warm ramp** | Neon yellow `--warning: #f0bf00` plus vivid orange `--priority-urgent: #ff7236` (≈18°, 100% saturation). Warm colour is used for urgency and is loud. | Deep amber `#8A5A00` (≈39°) and `#E8A93A` (≈38°, 79% saturation). Amber is rationed and never neon. | Neon removed. Both the light and dark ambers are darker ochres, so warmth signals without shouting. |
| 4 | **Success / error** | `--success: #43bc58` (bright grass green), `--danger: #f34e52` (light coral red), dark variants `#53b98a` / `#ef686d`. | `--color-success: #187A4C` (deep forest), `--color-error: #C0392B` (brick), dark `#57C98A` / `#F0796E`. | Same semantic slots, different value families. In light mode ours are far darker (L 29% vs 50% for success) and lower in absolute chroma, so they sit *below* the teal in visual priority instead of competing with it. |
| 5 | **Type strategy** | System stack only: `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", …`. Body set at **12px / weight 450**. No monospace token. | `--font-sans` names **Inter** first with the system stack behind it; `--font-mono` names **JetBrains Mono** first. Body baseline **14px**, and all numerals, IDs, timestamps and counts are forced to mono. | Different strategy, not just different names: dashi treats mono as incidental, we make it a rule so figure columns stay in register. Still zero network font dependency — both degrade to system faces. |
| 6 | **Token carrier** | Bespoke hand-written CSS custom properties (`--bg`, `--surface-muted`, `--status-done`, …), consumed directly. | A **daisyUI theme mapping** — daisyUI v5 canonical `--color-*` plus v4 aliases (`--p`, `--b1`, `--in`, …) plus our own `--brand-*` extension layer, on a documented 4/6/8px radius scale. | Different contract. dashi's tokens are private to its components; ours are a daisyUI theme, so any daisyUI component inherits the brand without bespoke CSS. |
| 7 | **Brand mark** | No equivalent owned mark — icons are inline SVGs; the app relies on the project avatar for identity. | `logo.svg` / `logo-dark.svg` / `logo-mono.svg` — the **Signal Bars** mark: three capsule columns at `x=5/13/21`, all bottom-aligned at `y=27`, `6×{10,15,17}`, `rx=3`, capped by a `r=2.75` node at `(24,6)`. | We own a geometry; dashi does not. This is the strongest separator — a mark cannot be produced by recolouring. |

### Bonus separations (not required, but they reinforce the point)

| Dimension | dashi-taskboard | MeerkatTaskPanel | Verdict |
|---|---|---|---|
| **Card elevation** | Cards carry a shadow (`--card-shadow: 0 3px 6px -2px …, 0 1px 1px …`), and hover deepens it. | **Cards cast no shadow at all.** Elevation is reserved for floats via `--shadow-pop`, used only on dropdowns, dialogs and drawers. | Cards are defined by their hairline edge and surface here. Quieter, flatter, more instrument-like. |
| **Status distinguishability** | `--status-backlog`, `--status-todo` and `--status-canceled` are *all* `#9e9ea1` — three states collapse to one swatch in light mode. | Seven distinct values, one per state, with the mapping pinned as "unique, never mixed". | Ours treats the status ramp as information; dashi's light mode does not separate backlog from todo. |
| **Border model** | `--border: #e1e1e1` / `--border-strong: #d5d5d5` at `0.5px` hairlines. | `--brand-border: #E6E8EB` / `--brand-border-strong: #CFD5D9`, plus a 4-step text ramp (`#14181B` → `#4A555E` → `#7E8A91` → `#B8C0C5`). | Both use hairlines, but ours ships a measured, contrast-verified text ramp rather than ad-hoc greys. |

## Conclusion

**No overlap: hue family, neutral cast, warm ramp, type strategy, token carrier
and brand mark are all six distinct.**

**不重叠：色相族、中性调、暖色、字体策略、token 载体、品牌 mark 六个维度均不同。**

The only deliberate common ground is the shared genre — a dense, restrained
workhorse board UI with hairline borders and a kanban-shaped information
hierarchy. That is the project brief, not the reference. Everything that
constitutes identity is independently authored here.
