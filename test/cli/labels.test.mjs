/**
 * Step 12: the label surface (§4.4, A5).
 *
 * Read-only, and structurally so — `labels add` is not a command, so it is a
 * usage error, the same shape as the assignee/reporter tests next door. The
 * registry grows from `issue create --label`.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    return fn(ctx);
  });
}

const create = (run, extra) =>
  dataOf(run(["issue", "create", "--project", "demo", "--title", "T", ...extra, "--json"]));

describe("cli/labels — the read-only surface", () => {
  it("lists labels by display name, id, colour and use count", async () => {
    await board(async ({ run }) => {
      create(run, ["--label", "Bug", "--label", "ui"]);
      create(run, ["--title", "Second", "--label", "bug"]);

      const all = dataOf(run(["labels", "list", "--json"]));
      assert.deepEqual(all.labels.map((l) => l.display_name), ["Bug", "ui"]);
      const bug = all.labels.find((l) => l.display_name === "Bug");
      assert.equal(bug.use_count, 2, "two live tasks name it");
      assert.equal(typeof bug.id, "string");
      assert.match(bug.color, /^#[0-9a-f]{6}$/i);
      assert.equal(bug.norm, "bug");

      const filtered = dataOf(run(["labels", "list", "--query", "UI", "--json"]));
      assert.deepEqual(filtered.labels.map((l) => l.display_name), ["ui"]);
    });
  });

  it("renders a human table, and `no labels` for an empty registry", async () => {
    await board(async ({ run }) => {
      assert.match(run(["labels", "list"]).stdout, /no labels/);
      create(run, ["--label", "Bug"]);
      const human = run(["labels", "list"]);
      assert.match(human.stdout, /display_name\s+id\s+color\s+used/);
      assert.match(human.stdout, /Bug\s+[0-9a-f-]{36}/);
    });
  });

  it("shows group and command help without touching the board", async () => {
    await board(async ({ run }) => {
      const group = run(["labels"]);
      assert.equal(group.status, 0);
      assert.match(group.stdout, /labels list/);

      const help = run(["labels", "list", "--help"]);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage: taskctl labels list \[options\]/);
      assert.match(help.stdout, /--query <text>/);
      assert.match(help.stdout, /--limit <n>/);
    });
  });

  it("has no add/rm/rename: they are not commands, so they exit 2", async () => {
    await board(async ({ run }) => {
      for (const verb of ["add", "rm", "remove", "rename", "create"]) {
        const result = run(["labels", verb, "bug", "--json"]);
        assert.equal(result.status, 2, `labels ${verb} should not exist`);
        assert.equal(errorOf(result).code, "CLI_USAGE");
        assert.match(errorOf(result).message, new RegExp(`unknown command "labels ${verb}"`));
      }
    });
  });
});
