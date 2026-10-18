/**
 * C-KIND-1 — the create dialog files `task` cards, and only `task` cards.
 *
 * ## The ruling this file pins
 *
 * T-20261017-063826 asked for a decision on "the board UI cannot create an epic and cannot set
 * `kind`", and the ruling is **(C) — do not add it**: the create dialog keeps no `kind` field,
 * and `epic` is produced agent-side by promoting a card in place
 * (`skills/meerkat-taskpanel/SKILL.md` §"When the card is a container"). The two other
 * candidates were considered and refused on evidence:
 *
 *   * **(A) a full `kind` select** would put `deploy` in a form. `deploy` is a card that no
 *     automatic read may offer *and* that is dispatched explicitly
 *     (`src/core/domain/enums.mjs`, `src/core/domain/claim.mjs`); a form option is the one
 *     shape that marker must never take.
 *   * **(B) `epic` only** would ship a dead-end affordance. A card created from this dialog is
 *     born in one of `createStatuses` — never `in_review`, by the creation gate — so an epic
 *     made here is born `todo`, and `todo` is precisely the state T-20261017-063808 proves has
 *     **no legal path** to `in_review` (an epic can never be claimed, so `todo → in_progress`
 *     is dead too). The human would get a card nothing can pick up and nothing can close,
 *     where today they get a `task` an agent will claim and promote.
 *
 * ## What is pinned, and why a pin rather than a fix
 *
 * There is no bug here to turn red: the shipped dialog already behaves as the ruling says. What
 * a ruling needs instead is a **tripwire**, so that the next lane that reaches for `kind` meets
 * the decision and its reason rather than re-deriving both. K1–K3 are that tripwire; they read
 * source text only, so — exactly like `test/web/side-rail-short-code.test.mjs` — they need no
 * browser and no `web/dist`, and they hold in the container where the browser layer self-skips.
 *
 * **K3 is the one that makes the ruling legible.** It asserts the *wire* still carries the three
 * kinds, so a future reader can see that `kind` is withheld by a UI decision and not by a
 * missing capability — the two would otherwise look identical from this file alone.
 *
 * ## When to re-cut this file
 *
 * If T-20261017-063808 lands and an epic in `todo` can reach `in_review`, candidate (B) becomes
 * cheap and safe; the ruling should then be re-taken, and K1/K2 re-cut to *require* the field
 * the way `side-rail-short-code.test.mjs` was re-cut for C-RAIL-2 P5. Until then, red here means
 * "this is a decision, not an oversight".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { TASK_KINDS } from "../../src/core/domain/enums.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MODAL = resolve(ROOT, "web/src/components/create/CreateTaskModal.vue");

/** @type {string} */
const modal = readFileSync(MODAL, "utf8");

/**
 * The dialog's submit payload, as the card documents it: what `submit()` sends, no more.
 *
 * Read out of the source because that is where it is built — `CreateTaskModal.submit()` is the
 * only writer, and the store's `createTask()` spreads what it is handed. The payload is a
 * literal plus two conditional assignments, so both shapes have to be collected to get the
 * whole key set; a key added in either shape reds K1.
 */
const DOCUMENTED_PAYLOAD_KEYS = [
  "assignee",
  "description",
  "labels",
  "priority",
  "project_id",
  "reporter",
  "status",
  "title",
];

function payloadKeys() {
  const literal = modal.match(/const payload = \{([\s\S]*?)\n\s*\};/);
  assert.ok(literal, "CreateTaskModal.submit() no longer builds a `const payload = { … }` literal");
  const declared = [...literal[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  const assigned = [...modal.matchAll(/payload\.(\w+)\s*=/g)].map((m) => m[1]);
  return [...new Set([...declared, ...assigned])].sort();
}

describe("web · C-KIND-1 — the create dialog files plain `task` cards", () => {
  it("K1 — the submit payload is the documented key set, and carries no `kind`", () => {
    assert.deepEqual(
      payloadKeys(),
      DOCUMENTED_PAYLOAD_KEYS,
      "the create dialog's payload changed. If you are adding `kind` (T-20261017-063826), that " +
        "is ruling (A)/(B) and it was refused: read the header of this file first — a one-line " +
        "`kind: \"task\"` default is not a smaller change than the field itself.",
    );
  });

  it("K2 — the dialog offers no `kind` control", () => {
    // Precise patterns on purpose: the modal legitimately says "kind" twice already, in
    // ComboField's `kind-attr="data-assignee-kind"` — a monogram hook that has nothing to do
    // with a task's kind. A bare /kind/ match would red on the assignee control.
    assert.doesNotMatch(modal, /TASK_KINDS/, "the modal must not import the kind vocabulary");
    assert.doesNotMatch(
      modal,
      /data-create-task-kind|createTask\.field\.kind/,
      "the dialog must carry no `kind` hook and no `kind` label — B10's routing column is the " +
        "eight fields `design/BLOCKS.md` names, and a ninth would be a design round.",
    );
  });

  it("K3 — the wire still carries the three kinds, so this is a UI decision", () => {
    assert.deepEqual(
      [...TASK_KINDS],
      ["task", "epic", "deploy"],
      "`TASK_KINDS` is the vocabulary `POST /api/v1/tasks` accepts (`kind` is in the contract " +
        "snapshot). The dialog withholds `kind` by ruling (C), not because the wire is missing " +
        "it — if this assertion moved, the ruling has to be re-taken, not the dialog quietly " +
        "re-opened.",
    );
    assert.ok(
      modal.includes("createTask("),
      "the modal no longer reaches the create path at all — this file's subject is gone",
    );
  });
});
