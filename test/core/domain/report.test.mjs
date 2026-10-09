/**
 * Step 10: report content validation (card A8, V7).
 *
 * One reject case per rule, each asserting the exact `issues[].path` — an agent
 * fixing a rejected report should be told *which field* to fix, not that
 * "something was invalid".
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  REPORT_MAX_BYTES,
  REPORT_MAX_CONCLUSION_CHARS,
  REPORT_MAX_ITEMS,
} from "../../../src/shared/constants.mjs";
import {
  OPEN_ACCEPTANCE_STATUSES,
  acceptanceFromJson,
  boundEvidence,
  evidenceFromJson,
  normalizeImportedReport,
  normalizeReportCreate,
  reportFromRow,
  serializeAcceptance,
  serializeEvidence,
  validateReport,
} from "../../../src/core/domain/report.mjs";

const NOW = "2026-10-08T00:00:00.000Z";
const CONTEXT = { taskRound: 1, now: NOW };

/** A minimal report that passes. `overrides` replaces top-level keys. */
function good(overrides = {}) {
  return {
    conclusion: "M1 core is implemented and verified.",
    acceptance: [{ text: "domain has no Node I/O", status: "met", note: "purity test" }],
    evidence: [{ kind: "commit", sha: "dcd7d15" }],
    author: { kind: "agent", id: "linus" },
    ...overrides,
  };
}

/** @returns {string[]} the issue paths, in order */
function paths(input, context = {}) {
  const report = { ...good(), ...input };
  const result = validateReport(report, { ...CONTEXT, ...context });
  assert.equal(result.ok, false, "expected the report to be rejected");
  return result.issues.map((issue) => issue.path);
}

describe("domain/report — conclusion", () => {
  it("accepts a well-formed report", () => {
    const result = validateReport(good(), CONTEXT);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.report.conclusion, "M1 core is implemented and verified.");
    assert.equal(result.report.round, 1, "the round defaults to the task's current round");
  });

  it("rejects an empty, blank or over-long conclusion", () => {
    assert.deepEqual(paths({ conclusion: "" }), ["conclusion"]);
    assert.deepEqual(paths({ conclusion: "   " }), ["conclusion"]);
    assert.deepEqual(paths({ conclusion: null }), ["conclusion"]);
    assert.deepEqual(paths({ conclusion: "x".repeat(REPORT_MAX_CONCLUSION_CHARS + 1) }), ["conclusion"]);
  });
});

describe("domain/report — acceptance", () => {
  it("requires an array with at least one criterion", () => {
    assert.deepEqual(paths({ acceptance: undefined }), ["acceptance"]);
    assert.deepEqual(paths({ acceptance: "met" }), ["acceptance"]);
    assert.deepEqual(paths({ acceptance: [] }), ["acceptance"]);
  });

  it("requires text and a known status on every item", () => {
    assert.deepEqual(paths({ acceptance: [{}] }), ["acceptance[0].text", "acceptance[0].status"]);
    assert.deepEqual(paths({ acceptance: [{ text: "x", status: "done" }] }), ["acceptance[0].status"]);
    assert.deepEqual(paths({ acceptance: [{ text: "", status: "met" }] }), ["acceptance[0].text"]);
    assert.deepEqual(paths({ acceptance: [null] }), ["acceptance[0]"]);
    assert.deepEqual(paths({ acceptance: [{ text: "x", status: "met", note: 7 }] }), [
      "acceptance[0].note",
    ]);
  });

  it("accepts all four statuses, including not_applicable", () => {
    for (const status of ["met", "partial", "not_met", "not_applicable"]) {
      const report = good({ acceptance: [{ text: "x", status }] });
      if (status === "partial" || status === "not_met") report.leftovers = "still open";
      assert.equal(validateReport(report, CONTEXT).ok, true, status);
    }
  });

  it("rejects more than the item cap", () => {
    const many = Array.from({ length: REPORT_MAX_ITEMS + 1 }, (_, i) => ({ text: `c${i}`, status: "met" }));
    assert.deepEqual(paths({ acceptance: many }), ["acceptance"]);
  });
});

describe("domain/report — evidence anchors", () => {
  it("requires at least one anchor", () => {
    assert.deepEqual(paths({ evidence: undefined }), ["evidence"]);
    assert.deepEqual(paths({ evidence: [] }), ["evidence"]);
    assert.deepEqual(paths({ evidence: "commit" }), ["evidence"]);
  });

  it("accepts each of the four anchor kinds", () => {
    const anchors = [
      { kind: "commit", sha: "a".repeat(40) },
      { kind: "commit", sha: "0123456" },
      { kind: "path", path: "src/core/domain/report.mjs" },
      { kind: "command", cmd: "node --test test/contract", exit_code: 0 },
      { kind: "coverage", lines: 92.5, scope: "src/core/**" },
    ];
    for (const anchor of anchors) {
      assert.equal(validateReport(good({ evidence: [anchor] }), CONTEXT).ok, true, JSON.stringify(anchor));
    }
  });

  it("rejects an anchor with a missing or unknown kind", () => {
    assert.deepEqual(paths({ evidence: [{ sha: "abc1234" }] }), ["evidence[0].kind"]);
    assert.deepEqual(paths({ evidence: [{ kind: "screenshot", path: "x.png" }] }), ["evidence[0].kind"]);
    assert.deepEqual(paths({ evidence: [null] }), ["evidence[0]"]);
  });

  it("pins the required fields of each anchor kind", () => {
    assert.deepEqual(paths({ evidence: [{ kind: "commit", sha: "ZZZ" }] }), ["evidence[0].sha"]);
    assert.deepEqual(paths({ evidence: [{ kind: "commit", sha: "abc" }] }), ["evidence[0].sha"]);
    assert.deepEqual(paths({ evidence: [{ kind: "commit", sha: "ABCDEF1" }] }), ["evidence[0].sha"]);
    assert.deepEqual(paths({ evidence: [{ kind: "path", path: "  " }] }), ["evidence[0].path"]);
    assert.deepEqual(paths({ evidence: [{ kind: "command", cmd: "node --test" }] }), [
      "evidence[0].exit_code",
    ]);
    assert.deepEqual(paths({ evidence: [{ kind: "command", cmd: "", exit_code: 1.5 }] }), [
      "evidence[0].cmd",
      "evidence[0].exit_code",
    ]);
    assert.deepEqual(paths({ evidence: [{ kind: "coverage", lines: 101 }] }), ["evidence[0].lines"]);
    assert.deepEqual(paths({ evidence: [{ kind: "coverage", lines: "high" }] }), ["evidence[0].lines"]);
    assert.deepEqual(paths({ evidence: [{ kind: "coverage", lines: 50, scope: 7 }] }), [
      "evidence[0].scope",
    ]);
  });

  it("rejects more than the anchor cap", () => {
    const many = Array.from({ length: REPORT_MAX_ITEMS + 1 }, () => ({ kind: "path", path: "x" }));
    assert.deepEqual(paths({ evidence: many }), ["evidence"]);
  });
});

describe("domain/report — leftovers and author", () => {
  it("demands leftovers whenever something is partial or not met", () => {
    for (const status of OPEN_ACCEPTANCE_STATUSES) {
      assert.deepEqual(paths({ acceptance: [{ text: "x", status }] }), ["leftovers"]);
      assert.deepEqual(paths({ acceptance: [{ text: "x", status }], leftovers: "  " }), ["leftovers"]);
      assert.equal(
        validateReport(
          good({ acceptance: [{ text: "x", status }], leftovers: "container run pending" }),
          CONTEXT,
        ).ok,
        true,
        status,
      );
    }
    assert.equal(validateReport(good({ acceptance: [{ text: "x", status: "met" }] }), CONTEXT).ok, true);
    assert.deepEqual(paths({ leftovers: 42 }), ["leftovers"]);
  });

  it("requires a named author", () => {
    assert.deepEqual(paths({ author: undefined }), ["author"]);
    assert.deepEqual(paths({ author: { id: "linus" } }), ["author.kind"]);
    assert.deepEqual(paths({ author: { kind: "agent" } }), ["author.id"]);
    assert.deepEqual(paths({ author: { kind: "robot", id: "" } }), ["author.kind", "author.id"]);
  });

  it("returns every problem at once", () => {
    const report = { conclusion: "", acceptance: [], evidence: [], author: null };
    const result = validateReport(report, CONTEXT);
    assert.deepEqual(
      result.issues.map((i) => i.path),
      ["conclusion", "acceptance", "evidence", "author"],
    );
    assert.equal(validateReport(null, CONTEXT).ok, false);
  });
});

describe("domain/report — round", () => {
  it("rejects a round that is not the current delivery round (F3)", () => {
    assert.throws(() => normalizeReportCreate(good({ round: 2 }), CONTEXT), (err) => {
      assert.equal(err.code, "REPORT_ROUND_MISMATCH");
      assert.equal(err.http, 409);
      assert.deepEqual(err.details, { field: "round", received: 2, taskRound: 1 });
      return true;
    });
    assert.equal(normalizeReportCreate(good({ round: 1 }), CONTEXT).round, 1);
    assert.equal(normalizeReportCreate(good(), { ...CONTEXT, taskRound: 3 }).round, 3);
  });
});

describe("domain/report — normalizeImportedReport (the relaxed read path)", () => {
  const narrative = {
    conclusion: "A free-form narrative that predates the structured report schema.",
    acceptance: [],
    evidence: [],
    author: { kind: "agent", id: "unknown" },
  };

  it("permits an empty acceptance and evidence, fabricating nothing", () => {
    const report = normalizeImportedReport(narrative, CONTEXT);
    assert.equal(report.conclusion, narrative.conclusion);
    assert.deepEqual(report.acceptance, []);
    assert.equal(report.acceptanceJson, "[]");
    assert.equal(report.evidenceJson, "[]");
    assert.deepEqual(report.evidence, { items: [], truncated: false, note: null });
    assert.equal(report.truncated, false);
    assert.equal(report.createdAt, NOW);
    assert.equal(report.round, 1);
  });

  it("still validates types, the author and the round", () => {
    assert.throws(() => normalizeImportedReport({ ...narrative, conclusion: "" }, CONTEXT), (err) => {
      assert.equal(err.code, "REPORT_INVALID");
      assert.deepEqual(err.details.issues, [{ path: "conclusion", message: "conclusion must be a non-empty string" }]);
      return true;
    });
    assert.throws(
      () => normalizeImportedReport({ ...narrative, author: { kind: "nope", id: "x" } }, CONTEXT),
      (err) => err.code === "REPORT_INVALID",
    );
    assert.throws(() => normalizeImportedReport({ ...narrative, round: 2 }, CONTEXT), (err) => {
      assert.equal(err.code, "REPORT_ROUND_MISMATCH");
      return true;
    });
  });

  it("does NOT weaken the gate: normalizeReportCreate still rejects the same payload", () => {
    assert.throws(() => normalizeReportCreate(narrative, CONTEXT), (err) => {
      assert.equal(err.code, "REPORT_INVALID");
      assert.deepEqual(
        err.details.issues.map((issue) => issue.path),
        ["acceptance", "evidence"],
      );
      return true;
    });
  });
});

describe("domain/report — bounds and truncation", () => {
  it("wraps validateReport failures in REPORT_INVALID with the issue list", () => {
    assert.throws(() => normalizeReportCreate({ ...good(), conclusion: "" }, CONTEXT), (err) => {
      assert.equal(err.code, "REPORT_INVALID");
      assert.equal(err.http, 422);
      assert.deepEqual(err.details.issues, [{ path: "conclusion", message: "conclusion must be a non-empty string" }]);
      return true;
    });
  });

  it("truncates an oversized payload and marks it, instead of failing", () => {
    const big = {
      ...good(),
      acceptance: [{ text: "criterion", status: "met", note: "n".repeat(40_000) }],
      evidence: [{ kind: "path", path: "p".repeat(40_000) }],
    };
    assert.equal(validateReport(big, CONTEXT).ok, true, "bounds are not a validation failure");

    const report = normalizeReportCreate(big, CONTEXT);
    assert.equal(report.truncated, true);
    assert.equal(report.evidence.truncated, true);
    assert.match(report.evidence.note, new RegExp(String(REPORT_MAX_BYTES)));
    assert.match(report.evidence.items[0].path, /…$/, "long strings are shortened");
    assert.equal(report.acceptance[0].note, undefined, "prose is dropped before evidence");
    const size =
      new TextEncoder().encode(report.acceptanceJson).length +
      new TextEncoder().encode(report.evidenceJson).length;
    assert.ok(size <= REPORT_MAX_BYTES, `still ${size} bytes`);
  });

  it("refuses a payload that cannot be shrunk under the cap", () => {
    const many = Array.from({ length: REPORT_MAX_ITEMS }, (_, i) => ({
      kind: "path",
      path: `${i}-`.padEnd(2000, "x"),
    }));
    // The acceptance list is never dropped, so a cap smaller than it is fatal.
    assert.throws(
      () => normalizeReportCreate(good({ evidence: many }), { ...CONTEXT, maxBytes: 20 }),
      (err) => {
        assert.equal(err.code, "REPORT_TOO_LARGE");
        assert.equal(err.http, 413);
        return true;
      },
    );
    // ...and truncation may not empty the evidence list either.
    assert.throws(
      () => normalizeReportCreate(good({ evidence: many }), { ...CONTEXT, maxBytes: 250 }),
      (err) => err.code === "REPORT_TOO_LARGE",
    );
    const bounded = boundEvidence(
      [],
      Array.from({ length: REPORT_MAX_ITEMS }, () => ({ kind: "path", path: "y".repeat(500) })),
      { maxBytes: 50 },
    );
    assert.equal(bounded.fits, false);
    assert.deepEqual(bounded.evidence, [], "nothing fits, so nothing is kept");
  });

  it("serialises arrays plainly and truncated payloads as an object", () => {
    assert.equal(serializeAcceptance([{ text: "x", status: "met" }]), '[{"text":"x","status":"met"}]');
    assert.equal(serializeEvidence([{ kind: "commit", sha: "abc1234" }]), '[{"kind":"commit","sha":"abc1234"}]');
    assert.match(serializeEvidence([], { truncated: true, note: "why" }), /"truncated":true/);
  });
});

describe("domain/report — decoding", () => {
  it("reads both evidence shapes and never throws on junk", () => {
    assert.deepEqual(evidenceFromJson('[{"kind":"path","path":"x"}]'), {
      items: [{ kind: "path", path: "x" }],
      truncated: false,
      note: null,
    });
    const bounded = evidenceFromJson({ truncated: true, items: [{ kind: "path", path: "x" }], note: "n" });
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.note, "n");
    assert.deepEqual(evidenceFromJson("{not json"), { items: [], truncated: false, note: null });
    assert.deepEqual(evidenceFromJson(null), { items: [], truncated: false, note: null });
    assert.deepEqual(acceptanceFromJson('[{"text":"x","status":"met"}]'), [{ text: "x", status: "met" }]);
    assert.deepEqual(acceptanceFromJson("nope"), []);
  });

  it("maps a row to a report DTO", () => {
    const report = reportFromRow({
      id: 1,
      task_id: "task-1",
      round: 2,
      seg: "seg2",
      session_id: "s",
      conclusion: "done",
      acceptance_json: '[{"text":"x","status":"met"}]',
      evidence_json: '[{"kind":"commit","sha":"abc1234"}]',
      leftovers: null,
      author_kind: "agent",
      author_id: "linus",
      source_seq: null,
      created_at: NOW,
    });
    assert.equal(report.taskId, "task-1");
    assert.equal(report.round, 2);
    assert.deepEqual(report.acceptance, [{ text: "x", status: "met" }]);
    assert.deepEqual(report.evidence.items, [{ kind: "commit", sha: "abc1234" }]);
    assert.equal(reportFromRow(null), null);
  });
});
