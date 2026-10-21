/**
 * Step 15: `comment list|add`.
 *
 * Comments are append-only at the database level, so the two things worth
 * pinning are that `--kind` is honoured (a `decision` is what a reviewer reads)
 * and that there is nowhere to edit one.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/comment", () => {
  it("appends a comment and lists it back", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const added = dataOf(run(["comment", "add", "DEMO-0001", "--body", "looks good", "--kind", "decision", "--json"]));
      assert.equal(added.comment.kind, "decision");
      assert.equal(added.comment.body, "looks good");
      assert.equal(added.comment.author_kind, "human", "an unnamed caller is a local human");

      const listed = dataOf(run(["comment", "list", "DEMO-0001", "--json"]));
      assert.equal(listed.comments.length, 1);
      // The wire carries an `author` ref beside the id (Phase 7).
      assert.equal(added.comment.author.kind, "human");
      assert.equal(typeof added.comment.author.display_name, "string");

      const filtered = dataOf(run(["comment", "list", "DEMO-0001", "--kind", "note", "--json"]));
      assert.equal(filtered.comments.length, 0);

      // The rendered author column names the author, not the actor id: since
      // 0020 `author_id` is a uuid, and the table shows the ref's display name.
      const rendered = run(["comment", "list", "DEMO-0001"]).stdout;
      assert.match(rendered, /decision\s+.* \(human\)\s+looks good/);
      assert.ok(rendered.includes(`${added.comment.author.display_name} (human)`), rendered);
      assert.ok(!rendered.includes(added.comment.author_id), "the table names the author, not the id");
    });
  });

  it("accepts the confirm_request kind", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const added = dataOf(run([
        "comment", "add", "DEMO-0001",
        "--body", "docs/plan.md is ready — please confirm the open items",
        "--kind", "confirm_request",
        "--json",
      ]));
      assert.equal(added.comment.kind, "confirm_request");

      const filtered = dataOf(run(["comment", "list", "DEMO-0001", "--kind", "confirm_request", "--json"]));
      assert.equal(filtered.comments.length, 1);
    });
  });

  it("reads the body from stdin, and records the agent that wrote it", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const added = dataOf(
        run(
          ["comment", "add", "DEMO-0001", "--body", "ignored", "--file", "-", "--kind", "change", "--json"],
          { input: "body from stdin\n", env: {} },
        ),
      );
      assert.equal(added.comment.body, "body from stdin\n");

      const asAgent = dataOf(
        run(["comment", "add", "DEMO-0001", "--body", "hi", "--agent", "linus", "--json"]),
      );
      assert.equal(asAgent.comment.author.display_name, "linus");
    });
  });

  it("refuses an unknown kind, and has no edit path", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const bad = run(["comment", "add", "DEMO-0001", "--body", "x", "--kind", "nonsense", "--json"]);
      assert.equal(bad.status, 1);
      assert.equal(errorOf(bad).code, "VALIDATION_FAILED");

      for (const verb of ["edit", "update", "delete", "rm"]) {
        assert.equal(run(["comment", verb, "DEMO-0001"]).status, 2, `comment ${verb} must not exist`);
      }
    });
  });
});

describe("cli/comment — reading the body from a file", () => {
  it("reads --file from a real path, and refuses a body that is neither", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      run(["issue", "create", "--project", "demo", "--title", "T", "--json"]);

      const fs = await import("node:fs");
      const file = `${dataDir}/body.md`;
      fs.writeFileSync(file, "# from a file\n");
      const added = dataOf(run(["comment", "add", "DEMO-0001", "--body", "ignored", "--file", file, "--json"]));
      assert.equal(added.comment.body, "# from a file\n");

      // A `--file` that is not there is an IO failure, not a silent empty body.
      const missing = run(["comment", "add", "DEMO-0001", "--body", "x", "--file", `${dataDir}/nope.md`, "--json"]);
      assert.equal(missing.status, 1);
      assert.match(missing.stdout, /ENOENT|no such file/i);
    });
  });
});
