/**
 * `taskctl loop doctor` — the read-only daily inspection.
 *
 * The board is a sentinel CLI and the state directory is real files, so the test
 * asserts both the report and the promise behind it: every board call is a read,
 * and no file under the state directory changes.
 *
 * The two "stuck" judgements are not re-tested here — they belong to
 * `planPatrol` (`scheduling.mjs`) and to the workflow's `review_aging` rule.
 * What is asserted is that the doctor *uses* those rules, and reports the
 * threshold it used.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  LOOP_DISPATCH_FAILED_MIN,
  LOOP_DISPATCH_ROWS_MIN,
  LOOP_REVIEW_REOPEN_MIN,
  LOOP_REVIEW_ROUND_MIN,
  LOOP_REWORK_ROUND_MIN,
  LOOP_SUBAGENT_FAILED_MIN,
  LOG_TAIL_LINES,
  LOG_TAIL_BYTES,
  LOG_TAIL_LINE_CHARS,
  doctorReport,
  main,
} from "../../src/orchestrator/doctor.mjs";
import { bumpsDeliveryRound } from "../../src/core/domain/status.mjs";
import { DEFAULT_REVIEW_REOPEN_MAX } from "../../src/core/domain/workflow.mjs";
import { parseArgs } from "../../src/orchestrator/options.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-doctor-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

/** Six cards: three in progress (stale / fresh / unreadable), two in review, one todo. */
const TASKS = [
  { identifier: "T-100", title: "Stale claim", status: "in_progress", heartbeat_at: at(31 * MIN) },
  { identifier: "T-101", title: "Healthy claim", status: "in_progress", heartbeat_at: at(5 * MIN) },
  { identifier: "T-102", title: "No heartbeat", status: "in_progress", heartbeat_at: null },
  { identifier: "T-103", title: "Just inside the window", status: "in_progress", heartbeat_at: at(29 * MIN) },
  { identifier: "T-200", title: "Waiting too long", status: "in_review", status_changed_at: at(90 * MIN) },
  { identifier: "T-201", title: "Just delivered", status: "in_review", status_changed_at: at(10 * MIN) },
  {
    identifier: "T-202",
    title: "Reviewer card",
    status: "in_review",
    status_changed_at: at(120 * MIN),
    review_of_id: "orig-200",
  },
  { identifier: "T-300", title: "Queued", status: "todo" },
];

function sentinel(dir, { fail = false, tasks = TASKS } = {}) {
  const record = join(dir, "calls.jsonl");
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "if (process.env.TP_CALLS) appendFileSync(process.env.TP_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      fail
        ? 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "board down" } }));'
        : `process.stdout.write(JSON.stringify({ ok: true, data: { tasks: ${JSON.stringify(tasks)} } }));`,
    ].join("\n"),
  );
  return { script, record };
}

const noUnits = () => ({ status: 1, stdout: "", stderr: "", error: null });

/** A successful child-process result, in the shape every run seam uses. */
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function deps(overrides = {}) {
  return {
    run: noUnits,
    isAlive: () => false,
    now: () => NOW,
    ...overrides,
  };
}

function optsFor(dir, script, extra = []) {
  return parseArgs(
    [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
      ...extra,
    ],
    { HOME: dir },
  );
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function seedState(
  dir,
  { patrolAgeMs = 30 * MIN, cadenceMin = 15, cards, subagents } = {},
) {
  writeJson(join(dir, "cards.queue.json"), {
    version: 1,
    cards: cards ?? [{ status: "pending" }, { status: "processing" }],
  });
  writeJson(join(dir, "subagents.state.json"), {
    version: 1,
    subagents: subagents ?? [{ status: "running" }, { status: "completed" }],
  });
  writeJson(join(dir, "loop-patrol-last-ok.json"), {
    mechanism: "sla",
    last_ok: at(patrolAgeMs),
    cadence_period_min: cadenceMin,
  });
}

function writeLog(dir, count) {
  const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(dir, "supervisor.log"), `${lines.join("\n")}\n`);
  return lines;
}

describe("loop doctor — the report", () => {
  it("reports an accepted producer whose required handoff was never consumed", () => {
    const dir = tempDir();
    const tasks = [
      {
        identifier: "T-400",
        title: "Design",
        status: "done",
        status_changed_at: at(30 * MIN),
        delivery_round: 2,
        meta: { stage_handoff: "required" },
      },
      {
        identifier: "T-401",
        title: "Fresh",
        status: "done",
        status_changed_at: at(1 * MIN),
        delivery_round: 1,
        meta: { stage_handoff: "required" },
      },
      {
        identifier: "T-402",
        title: "Consumed",
        status: "done",
        status_changed_at: at(30 * MIN),
        delivery_round: 1,
        meta: { stage_handoff: "required", handoff_consumed_round: "1" },
      },
      {
        identifier: "T-403",
        title: "Consumed, refs recorded in the value",
        status: "done",
        status_changed_at: at(30 * MIN),
        delivery_round: 1,
        meta: { stage_handoff: "required", handoff_consumed_round: "1 (T-999)" },
      },
    ];
    const { script } = sentinel(dir, { tasks });
    seedState(dir, { cards: [] });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.handoff_unconsumed.map((entry) => entry.ref), ["T-400"]);
    assert.ok(
      report.attention_reasons.some((reason) => /handoff_unconsumed: 1/.test(reason)),
      "the unconsumed handoff is an attention reason",
    );
  });

  it("suppresses the finding while a triage row is still open", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{
        identifier: "T-400",
        title: "Design",
        status: "done",
        status_changed_at: at(30 * MIN),
        delivery_round: 2,
        meta: { stage_handoff: "required" },
      }],
    });
    seedState(dir, {
      cards: [{ status: "pending", queue_kind: "question", triage: true, card: "T-400" }],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.deepEqual(report.handoff_unconsumed, []);
  });

  it("covers every surface in one pass", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeLog(dir, 50);

    // The scan set is discovery, never `--agent` (which names the units): two role
    // skills on this home stand in for the team.
    for (const [skill, agent] of [["jobs", "alice"], ["linus", "bob"]]) {
      const roleDir = join(dir, ".claude", "skills", skill);
      mkdirSync(roleDir, { recursive: true });
      writeFileSync(join(roleDir, "SKILL.md"), `---\nname: ${skill}\n---\n`);
      writeFileSync(
        join(roleDir, "role.json"),
        JSON.stringify({ schema: "meerkat-role", id: skill, agent, lanes: ["worker"] }),
      );
    }
    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.read_only, true);
    assert.equal(report.supervisor.verdict, "absent");
    assert.deepEqual(report.agents, ["alice", "bob"]);

    assert.equal(report.compat, undefined, "the report carries no board-interface verdict");

    assert.equal(report.patrol.age_ms, 30 * MIN);
    assert.equal(report.patrol.cadence_min, 15);
    assert.equal(report.patrol.overdue, false, "30m is inside 3 × 15m");

    assert.equal(report.board.total, TASKS.length);
    assert.equal(report.board.truncated, false);
    assert.equal(report.board.counts.in_progress, 4);
    assert.equal(report.board.counts.in_review, 3);

    assert.equal(report.log.source, "live");
    assert.equal(report.log.lines.length, LOG_TAIL_LINES);
    assert.equal(report.log.lines.at(-1), "line 50");
    assert.equal(report.log.truncated, true);

    assert.equal(report.queue.depth, 2);
    assert.equal(report.queue.pending, 1);
    assert.equal(report.queue.processing, 1);
    assert.equal(report.queue.failed, 0);

    assert.equal(report.subagents.live, 1);
    assert.equal(report.subagents.total, 2);
    assert.deepEqual(report.subagents.by_status, { running: 1, completed: 1 });

    assert.deepEqual(
      report.stuck_cards.in_progress.map((card) => card.ref),
      ["T-100", "T-102"],
      "29 minutes is inside the patrol window, and the unreadable heartbeat is reported, not dropped",
    );
    assert.equal(report.stuck_cards.in_progress[0].threshold_ms, 30 * MIN);
    assert.equal(report.stuck_cards.in_progress[1].reason, "heartbeat-unreadable");
    assert.equal(report.stuck_cards.in_progress[1].detail, "missing");

    assert.deepEqual(
      report.waiting.in_review.map((card) => [card.ref, card.review]),
      [["T-202", true], ["T-200", false], ["T-201", false]],
      "a review card is labelled, not judged — the workflow pass owns review aging",
    );
    assert.equal(report.waiting.in_review[0].age_ms, 120 * MIN);
    assert.equal("aging" in report.waiting.in_review[0], false);
    assert.equal(report.waiting.total, 3);
    assert.equal(report.stuck_cards.total, 2, "only the patrol's heartbeat judgement is 'stuck'");
    assert.deepEqual(report.looping, {
      rework_rounds: [],
      review_reopens: [],
      dispatch_retries: [],
      subagent_failures: [],
      deferrals: [],
      held: [],
      awaiting: [],
      question_lane: [],
      unowned: [],
      orphaned: [],
      total: 0,
    }, "the looping section is always present, and empty when nothing is circling");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.ok, true);
    assert.equal(report.attention, true);
    assert.ok(report.attention_reasons.includes("stuck_cards: 2"));
  });

  it("does not call an epic container a stuck card", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "E-1", title: "Container", kind: "epic", status: "in_progress", heartbeat_at: null },
        { identifier: "T-1", title: "Work", kind: "task", status: "in_progress", heartbeat_at: null },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.stuck_cards.in_progress.map((card) => card.ref),
      ["T-1"],
      "an epic's in_progress is the board's design, not a stale claim",
    );
    assert.equal(report.stuck_cards.total, 1);
  });

  it("reports a stale claim whose handoff rows are all terminal", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", title: "Dead dispatch", status: "in_progress", heartbeat_at: at(600 * MIN) },
        { identifier: "T-2", title: "No row at all", status: "in_progress", heartbeat_at: null },
      ],
    });
    seedState(dir, {
      cards: [
        {
          card: "T-1",
          queue_kind: "handoff",
          status: "failed",
          attempts: 3,
          timeouts: 2,
          retry_at: null,
          lastError: "session is closed",
        },
      ],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.undispatched_claims.cards.map((card) => card.ref),
      ["T-1", "T-2"],
      "a stale claim with no pending/processing handoff row has no dispatcher left",
    );
    const terminal = report.undispatched_claims.cards.find((card) => card.ref === "T-1");
    assert.deepEqual(terminal.queue_row, {
      status: "failed",
      attempts: 3,
      timeouts: 2,
      retry_at: null,
      last_error: "session is closed",
    });
    assert.equal(
      report.undispatched_claims.cards.find((card) => card.ref === "T-2").queue_row,
      null,
      "a card with no queue row at all is still reported",
    );
    assert.equal(report.stuck_cards.total, 2, "the stuck judgement itself is unchanged");
    assert.ok(report.attention_reasons.includes("undispatched_claims: 2"));
  });

  it("shows both the attempt and timeout counters on an undispatched row", async () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-1",
          title: "Timed out",
          status: "in_progress",
          heartbeat_at: at(600 * MIN),
        },
      ],
    });
    seedState(dir, {
      cards: [
        {
          card: "T-1",
          queue_kind: "handoff",
          status: "failed",
          attempts: 0,
          timeouts: 3,
          retry_at: null,
          lastError: "turn timed out after 3600000ms",
        },
      ],
    });

    let out = "";
    const exit = await main(
      [
        "--state", join(dir, "state.json"),
        "--log", join(dir, "supervisor.log"),
        "--config", join(dir, "config.env"),
        "--cli", script,
        "--agent", "alice",
        "--actor-kind", "claude",
        "--home", dir,
      ],
      { HOME: dir },
      deps(),
      { out: (text) => (out += text) },
    );
    assert.equal(exit, 0);
    assert.match(
      out,
      /queue failed after 0 attempt\(s\), 3 timeout\(s\)/,
      "an operator can tell a timeout retry from a delivery retry",
    );
  });

  it("does not report a stale claim that still has a dispatchable handoff row", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-1", title: "Still queued", status: "in_progress", heartbeat_at: at(600 * MIN) }],
    });
    seedState(dir, {
      cards: [{ card: "T-1", queue_kind: "handoff", status: "pending", attempts: 1 }],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.undispatched_claims.total, 0);
    assert.equal(report.stuck_cards.total, 1, "stale is still reported; only the dead-end is not");
  });

  it("calls out an acceptance the board refused: the marker says accepted, the card does not", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-400",
          title: "Approved but unclosable",
          status: "in_review",
          delivery_round: 1,
          status_changed_at: at(90 * MIN),
          meta: { accepted_by: "loop-review", accepted_round: "1" },
        },
        {
          // A marker from an earlier round is history, not a blocked approval.
          identifier: "T-401",
          title: "Marker from round 1",
          status: "in_review",
          delivery_round: 2,
          status_changed_at: at(30 * MIN),
          meta: { accepted_by: "loop-review", accepted_round: "1" },
        },
        { identifier: "T-402", title: "Plain delivery", status: "in_review", meta: {} },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.blocked_acceptance.cards.map((card) => [card.ref, card.round, card.age_ms]),
      [["T-400", 1, 90 * MIN]],
      "only a marker for the card's current round is a blocked acceptance",
    );
    assert.equal(report.blocked_acceptance.total, 1);
    assert.ok(report.attention_reasons.includes("blocked_acceptance: 1"));
    assert.equal(report.stuck_cards.total, 0, "a stray marker is not a stale claim");
  });

  it("does not classify open task cards: the generic layer carries no unclassified probe", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-500", title: "No marker", status: "todo", meta: { acceptance: ["a"] } },
        { identifier: "T-501", title: "Old hint", status: "todo", meta: { product_change: "none" } },
        {
          identifier: "T-502",
          title: "In progress",
          status: "in_progress",
          heartbeat_at: at(5 * MIN),
          meta: {},
        },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(
      report.unclassified,
      undefined,
      "a card with no classification meta is no longer a doctor finding",
    );
    assert.equal(
      report.attention_reasons.some((reason) => reason.startsWith("unclassified")),
      false,
    );
    assert.equal(report.stuck_cards.total, 0);
  });

  it("names a done card whose delivery-round lane never landed, and only when git says it did not", () => {
    const dir = tempDir();
    const projectDir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-500", title: "Landed long ago", status: "done", project_id: "proj" },
        {
          identifier: "T-501",
          title: "Old round worktree still out",
          status: "done",
          project_id: "proj",
          delivery_round: 2,
        },
        {
          identifier: "T-502",
          title: "Old round branch survived cleanup",
          status: "done",
          project_id: "proj",
          delivery_round: 2,
        },
        { identifier: "T-503", title: "Still being worked", status: "in_progress", project_id: "proj" },
        { identifier: "T-504", title: "Delivery round still out", status: "done", project_id: "proj" },
      ],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [{ project: "proj", local_path: projectDir }] });
    // T-501/T-502 were rejected once: only the round-1 record survives, and its
    // branch is still unmerged. The delivery round (2) has no record — it was
    // cleaned after landing.
    writeJson(join(dir, "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          identifier: "T-501",
          round: 1,
          path: join(projectDir, ".worktrees", "T-501"),
          branch: "lane/T-501",
          project_dir: projectDir,
        },
        {
          identifier: "T-502",
          round: 1,
          path: join(projectDir, ".worktrees", "T-502"),
          branch: "lane/T-502",
          project_dir: projectDir,
        },
      ],
    });

    const report = doctorReport(opts, { HOME: dir }, deps({
      git: (cmd, argv) => {
        const key = argv.join(" ");
        if (key.includes("worktree list")) {
          return ok(
            [
              `worktree ${projectDir}`,
              "branch refs/heads/dev",
              "",
              `worktree ${projectDir}/.worktrees/T-500`,
              "branch refs/heads/lane/T-500",
              "",
              `worktree ${projectDir}/.worktrees/T-501`,
              "branch refs/heads/lane/T-501",
              "",
              `worktree ${projectDir}/.worktrees/T-504`,
              "branch refs/heads/lane/T-504",
              "",
            ].join("\n"),
          );
        }
        if (key.includes("branch --no-merged")) {
          return ok("  lane/T-501\n  lane/T-502\n  lane/T-504\n");
        }
        return ok("");
      },
    }));

    assert.deepEqual(
      report.unlanded.cards.map((card) => [card.ref, card.branch, card.path === null ? null : "worktree"]),
      [["T-504", "lane/T-504", "worktree"]],
      "T-500's lane is merged, T-501/T-502's unmerged branches belong to a rejected round, " +
        "and T-503 is not done at all",
    );
    assert.equal(report.unlanded.total, 1);
    assert.ok(report.attention_reasons.includes("unlanded: 1"));
    assert.deepEqual(report.errors, [], "a plain finding is not an error");
  });

  it("does not report an unmerged old round when the delivery round's record was cleaned", () => {
    const dir = tempDir();
    const projectDir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-700",
          title: "Old round record only",
          status: "done",
          project_id: "proj",
          delivery_round: 2,
        },
        {
          identifier: "T-701",
          title: "Both rounds recorded",
          status: "done",
          project_id: "proj",
          delivery_round: 2,
        },
      ],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [{ project: "proj", local_path: projectDir }] });
    writeJson(join(dir, "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          identifier: "T-700",
          round: 1,
          path: join(projectDir, ".worktrees", "T-700"),
          branch: "lane/T-700",
          project_dir: projectDir,
        },
        {
          identifier: "T-701",
          round: 1,
          path: join(projectDir, ".worktrees", "T-701"),
          branch: "lane/T-701",
          project_dir: projectDir,
        },
        {
          identifier: "T-701",
          round: 2,
          path: join(projectDir, ".worktrees", "T-701-r2"),
          branch: "lane/T-701-r2",
          project_dir: projectDir,
        },
      ],
    });

    const report = doctorReport(opts, { HOME: dir }, deps({
      git: (cmd, argv) => {
        const key = argv.join(" ");
        if (key.includes("worktree list")) {
          return ok(
            [
              `worktree ${projectDir}`,
              "branch refs/heads/dev",
              "",
              `worktree ${projectDir}/.worktrees/T-700`,
              "branch refs/heads/lane/T-700",
              "",
              `worktree ${projectDir}/.worktrees/T-701`,
              "branch refs/heads/lane/T-701",
              "",
              `worktree ${projectDir}/.worktrees/T-701-r2`,
              "branch refs/heads/lane/T-701-r2",
              "",
            ].join("\n"),
          );
        }
        if (key.includes("branch --no-merged")) {
          return ok("  lane/T-700\n  lane/T-701\n");
        }
        return ok("");
      },
    }));

    assert.deepEqual(
      report.unlanded.cards.map((card) => [card.ref, card.branch]),
      [],
      "T-700's delivery-round record is gone (landed); T-701's round-2 lane is merged",
    );
    assert.equal(report.unlanded.total, 0);
    assert.equal(
      report.attention_reasons.some((reason) => reason.startsWith("unlanded")),
      false,
    );
  });

  it("treats a landed_sha that is an ancestor of HEAD as landed", () => {
    const dir = tempDir();
    const projectDir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-710",
          title: "Landed by cherry-pick",
          status: "done",
          project_id: "proj",
          delivery_round: 1,
          meta: { landed_sha: "aaaa1111" },
        },
        {
          identifier: "T-711",
          title: "Recorded sha is not in HEAD",
          status: "done",
          project_id: "proj",
          delivery_round: 1,
          meta: { landed_sha: "bbbb2222" },
        },
      ],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [{ project: "proj", local_path: projectDir }] });

    const report = doctorReport(opts, { HOME: dir }, deps({
      git: (cmd, argv) => {
        const key = argv.join(" ");
        if (key.includes("merge-base --is-ancestor")) {
          return argv.includes("aaaa1111") ? ok("") : { status: 1, stdout: "", stderr: "" };
        }
        if (key.includes("worktree list")) {
          return ok(
            [
              `worktree ${projectDir}`,
              "branch refs/heads/dev",
              "",
              `worktree ${projectDir}/.worktrees/T-710`,
              "branch refs/heads/lane/T-710",
              "",
              `worktree ${projectDir}/.worktrees/T-711`,
              "branch refs/heads/lane/T-711",
              "",
            ].join("\n"),
          );
        }
        if (key.includes("branch --no-merged")) {
          return ok("  lane/T-710\n  lane/T-711\n");
        }
        return ok("");
      },
    }));

    assert.deepEqual(
      report.unlanded.cards.map((card) => [card.ref, card.branch, card.path === null ? null : "worktree"]),
      [["T-711", "lane/T-711", "worktree"]],
      "T-710's landed_sha is in HEAD; T-711's is not, so its lane is still judged",
    );
  });

  it("reports the delivery round when its own lane is still unmerged", () => {
    const dir = tempDir();
    const projectDir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-720",
          title: "Third round still out",
          status: "done",
          project_id: "proj",
          delivery_round: 3,
        },
      ],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [{ project: "proj", local_path: projectDir }] });
    writeJson(join(dir, "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          identifier: "T-720",
          round: 2,
          path: join(projectDir, ".worktrees", "T-720-r2"),
          branch: "lane/T-720-r2",
          project_dir: projectDir,
        },
        {
          identifier: "T-720",
          round: 3,
          path: join(projectDir, ".worktrees", "T-720-r3"),
          branch: "lane/T-720-r3",
          project_dir: projectDir,
        },
      ],
    });

    const report = doctorReport(opts, { HOME: dir }, deps({
      git: (cmd, argv) => {
        const key = argv.join(" ");
        if (key.includes("worktree list")) {
          return ok(
            [
              `worktree ${projectDir}`,
              "branch refs/heads/dev",
              "",
              `worktree ${projectDir}/.worktrees/T-720-r2`,
              "branch refs/heads/lane/T-720-r2",
              "",
              `worktree ${projectDir}/.worktrees/T-720-r3`,
              "branch refs/heads/lane/T-720-r3",
              "",
            ].join("\n"),
          );
        }
        if (key.includes("branch --no-merged")) {
          return ok("  lane/T-720-r2\n  lane/T-720-r3\n");
        }
        return ok("");
      },
    }));

    assert.deepEqual(report.unlanded.cards, [
      {
        ref: "T-720",
        title: "Third round still out",
        branch: "lane/T-720-r3",
        path: join(projectDir, ".worktrees", "T-720-r3"),
      },
    ]);
    assert.equal(report.unlanded.total, 1);
  });

  it("skips a project the map cannot resolve instead of failing the report", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-600", title: "Elsewhere", status: "done", project_id: "missing" }],
    });
    seedState(dir);

    const opts = optsFor(dir, script);
    opts.projectsJson = join(dir, "projects.json");
    writeJson(opts.projectsJson, { projects: [] });

    const report = doctorReport(opts, { HOME: dir }, deps({ git: () => ok("") }));

    assert.equal(report.unlanded.total, 0);
    assert.ok(
      report.skipped.some((line) => /unlanded: missing/.test(line)),
      `the unreadable project is named as skipped: ${JSON.stringify(report.skipped)}`,
    );
    assert.deepEqual(report.errors, []);
  });

  it("keeps in_review as facts: the review-aging setting does not judge them", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);

    // `--review-aging-minutes` is accepted (it is a shared loop flag) but it is
    // the *workflow* pass's threshold. Applying it here would report every
    // delivery waiting for acceptance as an aged review card.
    const report = doctorReport(
      optsFor(dir, script, ["--review-aging-minutes", "5"]),
      { HOME: dir },
      deps(),
    );

    assert.equal(report.waiting.total, 3);
    for (const card of report.waiting.in_review) {
      assert.equal("aging" in card, false);
      assert.equal("threshold_ms" in card, false);
    }
    assert.equal(
      report.attention_reasons.some((reason) => /aging/.test(reason)),
      false,
    );
  });

  it("calls an overdue patrol marker out, and only when a cadence is declared", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir, { patrolAgeMs: 60 * MIN, cadenceMin: 15 });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.patrol.overdue, true, "60m is outside 3 × 15m");
    assert.ok(report.attention_reasons.includes("patrol: marker overdue"));

    writeJson(join(dir, "loop-patrol-last-ok.json"), { mechanism: "sla", last_ok: at(600 * MIN) });
    const undeclared = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(undeclared.patrol.overdue, null, "no cadence, no invented threshold");
    assert.equal(
      undeclared.attention_reasons.includes("patrol: marker overdue"),
      false,
    );
  });

  it("keeps the report complete when the board cannot be read", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, { fail: true });
    seedState(dir);
    writeLog(dir, 3);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.ok, false);
    assert.match(report.errors[0], /^board: board down/);
    assert.equal(report.queue.depth, 2, "the local checks still run");
    assert.equal(report.log.lines.length, 3);
    assert.equal(report.stuck_cards.total, 0);
    assert.equal(report.board.total, 0);
    assert.equal(report.attention, true);
  });

  it("never asks the board what version it is", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir);
    seedState(dir);

    process.env.TP_CALLS = record;
    try {
      doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    } finally {
      delete process.env.TP_CALLS;
    }

    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.length > 0, "the doctor still reads the board");
    assert.deepEqual(
      calls.filter((args) => args.includes("--version")),
      [],
      "the retired board-interface gate must not leave a version probe behind",
    );
  });
});

describe("loop doctor — the loop thresholds", () => {
  it("mirrors the review-reopen bound and the round-bump rule", () => {
    assert.equal(LOOP_REVIEW_REOPEN_MIN, DEFAULT_REVIEW_REOPEN_MAX);
    assert.equal(LOOP_REVIEW_ROUND_MIN, LOOP_REVIEW_REOPEN_MIN + 1);
    assert.equal(bumpsDeliveryRound("in_review", "in_progress"), true);
    assert.equal(bumpsDeliveryRound("in_review", "blocked"), true);
    assert.equal(bumpsDeliveryRound("done", "todo"), true);
    assert.equal(bumpsDeliveryRound("in_progress", "in_review"), false);
    assert.equal(LOOP_REWORK_ROUND_MIN, 4);
    assert.equal(LOOP_DISPATCH_ROWS_MIN, 5);
    assert.equal(LOOP_DISPATCH_FAILED_MIN, 2);
    assert.equal(LOOP_SUBAGENT_FAILED_MIN, 3);
  });
});

describe("loop doctor — looping cards", () => {
  it("flags a card whose delivery rounds keep coming back", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-701",
          title: "Round five",
          status: "todo",
          delivery_round: 5,
          status_changed_at: at(90 * MIN),
        },
        {
          identifier: "T-700",
          title: "Round four",
          status: "in_progress",
          delivery_round: 4,
          heartbeat_at: at(5 * MIN),
        },
        {
          identifier: "E-1",
          title: "Epic round four",
          kind: "epic",
          status: "in_progress",
          delivery_round: 4,
        },
        { identifier: "T-702", title: "Done at four", status: "done", delivery_round: 4 },
        {
          identifier: "R-9",
          title: "Review own two",
          status: "in_review",
          delivery_round: 2,
          review_of_id: "orig-9",
          review_round: 1,
        },
        { identifier: "T-704", title: "Round three", status: "todo", delivery_round: 3 },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.looping.rework_rounds.map((card) => [card.ref, card.round]),
      [
        ["T-701", 5],
        ["E-1", 4],
        ["T-700", 4],
      ],
      "terminal cards, review cards and round 3 are not rework loops",
    );
    assert.equal(report.looping.rework_rounds[0].age_ms, 90 * MIN);
    assert.equal(report.looping.rework_rounds[0].since, at(90 * MIN));
    assert.equal(report.looping.rework_rounds[1].kind, "epic", "a rejected container is still a loop");
    assert.deepEqual(report.looping.review_reopens, [], "a review card is never counted as rework");
    assert.equal(report.looping.total, 3);
    assert.ok(report.attention_reasons.includes("looping: 3"));
    assert.equal(report.ok, true, "a looping finding is not an error");
  });

  it("flags a review card the loop re-dispatched to exhaustion", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { id: "id-900", identifier: "T-900", title: "Original", status: "in_review", delivery_round: 3 },
        {
          identifier: "R-1",
          title: "Retry two",
          status: "in_review",
          delivery_round: 1,
          review_of_id: "id-900",
          review_round: 1,
          meta: { review_retry: 2 },
        },
        {
          identifier: "R-2",
          title: "Retry one",
          status: "in_review",
          delivery_round: 2,
          review_of_id: "id-900",
          review_round: 1,
          meta: { review_retry: "1" },
        },
        {
          identifier: "R-3",
          title: "Round three",
          status: "todo",
          delivery_round: 3,
          review_of_id: "id-900",
          review_round: 1,
        },
        {
          identifier: "R-4",
          title: "Done at three",
          status: "done",
          delivery_round: 3,
          review_of_id: "id-900",
          review_round: 1,
        },
        {
          identifier: "R-5",
          title: "Legacy review",
          status: "in_review",
          delivery_round: 3,
          meta: { review_of: "T-900" },
        },
      ],
    });
    seedState(dir);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.looping.review_reopens.map((card) => [
        card.ref,
        card.retries,
        card.own_round,
        card.audited_round,
        card.original,
      ]),
      [
        ["R-1", 2, 1, 1, "T-900"],
        ["R-3", 0, 3, 1, "T-900"],
        ["R-5", 0, 3, null, "T-900"],
      ],
      "the retry marker and the review card's own round are two readings of the same reopens",
    );
    assert.equal(report.looping.total, 3);
    assert.equal(report.looping.rework_rounds.length, 0);
  });

  it("flags a dispatch retry loop from accumulated handoff rows", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-1",
          title: "One",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
        { identifier: "T-2", title: "Two", status: "in_review", delivery_round: 1 },
        {
          identifier: "T-3",
          title: "Three",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
        { identifier: "T-5", title: "Five", status: "done", delivery_round: 1 },
      ],
    });
    seedState(dir, {
      cards: [
        { card: "T-1", status: "done" },
        { card: "T-1", status: "failed", attempts: 3, lastError: "old" },
        { card: "T-1", status: "done" },
        { card: "T-1", status: "failed", attempts: 3, lastError: "attempt cap hit" },
        { card: "T-1", status: "done" },
        { card: "T-2", status: "failed", attempts: 3, lastError: "a" },
        { card: "T-2", status: "failed", attempts: 3, lastError: "b" },
        { card: "T-3", status: "done" },
        { card: "T-3", status: "done" },
        { card: "T-3", status: "done" },
        { card: "T-3", status: "done" },
        ...Array.from({ length: 5 }, () => ({
          card: "T-4",
          status: "failed",
          queue_kind: "question",
        })),
        ...Array.from({ length: 3 }, () => ({ status: "failed" })),
        ...Array.from({ length: 5 }, () => ({ card: "T-5", status: "done" })),
      ],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.looping.dispatch_retries.map((card) => [
        card.ref,
        card.rows,
        card.failed,
        card.last_status,
        card.last_error,
      ]),
      [
        ["T-1", 5, 2, "done", "attempt cap hit"],
        ["T-2", 2, 2, "failed", "b"],
      ],
      "question rows, unattributed rows and finished cards are not dispatch loops",
    );
    assert.equal(
      report.queue.failed,
      2 + 2 + 5 + 3,
      "the aggregate still counts question and unattributed rows",
    );
    assert.ok(
      report.attention_reasons.includes("looping: 3"),
      "question rows are their own list now, so T-4 is a third looping card",
    );
  });

  it("flags a subagent failure loop from the ledger", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-1",
          title: "One",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
        {
          identifier: "T-2",
          title: "Two",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
        { identifier: "T-3", title: "Three", status: "done", delivery_round: 1 },
      ],
    });
    seedState(dir, {
      subagents: [
        { card: "T-1", status: "failed", lastResult: "first", lastSeenAt: at(50 * MIN) },
        { card: "T-1", status: "interrupted", lastResult: "second", lastSeenAt: at(40 * MIN) },
        { card: "T-1", status: "stale", lastResult: "third", lastSeenAt: at(30 * MIN) },
        { card: "T-1", status: "running", lastSeenAt: at(20 * MIN) },
        { card: "T-2", status: "failed", lastResult: "x", lastSeenAt: at(10 * MIN) },
        { card: "T-2", status: "completed", lastResult: "y", lastSeenAt: at(5 * MIN) },
        ...Array.from({ length: 3 }, () => ({ card: "T-3", status: "failed" })),
        ...Array.from({ length: 3 }, () => ({ card: null, status: "failed" })),
      ],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(
      report.looping.subagent_failures.map((card) => [
        card.ref,
        card.failures,
        card.statuses,
        card.last_result,
        card.last_seen_at,
      ]),
      [["T-1", 3, { failed: 1, interrupted: 1, stale: 1 }, "third", at(30 * MIN)]],
      "only terminal failures count; a live row is not a failure",
    );
    assert.equal(report.looping.total, 1);
  });

  it("counts a card once when two kinds name it", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-700",
          title: "Both",
          status: "in_progress",
          delivery_round: 4,
          heartbeat_at: at(5 * MIN),
        },
      ],
    });
    seedState(dir, {
      cards: Array.from({ length: 5 }, () => ({ card: "T-700", status: "done" })),
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.looping.rework_rounds.map((card) => card.ref), ["T-700"]);
    assert.deepEqual(report.looping.dispatch_retries.map((card) => card.ref), ["T-700"]);
    assert.equal(report.looping.total, 1, "the attention total is distinct cards");
    assert.ok(report.attention_reasons.includes("looping: 1"));
  });

  it("keeps the local loop halves when the board cannot be read", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, { fail: true });
    seedState(dir, {
      cards: Array.from({ length: 5 }, () => ({ card: "T-Q", status: "done" })),
      subagents: [
        { card: "T-L", status: "failed" },
        { card: "T-L", status: "failed" },
        { card: "T-L", status: "stale" },
      ],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.looping.rework_rounds, []);
    assert.deepEqual(report.looping.review_reopens, []);
    assert.deepEqual(report.looping.dispatch_retries.map((card) => card.ref), ["T-Q"]);
    assert.deepEqual(report.looping.subagent_failures.map((card) => card.ref), ["T-L"]);
    assert.equal(report.looping.total, 2);
    assert.match(report.errors[0], /^board:/);
    assert.equal(report.ok, false);
    assert.ok(report.attention_reasons.includes("looping: 2"));
  });

  it("reports nothing at the thresholds' edge", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", title: "Three", status: "todo", delivery_round: 3 },
        {
          identifier: "R-1",
          title: "Retry one",
          status: "in_review",
          delivery_round: 2,
          review_of_id: "x",
          meta: { review_retry: "1" },
        },
        {
          identifier: "R-2",
          title: "Garbage retry",
          status: "in_review",
          delivery_round: 2,
          review_of_id: "x",
          meta: { review_retry: "not-a-number" },
        },
      ],
    });
    seedState(dir, {
      cards: [
        { card: "T-1", status: "done" },
        { card: "T-1", status: "done" },
        { card: "T-1", status: "failed" },
        { card: "T-1", status: "done" },
      ],
      subagents: [
        { card: "T-1", status: "failed" },
        { card: "T-1", status: "failed" },
      ],
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.looping, {
      rework_rounds: [],
      review_reopens: [],
      dispatch_retries: [],
      subagent_failures: [],
      deferrals: [],
      held: [],
      awaiting: [],
      question_lane: [],
      unowned: [],
      orphaned: [],
      total: 0,
    });
    assert.equal(report.attention_reasons.some((reason) => reason.startsWith("looping")), false);
  });
});

describe("loop doctor — the log tail", () => {
  it("falls back to the rotated generation, and calls a missing log missing", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeFileSync(join(dir, "supervisor.log.1"), "old 1\nold 2\n");

    const rotated = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(rotated.log.source, "rotated");
    assert.deepEqual(rotated.log.lines, ["old 1", "old 2"]);
    assert.equal(rotated.log.truncated, false);

    rmSync(join(dir, "supervisor.log.1"));
    const missing = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(missing.log.missing, true);
    assert.equal(missing.log.source, "missing");
    assert.deepEqual(missing.log.lines, []);
    assert.deepEqual(missing.errors, [], "a log that was never written is not an error");
    assert.equal(missing.ok, true);
  });

  it("caps a long line so one embedded message cannot crowd out the report", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    // The live log carries whole assistant messages inside `msg="…"`.
    writeFileSync(join(dir, "supervisor.log"), `short line\n${"x".repeat(500)}\n`);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.equal(report.log.lines[0], "short line");
    assert.equal(report.log.lines[1].length, LOG_TAIL_LINE_CHARS + 1);
    assert.match(report.log.lines[1], /x…$/);
  });

  it("reads a bounded tail rather than the whole file", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    // One line far longer than the byte cap: the read must not pull it all in.
    writeFileSync(join(dir, "supervisor.log"), `${"x".repeat(LOG_TAIL_BYTES * 2)}\ntail 1\ntail 2\n`);

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());

    assert.deepEqual(report.log.lines, ["tail 1", "tail 2"]);
    assert.equal(report.log.truncated, true);
  });
});

describe("loop doctor — read-only", () => {
  it("issues no board write, and leaves the state directory alone", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir);
    // A looping shape too: the new judgement must read the same files without
    // writing a byte of its own state.
    seedState(dir, {
      cards: Array.from({ length: 5 }, () => ({ card: "T-100", status: "done" })),
      subagents: Array.from({ length: 3 }, () => ({ card: "T-100", status: "failed" })),
    });
    writeLog(dir, 5);

    const before = ["cards.queue.json", "subagents.state.json", "loop-patrol-last-ok.json", "supervisor.log"]
      .map((name) => readFileSync(join(dir, name), "utf8"));

    process.env.TP_CALLS = record;
    let report;
    try {
      report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    } finally {
      delete process.env.TP_CALLS;
    }
    assert.equal(report.looping.total, 1, "the loop-shaped rows were actually judged");

    const after = ["cards.queue.json", "subagents.state.json", "loop-patrol-last-ok.json", "supervisor.log"]
      .map((name) => readFileSync(join(dir, name), "utf8"));
    assert.deepEqual(after, before, "the inspection writes nothing to its own state");

    const calls = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    const writes = calls.filter((args) => /\b(move|claim|deliver|add|update|create)\b/.test(args.join(" ")));
    assert.deepEqual(writes, [], "the doctor never writes to the board");
    for (const args of calls) {
      assert.equal(args.includes("issue") && args.includes("list"), true, `unexpected board call: ${args.join(" ")}`);
    }
  });
});

describe("loop doctor — the process boundary", () => {
  it("emits the raw report with --json and a digest without it", async () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeLog(dir, 2);
    const argv = [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
    ];

    let out = "";
    const exit = await main([...argv, "--json"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(exit, 0);
    const report = JSON.parse(out);
    assert.equal(report.read_only, true);
    assert.equal(report.ok, true);
    assert.equal(report.data, undefined, "the loop's verbs print their own JSON, not the envelope");

    out = "";
    const textExit = await main(argv, { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(textExit, 0);
    assert.match(out, /supervisor\s+absent/);
    assert.match(out, /patrol\s+last_ok 2025-12-31T23:30:00.000Z \(30m ago, cadence 15m\)/);
    assert.match(out, /stuck\s+2 card\(s\): 2 in_progress/);
    assert.match(out, /looping\s+0 card\(s\)/);
    assert.match(out, /T-100  in_progress  stale 31m > 30m  Stale claim/);
    assert.match(out, /waiting\s+3 in_review \(oldest 120m\)/);
    assert.match(out, /T-202  in_review  120m  \[review\]  Reviewer card/);
    assert.match(out, /T-200  in_review  90m  Waiting too long/);
    assert.match(out, /queue\s+depth 2/);

    out = "";
    const helpExit = await main(["--help"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(helpExit, 0);
    assert.match(out, /^Usage: taskctl loop doctor/);
  });

  it("renders the looping block and caps its free text on one line", async () => {
    const dir = tempDir();
    const long = "x".repeat(LOG_TAIL_LINE_CHARS * 2);
    const { script } = sentinel(dir, {
      tasks: [
        {
          identifier: "T-700",
          title: "Both",
          status: "in_progress",
          delivery_round: 4,
          heartbeat_at: at(5 * MIN),
        },
        {
          identifier: "E-1",
          title: "Rejected container",
          kind: "epic",
          status: "in_progress",
          delivery_round: 4,
        },
        {
          identifier: "R-1",
          title: "Retry",
          status: "in_review",
          delivery_round: 1,
          review_of_id: "x",
          meta: { review_retry: "2" },
        },
        {
          identifier: "T-D",
          title: "Dispatch",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
        {
          identifier: "T-L",
          title: "Ledger",
          status: "in_progress",
          delivery_round: 1,
          heartbeat_at: at(5 * MIN),
        },
      ],
    });
    seedState(dir, {
      cards: [
        ...Array.from({ length: 5 }, () => ({ card: "T-700", status: "done" })),
        { card: "T-D", status: "failed", attempts: 3, lastError: long },
        { card: "T-D", status: "failed", attempts: 3, lastError: long },
      ],
      subagents: Array.from({ length: 3 }, () => ({ card: "T-L", status: "failed" })),
    });
    const argv = [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
    ];

    let out = "";
    const exit = await main(argv, { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(exit, 0);
    assert.match(out, /looping\s+5 card\(s\)/);
    assert.match(out, /T-700  rework  round 4/);
    assert.match(out, /E-1  rework  round 4.*\[epic\]/);
    assert.match(out, /R-1  review-reopen  retries 2/);
    assert.match(out, /T-D  dispatch  2 handoff\(s\) \(2 failed, last failed\)/);
    assert.match(out, /T-L  subagent  3 failure\(s\)/);
    assert.match(out, /a card can appear in more than one list/);
    assert.equal(out.includes(long), false, "the human page caps free text");

    out = "";
    await main([...argv, "--json"], { HOME: dir }, deps(), { out: (text) => (out += text) });
    assert.equal(
      JSON.parse(out).looping.dispatch_retries[0].last_error,
      long,
      "the JSON keeps the raw value",
    );
  });
});

describe("loop doctor — deferred admission and stale workspaces", () => {
  it("flags a card whose admission keeps failing", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-800", title: "Deferred card", status: "todo" }],
    });
    seedState(dir);
    writeJson(join(dir, "deferrals.json"), {
      version: 1,
      cards: {
        "T-800": {
          identifier: "T-800",
          round: 2,
          count: 4,
          first_at: at(40 * MIN),
          last_at: at(5 * MIN),
          code: "WORKSPACE_CREATE_FAILED",
          reason: "invalid reference: lane/T-800-r2",
        },
      },
    });
    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.deepEqual(
      report.looping.deferrals.map((card) => [card.ref, card.count, card.code]),
      [["T-800", 4, "WORKSPACE_CREATE_FAILED"]],
    );
    assert.equal(report.looping.total, 1);
    assert.ok(report.attention_reasons.includes("looping: 1"));
    assert.equal(report.ok, true, "a deferral finding is not an error");
  });

  it("does not flag a deferral below the threshold", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-801", title: "Transient", status: "todo" }],
    });
    seedState(dir);
    writeJson(join(dir, "deferrals.json"), {
      version: 1,
      cards: {
        "T-801": {
          identifier: "T-801",
          count: 2,
          first_at: at(20 * MIN),
          last_at: at(5 * MIN),
          code: "X",
          reason: "x",
        },
      },
    });
    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.deepEqual(report.looping.deferrals, []);
    assert.equal(report.ok, true);
  });

  it("treats a corrupt ledger as an error but keeps reporting", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeFileSync(join(dir, "deferrals.json"), "{not json");
    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.deepEqual(report.looping.deferrals, []);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((line) => line.startsWith("deferrals:")));
  });

  function staleFixture({ status = "todo", probe = 1 } = {}) {
    const dir = tempDir();
    const app = join(dir, "app");
    mkdirSync(join(app, ".git"), { recursive: true });
    const { script } = sentinel(dir, {
      tasks: [{ identifier: "T-810", title: "Stale record", status }],
    });
    seedState(dir);
    writeJson(join(dir, "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          identifier: "T-810",
          round: 1,
          path: join(app, ".worktrees", "T-810"),
          branch: "lane/T-810",
          project_dir: app,
        },
      ],
    });
    const git = (cmd, argv) => {
      const key = argv.join(" ");
      if (key.includes("rev-parse --verify --quiet")) {
        return { status: probe, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { dir, script, git };
  }

  it("names a stale workspace record for a non-terminal card", () => {
    const f = staleFixture();
    const report = doctorReport(optsFor(f.dir, f.script), { HOME: f.dir }, deps({ git: f.git }));
    assert.deepEqual(report.workspaces.stale.map((record) => record.ref), ["T-810"]);
    assert.ok(report.attention_reasons.includes("stale_workspaces: 1"));
  });

  it("does not call a terminal card's record stale", () => {
    const f = staleFixture({ status: "done" });
    const report = doctorReport(optsFor(f.dir, f.script), { HOME: f.dir }, deps({ git: f.git }));
    assert.deepEqual(report.workspaces.stale, []);
  });

  it("keeps a record when git cannot probe the branch", () => {
    const f = staleFixture({ probe: 128 });
    const report = doctorReport(optsFor(f.dir, f.script), { HOME: f.dir }, deps({ git: f.git }));
    assert.deepEqual(report.workspaces.stale, [], "a git failure is not evidence of absence");
  });
});

describe("loop doctor — worker sessions", () => {
  it("reports blocked/stale worker sessions and a missing worktree", () => {
    const dir = tempDir();
    const { script } = sentinel(dir);
    seedState(dir);
    writeJson(join(dir, "sessions.state.json"), {
      version: 3,
        projects: {
        "worker:T-900:r1": {
          kind: "worker-session",
          card: "T-900",
          round: 1,
          worktree: join(dir, "gone"),
          sessionId: "sid-1",
          status: "stale",
          blocked: true,
          resumeState: "stale",
          lastError: "replay failed",
        },
      },
    });
    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps());
    assert.equal(report.workers.total, 1);
    assert.equal(report.workers.by_status.stale, 1);
    assert.equal(report.workers.blocked.length, 1);
    assert.equal(report.workers.stale.length, 1);
    assert.equal(report.workers.missing_worktree.length, 1);
    assert.ok(report.attention_reasons.includes("workers: 1"));
    assert.ok(report.attention_reasons.includes("worker_worktrees: 1"));
  });
});

describe("loop doctor — the human queue and the loop's dead ends", () => {
  it("reports awaiting, unowned, a failed director row and an orphaned child", () => {
    const dir = tempDir();
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    const tasks = [
      {
        identifier: "T-400",
        title: "Waiting on a human",
        status: "awaiting",
        awaiting_reason: "E2",
        status_changed_at: at(60 * MIN),
      },
      {
        identifier: "T-401",
        title: "Nobody owns this",
        status: "todo",
        kind: "task",
        created_at: at(45 * MIN),
      },
      { identifier: "T-402", title: "Fine", status: "in_review", status_changed_at: at(5 * MIN) },
      { identifier: "R-403", title: "Review", status: "in_review", status_changed_at: at(5 * MIN) },
    ];
    const { script } = sentinel(dir, { tasks });
    writeJson(join(dir, "cards.queue.json"), {
      version: 1,
      cards: [
        {
          id: "question:T-402:q-1",
          card: "T-402",
          role: "question",
          queue_kind: "question",
          status: "failed",
          attempts: 2,
          lastError: "director turn did not settle the question",
          enqueuedAt: at(20 * MIN),
        },
        {
          id: "T-402-worker",
          card: "T-402",
          role: "worker",
          queue_kind: "handoff",
          status: "processing",
          target_dir: app,
          enqueuedAt: at(180 * MIN),
        },
        {
          id: "R-403-reviewer",
          card: "R-403",
          role: "reviewer",
          queue_kind: "handoff",
          status: "processing",
          target_dir: app,
          enqueuedAt: at(180 * MIN),
        },
      ],
    });
    writeJson(join(dir, "subagents.state.json"), { version: 1, subagents: [] });
    writeJson(join(dir, "sessions.state.json"), {
      version: 2,
      projects: {
        "worker:T-402:r1": {
          kind: "worker-session",
          card: "T-402",
          cwd: app,
          pid: process.pid,
          startedAt: at(180 * MIN),
          status: "running",
        },
        "worker:R-403:r1": {
          kind: "worker-session",
          role: "reviewer",
          card: "R-403",
          cwd: app,
          pid: process.pid,
          startedAt: at(180 * MIN),
          status: "running",
        },
      },
    });
    writeJson(join(dir, "loop-patrol-last-ok.json"), {
      mechanism: "sla",
      last_ok: at(5 * MIN),
      cadence_period_min: 15,
    });

    const report = doctorReport(optsFor(dir, script), { HOME: dir }, deps({ isAlive: () => true }));

    assert.equal(report.looping.awaiting[0].ref, "T-400");
    assert.equal(report.looping.awaiting[0].reason, "E2");
    assert.equal(report.looping.unowned[0].ref, "T-401");
    assert.equal(report.looping.question_lane[0].ref, "T-402");
    assert.equal(report.looping.question_lane[0].lane, "question");
    assert.equal(report.looping.question_lane[0].rows, 1);
    const staleWorker = report.looping.orphaned.find((row) => row.ref === "T-402");
    assert.ok(staleWorker);
    assert.equal(staleWorker.pid, process.pid);
    assert.equal(staleWorker.bound_ms, 2 * 60 * MIN);
    assert.ok(
      report.looping.orphaned.some((row) => row.ref === "R-403"),
      "a stale review handoff is the same finding as a stale worker one",
    );
    assert.equal(report.looping.total, 4, "T-402 is one card even in two lists");
  });
});
