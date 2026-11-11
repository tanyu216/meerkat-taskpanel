/**
 * The intake group (0007): submit, read, settle.
 *
 * The supervisor reads pending requests through `list`; the decision lane
 * answers with `complete` or `fail`. `--idem` is the mechanical guard against a
 * double submit, and `--created` accepts the comma-separated spelling a caller
 * is likely to copy from a card list.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
    return fn(ctx);
  });
}

const submit = (run, extra = []) =>
  dataOf(run(["intake", "create", "--project", "demo", "--text", "Fix the blank paint", ...extra, "--json"]))
    .request;

describe("cli/intake — submit and read", () => {
  it("submits a pending request and reads it back", async () => {
    await board(async ({ run }) => {
      const request = submit(run);
      assert.equal(request.status, "pending");
      assert.equal(request.project_id, "demo");
      assert.equal(request.text, "Fix the blank paint");

      const listed = dataOf(run(["intake", "list", "--status", "pending", "--json"]));
      assert.deepEqual(listed.requests.map((row) => row.id), [request.id]);

      const read = dataOf(run(["intake", "get", request.id, "--json"])).request;
      assert.equal(read.id, request.id);

      const human = run(["intake", "list"]);
      assert.match(human.stdout, /pending\s+demo/);
    });
  });

  it("a repeated --idem returns the first request", async () => {
    await board(async ({ run }) => {
      const first = submit(run, ["--idem", "click-1"]);
      const second = submit(run, ["--idem", "click-1"]);
      assert.equal(second.id, first.id);
      const listed = dataOf(run(["intake", "list", "--json"]));
      assert.equal(listed.requests.length, 1);
    });
  });
});

describe("cli/intake — settlement", () => {
  it("completes with repeated and comma-separated refs", async () => {
    await board(async ({ run }) => {
      const request = submit(run);
      const completed = dataOf(
        run([
          "intake", "complete", request.id,
          "--created", "TP-1,TP-2",
          "--created", "TP-3",
          "--json",
        ]),
      ).request;
      assert.equal(completed.status, "consumed");
      assert.deepEqual(completed.created_refs, ["TP-1", "TP-2", "TP-3"]);
    });
  });

  it("fails with a reason and refuses to complete afterwards", async () => {
    await board(async ({ run }) => {
      const request = submit(run);
      const failed = dataOf(
        run(["intake", "fail", request.id, "--reason", "not work", "--json"]),
      ).request;
      assert.equal(failed.status, "failed");
      assert.equal(failed.last_error, "not work");

      const conflict = run(["intake", "complete", request.id, "--created", "TP-1", "--json"]);
      assert.equal(conflict.status, 1);
      assert.equal(errorOf(conflict).code, "INVALID_TRANSITION");
    });
  });

  it("shows the group and command help", async () => {
    await board(async ({ run }) => {
      const group = run(["intake"]);
      assert.equal(group.status, 0);
      assert.match(group.stdout, /intake create/);

      const help = run(["intake", "create", "--help"]);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /--project <id>/);
      assert.match(help.stdout, /--text <text>/);
      assert.match(help.stdout, /--idem <key>/);
    });
  });
});
