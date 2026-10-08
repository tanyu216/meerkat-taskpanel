/**
 * Step 15: `relation add|remove|list`.
 *
 * The direction convention is the thing to get right and the thing worth
 * asserting: for `parent`, the task you name is the **parent** and `--target` is
 * the child, which is why only an `epic` may be named first.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Epic", "--kind", "epic", "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Child", "--json"]);
    return fn(ctx);
  });
}

describe("cli/relation", () => {
  it("adds a parent edge (source = parent), lists it and removes it", async () => {
    await board(async ({ run }) => {
      const added = dataOf(
        run(["relation", "add", "DEMO-0001", "--type", "parent", "--target", "DEMO-0002", "--json"]),
      );
      assert.equal(added.relation.type, "parent");
      assert.equal(added.relation.source.length > 0, true);

      const listing = dataOf(run(["relation", "list", "DEMO-0002", "--json"]));
      assert.equal(listing.ancestors.length, 1);
      const parents = dataOf(run(["relation", "list", "DEMO-0001", "--json"]));
      assert.equal(parents.children.length, 1);

      const human = run(["relation", "list", "DEMO-0001"]);
      assert.match(human.stdout, /child\s+[0-9a-f-]{36}/);

      const removed = dataOf(run(["relation", "remove", "DEMO-0001", added.relation.id, "--json"]));
      assert.equal(removed.removed, true);
      assert.equal(dataOf(run(["relation", "list", "DEMO-0001", "--json"])).children.length, 0);
    });
  });

  it("refuses a parent edge that the shape rules forbid", async () => {
    await board(async ({ run }) => {
      // A `task` may not be a parent — only an epic (I: parent kind).
      const bad = run(["relation", "add", "DEMO-0002", "--type", "parent", "--target", "DEMO-0001", "--json"]);
      assert.equal(bad.status, 1);
      assert.equal(errorOf(bad).code, "VALIDATION_FAILED");
      assert.match(errorOf(bad).message, /only an epic can be a parent/);

      // A self-reference is its own reason code, straight from the database.
      const self = run(["relation", "add", "DEMO-0001", "--type", "related", "--target", "DEMO-0001", "--json"]);
      assert.equal(self.status, 1);
      assert.equal(errorOf(self).code, "SELF_REFERENCE");
    });
  });

  it("adds the other two relation types and reports a duplicate", async () => {
    await board(async ({ run }) => {
      const blocks = dataOf(run(["relation", "add", "DEMO-0001", "--type", "blocks", "--target", "DEMO-0002", "--json"]));
      assert.equal(blocks.relation.type, "blocks");

      const duplicate = run(["relation", "add", "DEMO-0001", "--type", "blocks", "--target", "DEMO-0002", "--json"]);
      assert.equal(duplicate.status, 1);
      assert.equal(errorOf(duplicate).code, "RELATION_DUPLICATE");

      const related = dataOf(run(["relation", "add", "DEMO-0001", "--type", "related", "--target", "DEMO-0002", "--json"]));
      assert.equal(related.relation.type, "related");

      const listing = dataOf(run(["relation", "list", "DEMO-0002", "--json"]));
      assert.equal(listing.blocked_by.length, 1);
    });
  });
});
