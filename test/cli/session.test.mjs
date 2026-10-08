/**
 * Step 15: `session set|close|list`.
 *
 * The session id is deterministic from `(task, owner, seg)`, which is the point:
 * a resumed conversation keeps its id. So the same three inputs must resolve to
 * the same row however the task was addressed.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { sessionId as deriveSessionId } from "../../src/shared/ids.mjs";
import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/session", () => {
  it("registers a session, lists it, closes it", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const registered = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "seg2", "--backend", "claude", "--owner", "linus", "--json"]),
      );
      assert.equal(registered.session.seg, "seg2");
      assert.equal(registered.session.owner, "linus");
      assert.equal(registered.session.status, "running");

      const listed = dataOf(run(["session", "list", "DEMO-0001", "--json"]));
      assert.equal(listed.sessions.length, 1);
      assert.match(run(["session", "list", "DEMO-0001"]).stdout, /seg2\s+linus\s+claude\s+running/);

      const closed = dataOf(run(["session", "close", "DEMO-0001", registered.session.id, "--json"]));
      assert.equal(closed.session.status, "closed");
      const failed = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "seg3", "--backend", "codex", "--json"]),
      );
      assert.equal(dataOf(run(["session", "close", "DEMO-0001", failed.session.id, "--failed", "--json"])).session.status, "failed");
    });
  });

  it("derives the same session id from the identifier and from the uuid", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);
      const task = dataOf(run(["issue", "create", "--project", "demo", "--title", "T", "--json"])).task;

      const byIdentifier = dataOf(
        run(["session", "set", "DEMO-0001", "--seg", "s1", "--backend", "claude", "--owner", "linus", "--json"]),
      );
      const byId = dataOf(
        run(["session", "set", task.id, "--seg", "s1", "--backend", "claude", "--owner", "linus", "--json"]),
      );
      assert.equal(byId.session.id, byIdentifier.session.id, "one session, not two");
      assert.equal(byIdentifier.session.session_id, deriveSessionId(task.id, "linus", "s1"));
      assert.equal(dataOf(run(["session", "list", "DEMO-0001", "--json"])).sessions.length, 1);
    });
  });

  it("requires --seg and --backend", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);
      const missing = run(["session", "set", "DEMO-0001", "--seg", "s1"]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /--backend is required/);
    });
  });
});
