/**
 * Step 6: the `--json` contract (V9).
 *
 * Two promises are asserted here and nowhere else:
 *
 *   * the wire is **snake_case** — no camelCase key may leak, because that is
 *     the vocabulary the card and `task-interface v1` bind to;
 *   * an actor always carries `display_name` **and** `id`, so a human can
 *     recognise it and a script can address it.
 *
 * The error half is checked for *deep equality* with `DomainError.toJSON()`:
 * "the CLI passes the domain error through" is the contract, not "it looks
 * similar".
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { renderFailure, renderResult } from "../../src/cli/output/index.mjs";
import { serialize, successEnvelope } from "../../src/cli/output/json.mjs";
import { actorLabel, table } from "../../src/cli/output/human.mjs";
import {
  commentToWire,
  dictionaryEntryToWire,
  projectToWire,
  relationToWire,
  reportToWire,
  sessionToWire,
  taskToWire,
  waiverOf,
  waiversFromActivities,
} from "../../src/cli/wire.mjs";
import { DomainError } from "../../src/shared/errors.mjs";

const TOKEN = `td_${"ab".repeat(32)}`;

const TASK = {
  id: "11111111-1111-5111-8111-111111111111",
  identifier: "PROJ-0007",
  projectId: "proj",
  title: "Ship M2",
  description: "…",
  status: "in_review",
  priority: "high",
  kind: "task",
  labels: ["m2"],
  sortOrder: 0,
  assigneeKind: "agent",
  assigneeId: "a-1",
  reporterId: "r-1",
  creatorKind: "human",
  creatorId: "elon",
  claimedBy: null,
  claimedAt: null,
  heartbeatAt: null,
  blockedAt: null,
  statusChangedAt: "2026-10-09T00:00:00.000Z",
  archivedAt: null,
  sourcePath: null,
  meta: {},
  reportLatestId: 3,
  deliveryRound: 1,
  reportWaiverRound: null,
  reportWaiverReason: null,
  reportWaivedAt: null,
  version: 4,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
};

const LOOKUP = (kind, id) =>
  ({ assignee: { id: "a-1", displayName: "linus", kind: "agent" }, reporter: { id: "r-1", displayName: "elon", kind: "human" } })[
    kind
  ]?.id === id
    ? { assignee: { id: "a-1", displayName: "linus", kind: "agent" }, reporter: { id: "r-1", displayName: "elon", kind: "human" } }[kind]
    : null;

describe("cli/wire — the JSON vocabulary", () => {
  it("projects a task to snake_case with no camelCase leak", () => {
    const wire = taskToWire(TASK, { lookup: LOOKUP });
    for (const key of Object.keys(wire)) {
      assert.equal(/[A-Z]/.test(key), false, `${key} is not snake_case`);
    }
    assert.equal(wire.project_id, "proj");
    assert.equal(wire.delivery_round, 1);
    assert.equal(wire.report_latest_id, 3);
    assert.equal(wire.status_changed_at, "2026-10-09T00:00:00.000Z");
    assert.equal(wire.report_waiver, null);
  });

  it("gives assignee and reporter both a display_name and an id", () => {
    const wire = taskToWire(TASK, { lookup: LOOKUP });
    assert.deepEqual(wire.assignee, { id: "a-1", display_name: "linus", kind: "agent" });
    assert.deepEqual(wire.reporter, { id: "r-1", display_name: "elon", kind: "human" });
  });

  it("falls back to the id as the display name when nothing can resolve it", () => {
    const wire = taskToWire(TASK);
    assert.deepEqual(wire.assignee, { id: "a-1", display_name: "a-1", kind: "agent" });
    assert.equal(wire.reporter.display_name, "r-1");
  });

  it("surfaces a waiver on the task and in the audit trail", () => {
    const waived = taskToWire({ ...TASK, reportWaiverRound: 1, reportWaiverReason: "hotfix", reportWaivedAt: "2026-10-09T01:00:00.000Z" });
    assert.deepEqual(waived.report_waiver, { round: 1, reason: "hotfix", waived_at: "2026-10-09T01:00:00.000Z" });

    const waivers = waiversFromActivities([
      { event: "task_moved", changes: {} },
      { event: "report_waived", changes: { round: 2, reason: "no time" }, createdAt: "2026-10-09T02:00:00.000Z", actorId: "linus" },
    ]);
    assert.deepEqual(waivers, [{ round: 2, reason: "no time", waived_at: "2026-10-09T02:00:00.000Z", actor_id: "linus" }]);
  });

  it("projects the other entities with the same naming rule", () => {
    assert.deepEqual(
      projectToWire({ id: "p", name: "P", workspacePath: "/tmp/p", labels: [], meta: {}, readme: null, archivedAt: null, createdAt: "t", updatedAt: "t" }),
      { id: "p", name: "P", workspace_path: "/tmp/p", labels: [], meta: {}, readme: null, archived_at: null, created_at: "t", updated_at: "t" },
    );
    assert.equal(commentToWire({ id: "c", taskId: "t", body: "b", kind: "note", authorKind: "human", authorId: "e", refs: [], version: 1, createdAt: "t" }).author_kind, "human");
    assert.equal(relationToWire({ id: 1, type: "parent", source: "a", target: "b", origin: null, createdAt: "t" }).source, "a");
    assert.equal(sessionToWire({ id: "s", taskId: "t", seg: "s1", owner: "linus", backend: "claude", sessionId: "x", status: "running", ts: "t" }).session_id, "x");
    assert.equal(dictionaryEntryToWire({ id: "a-1", kind: "agent", displayName: "linus", normalizedName: "linus", useCount: 2 }).display_name, "linus");
    const report = reportToWire({ id: 3, taskId: "t", round: 1, conclusion: "ok", acceptance: [], evidence: { items: [{ kind: "commit", sha: "abc1234" }], truncated: false }, authorKind: "agent", authorId: "linus", createdAt: "t" });
    assert.equal(report.evidence[0].sha, "abc1234");
    assert.equal(report.evidence_truncated, false);
  });
});

describe("cli/output — routing", () => {
  /** Collect what a render writes to each stream. */
  function capture() {
    const out = [];
    const err = [];
    return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
  }

  it("writes --json success to stdout and nothing to stderr (bar warnings)", () => {
    const cap = capture();
    renderResult({ data: { a: 1 }, human: "ignored", warnings: ["careful"] }, { json: true, ...cap.io });
    assert.equal(cap.out.length, 1);
    assert.deepEqual(JSON.parse(cap.out[0]), { ok: true, data: { a: 1 } });
    assert.deepEqual(cap.err, ["warning: careful\n"]);
  });

  it("writes human output to stdout and errors to stderr", () => {
    const ok = capture();
    renderResult({ data: {}, human: "hello" }, { json: false, ...ok.io });
    assert.deepEqual(ok.out, ["hello\n"]);
    assert.deepEqual(ok.err, []);

    const bad = capture();
    renderFailure(new DomainError("NOT_FOUND", { message: "no task x" }), { json: false, ...bad.io });
    assert.deepEqual(bad.out, []);
    assert.match(bad.err[0], /^NOT_FOUND: no task x/);
  });

  it("writes --json failures to stdout, as DomainError.toJSON() verbatim", () => {
    const err = new DomainError("REPORT_REQUIRED", {
      message: "no report for round 1",
      details: { round: 1, existingRounds: [] },
    });
    const cap = capture();
    renderFailure(err, { json: true, ...cap.io });
    assert.deepEqual(cap.err, []);
    const envelope = JSON.parse(cap.out[0]);
    assert.equal(envelope.ok, false);
    assert.deepEqual(envelope.error, err.toJSON());
  });

  it("redacts unless the command says it means to print a secret", () => {
    const secret = { token: TOKEN };
    assert.equal(serialize(successEnvelope(secret)).includes(TOKEN), false);
    assert.equal(serialize(successEnvelope(secret), { redact: false }).includes(TOKEN), true);
  });
});

describe("cli/output/human", () => {
  it("labels an actor with its display name and id", () => {
    assert.equal(actorLabel({ id: "a-1", display_name: "linus" }), "linus#a-1");
    assert.equal(actorLabel(null), "-");
  });

  it("aligns a table and does not pad the last column", () => {
    const text = table(["id", "name"], [["a", "alpha"], ["bb", "beta"]]);
    assert.deepEqual(text.split("\n"), ["id  name", "a   alpha", "bb  beta"]);
  });
});

describe("cli/wire — the projector's edges", () => {
  it("treats a missing entity as null and an empty id as nobody", () => {
    assert.equal(projectToWire(null), null);
    assert.equal(commentToWire(null), null);
    assert.equal(relationToWire(null), null);
    assert.equal(sessionToWire(null), null);
    assert.equal(dictionaryEntryToWire(null), null);
    assert.equal(reportToWire(null), null);

    const nobody = taskToWire({ ...TASK, assigneeId: "", reporterId: undefined });
    assert.equal(nobody.assignee, null);
    assert.equal(nobody.reporter, null);
  });

  it("takes the kind from the dictionary when it has one, and the task when it does not", () => {
    const resolved = taskToWire({ ...TASK, assigneeKind: "human" }, { lookup: () => ({ id: "a-1", displayName: "Linus", kind: "agent" }) });
    assert.equal(resolved.assignee.kind, "agent", "the dictionary is authoritative");

    const unresolved = taskToWire({ ...TASK, assigneeKind: "human" });
    assert.equal(unresolved.assignee.kind, "human", "otherwise the task's own column decides");
    assert.equal(taskToWire({ ...TASK, assigneeKind: null }).assignee.kind, "assignee", "and otherwise the role name");
  });

  it("reads evidence whether it is a list or a truncation envelope", () => {
    const plain = reportToWire({ id: 1, taskId: "t", round: 1, conclusion: "c", acceptance: [], evidence: [{ kind: "path", path: "x" }], authorKind: "agent", authorId: "a", createdAt: "t" });
    assert.deepEqual(plain.evidence, [{ kind: "path", path: "x" }]);
    assert.equal(plain.evidence_truncated, false);

    const truncated = reportToWire({ id: 2, taskId: "t", round: 1, conclusion: "c", acceptance: [], evidence: { items: [], truncated: true }, truncated: true, authorKind: "agent", authorId: "a", createdAt: "t" });
    assert.equal(truncated.evidence_truncated, true);

    const nulls = taskToWire({ ...TASK, labels: undefined, meta: undefined });
    assert.deepEqual(nulls.labels, []);
    assert.deepEqual(nulls.meta, {});
  });

  it("ignores a waiver round of zero when nothing was waived, and tolerates a missing audit list", () => {
    assert.equal(waiverOf({ reportWaiverRound: null }), null);
    assert.equal(waiverOf(null), null);
    assert.deepEqual(waiverOf({ reportWaiverRound: 3, reportWaiverReason: "why", reportWaivedAt: "t" }), { round: 3, reason: "why", waived_at: "t" });
    assert.deepEqual(waiversFromActivities(undefined), []);
    assert.deepEqual(waiversFromActivities([{ event: "task_moved", changes: {} }]), []);
    // A waiver row with no recorded round is still reported, as round 0.
    assert.deepEqual(waiversFromActivities([{ event: "report_waived", changes: {}, createdAt: "t", actorId: "a" }]), [
      { round: 0, reason: "", waived_at: "t", actor_id: "a" },
    ]);
  });
});
