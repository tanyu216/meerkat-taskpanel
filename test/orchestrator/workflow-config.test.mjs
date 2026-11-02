/**
 * The loop’s workflow configuration (`src/foundation/scheduling.mjs`): flag > env >
 * file > default. Pure; no board, no clock.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_REVIEW_AGING_MINUTES,
  DEFAULT_WORKFLOW_MAX_ACTIONS as LOOP_MAX_ACTIONS,
  resolveWorkflowConfig,
} from "../../src/foundation/scheduling.mjs";
import {
  DEFAULT_BOARD_LIMIT,
  DEFAULT_REVIEW_AGING_MS,
  DEFAULT_WORKFLOW_MAX_ACTIONS,
} from "../../src/foundation/constants.mjs";
import {
  DEFAULT_REVIEW_AGING_MS as BOARD_AGING_MS,
  DEFAULT_WORKFLOW_MAX_ACTIONS as BOARD_MAX_ACTIONS,
} from "../../src/core/domain/workflow.mjs";

describe("resolveWorkflowConfig", () => {
  it("shares one set of workflow defaults with the board's planner", () => {
    // The board decides with these numbers and the loop resolves them; a second
    // copy is how the two sides drift into disagreeing about "aged" or "capped".
    assert.equal(LOOP_MAX_ACTIONS, BOARD_MAX_ACTIONS);
    assert.equal(BOARD_MAX_ACTIONS, DEFAULT_WORKFLOW_MAX_ACTIONS);
    assert.equal(BOARD_AGING_MS, DEFAULT_REVIEW_AGING_MS);
    assert.equal(DEFAULT_REVIEW_AGING_MINUTES * 60_000, DEFAULT_REVIEW_AGING_MS);
    assert.equal(DEFAULT_BOARD_LIMIT, 500);

    const config = resolveWorkflowConfig();
    assert.equal(config.maxActions, DEFAULT_WORKFLOW_MAX_ACTIONS);
    assert.equal(config.reviewAgingMs, DEFAULT_REVIEW_AGING_MS);
  });

  it("defaults to on, 20 writes", () => {
    assert.deepEqual(resolveWorkflowConfig(), {
      workflow: true,
      maxActions: 20,
      reviewAgingMs: 3_600_000,
      reworkMaxRounds: 4,
    });
  });

  it("prefers flag > env > file > default", () => {
    const file = {
      MEERKAT_TASKPANEL_WORKFLOW: "no",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "7",
      MEERKAT_TASKPANEL_REWORK_MAX_ROUNDS: "6",
    };
    const env = {
      MEERKAT_TASKPANEL_WORKFLOW: "yes",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "9",
      MEERKAT_TASKPANEL_REWORK_MAX_ROUNDS: "5",
    };
    assert.deepEqual(resolveWorkflowConfig({ env, file }), {
      workflow: true,
      maxActions: 9,
      reviewAgingMs: 3_600_000,
      reworkMaxRounds: 5,
    });
    assert.deepEqual(
      resolveWorkflowConfig({
        flags: {
          workflow: "no",
          workflowMaxActions: "3",
          reviewAgingMinutes: "30",
          reworkMaxRounds: "2",
        },
        env,
        file,
      }),
      {
        workflow: false,
        maxActions: 3,
        reviewAgingMs: 1_800_000,
        reworkMaxRounds: 2,
      },
    );
    assert.deepEqual(resolveWorkflowConfig({ file }), {
      workflow: false,
      maxActions: 7,
      reviewAgingMs: 3_600_000,
      reworkMaxRounds: 6,
    });
  });

  it("ignores an unreadable value and falls through", () => {
    const resolved = resolveWorkflowConfig({
      flags: { workflow: "maybe", workflowMaxActions: "0" },
      file: { MEERKAT_TASKPANEL_WORKFLOW: "no" },
    });
    assert.equal(resolved.workflow, false, "the file's value is the next readable one");
    assert.equal(resolved.maxActions, 20, "a non-positive cap is not a cap");
  });
});

