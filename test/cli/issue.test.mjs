/**
 * Step 12: `issue` without `deliver` (A1/A5).
 *
 * `deliver` has its own file (`deliver.test.mjs`) because it is the milestone's
 * centre of gravity; everything else about a task lives here.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A board with one project. */
async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
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

      const entries = dataOf(run(["actors", "list", "--json"]));
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
      const id = dataOf(run(["actors", "list", "--json"])).entries[0].id;
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
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--seg", "seg2", "--actor-kind", "claude", "--session-id", "session-2", "--json"], {
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
      assert.equal(anonymous.report.author.display_name, "linus");

      // An explicit `author: null` is the same as omitting it.
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const explicitNull = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--agent", "terry", "--json"], {
          input: JSON.stringify({ ...report, author: null }),
        }),
      );
      assert.equal(explicitNull.report.author.display_name, "terry");

      // A named author wins.
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const named = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--agent", "terry", "--json"], {
          input: JSON.stringify({ ...report, author: { kind: "agent", id: "linus" } }),
        }),
      );
      assert.equal(named.report.author.display_name, "linus");
    });
  });
});

describe("cli/issue — candidates (the poll read)", () => {
  it("lists claimable cards and excludes unmet deps, epics and deployment cards", async () => {
    await board(async ({ run }) => {
      // `--allow-dup` keeps the cards distinct: they share one assignee, so
      // the creation idempotency key would otherwise converge them onto one card.
      const ready = createIssue(run, ["--title", "Ready", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      createIssue(run, ["--title", "Epic", "--kind", "epic", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      // A deployment card (T-20261013-232004) assigned to the same poller: the
      // poll's read must not offer it, even though it is a claimable `todo`.
      const deploy = createIssue(run, ["--title", "Rebuild dist", "--kind", "deploy", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const blocked = createIssue(run, ["--title", "Blocked", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const blocker = createIssue(run, ["--title", "Blocker", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      // `blocks` source = blocker, target = blocked — the blocked card's depends_on.
      dataOf(run(["relation", "add", blocker.task.identifier, "--type", "blocks", "--target", blocked.task.identifier, "--json"]));

      const candidates = dataOf(run(["issue", "candidates", "--assignee", "pollbot", "--json"]));
      assert.deepEqual(
        candidates.candidates.map((c) => c.identifier),
        [ready.task.identifier, blocker.task.identifier],
        "the blocked card is excluded (depends_on unmet), and so are the epic and the deploy card",
      );
      assert.equal(candidates.candidates[0].status, "todo");
      assert.equal(candidates.candidates[0].project, "demo");
      assert.equal(candidates.candidates[0].reason, "ready");

      const human = run(["issue", "candidates", "--assignee", "pollbot"]);
      assert.match(human.stdout, new RegExp(`${ready.task.identifier}\\s+todo\\s+medium`));
      assert.match(human.stdout, new RegExp(`${blocker.task.identifier}\\s+todo\\s+medium`));
      assert.equal(human.stdout.includes(deploy.task.identifier), false, "the deploy card is withheld from the human read too");

      // ...but it is a card like any other when it is dispatched explicitly: the
      // refusal here is the **ordinary routing lock** (another actor, another
      // card), never `not_claimable` — the marker keeps the poll off the card, it
      // does not lock the claim gate. The documented override then takes it.
      const asStranger = run(["issue", "move", deploy.task.identifier, "in_progress", "--json"]);
      assert.equal(errorOf(asStranger).code, "not_assignee");
      const dispatched = dataOf(
        run([
          "issue", "move", deploy.task.identifier, "in_progress",
          "--allow-steal", "--reason", "explicit dispatch of a deployment card", "--json",
        ]),
      ).task;
      assert.equal(dispatched.status, "in_progress");
      assert.equal(dispatched.kind, "deploy", "the marker survives the claim");
    });
  });

  it("--include-unassigned adds the unassigned public pool (supervisor policy)", async () => {
    await board(async ({ run }) => {
      const assigned = createIssue(run, ["--title", "Assigned", "--assignee", "pollbot", "--assignee-kind", "agent", "--allow-dup"]);
      const pool = createIssue(run, ["--title", "Public pool", "--allow-dup"]);
      createIssue(run, ["--title", "Someone else", "--assignee", "terry", "--assignee-kind", "agent", "--allow-dup"]);
      createIssue(run, ["--title", "Pool epic", "--kind", "epic", "--allow-dup"]);
      createIssue(run, ["--title", "Pool deploy", "--kind", "deploy", "--allow-dup"]);

      const without = dataOf(run(["issue", "candidates", "--assignee", "pollbot", "--json"]));
      assert.deepEqual(without.candidates.map((c) => c.identifier), [assigned.task.identifier]);

      const withPool = dataOf(
        run(["issue", "candidates", "--assignee", "pollbot", "--include-unassigned", "--json"]),
      );
      assert.deepEqual(
        withPool.candidates.map((c) => c.identifier),
        [assigned.task.identifier, pool.task.identifier],
        "the public pool admits an unassigned card — but not the epic or the deploy card in it",
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
      // `norm` folds the case, so the claimant `linus` is the assignee actor row
      // `Linus` — the spelling the dictionary saw first wins.
      assert.equal(moved.task.claimed_by_actor.display_name, "Linus");
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
      assert.equal(moved.task.claimed_by_actor.display_name, "elon");

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

describe("cli/issue — `issue heartbeat` (T-20261017-063818)", () => {
  // Until this command existed the rule "keep the heartbeat fresh (≤10 minutes)"
  // named no command at all, and the only way to reset the clock was to re-claim
  // the card. The board has no background pulse: whoever holds the claim is the
  // only thing that knows the work is still going, so the pulse is the holder's
  // to send — and these legs are the proof the holder can.
  const assignLinus = (run) => dataOf(run(["issue", "assign", "DEMO-0001", "--assignee", "Linus", "--json"]));

  it("pulses a claimed card without moving it, and prints the refreshed heartbeat", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);
      const before = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--agent", "linus", "--json"]));

      const pulsed = dataOf(run(["issue", "heartbeat", "DEMO-0001", "--agent", "linus", "--json"]));
      assert.equal(pulsed.task.status, "in_progress", "a pulse never moves the card");
      assert.equal(pulsed.task.claimed_by_actor.display_name, "Linus", "…nor changes who holds it");
      assert.equal(pulsed.task.claimed_at, before.task.claimed_at, "the claim itself is not re-stamped");
      assert.equal(pulsed.task.version, before.task.version + 1, "the pulse is exactly one write");

      // A separate process reads it back, so the pulse is on the card.
      const read = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task;
      assert.equal(read.heartbeat_at, pulsed.task.heartbeat_at);

      const human = run(["issue", "heartbeat", "DEMO-0001", "--agent", "linus"]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /DEMO-0001/);
      assert.match(human.stdout, /in_progress/);
    });
  });

  it("refuses a card that is not in_progress — there is nothing to pulse", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const refused = run(["issue", "heartbeat", "DEMO-0001", "--agent", "linus", "--json"]);
      assert.equal(refused.status, 1);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, "INVALID_TRANSITION");
      assert.equal(error.http, 409);
      assert.match(error.message, /nothing to pulse/);
    });
  });

  it("refuses a non-holder with EXECUTION_ACTIVE, naming the holder", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      assignLinus(run);
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--agent", "linus", "--json"]));

      const refused = run(["issue", "heartbeat", "DEMO-0001", "--agent", "elon", "--json"]);
      assert.equal(refused.status, 1);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, "EXECUTION_ACTIVE");
      assert.equal(error.http, 409);
      assert.match(error.message, /Linus/);
    });
  });
});

describe("cli/issue — `issue move --blocked-reason` (0016)", () => {
  // The CLI half of the write path. The column itself is asserted over HTTP in
  // test/server/routes.test.mjs; the point here is that the flag exists, that it
  // reaches the board, and that the *vocabulary* — not a locally invented list —
  // is what refuses a bad value.
  it("writes the class on a move into `blocked`, and clears it on the move out", async () => {
    await board(async ({ run }) => {
      createIssue(run);

      const blocked = dataOf(
        run(["issue", "move", "DEMO-0001", "blocked", "--blocked-reason", "dependency", "--json"]),
      );
      assert.equal(blocked.task.status, "blocked");
      assert.equal(blocked.task.blocked_reason, "dependency");

      // A separate process reads it back, so the value is on the card and not
      // merely in the response the writer happened to receive.
      assert.equal(dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.blocked_reason, "dependency");

      const back = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      assert.equal(back.task.status, "in_progress");
      assert.equal(back.task.blocked_reason, null);
      assert.equal(dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.blocked_reason, null);
    });
  });

  it("is optional — a card blocked without a class is legal", async () => {
    await board(async ({ run }) => {
      createIssue(run);
      const blocked = dataOf(run(["issue", "move", "DEMO-0001", "blocked", "--json"]));
      assert.equal(blocked.task.status, "blocked");
      assert.equal(blocked.task.blocked_reason, null);
    });
  });

  it("refuses a value outside the eight literals with VALIDATION_FAILED", async () => {
    await board(async ({ run }) => {
      createIssue(run);

      for (const bad of ["deps", "Dependency", "free text"]) {
        const refused = run(["issue", "move", "DEMO-0001", "blocked", "--blocked-reason", bad, "--json"]);
        assert.equal(refused.status, 1, `${bad}: ${refused.stdout}${refused.stderr}`);
        const error = errorOf(refused);
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.equal(error.details.field, "blocked_reason");
        assert.equal(error.http, 400);
      }

      // The refused moves wrote nothing: the card never left `todo`.
      assert.equal(dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.status, "todo");
    });
  });

  it("writes the same column the HTTP body does — one card, two entry points", async () => {
    await board(async ({ run, url, token }) => {
      createIssue(run);

      // HTTP in, CLI out: the flag and the body are two spellings of one write.
      const moved = await fetch(`${url}/api/v1/tasks/DEMO-0001/move`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: "blocked", blocked_reason: "defect" }),
      });
      assert.equal(moved.status, 200);
      assert.equal((await moved.json()).data.task.blocked_reason, "defect");
      assert.equal(dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.blocked_reason, "defect");

      // And back out through the CLI — the column is cleared by whichever entry
      // performed the move, since both go through the same command layer.
      dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      const read = await fetch(`${url}/api/v1/tasks/DEMO-0001`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal((await read.json()).data.task.blocked_reason, null);
    });
  });
});

describe("cli/issue — the container recipe, run exactly as `SKILL.md` spells it", () => {
  const REPORT = {
    conclusion: "Rolled up: both pieces delivered, nothing outstanding.",
    acceptance: [{ text: "the container is whole", status: "met" }],
    evidence: [{ kind: "commit", sha: "dcd7d15" }],
  };
  // Rule 8: every write carries the agent's attribution, so the claim below is
  // made *by* the card's assignee rather than by whatever actor the host defaulted to.
  const AS = ["--agent", "linus"];
  const forLinus = ["--assignee", "linus", "--assignee-kind", "agent", ...AS];

  const childReport = (sha) => ({
    conclusion: `Piece delivered (${sha}).`,
    acceptance: [{ text: "the piece works", status: "met" }],
    evidence: [{ kind: "commit", sha }],
  });

  /** Claim, deliver with a report, and accept — the whole life of one child. */
  const finishChild = (run, identifier, sha) => {
    dataOf(run(["issue", "move", identifier, "in_progress", ...AS, "--json"]));
    dataOf(run(["issue", "deliver", identifier, "--report-file", "-", ...AS, "--json"], {
      input: JSON.stringify(childReport(sha)),
    }));
    dataOf(run(["issue", "move", identifier, "done", ...AS, "--json"]));
  };

  it("closes the container itself when its last child is accepted", async () => {
    await board(async ({ run }) => {
      // 1. the card is in hand and claimed — while it is still a `task`
      const card = createIssue(run, forLinus);
      dataOf(run(["issue", "move", card.task.identifier, "in_progress", ...AS, "--json"]));

      // 2. promote it in place: the kind changes, the status does not
      const promoted = dataOf(run(["issue", "update", card.task.identifier, "--kind", "epic", ...AS, "--json"]));
      assert.equal(promoted.task.kind, "epic");
      assert.equal(promoted.task.status, "in_progress");

      // 3. one create per deliverable, each naming its own `target` — the retry
      //    guard would otherwise read two children for one owner as one card
      const first = createIssue(run, ["--title", "Piece one", "--target", "src/a", ...forLinus]);
      const second = createIssue(run, ["--title", "Piece two", "--target", "src/b", ...forLinus]);
      assert.notEqual(first.task.identifier, second.task.identifier);

      // 4. the edge is its own command — `issue create` links nothing
      for (const child of [first, second]) {
        dataOf(run(["relation", "add", card.task.identifier, "--type", "parent", "--target", child.task.identifier, ...AS, "--json"]));
      }
      assert.equal(dataOf(run(["relation", "list", card.task.identifier, "--json"])).children.length, 2);

      // 5. work the children. No parking move: the container is delivered out of
      //    whichever status the claim left it in (0024).
      finishChild(run, first.task.identifier, "abc1234");
      assert.equal(
        dataOf(run(["issue", "get", card.task.identifier, "--json"])).task.status,
        "in_progress",
        "one child is not the whole set",
      );

      finishChild(run, second.task.identifier, "def5678");

      // 6. the board closed the container itself: the transition is spent, so a
      //    second, manual delivery is refused.
      const closed = dataOf(run(["issue", "get", card.task.identifier, "--json"])).task;
      assert.equal(closed.status, "in_review", "a human accepts the container to done");
      const again = run(["issue", "deliver", card.task.identifier, "--report-file", "-", ...AS, "--json"], {
        input: JSON.stringify(REPORT),
      });
      assert.equal(again.status, 1);
      assert.equal(JSON.parse(again.stdout).error.code, "INVALID_TRANSITION");
    });
  });

  it("leaves the container open when its children were all waived, so a human can close it", async () => {
    await board(async ({ run }) => {
      const card = createIssue(run, forLinus);
      dataOf(run(["issue", "update", card.task.identifier, "--kind", "epic", ...AS, "--json"]));
      const child = createIssue(run, ["--title", "Waived piece", "--target", "src/w", ...forLinus]);
      dataOf(run(["relation", "add", card.task.identifier, "--type", "parent", "--target", child.task.identifier, ...AS, "--json"]));

      // A waiver leaves no report, so there is no evidence to roll up.
      dataOf(run(["issue", "move", child.task.identifier, "in_progress", ...AS, "--json"]));
      dataOf(run(["issue", "move", child.task.identifier, "in_review", "--no-report", "--reason", "audited waiver, no commit", ...AS, "--json"]));
      dataOf(run(["issue", "move", child.task.identifier, "done", ...AS, "--json"]));

      assert.equal(
        dataOf(run(["issue", "get", card.task.identifier, "--json"])).task.status,
        "in_progress",
        "the container started when its child did; there is no evidence to deliver it",
      );

      // The manual path still works — the container is a human's to close here.
      const delivered = dataOf(
        run(["issue", "deliver", card.task.identifier, "--report-file", "-", ...AS, "--json"], {
          input: JSON.stringify(REPORT),
        }),
      );
      assert.equal(delivered.task.status, "in_review");
      assert.equal(delivered.report.round, 1);
    });
  });

  it("collapses two creates for one owner — which is why a child names its own target", async () => {
    await board(async ({ run }) => {
      const asked = createIssue(run, ["--title", "Piece one", ...forLinus]);
      const again = createIssue(run, ["--title", "Piece two", ...forLinus]);
      assert.equal(
        again.task.identifier,
        asked.task.identifier,
        "same kind, assignee, source and target: the second create is a retry of the first, not a sibling",
      );
    });
  });
});

describe("cli/issue — `issue meta` is a merge, not a replace", () => {
  it("writes one key and leaves the rest of the metadata — and its types — intact", async () => {
    await board(async ({ run }) => {
      const created = createIssue(run, [
        "--acceptance", "cli works",
        "--target", "src/x",
        "--meta", "flow=A",
      ]);
      const merged = dataOf(
        run(["issue", "meta", created.task.identifier, "--meta", "accepted_by=loop-review", "--meta", "accepted_round=1", "--json"]),
      );
      assert.deepEqual(merged.task.meta.acceptance, ["cli works"], "the acceptance list survives as a list");
      assert.equal(merged.task.meta.target, "src/x");
      assert.equal(merged.task.meta.flow, "A");
      assert.equal(merged.task.meta.accepted_by, "loop-review");
      assert.equal(merged.task.meta.accepted_round, "1");

      const again = dataOf(run(["issue", "meta", created.task.identifier, "--meta", "rework_round=2", "--json"]));
      assert.equal(again.task.meta.rework_round, "2");
      assert.deepEqual(again.task.meta.acceptance, ["cli works"], "a second merge is still additive");
      assert.equal(again.task.meta.accepted_by, "loop-review");
    });
  });
});

describe("cli/issue — the loop's two lifecycle counter-proofs", () => {
  const report = (conclusion = "delivered") =>
    JSON.stringify({
      conclusion,
      acceptance: [{ text: "a", status: "met" }],
      evidence: [{ kind: "path", path: "x" }],
    });

  it("re-closes a reopened epic unless a fix child exists first (the safe rejection path)", async () => {
    await board(async ({ run }) => {
      const epic = createIssue(run, ["--title", "Container", "--kind", "epic", "--allow-dup"]);
      const child = createIssue(run, ["--title", "Piece", "--allow-dup"]);
      dataOf(run(["relation", "add", epic.task.identifier, "--type", "parent", "--target", child.task.identifier, "--json"]));
      dataOf(run(["issue", "move", child.task.identifier, "in_progress", "--json"]));
      dataOf(run(["issue", "deliver", child.task.identifier, "--report-file", "-", "--json"], { input: report() }));
      dataOf(run(["issue", "move", child.task.identifier, "done", "--json"]));
      assert.equal(
        dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status,
        "in_review",
        "the board rolled the container up",
      );

      // Reopening without creating anything new: reconcile closes it straight back.
      // This is why a rejection must create the fix child BEFORE it reopens.
      dataOf(run(["issue", "move", epic.task.identifier, "in_progress", "--json"]));
      const unsafe = dataOf(run(["issue", "reconcile", "--json"]));
      const unsafeAction = unsafe.actions.find((entry) => entry.epic === epic.task.identifier);
      assert.equal(unsafeAction.action, "close");
      assert.equal(unsafeAction.reason, "all_children_terminal");
      assert.equal(
        dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status,
        "in_review",
        "without a fix child the sweep immediately re-closes the container",
      );

      // The safe path: a non-terminal fix child holds the container open.
      dataOf(run(["issue", "move", epic.task.identifier, "in_progress", "--json"]));
      const fix = createIssue(run, ["--title", "Fix the gap", "--allow-dup"]);
      dataOf(run(["relation", "add", epic.task.identifier, "--type", "parent", "--target", fix.task.identifier, "--json"]));

      const safe = dataOf(run(["issue", "reconcile", "--json"]));
      const safeAction = safe.actions.find((entry) => entry.epic === epic.task.identifier);
      assert.equal(safeAction.action, "none");
      assert.equal(safeAction.reason, "children_unfinished");
      assert.deepEqual(safeAction.blocking, [{ identifier: fix.task.identifier, status: "todo" }]);
      assert.equal(
        dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status,
        "in_progress",
        "with a fix child in flight the container stays open",
      );
    });
  });

  it("cannot skip in_review: a review card goes in_progress → in_review → done", async () => {
    await board(async ({ run }) => {
      const review = createIssue(run, [
        "--title", "Review DEMO-1",
        "--meta", "review_of=DEMO-1",
        "--meta", "flow=B",
        "--meta", "review_round=1",
        "--target", "review:DEMO-1:r1",
        "--allow-dup",
      ]);
      dataOf(run(["issue", "move", review.task.identifier, "in_progress", "--json"]));

      const refused = run(["issue", "move", review.task.identifier, "done", "--json"]);
      assert.equal(refused.status, 1, "done is reachable only from in_review");
      assert.equal(errorOf(refused).code, "INVALID_TRANSITION");

      const delivered = dataOf(
        run(["issue", "deliver", review.task.identifier, "--report-file", "-", "--json"], {
          input: report("VERDICT: APPROVE"),
        }),
      );
      assert.equal(delivered.task.status, "in_review", "the verdict report is the evidence");

      const accepted = dataOf(run(["issue", "move", review.task.identifier, "done", "--json"]));
      assert.equal(accepted.task.status, "done");
    });
  });
});

describe("cli/issue — reconcile (the container backstop)", () => {
  it("plans a missed closure with --dry-run, applies it once, and is idempotent", async () => {
    await board(async ({ run }) => {
      // A child finished with no container above it: the event path never saw a
      // parent, and the epic below is attached after the fact (`relation add`
      // fires no status hook by design). This is the missed-event shape the
      // sweep exists for.
      const child = createIssue(run, ["--title", "Child"]);
      dataOf(run(["issue", "move", child.task.identifier, "in_progress", "--json"]));
      dataOf(
        run(["issue", "deliver", child.task.identifier, "--report-file", "-", "--json"], {
          input: JSON.stringify({
            conclusion: "done",
            acceptance: [{ text: "a", status: "met" }],
            evidence: [{ kind: "path", path: "x" }],
          }),
        }),
      );
      dataOf(run(["issue", "move", child.task.identifier, "done", "--json"]));

      const epic = createIssue(run, ["--title", "Container", "--kind", "epic", "--allow-dup"]);
      dataOf(
        run(["relation", "add", epic.task.identifier, "--type", "parent", "--target", child.task.identifier, "--json"]),
      );
      assert.equal(dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status, "todo");

      const dry = dataOf(run(["issue", "reconcile", "--dry-run", "--json"]));
      assert.equal(dry.dry_run, true);
      assert.equal(dry.actions.find((entry) => entry.epic === epic.task.identifier).action, "close");
      assert.equal(
        dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status,
        "todo",
        "a dry run writes nothing",
      );

      const applied = dataOf(run(["issue", "reconcile", "--json"]));
      assert.equal(applied.actions.find((entry) => entry.epic === epic.task.identifier).action, "close");
      assert.equal(dataOf(run(["issue", "get", epic.task.identifier, "--json"])).task.status, "in_review");

      const comments = dataOf(run(["comment", "list", epic.task.identifier, "--json"])).comments;
      assert.equal(comments.length, 1);
      assert.equal(comments[0].kind, "note");
      assert.match(comments[0].body, /^Auto-rollup \(sweep\): 1\/1 child card\(s\) terminal /);

      // A second sweep sees a container already waiting for a human and writes
      // nothing: same state, same answer.
      const again = dataOf(run(["issue", "reconcile", "--json"]));
      assert.equal(again.actions.find((entry) => entry.epic === epic.task.identifier).action, "none");
      assert.equal(dataOf(run(["comment", "list", epic.task.identifier, "--json"])).comments.length, 1);
    });
  });

  it("names the child holding a container open in the human report too", async () => {
    await board(async ({ run }) => {
      // The epic is started by the first child, then a second child is attached
      // afterwards: the container is in_progress with work still outstanding.
      const epic = createIssue(run, ["--title", "Container", "--kind", "epic", "--allow-dup"]);
      const done = createIssue(run, ["--title", "Done"]);
      const pending = createIssue(run, ["--title", "Pending", "--allow-dup"]);
      dataOf(
        run(["relation", "add", epic.task.identifier, "--type", "parent", "--target", done.task.identifier, "--json"]),
      );
      // The claim starts the container; the second child is attached after that,
      // so the container is in_progress with work still outstanding.
      dataOf(run(["issue", "move", done.task.identifier, "in_progress", "--json"]));
      dataOf(
        run(["relation", "add", epic.task.identifier, "--type", "parent", "--target", pending.task.identifier, "--json"]),
      );
      dataOf(
        run(["issue", "deliver", done.task.identifier, "--report-file", "-", "--json"], {
          input: JSON.stringify({
            conclusion: "done",
            acceptance: [{ text: "a", status: "met" }],
            evidence: [{ kind: "path", path: "x" }],
          }),
        }),
      );
      dataOf(run(["issue", "move", done.task.identifier, "done", "--json"]));

      const human = run(["issue", "reconcile", "--dry-run"]);
      assert.match(human.stdout, /children_unfinished/);
      assert.ok(
        human.stdout.includes(`${pending.task.identifier} (todo)`),
        `the report must name the child, got:\n${human.stdout}`,
      );
      assert.ok(!human.stdout.includes(`${done.task.identifier} (done)`), "a finished child is not blocking");
    });
  });
});
