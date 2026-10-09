/**
 * Step 12: `issue` without `deliver` (A1/A5).
 *
 * `deliver` has its own file (`deliver.test.mjs`) because it is the milestone's
 * centre of gravity; everything else about a task lives here.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A board with one project. */
async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    return fn(ctx);
  });
}

const createIssue = (run, extra = []) =>
  dataOf(run(["issue", "create", "--project", "demo", "--title", "Ship M2", ...extra, "--json"]));

describe("cli/issue — create, list, get", () => {
  it("creates a task with acceptance criteria and a free-text assignee", async () => {
    await board(async ({ run }) => {
      const created = createIssue(run, [
        "--acceptance", "cli works",
        "--acceptance", "gate visible",
        "--assignee", "linus",
        "--assignee-kind", "agent",
        "--priority", "high",
        "--label", "m2",
      ]);
      assert.equal(created.task.identifier, "DEMO-0001");
      assert.equal(created.task.status, "todo");
      assert.deepEqual(created.task.meta.acceptance, ["cli works", "gate visible"]);
      assert.equal(created.task.assignee.display_name, "linus");
      assert.equal(typeof created.task.assignee.id, "string");
      assert.deepEqual(created.task.labels, ["m2"]);
      assert.equal(created.task.priority, "high");
    });
  });

  it("lists with filters, and prints one line per task", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      createIssue(run, ["--title", "Second", "--status", "blocked"]);

      const all = dataOf(run(["issue", "list", "--json"]));
      assert.equal(all.tasks.length, 2);

      const filtered = dataOf(run(["issue", "list", "--status", "blocked", "--json"]));
      assert.deepEqual(filtered.tasks.map((t) => t.title), ["Second"]);

      const two = dataOf(run(["issue", "list", "--status", "todo", "--status", "blocked", "--json"]));
      assert.equal(two.tasks.length, 2);

      const limited = dataOf(run(["issue", "list", "--limit", "1", "--json"]));
      assert.equal(limited.tasks.length, 1);

      const human = run(["issue", "list"]);
      assert.match(human.stdout, /DEMO-0001\s+todo\s+medium/);
    });
  });

  it("gets a task by identifier and by id, and reports a miss as NOT_FOUND", async () => {
    await board(async ({ run }) => {
      const created = createIssue(run);
      const byIdentifier = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(byIdentifier.task.id, created.task.id);
      assert.deepEqual(byIdentifier.report_waivers, []);

      const byId = dataOf(run(["issue", "get", created.task.id, "--json"]));
      assert.equal(byId.task.identifier, "DEMO-0001");

      const missing = run(["issue", "get", "NOPE-9999", "--json"]);
      assert.equal(missing.status, 1);
      assert.equal(JSON.parse(missing.stdout).error.code, "NOT_FOUND");
    });
  });

  it("re-uses the existing card for a repeated --idem, and --allow-dup overrides it", async () => {
    await board(async ({ run }) => {
      const first = createIssue(run, ["--idem", "k-cli-1"]);
      const again = createIssue(run, ["--idem", "k-cli-1", "--title", "Retry"]);
      assert.equal(again.task.id, first.task.id);
      assert.equal(again.task.identifier, first.task.identifier);

      const dup = createIssue(run, ["--idem", "k-cli-1", "--allow-dup"]);
      assert.notEqual(dup.task.id, first.task.id);

      const all = dataOf(run(["issue", "list", "--json"]));
      assert.equal(all.tasks.length, 2, "the reuse wrote nothing; the dup added one");
    });
  });
});

describe("cli/issue — update, move, assign, archive", () => {
  it("updates metadata and acceptance, and refuses an empty update locally", async () => {
    await board(async ({ run }) => {
      createIssue(run);

      const updated = dataOf(run(["issue", "update", "DEMO-0001", "--acceptance", "a", "--acceptance", "b", "--json"]));
      assert.deepEqual(updated.task.meta.acceptance, ["a", "b"]);

      const merged = dataOf(run(["issue", "update", "DEMO-0001", "--meta", "team=panel", "--json"]));
      assert.equal(merged.task.meta.team, "panel");
      assert.deepEqual(merged.task.meta.acceptance, ["a", "b"], "meta merge keeps what was there");

      const nothing = run(["issue", "update", "DEMO-0001"]);
      assert.equal(nothing.status, 0, "nothing to do is not an error");
      assert.equal(nothing.stdout, "");
      assert.match(nothing.stderr, /nothing to update/);
    });
  });

  it("never lets --status through update: it points at move/deliver", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const result = run(["issue", "update", "DEMO-0001", "--json"]);
      assert.equal(result.status, 0);

      // `--status` is not a declared flag on update, so it is a usage error with
      // the fix named in the help; the service refusal is covered in
      // test/server/routes.test.mjs.
      const withStatus = run(["issue", "update", "DEMO-0001", "--status", "done", "--json"]);
      assert.equal(withStatus.status, 2);
      assert.match(JSON.parse(withStatus.stdout).error.message, /unknown option --status/);
    });
  });

  it("moves a task, and reports an illegal transition as INVALID_TRANSITION", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const moved = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      assert.equal(moved.task.status, "in_progress");

      const illegal = run(["issue", "move", "DEMO-0001", "done", "--json"]);
      assert.equal(illegal.status, 1);
      const error = JSON.parse(illegal.stdout).error;
      assert.equal(error.code, "INVALID_TRANSITION");
      assert.equal(error.http, 409);
    });
  });

  it("assigns by free text and by id, and resolves the dictionary", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const assigned = dataOf(run(["issue", "assign", "DEMO-0001", "--assignee", "Linus", "--json"]));
      assert.equal(assigned.task.assignee.display_name, "Linus");

      const entries = dataOf(run(["assignees", "list", "--json"]));
      assert.equal(entries.entries.length, 1);
      const id = entries.entries[0].id;

      const byId = dataOf(run(["issue", "assign", "DEMO-0001", "--assignee-id", id, "--json"]));
      assert.equal(byId.task.assignee.id, id, "an exact id round-trips");

      const reporter = dataOf(run(["issue", "assign", "DEMO-0001", "--reporter", "elon", "--json"]));
      assert.equal(reporter.task.reporter.display_name, "elon");
      assert.equal(reporter.task.reporter.id.length > 0, true);
    });
  });

  it("archives a finished task, and refuses one that is still open", async () => {
    await board(async ({ run }) => {
      createIssue(run);

      const tooEarly = run(["issue", "archive", "DEMO-0001", "--json"]);
      assert.equal(tooEarly.status, 1);
      assert.equal(JSON.parse(tooEarly.stdout).error.code, "ARCHIVE_NOT_TERMINAL");

      dataOf(run(["issue", "move", "DEMO-0001", "canceled", "--json"]));
      const refused = run(["issue", "archive", "DEMO-0001", "--json"]);
      assert.equal(refused.status, 1, "the 7-day window has not passed");

      const archived = dataOf(run(["issue", "archive", "DEMO-0001", "--days", "0", "--json"]));
      assert.equal(typeof archived.task.archived_at, "string");

      const listed = dataOf(run(["issue", "list", "--json"]));
      assert.equal(listed.tasks.length, 0, "archived tasks are hidden by default");
      const withArchived = dataOf(run(["issue", "list", "--include-archived", "--json"]));
      assert.equal(withArchived.tasks.length, 1);
    });
  });
});

describe("cli/issue — every flag the command declares", () => {
  it("create carries description, status, kind, labels, meta and both dictionary kinds", async () => {
    await board(async ({ run }) => {
      const created = createIssue(run, [
        "--description", "a longer story",
        "--status", "backlog",
        "--kind", "epic",
        "--priority", "urgent",
        "--label", "x",
        "--meta", "team=panel",
        "--assignee", "linus",
        "--assignee-kind", "agent",
        "--reporter", "elon",
        "--reporter-kind", "human",
        "--force-create",
      ]);
      assert.equal(created.task.status, "backlog");
      assert.equal(created.task.kind, "epic");
      assert.equal(created.task.description, "a longer story");
      assert.equal(created.task.priority, "urgent");
      assert.deepEqual(created.task.labels, ["x"]);
      assert.equal(created.task.meta.team, "panel");
      assert.equal(created.task.reporter.display_name, "elon");
      assert.equal(created.task.reporter.kind, "human");
    });
  });

  it("create can pick an assignee by id", async () => {
    await board(async ({ run }) => {
      createIssue(run, ["--assignee", "linus"]);
      const id = dataOf(run(["assignees", "list", "--json"])).entries[0].id;
      const created = createIssue(run, ["--title", "Second", "--assignee-id", id]);
      assert.equal(created.task.assignee.id, id);
    });
  });

  it("update carries description, priority, kind and labels", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const updated = dataOf(
        run([
          "issue", "update", "DEMO-0001",
          "--description", "d",
          "--priority", "low",
          "--kind", "epic",
          "--label", "one", "--label", "two",
          "--json",
        ]),
      );
      assert.equal(updated.task.description, "d");
      assert.equal(updated.task.priority, "low");
      assert.equal(updated.task.kind, "epic");
      assert.deepEqual(updated.task.labels, ["one", "two"]);
    });
  });

  it("list filters by assignee and includes archived rows on request", async () => {
    await board(async ({ run }) => {
      const created = createIssue(run, ["--assignee", "linus"]);
      const id = created.task.assignee.id;
      assert.equal(dataOf(run(["issue", "list", "--assignee-id", id, "--json"])).tasks.length, 1);
      assert.equal(dataOf(run(["issue", "list", "--assignee-id", "nobody", "--json"])).tasks.length, 0);

      dataOf(run(["issue", "move", "DEMO-0001", "canceled", "--json"]));
      dataOf(run(["issue", "archive", "DEMO-0001", "--days", "0", "--json"]));
      assert.equal(dataOf(run(["issue", "list", "--include-archived", "--json"])).tasks.length, 1);
    });
  });

  it("move and assign accept if_version and force-create", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const task = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task;
      const moved = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--if-version", String(task.version), "--json"]));
      assert.equal(moved.task.status, "in_progress");

      const conflicts = run(["issue", "move", "DEMO-0001", "blocked", "--if-version", "1", "--json"]);
      assert.equal(conflicts.status, 1);
      assert.equal(JSON.parse(conflicts.stdout).error.code, "VERSION_CONFLICT");

      const assigned = dataOf(run(["issue", "assign", "DEMO-0001", "--assignee", "lin", "--force-create", "--json"]));
      assert.equal(assigned.task.assignee.display_name, "lin");
    });
  });

  it("deliver records seg and session, and takes an if_version guard", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const report = {
        conclusion: "done",
        acceptance: [{ text: "a", status: "met" }],
        evidence: [{ kind: "path", path: "x" }],
      };
      const delivered = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--seg", "seg2", "--session-id", "session-2", "--json"], {
          input: JSON.stringify(report),
        }),
      );
      assert.equal(delivered.report.seg, "seg2");
      assert.equal(delivered.report.session_id, "session-2");
      assert.equal(delivered.report.acceptance.length, 1);
    });
  });

  it("prints a task with its waiver line when one is on record", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      dataOf(run(["issue", "move", "DEMO-0001", "in_review", "--no-report", "--reason", "hotfix: later", "--json"]));
      const human = run(["issue", "get", "DEMO-0001"]);
      assert.match(human.stdout, /waiver\s+round 1: hotfix: later/);
      assert.match(human.stdout, /waivers\s+1 on record/);
    });
  });
});

describe("cli/issue — an empty board reads as 'no tasks'", () => {
  it("says so instead of printing an empty table", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assert.equal(run(["issue", "list", "--status", "canceled"]).stdout.trim(), "no tasks");
      assert.match(run(["comment", "list", "DEMO-0001"]).stdout, /no comments|created_at/);
      assert.equal(run(["session", "list", "DEMO-0001"]).stdout.trim(), "no sessions");
      assert.equal(run(["relation", "list", "DEMO-0001"]).stdout.trim(), "no relations");
    });
  });
});

describe("cli/issue — the actor recorded on a report", () => {
  it("uses the caller as the author when the report does not name one, and honours it when it does", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const report = {
        conclusion: "done",
        acceptance: [{ text: "a", status: "met" }],
        evidence: [{ kind: "path", path: "x" }],
      };

      // No author in the payload: the CLI fills it in from the actor flags.
      const anonymous = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--agent", "linus", "--json"], {
          input: JSON.stringify(report),
        }),
      );
      assert.equal(anonymous.report.author_id, "linus");

      // An explicit `author: null` is the same as omitting it.
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const explicitNull = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--agent", "terry", "--json"], {
          input: JSON.stringify({ ...report, author: null }),
        }),
      );
      assert.equal(explicitNull.report.author_id, "terry");

      // A named author wins.
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const named = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--agent", "terry", "--json"], {
          input: JSON.stringify({ ...report, author: { kind: "agent", id: "linus" } }),
        }),
      );
      assert.equal(named.report.author_id, "linus");
    });
  });
});

describe("cli/issue — candidates (the poll read)", () => {
  it("lists claimable cards and excludes unmet deps and epics", async () => {
    await board(async ({ run }) => {
      // `--allow-dup` keeps the four cards distinct: they share one assignee, so
      // the creation idempotency key would otherwise converge them onto one card.
      const ready = createIssue(run, ["--title", "Ready", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      createIssue(run, ["--title", "Epic", "--kind", "epic", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const blocked = createIssue(run, ["--title", "Blocked", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const blocker = createIssue(run, ["--title", "Blocker", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      // `blocks` source = blocker, target = blocked — the blocked card's depends_on.
      dataOf(run(["relation", "add", blocker.task.identifier, "--type", "blocks", "--target", blocked.task.identifier, "--json"]));

      const candidates = dataOf(run(["issue", "candidates", "--assignee", "pollbot", "--json"]));
      assert.deepEqual(
        candidates.candidates.map((c) => c.identifier),
        [ready.task.identifier, blocker.task.identifier],
        "the blocked card is excluded (depends_on unmet) and so is the epic",
      );
      assert.equal(candidates.candidates[0].status, "todo");
      assert.equal(candidates.candidates[0].project, "demo");
      assert.equal(candidates.candidates[0].reason, "ready");

      const human = run(["issue", "candidates", "--assignee", "pollbot"]);
      assert.match(human.stdout, new RegExp(`${ready.task.identifier}\\s+todo\\s+medium`));
      assert.match(human.stdout, new RegExp(`${blocker.task.identifier}\\s+todo\\s+medium`));
    });
  });

  it("--include-unassigned adds the unassigned public pool (supervisor policy)", async () => {
    await board(async ({ run }) => {
      const assigned = createIssue(run, ["--title", "Assigned", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const pool = createIssue(run, ["--title", "Public pool", "--allow-dup"]);
      createIssue(run, ["--title", "Someone else", "--assignee", "terry", "--assignee-kind", "agent", "--allow-dup"]);
      createIssue(run, ["--title", "Pool epic", "--kind", "epic", "--allow-dup"]);

      const without = dataOf(run(["issue", "candidates", "--assignee", "pollbot", "--json"]));
      assert.deepEqual(without.candidates.map((c) => c.identifier), [assigned.task.identifier]);

      const withPool = dataOf(
        run(["issue", "candidates", "--assignee", "pollbot", "--include-unassigned", "--json"]),
      );
      assert.deepEqual(
        withPool.candidates.map((c) => c.identifier),
        [assigned.task.identifier, pool.task.identifier],
      );
      assert.equal(withPool.candidates[1].reason, "unassigned");
    });
  });

  it("refuses a missing --assignee as a usage error", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const missing = run(["issue", "candidates", "--json"]);
      assert.equal(missing.status, 2);
      assert.match(JSON.parse(missing.stdout).error.message, /--assignee is required/);
    });
  });
});

describe("cli/issue — move enforces the assignee (T-20261009-230500)", () => {
  const assignLinus = (run) =>
    dataOf(run(["issue", "assign", "DEMO-0001", "--assignee", "Linus", "--json"]));

  it("lets the assignee move their own card to in_progress", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);
      const moved = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--agent", "linus", "--json"]));
      assert.equal(moved.task.status, "in_progress");
      assert.equal(moved.task.claimed_by, "linus");
    });
  });

  it("refuses a different actor with not_assignee (409)", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);
      const refused = run(["issue", "move", "DEMO-0001", "in_progress", "--json"]);
      assert.equal(refused.status, 1);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, "not_assignee");
      assert.equal(error.http, 409);
      assert.match(error.hint.fix, /--allow-steal/);
    });
  });

  it("takes it with --allow-steal --reason, and the takeover is readable", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);
      const moved = dataOf(
        run([
          "issue", "move", "DEMO-0001", "in_progress",
          "--allow-steal", "--reason", "linus is on another card",
          "--agent", "elon", "--json",
        ]),
      );
      assert.equal(moved.task.claimed_by, "elon");

      const comments = dataOf(run(["comment", "list", "DEMO-0001", "--json"])).comments;
      assert.equal(comments.length, 1);
      assert.equal(comments[0].kind, "change");
      assert.match(comments[0].body, /elon/);
      assert.match(comments[0].body, /linus/);
    });
  });

  it("refuses --allow-steal without a real reason, as a usage error (exit 2)", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);

      const missing = run(["issue", "move", "DEMO-0001", "in_progress", "--allow-steal", "--json"]);
      assert.equal(missing.status, 2);
      assert.equal(JSON.parse(missing.stdout).error.code, "CLI_USAGE");

      const short = run([
        "issue", "move", "DEMO-0001", "in_progress",
        "--allow-steal", "--reason", "short", "--json",
      ]);
      assert.equal(short.status, 2);
      assert.match(JSON.parse(short.stdout).error.message, /--reason/);
    });
  });
});
