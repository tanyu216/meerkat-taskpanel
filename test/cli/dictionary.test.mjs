/**
 * Step 12: dictionary interaction (§4.4, A5, V7).
 *
 * The dictionary has no management surface, and that is asserted here as a
 * *behaviour* rather than a comment: `assignees add` is not a command, so it is
 * a usage error. Growth happens when a task names somebody new.
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

describe("cli/dictionary — free text resolves against what exists", () => {
  it("reuses an exact hit, keeping the dictionary's own spelling", async () => {
    await board(async ({ run }) => {
      const first = create(run, ["--assignee", "linus", "--assignee-kind", "agent"]);
      const second = create(run, ["--assignee", "Linus", "--title", "Second"]);

      assert.equal(second.task.assignee.id, first.task.assignee.id, "one entry, not two");
      assert.equal(second.task.assignee.display_name, "linus", "the dictionary's spelling wins");
    });
  });

  it("reuses a unique prefix match", async () => {
    await board(async ({ run }) => {
      const first = create(run, ["--assignee", "linus"]);
      const second = create(run, ["--assignee", "linu", "--title", "Second"]);
      assert.equal(second.task.assignee.id, first.task.assignee.id);
    });
  });

  it("refuses an ambiguous name and lists the candidates", async () => {
    await board(async ({ run }) => {
      create(run, ["--assignee", "linus"]);
      create(run, ["--assignee", "linus-2", "--title", "Second"]);

      const ambiguous = run(["issue", "create", "--project", "demo", "--title", "Third", "--assignee", "linu", "--json"]);
      assert.equal(ambiguous.status, 1);
      const error = errorOf(ambiguous);
      assert.equal(error.code, "DICTIONARY_AMBIGUOUS");
      assert.equal(error.details.candidates.length, 2);
      assert.equal(error.hint.fix.includes("--force-create"), true);

      // Nothing was created, and nothing was half-written.
      assert.equal(dataOf(run(["issue", "list", "--json"])).tasks.length, 2);
    });
  });

  it("creates a second entry with --force-create", async () => {
    await board(async ({ run }) => {
      const a = create(run, ["--assignee", "linus"]);
      const b = create(run, ["--assignee", "linus-2", "--title", "Second"]);
      const forced = create(run, ["--assignee", "linu", "--force-create", "--title", "Third"]);

      assert.notEqual(forced.task.assignee.id, a.task.assignee.id);
      assert.notEqual(forced.task.assignee.id, b.task.assignee.id);
      assert.equal(forced.task.assignee.display_name, "linu");
    });
  });

  it("selects an entry by id, bypassing the dictionary", async () => {
    await board(async ({ run }) => {
      create(run, ["--assignee", "linus"]);
      const id = dataOf(run(["assignees", "list", "--json"])).entries[0].id;

      const byId = create(run, ["--assignee-id", id, "--title", "Second"]);
      assert.equal(byId.task.assignee.id, id);
      assert.equal(dataOf(run(["assignees", "list", "--json"])).entries.length, 1, "no new entry");
    });
  });
});

describe("cli/dictionary — the read-only surface", () => {
  it("lists assignees and reporters with display_name and id, and filters by --query", async () => {
    await board(async ({ run }) => {
      create(run, ["--assignee", "linus", "--reporter", "elon"]);
      create(run, ["--assignee", "terry", "--title", "Second"]);

      const all = dataOf(run(["assignees", "list", "--json"]));
      assert.equal(all.entries.length, 2);
      for (const entry of all.entries) {
        assert.equal(typeof entry.display_name, "string");
        assert.equal(typeof entry.id, "string");
      }

      const filtered = dataOf(run(["assignees", "list", "--query", "lin", "--json"]));
      assert.deepEqual(filtered.entries.map((e) => e.display_name), ["linus"]);

      const reporters = dataOf(run(["reporters", "list", "--json"]));
      assert.deepEqual(reporters.entries.map((e) => e.display_name), ["elon"]);

      const human = run(["assignees", "list"]);
      assert.match(human.stdout, /display_name\s+id/);
      assert.match(human.stdout, /linus\s+[0-9a-f-]{36}/);
    });
  });

  it("has no add/rm/rename: they are not commands, so they exit 2", async () => {
    await board(async ({ run }) => {
      for (const verb of ["add", "rm", "remove", "rename", "create"]) {
        const result = run(["assignees", verb, "linus", "--json"]);
        assert.equal(result.status, 2, `assignees ${verb} should not exist`);
        assert.equal(errorOf(result).code, "CLI_USAGE");
        assert.match(errorOf(result).message, new RegExp(`unknown command "assignees ${verb}"`));
      }
    });
  });
});
