/**
 * The create dialog's acceptance preselect (`web/src/lib/acceptance-default.js`).
 *
 * There is no project default any more: a new card starts on `auto`, and the
 * creator states `off` or `human` from the card's own context. The modal may
 * not import `src/`, so this is the copy held in step here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CARD_ACCEPTANCE_MODES } from "../../src/core/domain/acceptance-mode.mjs";
import {
  ACCEPTANCE_MODES,
  FALLBACK_ACCEPTANCE,
  defaultAcceptanceMode,
} from "../../web/src/lib/acceptance-default.js";

describe("create dialog — the acceptance preselect", () => {
  it("offers exactly the card modes the domain stores", () => {
    assert.deepEqual([...ACCEPTANCE_MODES], [...CARD_ACCEPTANCE_MODES]);
  });

  it("preselects auto, the unresolved-card fallback", () => {
    assert.equal(defaultAcceptanceMode(), "auto");
    assert.equal(FALLBACK_ACCEPTANCE, "auto");
  });
});
