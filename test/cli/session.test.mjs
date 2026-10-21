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
          "--goal", "ship the drawer ordering", "--json",
        ]),
      );
      assert.equal(registered.session.seg, "seg2");
      assert.equal(registered.session.owner, "linus");
      assert.equal(registered.session.status, "running");
      assert.equal(registered.session.goal, "ship the drawer ordering");

      // Re-registering without --goal keeps the sentence already recorded.
      run(["session", "set", "DEMO-0001", "--seg", "seg2", "--owner-kind", "claude", "--owner", "linus", "--json"]);

      const listed = dataOf(run(["session", "list", "DEMO-0001", "--json"]));
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].goal, "ship the drawer ordering");
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
