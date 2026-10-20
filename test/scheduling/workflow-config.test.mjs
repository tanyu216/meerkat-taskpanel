/**
 * The loop’s workflow configuration (`src/shared/scheduling.mjs`): flag > env >
 * file > default. Pure; no board, no clock.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveWorkflowConfig } from "../../src/shared/scheduling.mjs";

describe("resolveWorkflowConfig", () => {
  it("defaults to on, no reviewer, auto-accept, 20 writes", () => {
    assert.deepEqual(resolveWorkflowConfig(), {
      workflow: true,
      acceptancePolicy: "both",
      reviewer: null,
      autoAcceptReviews: true,
      maxActions: 20,
      reviewAgingMs: 3_600_000,
    });
  });

  it("prefers flag > env > file > default", () => {
    const file = {
      MEERKAT_TASKPANEL_WORKFLOW: "no",
      MEERKAT_TASKPANEL_REVIEWER: "file-reviewer",
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "no",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "7",
    };
    const env = {
      MEERKAT_TASKPANEL_WORKFLOW: "yes",
      MEERKAT_TASKPANEL_REVIEWER: "env-reviewer",
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "yes",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "9",
    };
    assert.deepEqual(resolveWorkflowConfig({ env, file }), {
      workflow: true,
      acceptancePolicy: "both",
      reviewer: "env-reviewer",
      autoAcceptReviews: true,
      maxActions: 9,
      reviewAgingMs: 3_600_000,
    });
    assert.deepEqual(
      resolveWorkflowConfig({
        flags: {
          workflow: "no",
          reviewer: "flag-reviewer",
          autoAcceptReviews: "no",
          workflowMaxActions: "3",
          reviewAgingMinutes: "30",
        },
        env,
        file,
      }),
      { workflow: false, acceptancePolicy: "both", reviewer: "flag-reviewer", autoAcceptReviews: false, maxActions: 3, reviewAgingMs: 1_800_000 },
    );
    assert.deepEqual(resolveWorkflowConfig({ file }), {
      workflow: false,
      acceptancePolicy: "both",
      reviewer: "file-reviewer",
      autoAcceptReviews: false,
      maxActions: 7,
      reviewAgingMs: 3_600_000,
    });
  });

  it("ignores an unreadable value and falls through", () => {
    const resolved = resolveWorkflowConfig({
      flags: { workflow: "maybe", reviewer: "   ", workflowMaxActions: "0" },
      env: { MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "perhaps" },
      file: { MEERKAT_TASKPANEL_WORKFLOW: "no" },
    });
    assert.equal(resolved.workflow, false, "the file's value is the next readable one");
    assert.equal(resolved.reviewer, null, "whitespace is not a name");
    assert.equal(resolved.autoAcceptReviews, true);
    assert.equal(resolved.maxActions, 20, "a non-positive cap is not a cap");
  });
});

