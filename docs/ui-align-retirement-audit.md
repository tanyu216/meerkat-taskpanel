# The `ui-align` retirement — an assertion-coverage audit

**Reading pinned to** `main` @ `b7d6379` (the contract layer), against `f61e02a^` (the deleted
manifests). Reproduce per §5. **Read it off those commits, never off the working tree** — this
repository routinely has concurrent lanes and the tree changes under you.

## 1. Why this file exists

`ui-align` — the prototype ↔ implementation machine check — had its project half removed on
2026-10-15: `d681cbe` cleaned the prose, comments and live contracts, and `f61e02a` deleted the six
files (`web/manifests/{board,board-m2}.json` and their 970-line `README.md`, `web/.ui-align.json`,
`web/scripts/ui-align-serve.mjs`, `test/web/ui-align-ready.test.mjs`).

The retirement is right, for the reason `f61e02a` gives: what stayed in this repository did two
things only — name a tool no reader of this repository can obtain, and hard-code an absolute path
that existed on one machine.

That same message also claims **"no loss of checking power: the part of the manifest that duplicated
assertions was already in `test/web/blocks.contract.mjs`"**. This file is the row-by-row
reconciliation of that claim. **It holds for most rows and fails for some.**

## 2. The criterion — and two earlier attempts that were wrong

"Does the contract layer cover this?" has no single answer, because a hook can appear there in four
ways and **only the first is a machine guard**:

| Where the hook appears | Machine-evaluated? |
|---|---|
| a `rules` entry whose `kind` has `layer: "dom"` (`count`, `computed`, `classes`, `text`, `order`, `identical-hookset`, `domain`, `absent`, `sequence`, `monotonic`) | **yes** — `web/scripts/dom-smoke.mjs` evaluates it |
| `kind: "source"` (`selector-literal-present`, …) | yes, but it only scans the **built bundle** for the literal |
| a `required` / `states` list entry | **no** — bundle-literal presence only, and **no scope** |
| `kind: "manual"` | **no** — `test/web/blocks.contract.mjs` states it is "human-reviewed — it is *not* [machine-checked]", and `blocks.contract.test.mjs` forbids a manual rule from carrying a `selector` |

So the criterion is: **a manifest fact is guarded iff a scoped machine rule asserts it.**

Two tempting shortcuts are wrong, and both were tried here:

- *"the token appears somewhere in the file"* — counts `required`, `manual` notes and comments as
  guards. **Under-reports**: it missed `B07-identity` entirely, because `[data-card-agent-role]` does
  appear in `REQUIRED_BY_EVERY_CARD`.
- *"it is the value of a `selector:` field"* — counts `required`-list assertions as unguarded.
  **Over-reports** (71 rows where the real answer is smaller).

## 3. The result

The two deleted manifests carry **373 checks**; deduplicated by `selector + scope + bound`, **256**.

| Tier | Rows | Meaning |
|---|---|---|
| a `layer: "dom"` rule references the hook | 204 | has a machine guard — see §4 for why this is *not* the same as "the same bound is asserted" |
| **no DOM-layer guard** | **52** | |
| ├ T1 — not even a bundle literal | **15** | **no guard whatsoever** |
| └ T2 — bundle literal only | **37** | the hook name provably survives the vite compile; the DOM shape (`count: 7`, `min: 1`, **`count: 0`**) is asserted nowhere |

### T1 — 15 rows with no guard at all

| selector | scope | bound | was asserted by |
|---|---|---|---|
| `[data-side-text]` | `[data-access-open]` | `count: 0` | `B03-footer-text` (both manifests) |
| `[data-card][draggable="true"]` | `[data-board]` | `min: 1` | `B07` (both manifests) |
| `svg[data-caret]` | `[data-lang-menu]` | `count: 0` | `board-m2/B03-icons-caret` |
| `[data-view-toggle].td-tabs` | — | `count: 1` | `board-m2/B02-r6` |
| `[data-view].td-tab` | — | `count: 2` | `board-m2/B02-r6` |
| `[data-theme-switch].td-access-cell` | — | `count: 1` | `board-m2/B03-r6-footer` |
| `[data-lang-select].td-access-cell` | — | `count: 1` | `board-m2/B03-r6-footer` |
| `[data-access-open].td-access-cell` | — | `count: 1` | `board-m2/B03-r6-footer` |
| `[data-theme-switch] .td-side-text` | — | `count: 1` | `board-m2/B03-r6-footer` |
| `[data-lang-select] .td-side-text` | — | `count: 1` | `board-m2/B03-r6-footer` |
| `[data-card-title].td-card-title` | — | `min: 1` | `board-m2/B07-r6` |
| `[data-list-status].td-chip.td-chip-status` | — | `min: 1` | `board-m2/B08-r6` |
| `[data-list-priority].td-pri` | — | `min: 1` | `board-m2/B08-r6` |
| `[data-detail-status-chip].badge-sm.td-chip.td-chip-status` | — | `count: 1` | `board-m2/B09-r6` |
| `[data-access-panel].td-access-panel` | — | `count: 1` | `board-m2/B19-r6` |

**The facts themselves are still true.** Every class name above is present in `web/src/` and in
`web/dist` today; what is gone is the assertion, not the behaviour.

### T2 — 37 rows held up only by a bundle literal

The hook name provably survives the framework compile into `web/dist/assets/*.js`. The manifest's
actual claim — a count, a `min`, or an **absence** — is asserted nowhere. **An absence claim
(`count: 0`) is completely unguarded in this tier**, because a literal-presence scan cannot prove
that something is *not* there. Representative rows:

- **`B07-identity`**, which the retired `web/manifests/README.md` §4 and §16 both called
  `board.json`'s **unique** assertion: an agent card's `[data-card-agent-role]` (`min: 1`), a **human
  card's absence of it (`count: 0`)**, and the agent/human pair on `[hidden] [data-card-assignee]`.
  The mechanism is worth recording, because it is why the claim looked true:
  `[data-card-agent-role]` appears in the contract layer only inside `REQUIRED_BY_EVERY_CARD`
  (`test/web/blocks.contract.mjs`), which has no scope; and `identical-hookset` compares the
  `data-*` attributes of `[data-card]` **itself**, whereas the role hook is a **descendant** element.
  So **"every assertion `board.json` alone carried has a twin in the contract layer" is false.**
- `[data-column-{dot,name,count,add}]` `count: 7`; `[data-card-{stripe,labels,priority,assignee,`
  `comment-count,attachment-count,relations}]` `min: 1`; `[data-detail-{reporter-label,version,`
  `agent-session-body}]`; `[data-agent-session]`; `[data-comment-{form,input,submit}]`;
  the four `[data-lang-menu]` rows; `[data-empty-lg]` `count: 0`; `[data-states-open]` `count: 0`;
  `[data-project-{current,switcher-icon}]`; `[data-revision]` / `[data-revision-value]`;
  `[data-brand]`; `[data-card][data-{done,canceled}="true"] [data-card-title]`.

## 4. What this audit does *not* settle

The 204 rows above merely have *some* `layer: "dom"` rule naming the hook. **"The hook is named by a
rule" is not "the same bound is asserted"** — a rule may constrain a different property, a different
scope, or a looser bound. Statically that is undecidable here.

The only reliable instrument is **mutation testing**: make the smallest implementation-side change
that violates one row, rebuild `web/dist`, and see whether `npm test` goes red. Red means guarded;
green means another lost row, to be added to T1/T2.

**Until that sweep is done, do not claim the retirement cost nothing.** The defensible statement
today is: *52 rows lost their DOM-level guard; 15 of those have no guard at all; 204 more are
unverified.*

Registered but out of scope (the retirement message names these replacements):

- the manifests' `style.targets` — 6 rows in `board.json`, 45 in `board-m2.json`, all **bilateral**
  computed-style comparisons — went with the engine. `web/scripts/shot-compare.mjs` is the surviving
  bilateral leg, but its stated basis is **structure + geometry, no pixel diff**.
- `overflowTargets` and the five-width console/page-error checks are carried by
  `web/scripts/dom-smoke.mjs` (five viewports, evaluated under `npm test`).

## 5. Reproduce

```bash
# the deleted manifests (both live at the deletion commit's parent)
git show 'f61e02a^:web/manifests/board.json'
git show 'f61e02a^:web/manifests/board-m2.json'

# the three contract-layer harnesses, pinned
git show 'b7d6379:test/web/blocks.contract.mjs'   # the rules
git show 'b7d6379:web/scripts/dom-smoke.mjs'      # the evaluator
```

Then, per §2:

1. take every check's `selector` and `scope` from both manifests, deduplicated by
   `selector + scope + bound` → expect **256** from **373** raw checks;
2. read `RULE_KINDS` in `blocks.contract.mjs` for each `kind`'s `layer`; collect the
   `selector` / `within` / `probe` / `root` values of every rule whose layer is `dom`;
3. a row is **guarded** iff every hook token in its selector appears in (a) that collected set, or
   (b) anywhere in `dom-smoke.mjs` / `rail-chip-overflow.mjs` / `shot-compare.mjs` (those are code,
   not `required` lists, so any mention counts);
4. among the unguarded rows, those whose token is also absent from `blocks.contract.mjs` entirely
   are **T1** (expect **15**); the rest are **T2** (expect **37**).

`grep -rn '<hook>' web/ test/` is the cheap first pass for any single row, and is the sweep §4 asks
for once you are ready to do it properly.
