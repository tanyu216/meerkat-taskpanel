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
} from "../../src/foundation/wire.mjs";
import { DomainError } from "../../src/foundation/errors.mjs";

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
  assigneeId: "a-1",
  // 0023 — the kind each reference was made under, on the *card*. This is what
  // the ref renders: the registry holds one row per person and no kind.
  assigneeKind: "claude",
  reporterId: "r-1",
  reporterKind: "human",
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

const NAMES = { "a-1": "linus", "r-1": "elon" };
/**
 * The registry lookup a projection is given: **a name for an id, and nothing
 * else**. It is role-less (`"actor"` names the one table both roles live in), and
 * since `0023` the entry it returns carries no kind — the reference does.
 */
const LOOKUP = (kind, id) => (NAMES[id] === undefined ? null : { id, displayName: NAMES[id] });

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
    // The **kind is the card's** (0023): which platform this assignee is on is a
    // fact about this reference, not about the person, who may be on another one
    // tomorrow. The lookup supplies the *name* and nothing else.
    assert.deepEqual(wire.assignee, { id: "a-1", display_name: "linus", kind: "claude" });
    assert.deepEqual(wire.reporter, { id: "r-1", display_name: "elon", kind: "human" });
  });

  it("falls back to the id as the display name when nothing can resolve it", () => {
    const wire = taskToWire(TASK);
    // With no lookup there is no row to read a name from, so the id stands in —
    // but the kind is still the card's, because it never needed a row.
    assert.deepEqual(wire.assignee, { id: "a-1", display_name: "a-1", kind: "claude" });
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
      projectToWire({ id: "p", name: "P", labels: [], meta: {}, readme: null, archivedAt: null, createdAt: "t", updatedAt: "t" }),
      {
        id: "p",
        name: "P",
        prefix: "P",
        labels: [],
        meta: {},
        readme: null,
        task_count: null,
        // 0031 — the review policy defaults to `optional`; no project override
        // means the deployment reviewer applies, so `reviewer` is null.
        review_policy: "optional",
        // 0038 — the single acceptance default.
        acceptance: "auto",
        reviewer: null,
        archived_at: null,
        created_at: "t",
        updated_at: "t",
      },
    );

    // The sidebar badge's number: served with the list, so it is `null` — not 0 —
    // when the caller did not supply one. The projection counts nothing itself.
    assert.equal(projectToWire({ id: "p", name: "P", taskCount: 4 }).task_count, 4);
    assert.equal(projectToWire({ id: "p", name: "P", taskCount: 0 }).task_count, 0);
    assert.equal(projectToWire({ id: "p", name: "P", taskCount: "4" }).task_count, null);

    // C-RAIL-1 §4 R-W1 — the wire carries the project's **effective prefix**, so
    // the sidebar rail can render the token the project's cards are numbered
    // with. It is the derived value, not `meta.prefix` verbatim: what is served
    // is what `allocateIdentifier` numbers with (C-RAIL-1 §3.1 M1/M2).
    assert.equal(projectToWire({ id: "p", meta: { prefix: "td" } }).prefix, "TD");
    assert.equal(projectToWire({ id: "p", meta: { prefix: "or c" } }).prefix, "OR-C");
    // Legacy fallback: no stored prefix ⇒ the id, exactly as before the slot
    // existed. This is the branch the browser cannot reproduce, which is why the
    // value is projected rather than derived client-side (C-RAIL-1 §3.2 (D)).
    assert.equal(projectToWire({ id: "demo" }).prefix, "DEMO");
    // The trap C-RAIL-1 §0 ⑤ / §5 names: `identifierPrefix(meta?.prefix) ||
    // identifierPrefix(id)` yields the *truthy* "UNDEFINED" when `meta` exists
    // but carries no prefix, and the fallback never runs.
    const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    assert.equal(projectToWire({ id: uuid, meta: {} }).prefix, "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D");
    assert.equal(projectToWire({ id: uuid }).prefix, "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D");
    assert.notEqual(projectToWire({ id: uuid, meta: {} }).prefix, "UNDEFINED");
    // A prefix that normalizes to nothing falls back too (C-PREFIX-1 M4 refuses
    // it at creation; a row that predates the guard must still not mint "####").
    assert.equal(projectToWire({ id: "p1", meta: { prefix: "####" } }).prefix, "P1");
    assert.equal(commentToWire({ id: "c", taskId: "t", body: "b", kind: "note", authorKind: "human", authorId: "e", refs: [], version: 1, createdAt: "t" }).author_kind, "human");
    assert.equal(relationToWire({ id: 1, type: "parent", source: "a", target: "b", origin: null, createdAt: "t" }).source, "a");
    assert.equal(sessionToWire({ id: "s", taskId: "t", seg: "s1", owner: "linus", ownerKind: "claude", sessionId: "x", status: "running", ts: "t" }).session_id, "x");
    assert.equal(
      sessionToWire({ id: "s", taskId: "t", seg: "s1", owner: "linus", ownerKind: "claude", sessionId: "x", status: "running", ts: "t" }).goal,
      "",
      "a session with no goal reads as the empty sentence",
    );
    assert.equal(
      sessionToWire({ id: "s", taskId: "t", seg: "s1", owner: "linus", ownerKind: "claude", sessionId: "x", status: "running", ts: "t", goal: "ship it" }).goal,
      "ship it",
    );
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

  it("takes the kind from the record, and the row cannot override it (0023)", () => {
    // The inversion of what `0019` did. The registry holds one row per person, so
    // a kind there could only ever be one person's *last* answer — and the whole
    // point of `0023` is that "which platform is this act from" belongs to the
    // act. A lookup that still reports a kind is ignored: the card's wins.
    const resolved = taskToWire(TASK, { lookup: () => ({ id: "a-1", displayName: "Linus", kind: "codex" }) });
    assert.equal(resolved.assignee.display_name, "Linus", "the row still names the person");
    assert.equal(resolved.assignee.kind, "claude", "and the reference still says what it is");

    // A card that recorded no kind reports none — `null`, not a fabricated
    // `agent`, and not the role word the role-name fallback used to produce.
    // (`null` is the client's cue to apply its own reading; the board does not
    // guess on the reference's behalf.)
    assert.equal(taskToWire({ ...TASK, assigneeKind: null }).assignee.kind, null);
    assert.equal(taskToWire(TASK).assignee.kind, "claude", "and no lookup is needed for it");
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
