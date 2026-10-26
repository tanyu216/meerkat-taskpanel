/**
 * Step 15: `session set|close|list`.
 *
 * The session id is deterministic from `(task, owner, seg)`, which is the point:
 * a resumed conversation keeps its id. So the same three inputs must resolve to
 * the same row however the task was addressed.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { sessionId as deriveSessionId } from "../../src/foundation/ids.mjs";
import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/session", () => {
  it("registers a session, lists it, closes it", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const registered = dataOf(
        run([
          "session", "set", "DEMO-0001", "--seg", "seg2", "--owner-kind", "claude", "--owner", "linus",
          "--goal", "ship the drawer ordering",
          "--meta", "harness=claude", "--meta", "thread_id=t1",
          "--json",
        ]),
      );
      assert.equal(registered.session.seg, "seg2");
      assert.equal(registered.session.owner, "linus");
      assert.equal(registered.session.status, "running");
      assert.equal(registered.session.goal, "ship the drawer ordering");
      assert.deepEqual(registered.session.meta, { harness: "claude", thread_id: "t1" });

      // Re-registering without --goal keeps the sentence already recorded; a
      // partial --meta merges into the recorded object.
      run([
        "session", "set", "DEMO-0001", "--seg", "seg2", "--owner-kind", "claude", "--owner", "linus",
        "--meta", "log=/tmp/t1.log",
        "--json",
      ]);

      const listed = dataOf(run(["session", "list", "DEMO-0001", "--json"]));
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].goal, "ship the drawer ordering");
      assert.deepEqual(listed.sessions[0].meta, { harness: "claude", thread_id: "t1", log: "/tmp/t1.log" });
      assert.match(run(["session", "list", "DEMO-0001"]).stdout, /seg2\s+linus\s+claude\s+running/);
      assert.match(run(["session", "list", "DEMO-0001"]).stdout, /ship the drawer ordering/);

      const closed = dataOf(run(["session", "close", "DEMO-0001", registered.session.id, "--json"]));
      assert.equal(closed.session.status, "closed");
      const failed = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "seg3", "--owner-kind", "codex", "--json"]),
      );
      assert.equal(dataOf(run(["session", "close", "DEMO-0001", failed.session.id, "--failed", "--json"])).session.status, "failed");
    });
  });

  it("closes a session by its (task, seg, owner) key, and refuses an ambiguous close", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const registered = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "claude", "--owner", "linus", "--json"]),
      );
      const closed = dataOf(
        run(["session", "close", "DEMO-0001", "--seg", "s1", "--owner", "linus", "--json"]),
      );
      assert.equal(closed.session.id, registered.session.id);
      assert.equal(closed.session.status, "closed");

      // Exactly one identity: a row id and --seg together is ambiguous.
      const both = run(["session", "close", "DEMO-0001", registered.session.id, "--seg", "s1"]);
      assert.equal(both.status, 2);
      assert.match(both.stderr, /exactly one/);

      // Neither is the same mistake, one argument apart.
      const neither = run(["session", "close", "DEMO-0001"]);
      assert.equal(neither.status, 2);
      assert.match(neither.stderr, /exactly one/);

      const missing = run(["session", "close", "DEMO-0001", "--seg", "nope", "--owner", "linus", "--json"]);
      assert.equal(missing.status, 1);
      assert.equal(JSON.parse(missing.stdout).error.code, "NOT_FOUND");
    });
  });

  it("lists the board's sessions by owner/status, and refuses an unbounded read", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "U", "--json"]);
      run(["session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "claude", "--owner", "linus", "--json"]);
      run(["session", "set", "DEMO-0002", "--seg", "s1", "--owner-kind", "codex", "--owner", "terry", "--json"]);

      const byOwner = dataOf(run(["session", "list", "--owner", "linus", "--json"]));
      assert.equal(byOwner.sessions.length, 1);
      assert.equal(byOwner.sessions[0].owner, "linus");

      const running = dataOf(run(["session", "list", "--status", "running", "--json"]));
      assert.equal(running.sessions.length, 2);

      const unbounded = run(["session", "list"]);
      assert.equal(unbounded.status, 2);
      assert.match(unbounded.stderr, /--owner/);
    });
  });

  it("derives the same session id from the identifier and from the uuid", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const task = dataOf(run(["issue", "create", "--project", "demo", "--title", "T", "--json"])).task;

      const byIdentifier = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "claude", "--owner", "linus", "--json"]),
      );
      const byId = dataOf(
        run(["session", "set", task.id, "--seg", "s1", "--owner-kind", "claude", "--owner", "linus", "--json"]),
      );
      assert.equal(byId.session.id, byIdentifier.session.id, "one session, not two");
      assert.equal(byIdentifier.session.session_id, deriveSessionId(task.id, "linus", "s1"));
      assert.equal(dataOf(run(["session", "list", "DEMO-0001", "--json"])).sessions.length, 1);
    });
  });

  it("requires --seg and --owner-kind", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);
      const missing = run(["session", "set", "DEMO-0001", "--seg", "s1"]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /--owner-kind is required/);
    });
  });

  it("derives the id without registering a session", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const task = dataOf(run(["issue", "create", "--project", "demo", "--title", "T", "--json"])).task;

      const derived = dataOf(
        run(["session", "id", "DEMO-0001", "--seg", "s1", "--owner", "linus", "--json"]),
      );
      assert.equal(derived.session_id, deriveSessionId(task.id, "linus", "s1"));
      assert.equal(derived.task_id, task.id);
      assert.equal(derived.task_identifier, "DEMO-0001");
      assert.equal(derived.derived_from, task.id);
      assert.equal(derived.owner, "linus");
      assert.equal(derived.seg, "s1");

      assert.equal(dataOf(run(["session", "list", "DEMO-0001", "--json"])).sessions.length, 0);
    });
  });

  it("matches the value session set writes, by identifier and by uuid", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const task = dataOf(run(["issue", "create", "--project", "demo", "--title", "T", "--json"])).task;

      const stored = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "claude", "--owner", "linus", "--json"]),
      ).session.session_id;
      const byIdentifier = dataOf(
        run(["session", "id", "DEMO-0001", "--seg", "s1", "--owner", "linus", "--json"]),
      ).session_id;
      const byId = dataOf(
        run(["session", "id", task.id, "--seg", "s1", "--owner", "linus", "--json"]),
      ).session_id;

      assert.equal(byIdentifier, stored);
      assert.equal(byId, stored);
    });
  });

  it("defaults the owner exactly as session set does", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const stored = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "human", "--json"]),
      ).session;
      const derived = dataOf(run(["session", "id", "DEMO-0001", "--seg", "s1", "--json"]));
      assert.equal(derived.owner, stored.owner);
      assert.equal(derived.session_id, stored.session_id);
    });
  });

  it("lets --session replace the task the id is derived from", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);
      const second = dataOf(
        run(["issue", "create", "--project", "demo", "--title", "Second", "--json"]),
      ).task;

      const derived = dataOf(
        run([
          "session", "id", "DEMO-0001", "--seg", "s1", "--owner", "linus",
          "--session", second.id, "--json",
        ]),
      );
      assert.equal(derived.derived_from, second.id);
      assert.equal(derived.session_id, deriveSessionId(second.id, "linus", "s1"));
      assert.equal(derived.task_identifier, "DEMO-0001");

      const stored = dataOf(
        run([
          "session", "set", "DEMO-0001", "--seg", "s1", "--owner-kind", "claude", "--owner", "linus",
          "--session", second.id, "--json",
        ]),
      ).session.session_id;
      assert.equal(stored, derived.session_id);
    });
  });

  it("refuses missing or empty inputs, and reports an unknown ref", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const missingSeg = run(["session", "id", "DEMO-0001", "--owner", "linus"]);
      assert.equal(missingSeg.status, 2);
      assert.match(missingSeg.stderr, /--seg is required/);

      assert.equal(run(["session", "id", "DEMO-0001", "--seg", "", "--owner", "linus"]).status, 2);
      assert.equal(run(["session", "id", "DEMO-0001", "--seg", "s1", "--owner", ""]).status, 2);

      const unknown = run(["session", "id", "NOPE-9999", "--seg", "s1", "--json"]);
      assert.equal(unknown.status, 1);
      assert.equal(errorOf(unknown).code, "NOT_FOUND");
    });
  });

  it("prints the bare uuid without --json", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const task = dataOf(run(["issue", "create", "--project", "demo", "--title", "T", "--json"])).task;

      const human = run(["session", "id", "DEMO-0001", "--seg", "s1", "--owner", "linus"]);
      assert.equal(human.status, 0, human.stderr);
      assert.equal(human.stdout, `${deriveSessionId(task.id, "linus", "s1")}\n`);
    });
  });
});
