/**
 * `web/lib/light-dismiss` — the one decision worth pinning without a browser.
 *
 * The rest of the module is DOM plumbing (`installLightDismiss` adds a document
 * listener, `dismissMemberFrom` clears an `open`), and its behaviour is asserted
 * where it happens — in the browser layer (`web/scripts/dom-smoke.mjs`, the R9
 * section, real clicks on a real page). What a unit test can reach, and what the
 * contract calls out as **not optional** (`design/fidelity-r9.md` §2.1), is the
 * single branch: a click on a *closed* member's own summary takes the other
 * members down, and a click on an **already-open** member's summary does not —
 * because at dispatch time the `<details>` has not toggled yet, so the open one
 * is on its way closed and must not be treated as the newcomer.
 *
 * The two `closest()` answers are the whole input, so they are faked exactly:
 * no DOM library is needed, and none exists (the test layer is Node builtins
 * only — `docs/agents/development.md`).
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { isOpeningClick } from "../../web/src/lib/light-dismiss.js";

/** A fake member: `hasAttribute("open")` is all the predicate asks of it. */
const member = (open) => ({ hasAttribute: (name) => name === "open" && open === true });

/** A fake click target: `closest("summary")` returns `summary` (or null). */
const target = (summary) => ({ closest: (selector) => (selector === "summary" ? summary : null) });

/** The summary element of `m`: `parentElement` is how membership is decided. */
const summaryOf = (m) => ({ parentElement: m });

describe("web/light-dismiss — the single-open guard", () => {
  it("treats a click on a closed member's own summary as the opening click", () => {
    const m = member(false);
    assert.equal(isOpeningClick(target(summaryOf(m)), m), true);
  });

  it("does not treat a click on an already-open member's summary as an opening click", () => {
    const m = member(true);
    assert.equal(isOpeningClick(target(summaryOf(m)), m), false, "an open member is on its way closed, not opening");
  });

  it("does not treat a click inside the panel (no summary ancestor) as an opening click", () => {
    const m = member(false);
    assert.equal(isOpeningClick(target(null), m), false);
  });

  it("does not treat a click on a summary of another member as this member's opening click", () => {
    const m = member(false);
    assert.equal(isOpeningClick(target(summaryOf(member(false))), m), false);
  });

  it("answers false when the click is outside every member", () => {
    const m = member(false);
    assert.equal(isOpeningClick(target(summaryOf(m)), null), false);
    assert.equal(isOpeningClick(null, m), false);
  });
});
