/**
 * The board's closed vocabularies have one definition each, and the browser's
 * copy is held to it — `docs/tech-spec.md`, structure and enumerations.
 *
 * `web/` cannot import `src/` (a different build, and only `web/dist` crosses into
 * the runtime image), so the board's statuses, awaiting categories, acceptance
 * modes and priorities are declared once in `web/src/lib/board-enums.js` and once
 * in the domain. This test is the link between them: a value added on one side
 * and not the other fails here instead of surfacing as a card that renders in no
 * column.
 *
 * Static only — both modules are plain ESM with no Vue import, so this runs in the
 * container without a browser (the image has no Chromium).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CARD_ACCEPTANCE_MODES } from "../../src/core/domain/acceptance-mode.mjs";
import { AWAITING_REASONS, PRIORITIES, STATUSES, STATUS } from "../../src/core/domain/enums.mjs";
import {
  ACCEPTANCE_MODES,
  AWAITING,
  AWAITING_CATEGORIES,
  COLUMN_STATUSES,
  PRIORITIES as WEB_PRIORITIES,
  STATUSES as WEB_STATUSES,
} from "../../web/src/lib/board-enums.js";

describe("web/enums.drift — the browser's copies of the board's closed sets", () => {
  it("lists the same statuses, in the same board order", () => {
    assert.deepEqual([...WEB_STATUSES], [...STATUSES]);
  });

  it("keeps `awaiting` out of the columns — it is an overlay, not an eighth column", () => {
    assert.equal(AWAITING, STATUS.AWAITING);
    assert.deepEqual(
      [...COLUMN_STATUSES],
      [...STATUSES].filter((status) => status !== STATUS.AWAITING),
    );
  });

  it("names the same awaiting categories", () => {
    assert.deepEqual([...AWAITING_CATEGORIES], [...AWAITING_REASONS]);
  });

  it("names the same card acceptance modes", () => {
    assert.deepEqual([...ACCEPTANCE_MODES], [...CARD_ACCEPTANCE_MODES]);
  });

  it("covers every canonical priority, plus the display-only `none` band last", () => {
    const web = [...WEB_PRIORITIES];
    assert.equal(web.at(-1), "none", "`none` is the UI band for an unset priority and sorts last");
    assert.deepEqual(
      new Set(web.filter((priority) => priority !== "none")),
      new Set(PRIORITIES),
      "the browser's priorities drifted from src/core/domain/enums.mjs",
    );
  });
});
